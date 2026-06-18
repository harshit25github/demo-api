import { MaxTurnsExceededError, MemorySession, Runner } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { FlightAgent } from './agent.js';
import { flightAgentConfig } from './config.js';
import { log } from './logger.js';

export const flightAgentRunner = new Runner({
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  workflowName: 'flight-agent',
  traceIncludeSensitiveData: false,
});

const flightAgentSessions = new Map();
const flightAgentContexts = new Map();

export function getFlightAgentSession(sessionId = 'default') {
  const existingSession = flightAgentSessions.get(sessionId);
  if (existingSession) {
    // Reuse the same MemorySession so the SDK loads prior turns automatically.
    return existingSession;
  }

  // Create a new local MemorySession for this chat/conversation.
  const session = new MemorySession({ sessionId });
  flightAgentSessions.set(sessionId, session);
  return session;
}

function getFlightAgentContext(sessionId, incomingContext) {
  const existingContext = flightAgentContexts.get(sessionId);

  if (incomingContext) {
    const appContext = existingContext || incomingContext;
    Object.assign(appContext, incomingContext);
    flightAgentContexts.set(sessionId, appContext);
    return appContext;
  }

  if (existingContext) {
    return existingContext;
  }

  const appContext = {};
  flightAgentContexts.set(sessionId, appContext);
  return appContext;
}

export async function clearFlightAgentSession(sessionId = 'default') {
  const session = flightAgentSessions.get(sessionId);
  const hadContext = flightAgentContexts.has(sessionId);

  if (session) {
    // Clear SDK-managed history for this chat.
    await session.clearSession();
  }

  // Clear matching tool/context state such as searchKey for this chat.
  flightAgentSessions.delete(sessionId);
  flightAgentContexts.delete(sessionId);
  return Boolean(session || hadContext);
}

export async function clearAllFlightAgentSessions() {
  for (const session of flightAgentSessions.values()) {
    // Clear all process-local MemorySession histories.
    await session.clearSession();
  }

  flightAgentSessions.clear();
  flightAgentContexts.clear();
}

export async function runFlightAgent({
  input,
  requestId = randomUUID(),
  sessionId = 'default',
  context,
} = {}) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const session = getFlightAgentSession(sessionId);
  const appContext = getFlightAgentContext(sessionId, context);

  // Accept both application naming conventions for hydrated flight context.
  appContext.UID ||= appContext.uid || 'demo-user';
  appContext.uid ||= appContext.UID;
  appContext.searchKey ||= appContext.sid;
  appContext.sid ||= appContext.searchKey;
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  appContext.toolCallLog ||= [];

  log('info', 'flight_agent.request', { requestId, sessionId, input });

  try {
    const result = await flightAgentRunner.run(FlightAgent, input, {
      context: appContext,
      maxTurns: flightAgentConfig.maxTurns,
      session,
    });

    const latencyMs = Date.now() - startedAt;
    const output = result.finalOutput || '';

    // Keep aliases synchronized after tools create or replace the active search.
    appContext.uid ||= appContext.UID;
    appContext.sid = appContext.searchKey || appContext.sid;

    log('info', 'flight_agent.response', {
      requestId,
      sessionId,
      latencyMs,
      output,
    });

    return {
      requestId,
      sessionId,
      output,
      latencyMs,
      context: appContext,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof MaxTurnsExceededError
        ? 'I could not complete that quickly. Please share the flight details again in one message.'
        : 'I am having trouble processing that flight request right now. Please try again.';

    log('error', 'flight_agent.error', {
      requestId,
      sessionId,
      latencyMs,
      errorName: error?.name,
      errorMessage: error?.message,
    });

    return {
      requestId,
      sessionId,
      output: message,
      latencyMs,
      context: appContext,
      error: true,
    };
  }
}
