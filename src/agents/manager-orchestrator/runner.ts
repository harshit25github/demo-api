import { generateTraceId, Runner, withTrace } from '@openai/agents';
import type { Session } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { assertOpenAIConfig } from '../flight/config.js';
import {
  ensureFlightRuntimeContext,
  prepareFlightAgentTurnContext,
} from '../flight/context/flight-context.js';
import {
  beginFlightSuggestionTurn,
  finalizeFlightSuggestedQuestions,
} from '../flight/tools/suggested-questions-tool.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { modelDeadlineProvider } from '../../shared/runtime/model-deadline.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { ManagerAgent } from './agent.js';
import { keepApprovedPhotos } from '../trip-planner-v2/photos.js';
import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import type { FlightAppContext } from '../flight/types.js';

assertOpenAIConfig();

export interface ManagerRunOptions {
  input: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  context?: unknown;
  maxTurns?: number;
  now?: Date | string | number;
  timeZone?: string;
  /** Model history for the conversation, e.g. an OpenAIConversationsSession. */
  session?: Session;
  /** Cancels the turn when the client disconnects. */
  signal?: AbortSignal;
  /** Consume SDK model events internally; the API still sends one final answer. */
  stream?: boolean;
  /** Substitute Runner, for tests that fake the run. Production uses the default. */
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
  modelProvider: modelDeadlineProvider,
  modelSettings: { retry: { maxRetries: 0 } },
  toolExecution: { maxFunctionToolConcurrency: 1 },
  workflowName: 'travel-manager',
  traceIncludeSensitiveData: true,
});

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
 * The Manager calls specialists as SDK agent tools and returns its final answer
 * whole. Optional SDK streaming is consumed here, before the existing final
 * output sanitizer. Neither mode restarts the run or reconstructs partial text.
 */
export async function runGatewayAgent(options: ManagerRunOptions) {
  const requestId = options.requestId ?? randomUUID();
  const traceId = options.traceId ?? generateTraceId();
  const sessionId = options.sessionId ?? 'default';
  const {
    input, context, session, signal, stream = false, maxTurns = 12,
    now = new Date(), timeZone, runner = mainChatRunner,
  } = options;
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
  let result;
  try {
    result = await withTrace(
      'travel-manager',
      async () => {
        const runOptions = { context: requestContext, maxTurns, session, signal };
        if (!stream) return runner.run(ManagerAgent, input, runOptions);
        const streamed = await runner.run(ManagerAgent, input, { ...runOptions, stream: true });
        // Observe completion immediately: the iterator and completed promise
        // can both reject for the same failure.
        void streamed.completed.catch(() => undefined);
        for await (const _event of streamed) { /* Keep partial/raw text private. */ }
        await streamed.completed;
        if (streamed.cancelled) {
          signal?.throwIfAborted();
          throw new Error('Manager run was cancelled.');
        }
        return streamed;
      },
      { traceId, metadata: { requestId } },
    );
  } finally {
    // Also on failure: the caller persists this context, and a Flight run that
    // died before its final tool call must not leave last turn's suggestions.
    finalizeFlightSuggestedQuestions(appContext);
  }

  // The Manager writes trip cards and days from Trip's report; their photos must be ones the app supplied.
  const photos = (appContext.tripPlanner as { photos?: Record<string, string> } | undefined)?.photos;
  const reply = keepApprovedPhotos(String(result.finalOutput ?? ''), photos);
  const sanitized = sanitizeNoLinks(reply, { preserveCardImageUrls: true });
  assertNoLinks(sanitized.text, { allowCardImageUrls: true });
  return {
    requestId,
    traceId,
    sessionId,
    output: sanitized.text,
    finalAgentName: ManagerAgent.name,
    context: appContext,
    latencyMs: Date.now() - startedAt,
    lastResponseId: result.lastResponseId || null,
    result,
  };
}
