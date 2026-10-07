import type { FlightContext } from '../types.js';
import { ensureFlightRuntimeContext } from './flight-context.js';
import { knownCityIataCode } from '../../../shared/travel/city-codes.js';

type MutableRecord = Record<string, unknown>;

function compactSegments(segments: FlightContext['segments']) {
  return segments.filter((segment) => segment.origin || segment.destination || segment.date);
}

export function buildActiveSearchSummary(context: MutableRecord): string {
  const flight = ensureFlightRuntimeContext(context).flight;
  const summary = {
    segments: compactSegments(flight.segments),
    tripType: flight.tripType,
    outboundDate: flight.outboundDate,
    inboundDate: flight.inboundDate || null,
    passengerData: flight.passengerData,
    cabinClass: flight.cabinClass,
    resolvedOrigin: flight.resolvedOrigin,
    resolvedDestination: flight.resolvedDestination,
    bookingStatus: flight.bookingStatus,
  };
  const hasSearchDetails =
    summary.segments.length > 0 ||
    summary.outboundDate ||
    summary.resolvedOrigin.userCity ||
    summary.resolvedDestination.userCity;
  return hasSearchDetails ? JSON.stringify(summary) : 'none';
}

export function buildPricePredictionRouteSummary(context: MutableRecord): string {
  const flight = ensureFlightRuntimeContext(context).flight;
  const first = flight.segments[0];
  const last = flight.segments.at(-1) || first;
  const routeCode = (location: string | undefined, resolved: { userCity?: string | null; airportIATA?: string | null }) => {
    if (location && location.trim().toLowerCase() === resolved.userCity?.trim().toLowerCase()) {
      const confirmed = knownCityIataCode(resolved.airportIATA);
      if (confirmed) return confirmed;
    }
    const direct = knownCityIataCode(location);
    if (direct) return direct;
    if (location && location.trim().toLowerCase() !== resolved.userCity?.trim().toLowerCase()) return null;
    return knownCityIataCode(resolved.airportIATA);
  };
  const origin = routeCode(first?.origin, flight.resolvedOrigin);
  const destination = routeCode(last?.destination, flight.resolvedDestination);
  return origin && destination ? `${origin} to ${destination}` : 'unresolved';
}
