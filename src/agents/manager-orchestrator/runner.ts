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
import { log } from '../../shared/logging/logger.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { modelDeadlineProvider } from '../../shared/runtime/model-deadline.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { ManagerAgent } from './agent.js';
import { combineSuggestedQuestions } from './suggested-questions.js';
import { assertNoLinks, assertOnlyIssuedLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import { cityPhotosFor } from '../../shared/media/city-photos.js';
import type { CityPhoto, DestinationRef } from '../../shared/media/city-photos.js';
import { linkCityPhotos } from '../../shared/text/city-photo-links.js';
import type { TripPlannerV2State } from '../trip-planner-v2/schema.js';
import type { FlightAppContext } from '../flight/types.js';

assertOpenAIConfig();

/** The destinations of a Trip turn: the options Trip suggested this turn, if it suggested any, and the plan's city. */
function tripDestinations(trip: TripPlannerV2State | undefined, optionsBefore: unknown): DestinationRef[] {
  const options = trip?.options && trip.options !== optionsBefore ? trip.options : [];
  const planCity = trip?.plan?.destination;
  return [
    ...options.map((option) => ({ iata: option.code, city: option.city })),
    ...(planCity ? [{ iata: planCity.iata, city: planCity.city }] : []),
  ];
}

/** How long a finished reply waits for its photos before it goes out without links (plan section 11). */
const PHOTO_LOOKUP_TIMEOUT_MS = 1000;

/** The photos a lookup found, or none when it fails or runs past timeoutMs: photos never fail a reply or hold it up for long. */
async function photosOrNone(lookup: () => Promise<CityPhoto[]>, timeoutMs: number, requestId: string): Promise<CityPhoto[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => { timer = setTimeout(resolve, timeoutMs, null); });
  try {
    const photos = await Promise.race([Promise.resolve().then(lookup), timedOut]);
    if (!photos) log('warn', 'manager.photo_lookup_timed_out', { requestId, timeoutMs });
    return photos ?? [];
  } catch (error) {
    log('warn', 'manager.photo_lookup_failed', {
      requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

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
  /** Substitute photo lookup and wait, for tests. Production uses cityPhotosFor and PHOTO_LOOKUP_TIMEOUT_MS. */
  photoLookup?: typeof cityPhotosFor;
  photoTimeoutMs?: number;
}

/**
 * The one Runner the Manager turn uses.
 *
 * Independent Flight and Trip tasks may overlap. Flight owns flight state and
 * its tool log; Trip owns the summary and plan. The Manager awaits prerequisites
 * and combines each specialist's work into one scoped call per batch.
 */
export const mainChatRunner = new Runner({
  modelProvider: modelDeadlineProvider,
  modelSettings: { retry: { maxRetries: 0 } },
  toolExecution: { maxFunctionToolConcurrency: 2 },
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
    photoLookup = cityPhotosFor, photoTimeoutMs = PHOTO_LOOKUP_TIMEOUT_MS,
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
  // Trip stores a new chip list each time its result is saved, so a different list means Trip ran.
  const tripChipsBefore = appContext.tripPlanner?.suggestions;
  // Likewise its options, which are replaced only when Trip suggests destinations.
  const tripOptionsBefore = appContext.tripPlanner?.options;
  const requestClock = createRequestClock({ now, timeZone });
  const requestContext = createRequestContext(appContext, requestClock);
  let result;
  let flightTurn: ReturnType<typeof finalizeFlightSuggestedQuestions>;
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
    flightTurn = finalizeFlightSuggestedQuestions(appContext);
  }

  const reply = String(result.finalOutput ?? '');
  const sanitized = sanitizeNoLinks(reply);
  assertNoLinks(sanitized.text);
  const tripChips = appContext.tripPlanner?.suggestions;
  // Photo links on the destination cities of a Trip turn (plan section 11). Only the text the client gets and the
  // chat stores is linked; the Manager's own conversation history keeps its plain reply.
  const tripRan = tripChips !== tripChipsBefore && Array.isArray(tripChips);
  const destinations = tripRan ? tripDestinations(appContext.tripPlanner, tripOptionsBefore) : [];
  const photos = destinations.length ? await photosOrNone(() => photoLookup(destinations), photoTimeoutMs, requestId) : [];
  const linked = linkCityPhotos(sanitized.text, photos);
  assertOnlyIssuedLinks(linked.text, linked.issued);
  const shownChips = appContext.summaryContext?.suggestedQuestions;
  appContext.summaryContext = {
    ...appContext.summaryContext,
    suggestedQuestions: combineSuggestedQuestions({
      flight: flightTurn.flightRan ? appContext.flight.suggestedQuestions : null,
      trip: tripRan ? tripChips : null,
      previous: Array.isArray(shownChips) ? shownChips : [],
      reply: sanitized.text,
    }),
  };
  return {
    requestId,
    traceId,
    sessionId,
    output: linked.text,
    finalAgentName: ManagerAgent.name,
    context: appContext,
    latencyMs: Date.now() - startedAt,
    lastResponseId: result.lastResponseId || null,
    result,
  };
}
