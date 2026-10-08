import { generateTraceId, withTrace } from '@openai/agents';
import { MaxTurnsExceededError, MemorySession, Runner } from '@openai/agents';
import { ObservedModelProvider, observeModelInput, UsageCollector, withUsageCollector } from '../../shared/observability/model-usage.js';
import { randomUUID } from 'node:crypto';
import { FlightAgent } from './agent.js';
import { flightAgentConfig } from './config.js';
import {
  ensureFlightRuntimeContext,
  mergeFlightAgentContext,
  prepareFlightAgentTurnContext,
} from './context/flight-context.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { clearFlightSearchRuntime } from './context/search-runtime-store.js';
import { log } from '../../shared/logging/logger.js';
import { sanitizePricePredictionFailureResponse } from './tools/price-prediction/failure-response.js';
import {
  beginFlightSuggestionTurn,
  finalizeFlightSuggestedQuestions,
} from './tools/suggested-questions-tool.js';
import type { FlightAppContext } from './types.js';
import { buildFlightCoreSuccessFallback } from './context/recovery-outcome.js';

export const flightAgentRunner = new Runner({
  modelProvider: new ObservedModelProvider(),
  callModelInputFilter: observeModelInput,
  model: flightAgentConfig.model,
  modelSettings: { ...flightAgentConfig.modelSettings, preserveRawUsage: true },
  workflowName: 'flight-agent',
  traceIncludeSensitiveData: true,
});

const flightAgentSessions = new Map<string, MemorySession>();
const flightAgentContexts = new Map<string, FlightAppContext>();

interface RunFlightAgentOptions {
  input: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  now?: Date | string | number;
  timeZone?: string;
}

export function getFlightAgentSession(sessionId = 'default'): MemorySession {
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

function getFlightAgentContext(
  sessionId: string,
  incomingContext?: Record<string, unknown>,
): FlightAppContext {
  const existingContext = flightAgentContexts.get(sessionId);

  if (incomingContext) {
    const appContext = mergeFlightAgentContext(
      existingContext || {},
      incomingContext,
    ) as FlightAppContext;
    flightAgentContexts.set(sessionId, appContext);
    return appContext;
  }

  if (existingContext) {
    return ensureFlightRuntimeContext(existingContext);
  }

  const appContext = ensureFlightRuntimeContext({});
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
  clearFlightSearchRuntime(flightAgentContexts.get(sessionId)?.flight?.searchKey);
  flightAgentSessions.delete(sessionId);
  flightAgentContexts.delete(sessionId);
  return Boolean(session || hadContext);
}

export async function runFlightAgent(options: RunFlightAgentOptions) {
  const requestId = options.requestId ?? randomUUID();
  const sessionId = options.sessionId ?? 'default';
  const traceId = options.traceId ?? generateTraceId();
  const usage = new UsageCollector({ requestId, sessionId, traceId });
  return withUsageCollector(usage, () => withTrace('flight-agent', async () => ({
    ...await runFlightAgentInternal({ ...options, requestId, traceId, sessionId }),
    usage: usage.snapshot(),
  }), { traceId }));
}

async function runFlightAgentInternal({
  input,
  requestId = randomUUID(),
  sessionId = 'default',
  context,
  now = new Date(),
  timeZone,
}: RunFlightAgentOptions) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const session = getFlightAgentSession(sessionId);
  const appContext = getFlightAgentContext(sessionId, context);
  appContext.currentUserMessage = input;
  const turnToolLogStart = appContext.toolCallLog.length;
  // Captured before preparation, which may clear them when no search exists yet.
  const suggestionsShownBefore = [...appContext.flight.suggestedQuestions];

  prepareFlightAgentTurnContext(appContext, {
    requestId,
    sessionId,
  });
  beginFlightSuggestionTurn(appContext, {
    flightRan: true,
    previousSuggestions: suggestionsShownBefore,
  });
  const requestClock = createRequestClock({
    now,
    timeZone,
  });
  const requestContext = createRequestContext(appContext, requestClock);
  const previousPricePrediction = appContext.flight.lastPricePrediction;
  const previousSearchKey = appContext.flight.searchKey || null;

  log('info', 'flight_agent.request', { requestId, sessionId, input });

  try {
    const result = await flightAgentRunner.run(FlightAgent, input, {
      context: requestContext,
      maxTurns: flightAgentConfig.maxTurns,
      session,
    });

    const latencyMs = Date.now() - startedAt;
    const guardedOutput = sanitizePricePredictionFailureResponse({
      output: result.finalOutput || '',
      context: appContext,
      currentUserMessage: input,
      previousPricePrediction,
      previousSearchKey,
    });
    const output = guardedOutput.output;
    finalizeFlightSuggestedQuestions(appContext);

    log('info', 'flight_agent.response', {
      requestId,
      sessionId,
      latencyMs,
      output,
      pricePredictionFailureGuardrail: guardedOutput.guardrail,
    });

    return {
      requestId,
      sessionId,
      output,
      latencyMs,
      context: appContext,
      pricePredictionFailureGuardrail: guardedOutput.guardrail,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startedAt;
    // A run that failed before its final tool call left suggestions written for
    // an earlier turn; drop them rather than show them against this one.
    finalizeFlightSuggestedQuestions(appContext);
    const completedCoreFallback = error instanceof MaxTurnsExceededError
      ? buildFlightCoreSuccessFallback(appContext, turnToolLogStart)
      : null;
    const message =
      completedCoreFallback || (error instanceof MaxTurnsExceededError
        ? 'I could not finish this request within the tool limit. Please share only the missing flight detail you want me to use.'
        : 'I am having trouble processing that flight request right now. Please try again.');

    log('error', 'flight_agent.error', {
      requestId,
      sessionId,
      latencyMs,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return {
      requestId,
      sessionId,
      output: message,
      latencyMs,
      context: appContext,
      error: !completedCoreFallback,
      recoveredFromMaxTurns: Boolean(completedCoreFallback),
    };
  }
}
