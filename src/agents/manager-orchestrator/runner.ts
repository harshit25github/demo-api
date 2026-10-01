import { generateTraceId, Runner, setDefaultOpenAIKey, withTrace } from '@openai/agents';
import type { Session } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { assertOpenAIConfig, flightAgentConfig } from '../flight/config.js';
import {
  ensureFlightRuntimeContext,
  prepareFlightAgentTurnContext,
} from '../flight/context/flight-context.js';
import {
  beginFlightSuggestionTurn,
  finalizeFlightSuggestedQuestions,
} from '../flight/tools/suggested-questions-tool.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { createManagerAgent } from './agent.js';
import {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
} from '../manager/tools.js';
import { log } from '../../shared/logging/logger.js';
import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import type { FlightAppContext } from '../flight/types.js';

export { sanitizeGatewayOutputForFinalAgent } from './output-guardrail.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey!);

type DynamicRecord = Record<string, any>;

export interface ManagerRunOptions {
  input: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  context?: unknown;
  maxTurns?: number;
  now?: Date | string | number;
  timeZone?: string;
  workflowName?: string;
  /** Model history for the conversation, e.g. an OpenAIConversationsSession. */
  session?: Session;
  /** Cancels the turn when the client disconnects. */
  signal?: AbortSignal;
  /**
   * Substitute Runner, for benchmarks that need different run configuration
   * (see scripts/evaluate-session-optimization.ts). Production uses the default.
   */
  runner?: Pick<Runner, 'run'>;
}

/**
 * The one Runner the Manager turn uses.
 *
 * `maxFunctionToolConcurrency: 1` keeps specialists serial. They share one
 * application context, and Trip Planner in particular scopes its whole turn
 * inside it, so two specialists running at once would interleave that state.
 * `parallelToolCalls: false` already asks the provider not to emit overlapping
 * calls; this enforces it locally even if it does.
 */
export const mainChatRunner = new Runner({
  toolExecution: { maxFunctionToolConcurrency: 1 },
  workflowName: 'travel-manager',
  traceIncludeSensitiveData: true,
});

/**
 * Compose the final answer from the Manager's text plus this turn's outcomes.
 *
 * Render references are resolved here, so bulk content (a Trip itinerary) is
 * inserted exactly once and never travelled through the Manager's own context.
 */
export function finalizeManagerAgentResult({
  result,
  appContext,
  turnState,
  startedAt = Date.now(),
}: {
  result: DynamicRecord;
  appContext: FlightAppContext;
  turnState: ReturnType<typeof createManagerTurnState>;
  startedAt?: number;
}) {
  const composed = finalizeManagerOutput(String(result?.finalOutput || ''), turnState);
  const sanitized = sanitizeNoLinks(composed.output, { preserveCardImageUrls: true });
  assertNoLinks(sanitized.text, { allowCardImageUrls: true });
  return {
    output: sanitized.text,
    finalAgentName: 'Manager Agent',
    context: appContext,
    latencyMs: Date.now() - startedAt,
    specialistsUsed: composed.specialistsUsed,
    renderFlightOptions: composed.renderFlightOptions,
    lastResponseId: result?.lastResponseId || null,
  };
}

export function buildGatewayContext({
  context,
  input,
  requestId,
  sessionId,
}: {
  context?: unknown;
  input: string;
  requestId: string;
  sessionId: string;
}): FlightAppContext {
  const appContext = ensureFlightRuntimeContext(context);
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  appContext.currentUserMessage = String(input || '');
  appContext.tripPlanner =
    appContext.tripPlanner && typeof appContext.tripPlanner === 'object'
      ? appContext.tripPlanner
      : {};
  appContext.tripPlanner.currentUserMessage = String(input || '');
  // Captured before preparation, which may clear them when no search exists yet.
  const suggestionsShownBefore = [...appContext.flight.suggestedQuestions];
  prepareFlightAgentTurnContext(appContext, {
    requestId,
    sessionId,
  });
  // Flight marks the turn when it actually runs; see manager/specialists/flight.ts.
  beginFlightSuggestionTurn(appContext, {
    flightRan: false,
    previousSuggestions: suggestionsShownBefore,
  });
  return appContext;
}

/**
 * Run one Manager turn.
 *
 * This is the production path. One nonstream `Runner.run()`: the Manager calls
 * the specialists it needs as SDK agent tools, then makes its own final model
 * call, and the composed answer is returned whole. There is no stream-resume
 * loop and no partial-answer reconstruction — a terminal failure throws and the
 * caller reports it.
 */
export async function runGatewayAgent(options: ManagerRunOptions) {
  const requestId = options.requestId ?? randomUUID();
  const traceId = options.traceId ?? generateTraceId();
  const sessionId = options.sessionId ?? 'default';
  return runManagerTurn({ ...options, requestId, traceId, sessionId });
}

async function runManagerTurn({
  input,
  requestId = randomUUID(),
  traceId = generateTraceId(),
  sessionId = 'default',
  context,
  session,
  signal,
  maxTurns = 12,
  now = new Date(),
  timeZone,
  runner = mainChatRunner,
}: ManagerRunOptions) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const appContext = buildGatewayContext({
    context,
    input,
    requestId,
    sessionId,
  });
  const requestClock = createRequestClock({ now, timeZone });
  const requestContext = createRequestContext(appContext, requestClock);
  const managerTurn = createManagerTurnState(appContext, requestId);
  const managerAgent = createManagerAgent(createManagerTools(managerTurn));

  log('info', 'manager_agent.request', { requestId, traceId, sessionId, input });

  let result: DynamicRecord;
  try {
    result = await withTrace(
      'travel-manager',
      () => runner.run(managerAgent, input, {
        context: requestContext,
        maxTurns,
        session,
        signal,
      }),
      { traceId, metadata: { requestId } },
    );
  } finally {
    // Also on failure: the caller persists this context, and a Flight run that
    // died before its final tool call must not leave last turn's suggestions.
    finalizeFlightSuggestedQuestions(appContext);
  }

  const finalized = finalizeManagerAgentResult({
    result,
    appContext,
    turnState: managerTurn,
    startedAt,
  });

  log('info', 'manager_agent.response', {
    requestId,
    traceId,
    sessionId,
    specialistsUsed: finalized.specialistsUsed,
    latencyMs: finalized.latencyMs,
  });

  return {
    requestId,
    traceId,
    sessionId,
    ...finalized,
    result,
  };
}
