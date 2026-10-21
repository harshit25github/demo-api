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
import { boldLabelsOnly } from '../../shared/text/label-bold.js';
import { markPlaces } from '../../shared/text/place-marks.js';
import type { PlaceCandidate } from '../../shared/text/place-marks.js';
import type { TripPlannerV2State } from '../trip-planner-v2/schema.js';
import { dayPlaces } from '../trip-planner-v2/state.js';
import type { FlightAppContext } from '../flight/types.js';

assertOpenAIConfig();

/** The cities a reply may name: the options Trip suggested this turn, if it ran and suggested any, and the plan's city. */
function tripDestinations(trip: TripPlannerV2State | undefined, optionsBefore: unknown): DestinationRef[] {
  const options = trip?.options && trip.options !== optionsBefore ? trip.options : [];
  const planCity = trip?.plan?.destination;
  return [
    ...options.map((option) => ({ iata: option.code, city: option.city })),
    ...(planCity ? [{ iata: planCity.iata, city: planCity.city }] : []),
  ];
}

/** A flight search's route cities (plan 12.12, F2). */
function routeCities(flight: FlightAppContext['flight']): DestinationRef[] {
  const segment = flight.segments?.[0];
  return segment
    ? [{ iata: segment.origin_iata ?? null, city: segment.origin || null }, { iata: segment.destination_iata ?? null, city: segment.destination || null }]
    : [];
}

/** A city as a mark candidate under its own name and the inventory's names for it, with its photo when there is one. */
function cityCandidate(city: DestinationRef, photos: readonly CityPhoto[]): PlaceCandidate | null {
  const lower = (value: string | null | undefined) => String(value ?? '').trim().toLowerCase();
  const photo = photos.find((entry) => (city.iata && entry.codes.includes(city.iata.toUpperCase()))
    || [entry.name, ...entry.aliases].some((name) => lower(name) === lower(city.city)));
  const names = [...new Set([city.city, photo?.name, ...(photo?.aliases ?? [])].filter((name): name is string => !!name?.trim()))];
  return names.length ? { names, kind: 'city', photo: photo?.photo ?? null } : null;
}

/** The named places of the saved plan, by kind. Plans saved before kinds existed have plain names, which stay unmarked. */
function planPlaces(trip: TripPlannerV2State | undefined): PlaceCandidate[] {
  return (trip?.plan?.days ?? []).flatMap((day) => dayPlaces(day).flatMap((place) => (place.kind ? [{ names: [place.name], kind: place.kind, photo: null }] : [])));
}

/** The word "flight" or "flights", marked with the flight icon on a turn that ran a flight search (plan 12.12). */
const FLIGHTS: PlaceCandidate = { names: ['flights', 'flight'], kind: 'flight', photo: null };

/** How long a finished reply waits for its photos before it goes out with marks but no photos (plan section 11). */
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
  /** Substitute city photo lookup and wait, for tests. Production uses cityPhotosFor and PHOTO_LOOKUP_TIMEOUT_MS. */
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
  // Place marks (plan 12.4 and 12.12): the plan's city and places whenever there is a plan, the options Trip suggested
  // this turn, and the route's cities and the flights on a flight search turn. Bold stays only on line labels. Only the
  // text the client gets and the chat stores changes; the Manager's own conversation history keeps its plain reply.
  const tripRan = tripChips !== tripChipsBefore && Array.isArray(tripChips);
  const flightSearched = flightTurn.flightRan && Boolean(appContext.flight.searchKey);
  const cities = [
    // A plan is marked on any turn, so a zoom answered from the last Trip report gets its marks too (R6).
    ...(tripRan || appContext.tripPlanner?.plan ? tripDestinations(appContext.tripPlanner, tripRan ? tripOptionsBefore : appContext.tripPlanner?.options) : []),
    ...(flightSearched ? routeCities(appContext.flight) : []),
  ];
  const photos = cities.length ? await photosOrNone(() => photoLookup(cities), photoTimeoutMs, requestId) : [];
  const marked = markPlaces(boldLabelsOnly(sanitized.text), [
    ...cities.flatMap((city) => cityCandidate(city, photos) ?? []),
    ...planPlaces(appContext.tripPlanner),
    ...(flightSearched ? [FLIGHTS] : []),
  ]);
  assertOnlyIssuedLinks(marked.text, marked.places.map((place) => `place:${place.ref}`));
  const shownChips = appContext.summaryContext?.suggestedQuestions;
  appContext.summaryContext = {
    ...appContext.summaryContext,
    suggestedQuestions: combineSuggestedQuestions({
      flight: flightTurn.flightRan ? appContext.flight.suggestedQuestions : null,
      trip: tripRan ? tripChips : null,
      previous: Array.isArray(shownChips) ? shownChips : [],
      reply: sanitized.text,
      used: input,
    }),
  };
  return {
    requestId,
    traceId,
    sessionId,
    output: marked.text,
    // The marks' kinds and photos, in reply order: done.places for the client, saved with the message.
    places: marked.places,
    finalAgentName: ManagerAgent.name,
    context: appContext,
    latencyMs: Date.now() - startedAt,
    lastResponseId: result.lastResponseId || null,
    result,
  };
}
