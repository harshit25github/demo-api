import { ensureFlightRuntimeContext } from '../../agents/flight/context/flight-context.js';
import {
  restoreFlightSearchRuntime,
  snapshotFlightSearchRuntime,
} from '../../agents/flight/context/search-runtime-store.js';
import type {
  FlightAppContext,
  FlightContext,
} from '../../agents/flight/types.js';
import { createClientSummary } from '../../agents/trip-planner-v2/client-summary.js';
import type { PersistedRuntimeContext, SummaryContext } from './types.js';

type MutableRecord = Record<string, any>;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

export function createEmptySummaryContext(): SummaryContext {
  return {
    origin: { city: null, iata: null },
    destination: { city: null, iata: null },
    outbound_date: null,
    return_date: null,
    duration_days: null,
    budget: {
      amount: null,
      currency: null,
      per_person: null,
      total: null,
    },
    tripType: [],
    placesOfInterest: [],
    passengerData: {
      total: null,
      adults: null,
      seniors: null,
      children: null,
      lapInfants: null,
      seatInfants: null,
      childrenAges: [],
    },
  };
}

function routeValue(endpoint: MutableRecord = {}) {
  return text(endpoint.iata)?.toUpperCase() || text(endpoint.city);
}

function hydrateFlightFromSummary(
  context: FlightAppContext,
  summary: SummaryContext,
): void {
  const flight = context.flight;
  const origin = routeValue(summary.origin);
  const destination = routeValue(summary.destination);
  const firstSegment = flight.segments?.[0] || { date: '', origin: '', destination: '' };
  const hasActiveSearch = Boolean(flight.searchKey);

  if (!firstSegment.origin && origin) firstSegment.origin = origin;
  if (!firstSegment.destination && destination) firstSegment.destination = destination;
  if (!firstSegment.date && summary.outbound_date) firstSegment.date = summary.outbound_date;
  flight.segments = [firstSegment, ...(flight.segments || []).slice(1)];

  if (!flight.outboundDate && summary.outbound_date) {
    flight.outboundDate = summary.outbound_date;
  }
  if (!flight.inboundDate && summary.return_date) {
    flight.inboundDate = summary.return_date;
  }

  const journeyType = summary.tripType?.find((value) =>
    ['oneway', 'roundtrip', 'multicity'].includes(value),
  );
  if (!hasActiveSearch && journeyType) {
    flight.tripType = journeyType;
  }

  if (!flight.resolvedOrigin?.userCity && summary.origin?.city) {
    flight.resolvedOrigin.userCity = summary.origin.city;
  }
  if (!flight.resolvedOrigin?.airportIATA && summary.origin?.iata) {
    flight.resolvedOrigin.airportIATA = summary.origin.iata;
  }
  if (!flight.resolvedDestination?.userCity && summary.destination?.city) {
    flight.resolvedDestination.userCity = summary.destination.city;
  }
  if (!flight.resolvedDestination?.airportIATA && summary.destination?.iata) {
    flight.resolvedDestination.airportIATA = summary.destination.iata;
  }

  const summaryPassengers = number(summary.passengerData?.total);
  if (!hasActiveSearch && summaryPassengers) {
    flight.pax = summaryPassengers;
    flight.passengerData = structuredClone(summary.passengerData) as typeof flight.passengerData;
  }
}

export function hydrateGatewayContext(
  runtimeContext: Partial<PersistedRuntimeContext> = {},
  summaryContext: SummaryContext = createEmptySummaryContext(),
): FlightAppContext {
  const context = ensureFlightRuntimeContext(
    structuredClone(runtimeContext || {}) as MutableRecord,
  ) as FlightAppContext;
  const summary = structuredClone(summaryContext || createEmptySummaryContext());
  // Legacy summaries seed old chats only; current runtime state may clear fields.
  if (!runtimeContext.summaryContext) hydrateFlightFromSummary(context, summary);
  // Trip keeps the client summary itself; an older chat's Trip-only copy (pax) converts to the client shape.
  context.summaryContext = createClientSummary(runtimeContext.summaryContext ?? summary);
  context.tripPlanner = context.tripPlanner || {};

  const searchKey = context.flight.searchKey;
  if (searchKey && runtimeContext.flightSearchRuntime) {
    restoreFlightSearchRuntime(searchKey, runtimeContext.flightSearchRuntime);
  }
  return context;
}

// The Trip state a later turn reads. The rest is rebuilt each time Trip runs,
// or only matters within one request.
const DURABLE_TRIP_PLANNER_FIELDS = [
  'dateHint',
  'options',
  'plan',
  'facts',
  'lastQuestion',
  'suggestions',
  'photos',
];

function durableTripPlannerState(value: MutableRecord = {}) {
  const state = value || {};
  return structuredClone(Object.fromEntries(
    DURABLE_TRIP_PLANNER_FIELDS.filter((field) => Object.hasOwn(state, field))
      .map((field) => [field, state[field]]),
  ));
}

export function snapshotGatewayContext(
  context: Partial<FlightAppContext> = {},
): PersistedRuntimeContext {
  const flight = structuredClone((context.flight || {}) as FlightContext);
  return {
    // Specialist-owned context must survive without post-turn extraction.
    summaryContext: structuredClone(context.summaryContext),
    flight,
    tripPlanner: durableTripPlannerState(context.tripPlanner as MutableRecord),
    flightSearchRuntime: snapshotFlightSearchRuntime(flight.searchKey),
  } as PersistedRuntimeContext;
}
