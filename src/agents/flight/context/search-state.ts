import type { FlightContext, PassengerData } from '../types.js';

type MutableRecord = Record<string, any>;
const endpointDetails = { iata: 'airportIATA', airport_name: 'airportName' } as const;

export function isRecord(value: unknown): value is MutableRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized) return normalized;
  }
  return null;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed === null || parsed < 0 ? fallback : Math.trunc(parsed);
}

function normalizeLocation(value: unknown): string | null {
  if (typeof value === 'string') {
    return nonEmptyString(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  return firstNonEmptyString(
    value.iata,
    value.IATA,
    value.airportIATA,
    value.code,
    value.Code,
    value.city,
    value.City,
    value.userCity,
    value.name,
    value.Name,
  );
}

export function normalizeResolvedLocation(value: unknown, fallbackLocation: unknown = null) {
  const source = isRecord(value) ? value : {};
  const fallback = nonEmptyString(fallbackLocation);
  const fallbackIata = fallback && /^[A-Za-z]{3}$/.test(fallback) ? fallback.toUpperCase() : null;
  return {
    userCity: firstNonEmptyString(source.userCity, source.city, fallback),
    airportIATA: firstNonEmptyString(source.airportIATA, source.iata, fallbackIata),
    ...(source.airportName != null ? { airportName: nonEmptyString(source.airportName) } : {}),
  };
}

function resolvedLocationForSearch(value: unknown, location: unknown) {
  const current = normalizeResolvedLocation(value);
  const userLocation = nonEmptyString(location);
  if (!userLocation) {
    return current;
  }

  const isIata = /^[A-Za-z]{3}$/.test(userLocation);
  const sameUserLocation =
    current.userCity?.toLowerCase() === userLocation.toLowerCase();
  return {
    userCity: userLocation,
    airportIATA: isIata
      ? userLocation.toUpperCase()
      : sameUserLocation
        ? current.airportIATA
        : null,
  };
}

function normalizeTripType(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value.find((item) => nonEmptyString(item)) : value;
  const normalized = nonEmptyString(candidate)?.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'roundtrip' || normalized === 'return') {
    return 'roundtrip';
  }
  if (normalized === 'multicity') {
    return 'multicity';
  }
  if (normalized === 'oneway' || normalized === 'single') {
    return 'oneway';
  }
  return null;
}

function normalizeCabinClass(value: unknown): string | null {
  const normalized = nonEmptyString(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  return normalized && ['economy', 'premium_economy', 'business', 'first'].includes(normalized)
    ? normalized
    : null;
}

function createDefaultPassengerData(): PassengerData {
  return {
    total: 1,
    adults: 1,
    seniors: 0,
    children: 0,
    lapInfants: 0,
    seatInfants: 0,
    childrenAges: [],
  };
}

export function normalizePassengerData(value: unknown, pax: unknown = null): PassengerData {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return {
      ...createDefaultPassengerData(),
      total: value,
      adults: value,
    };
  }

  const source = isRecord(value) ? value : {};
  const fallbackPax = typeof pax === 'number' && Number.isInteger(pax) && pax > 0 ? pax : null;
  const adults = Math.max(1, nonNegativeInteger(source.adults ?? source.adult, fallbackPax || 1));
  const seniors = nonNegativeInteger(source.seniors ?? source.senior);
  const children = nonNegativeInteger(source.children ?? source.child);
  const legacyInfants = nonNegativeInteger(source.infants ?? source.infant);
  const lapInfants = nonNegativeInteger(source.lapInfants, legacyInfants);
  const seatInfants = nonNegativeInteger(source.seatInfants);
  const calculatedTotal = adults + seniors + children + lapInfants + seatInfants;
  const suppliedTotal = nonNegativeInteger(source.total, calculatedTotal);

  return {
    total: Math.max(calculatedTotal, suppliedTotal, 1),
    adults,
    seniors,
    children,
    lapInfants,
    seatInfants,
    childrenAges: Array.isArray(source.childrenAges) ? [...source.childrenAges] : [],
  };
}

function passengersForSearch(passengerData: PassengerData) {
  return {
    adults: passengerData.adults,
    children: passengerData.children,
    infants: passengerData.lapInfants + passengerData.seatInfants,
  };
}

function normalizeOnd(ond: unknown): MutableRecord | null {
  if (!isRecord(ond)) {
    return null;
  }
  const normalized: MutableRecord = {
    origin: normalizeLocation(ond.origin),
    destination: normalizeLocation(ond.destination),
    outbound_date: firstNonEmptyString(
      ond.outbound_date,
      ond.outboundDate,
      ond.departureDate,
      ond.departDate,
      ond.date,
    ),
    return_date: firstNonEmptyString(
      ond.return_date,
      ond.returnDate,
      ond.inbound_date,
      ond.inboundDate,
    ),
  };
  for (const endpoint of ['origin', 'destination']) {
    for (const suffix of Object.keys(endpointDetails)) {
      const key = `${endpoint}_${suffix}`;
      if (key in ond) normalized[key] = nonEmptyString(ond[key]);
    }
  }
  return Object.values(normalized).some((item) => item !== null) ? normalized : null;
}

export function partialFlightSearchState(source: unknown): MutableRecord {
  if (!isRecord(source)) {
    return {};
  }

  const rawSegments = Array.isArray(source.onds)
    ? source.onds
    : Array.isArray(source.segments)
      ? source.segments
      : [];
  const onds = rawSegments.map(normalizeOnd).filter(Boolean);
  const firstOnd = onds[0];
  const lastOnd = onds.at(-1);
  const tripType = normalizeTripType(source.trip_type ?? source.tripType);
  const returnDate = firstNonEmptyString(
    source.return_date,
    source.returnDate,
    source.inbound_date,
    source.inboundDate,
    firstOnd?.return_date,
  );
  const passengerSource = source.passengerData ?? source.passengers ?? source.pax;
  const hasPassengerSource = passengerSource !== undefined && passengerSource !== null;

  const state: MutableRecord = {
    onds,
    origin:
      normalizeLocation(source.origin) ||
      firstOnd?.origin ||
      normalizeLocation(source.resolvedOrigin) ||
      null,
    destination:
      normalizeLocation(source.destination) ||
      lastOnd?.destination ||
      normalizeLocation(source.resolvedDestination) ||
      null,
    outbound_date:
      firstNonEmptyString(
        source.outbound_date,
        source.outboundDate,
        source.departureDate,
        source.departDate,
      ) || firstOnd?.outbound_date || null,
    return_date: tripType === 'oneway' ? null : returnDate,
    trip_type: tripType,
    passengers: hasPassengerSource
      ? passengersForSearch(normalizePassengerData(passengerSource, source.pax))
      : null,
    cabin_class: normalizeCabinClass(
      source.cabin_class ?? source.cabinClass ?? source.coach,
    ),
  };
  for (const endpoint of ['origin', 'destination']) {
    const segment = endpoint === 'origin' ? firstOnd : lastOnd;
    const resolved = source[endpoint === 'origin' ? 'resolvedOrigin' : 'resolvedDestination'];
    const sameCity = resolved?.userCity?.toLowerCase() === state[endpoint]?.toLowerCase();
    for (const [suffix, resolvedKey] of Object.entries(endpointDetails)) {
      const key = `${endpoint}_${suffix}`;
      if (key in source) state[key] = nonEmptyString(source[key]);
      else if (segment && key in segment) state[key] = segment[key];
      // Legacy code-only route values remain readable without duplicating the
      // same code into a name/code pair. New separated payloads are preserved above.
      else if (sameCity && state[endpoint]?.toUpperCase() !== resolved?.airportIATA &&
        nonEmptyString(resolved?.[resolvedKey])) state[key] = nonEmptyString(resolved[resolvedKey]);
    }
  }
  return state;
}

function mergeOnd(base: MutableRecord = {}, update: MutableRecord = {}) {
  const merged: MutableRecord = {
    origin: update.origin || base.origin || null,
    destination: update.destination || base.destination || null,
    outbound_date: update.outbound_date || base.outbound_date || null,
    return_date: update.return_date || base.return_date || null,
  };
  for (const endpoint of ['origin', 'destination']) {
    for (const suffix of Object.keys(endpointDetails)) {
      const key = `${endpoint}_${suffix}`;
      if (key in update) merged[key] = update[key];
      else if (key in base) {
        const changedCity = update[endpoint] && update[endpoint] !== base[endpoint];
        const changedAirport = `${endpoint}_iata` in update && update[`${endpoint}_iata`] !== base[`${endpoint}_iata`];
        merged[key] = changedCity || (suffix === 'airport_name' && changedAirport) ? null : base[key];
      }
    }
  }
  return merged;
}

function synchronizeState(state: MutableRecord): MutableRecord {
  const synchronized: MutableRecord = {
    ...state,
    onds: Array.isArray(state.onds) ? state.onds.map((ond) => ({ ...ond })) : [],
  };

  if (
    synchronized.onds.length === 0 &&
    (synchronized.origin || synchronized.destination || synchronized.outbound_date)
  ) {
    synchronized.onds.push({
      origin: synchronized.origin || null,
      destination: synchronized.destination || null,
      outbound_date: synchronized.outbound_date || null,
      return_date: synchronized.return_date || null,
    });
  }

  if (synchronized.onds.length > 0) {
    const firstOnd = synchronized.onds[0];
    const lastOnd = synchronized.onds.at(-1);
    synchronized.origin ||= firstOnd.origin || null;
    synchronized.destination ||= lastOnd.destination || null;
    synchronized.outbound_date ||= firstOnd.outbound_date || null;
    synchronized.return_date =
      synchronized.trip_type === 'oneway'
        ? null
        : synchronized.return_date || firstOnd.return_date || null;
    firstOnd.origin = synchronized.origin || firstOnd.origin || null;
    lastOnd.destination = synchronized.destination || lastOnd.destination || null;
    for (const endpoint of ['origin', 'destination']) {
      const segment = endpoint === 'origin' ? firstOnd : lastOnd;
      for (const suffix of Object.keys(endpointDetails)) {
        const key = `${endpoint}_${suffix}`;
        if (key in synchronized) segment[key] = synchronized[key];
        else if (key in segment) synchronized[key] = segment[key];
      }
    }
    firstOnd.outbound_date = synchronized.outbound_date || firstOnd.outbound_date || null;
    firstOnd.return_date = synchronized.return_date;
  }

  if (synchronized.return_date && synchronized.trip_type !== 'multicity') {
    synchronized.trip_type = 'roundtrip';
  }
  return synchronized;
}

export function mergeFlightSearchStates(
  base: MutableRecord = {},
  update: MutableRecord = {},
): MutableRecord {
  const merged: MutableRecord = {
    ...base,
    onds: Array.isArray(base.onds) ? base.onds.map((ond) => ({ ...ond })) : [],
  };

  if (Array.isArray(update.onds) && update.onds.length > 0) {
    const count = Math.max(merged.onds.length, update.onds.length);
    merged.onds = Array.from({ length: count }, (_, index) =>
      mergeOnd(merged.onds[index], update.onds[index]),
    );
  }
  for (const key of ['origin', 'destination']) {
    for (const suffix of Object.keys(endpointDetails)) {
      const detail = `${key}_${suffix}`;
      if (detail in update) merged[detail] = update[detail];
      else if (detail in base) {
        const changedCity = update[key] && update[key] !== base[key];
        const changedAirport = `${key}_iata` in update && update[`${key}_iata`] !== base[`${key}_iata`];
        if (changedCity || (suffix === 'airport_name' && changedAirport)) merged[detail] = null;
      }
    }
    if (update[key]) {
      merged[key] = update[key];
    }
  }
  if (update.trip_type) {
    merged.trip_type = update.trip_type;
  }
  merged.outbound_date = update.outbound_date || base.outbound_date || null;
  merged.return_date =
    update.trip_type === 'oneway' ? null : update.return_date || base.return_date || null;
  if (update.passengers) {
    merged.passengers = { ...update.passengers };
  }
  if (update.cabin_class) {
    merged.cabin_class = update.cabin_class;
  }
  return synchronizeState(merged);
}

function getSearchCandidates(context: MutableRecord): MutableRecord[] {
  const flight = isRecord(context?.flight) ? context.flight : {};
  return [
    context,
    context?.summary,
    context?.searchParams,
    context?.lastSearch,
    flight.summary,
    flight.lastSearch,
    flight,
  ].filter(isRecord);
}

export function readFlightSearchState(context: MutableRecord): MutableRecord {
  return getSearchCandidates(context).reduce(
    (state, candidate) => mergeFlightSearchStates(state, partialFlightSearchState(candidate)),
    {},
  );
}

function defaultSegments() {
  return [{ date: '', origin: '', destination: '' }];
}

export function flightSegmentsFromSearch(searchState: MutableRecord) {
  const segments = (searchState.onds || []).map((ond: MutableRecord) => ({
    date: ond.outbound_date || '',
    origin: ond.origin || '',
    destination: ond.destination || '',
    ...Object.fromEntries(['origin', 'destination'].flatMap((endpoint) =>
      Object.keys(endpointDetails).map((suffix) => `${endpoint}_${suffix}`)
        .filter((key) => key in ond).map((key) => [key, ond[key]]))),
  }));
  return segments.length > 0 ? segments : defaultSegments();
}

export function writeFlightSearchState(
  flight: FlightContext,
  state: MutableRecord,
): FlightContext {
  const synchronized = synchronizeState(state);
  const previousPassengerData = normalizePassengerData(flight.passengerData, flight.pax);
  const passengers = synchronized.passengers || passengersForSearch(previousPassengerData);
  const passengerData = normalizePassengerData({
    ...passengers,
    seniors: previousPassengerData.seniors,
    childrenAges: previousPassengerData.childrenAges,
  });
  const origin = synchronized.origin || null;
  const destination = synchronized.destination || null;

  flight.tripType = synchronized.trip_type || flight.tripType || 'oneway';
  flight.cabinClass = synchronized.cabin_class || flight.cabinClass || 'economy';
  flight.outboundDate = synchronized.outbound_date || null;
  flight.inboundDate = flight.tripType === 'oneway' ? '' : synchronized.return_date || '';
  flight.segments = flightSegmentsFromSearch(synchronized);
  flight.passengerData = passengerData;
  flight.pax = passengerData.total;
  flight.resolvedOrigin = resolvedLocationForSearch(flight.resolvedOrigin, origin);
  flight.resolvedDestination = resolvedLocationForSearch(
    flight.resolvedDestination,
    destination,
  );
  for (const endpoint of ['origin', 'destination']) {
    const resolved = endpoint === 'origin' ? flight.resolvedOrigin : flight.resolvedDestination;
    for (const [suffix, resolvedKey] of Object.entries(endpointDetails)) {
      const key = `${endpoint}_${suffix}`;
      if (key in synchronized) resolved[resolvedKey] = synchronized[key];
    }
  }
  return flight;
}
