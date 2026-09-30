import { ensureFlightRuntimeContext } from '../../agents/flight/context/flight-context.js';
import {
  restoreFlightSearchRuntime,
  snapshotFlightSearchRuntime,
} from '../../agents/flight/context/search-runtime-store.js';
import type {
  FlightAppContext,
  FlightContext,
} from '../../agents/flight/types.js';
import type { PersistedRuntimeContext, SummaryContext } from './types.js';

type MutableRecord = Record<string, any>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

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

function endpointForTripPlanner(endpoint: MutableRecord = {}) {
  return {
    city: text(endpoint.city),
    iata: text(endpoint.iata)?.toUpperCase() || null,
  };
}

function tripPlannerSummary(summary: SummaryContext, existing: MutableRecord = {}) {
  return {
    pax: number(summary.passengerData?.total),
    budget: clone(summary.budget || createEmptySummaryContext().budget),
    origin: endpointForTripPlanner(summary.origin),
    destination: endpointForTripPlanner(summary.destination),
    tripType: Array.isArray(summary.tripType) ? [...summary.tripType] : [],
    outbound_date: text(summary.outbound_date),
    return_date: text(summary.return_date),
    duration_days: number(summary.duration_days),
    upcomingEvents: Array.isArray(existing.upcomingEvents) ? clone(existing.upcomingEvents) : [],
    placesOfInterest: Array.isArray(summary.placesOfInterest)
      ? clone(summary.placesOfInterest)
      : [],
    suggestedQuestions: Array.isArray(existing.suggestedQuestions)
      ? [...existing.suggestedQuestions]
      : [],
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
    flight.passengerData = clone(summary.passengerData) as typeof flight.passengerData;
  }
}

export function hydrateGatewayContext(
  runtimeContext: Partial<PersistedRuntimeContext> = {},
  summaryContext: SummaryContext = createEmptySummaryContext(),
): FlightAppContext {
  const context = ensureFlightRuntimeContext(
    clone(runtimeContext || {}) as MutableRecord,
  ) as FlightAppContext;
  const summary = clone(summaryContext || createEmptySummaryContext());
  hydrateFlightFromSummary(context, summary);
  context.summaryContext = tripPlannerSummary(summary, context.summaryContext);
  context.tripPlanner = context.tripPlanner || {};

  const searchKey = context.flight.searchKey;
  if (searchKey && runtimeContext.flightSearchRuntime) {
    restoreFlightSearchRuntime(searchKey, runtimeContext.flightSearchRuntime);
  }
  return context;
}

function durableTripPlannerState(value: MutableRecord = {}) {
  const state = clone(value || {});
  delete state.currentUserMessage;
  delete state.turnState;
  delete state.planningBrief;
  return state;
}

export function snapshotGatewayContext(
  context: Partial<FlightAppContext> = {},
): PersistedRuntimeContext {
  const flight = clone((context.flight || {}) as FlightContext);
  return {
    flight,
    tripPlanner: durableTripPlannerState(context.tripPlanner as MutableRecord),
    flightSearchRuntime: snapshotFlightSearchRuntime(flight.searchKey),
  } as PersistedRuntimeContext;
}
