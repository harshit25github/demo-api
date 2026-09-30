type TripPlannerRecord = Record<string, any>;


const JOURNEY_TRIP_TYPES = new Set(['oneway', 'roundtrip', 'multicity']);
const PARTY_TRIP_TYPES = new Set(['solo', 'couple', 'family', 'friends', 'business']);
const PACE_TRIP_TYPES = new Set(['relaxed', 'balanced', 'fast-paced']);


function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizedTripTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(normalizedString).filter((item): item is string => Boolean(item)))];
}

function normalizedQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizedString).filter((item): item is string => Boolean(item)))];
}

function normalizedUpcomingEvents(value: unknown): unknown[] {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function normalizedPlacesOfInterest(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((place) => ({
      placeName: normalizedString(place?.placeName),
      description: normalizedString(place?.description),
    }))
    .filter((place) => place.placeName || place.description);
}

function createEndpoint(value: TripPlannerRecord = {}) {
  return {
    city: normalizedString(value?.city),
    iata: normalizedString(value?.iata)?.toUpperCase() || null,
  };
}

function createBudget(value: TripPlannerRecord = {}) {
  return {
    total: normalizedNumber(value?.total),
    amount: normalizedNumber(value?.amount),
    currency: normalizedString(value?.currency),
    per_person: normalizedBoolean(value?.per_person),
  };
}

export function createTripPlannerSummaryContext(value: TripPlannerRecord = {}) {
  return {
    pax: normalizedNumber(value.pax),
    budget: createBudget(value.budget),
    origin: createEndpoint(value.origin),
    destination: createEndpoint(value.destination),
    tripType: normalizedTripTypes(value.tripType),
    outbound_date: normalizedString(value.outbound_date),
    return_date: normalizedString(value.return_date),
    duration_days: normalizedNumber(value.duration_days),
    upcomingEvents: normalizedUpcomingEvents(value.upcomingEvents),
    placesOfInterest: normalizedPlacesOfInterest(value.placesOfInterest),
    suggestedQuestions: normalizedQuestions(value.suggestedQuestions),
  };
}

function mergeEndpoint(current: TripPlannerRecord, incoming: unknown) {
  const existing = createEndpoint(current);
  if (!incoming || typeof incoming !== 'object') {
    return existing;
  }

  const update = incoming as TripPlannerRecord;
  const incomingCity = normalizedString(update.city);
  const incomingIata = normalizedString(update.iata)?.toUpperCase() || null;
  if (incomingCity && incomingCity !== existing.city) {
    return {
      city: incomingCity,
      iata: incomingIata,
    };
  }

  return {
    city: incomingCity || existing.city,
    iata: incomingIata || existing.iata,
  };
}

function mergeBudget(current: TripPlannerRecord, incoming: unknown) {
  const existing = createBudget(current);
  if (!incoming || typeof incoming !== 'object') {
    return existing;
  }

  const update = incoming as TripPlannerRecord;
  const merged = {
    total: normalizedNumber(update.total) || existing.total,
    amount: normalizedNumber(update.amount) || existing.amount,
    currency: normalizedString(update.currency) || existing.currency,
    per_person:
      typeof update.per_person === 'boolean'
        ? update.per_person
        : existing.per_person,
  };

  if (update.per_person === true && !normalizedNumber(update.total)) {
    merged.total = null;
  }

  return merged;
}

function mergeTripTypes(current: unknown, incoming: unknown) {
  const existing = normalizedTripTypes(current);
  const next = normalizedTripTypes(incoming);
  if (next.length === 0) {
    return existing;
  }

  const nextLower = next.map((value) => value.toLowerCase());
  const replacesJourneyType = nextLower.some((value) => JOURNEY_TRIP_TYPES.has(value));
  const replacesPartyType = nextLower.some((value) => PARTY_TRIP_TYPES.has(value));
  const replacesPace = nextLower.some((value) => PACE_TRIP_TYPES.has(value));
  const retained = existing.filter((value) => {
    const normalized = value.toLowerCase();
    if (replacesJourneyType && JOURNEY_TRIP_TYPES.has(normalized)) {
      return false;
    }
    if (replacesPartyType && PARTY_TRIP_TYPES.has(normalized)) {
      return false;
    }
    if (replacesPace && PACE_TRIP_TYPES.has(normalized)) {
      return false;
    }
    return true;
  });

  return [...new Set([...retained, ...next])];
}

export function mergeTripPlannerSummaryContext(
  current: TripPlannerRecord = {},
  incoming: TripPlannerRecord = {},
) {
  const existing = createTripPlannerSummaryContext(current);
  if (!incoming || typeof incoming !== 'object') {
    return existing;
  }

  const origin = mergeEndpoint(existing.origin, incoming.origin);
  const destination = mergeEndpoint(existing.destination, incoming.destination);
  const destinationChanged = Boolean(
    (normalizedString(incoming.destination?.city) || normalizedString(incoming.destination?.iata)) &&
      (destination.city !== existing.destination.city || destination.iata !== existing.destination.iata),
  );
  const hasIncoming = (key: string) => Object.prototype.hasOwnProperty.call(incoming, key);

  return {
    pax: normalizedNumber(incoming.pax) || existing.pax,
    budget: mergeBudget(existing.budget, incoming.budget),
    origin,
    destination,
    tripType: mergeTripTypes(existing.tripType, incoming.tripType),
    outbound_date: normalizedString(incoming.outbound_date) || existing.outbound_date,
    return_date: normalizedString(incoming.return_date) || existing.return_date,
    duration_days: normalizedNumber(incoming.duration_days) || existing.duration_days,
    upcomingEvents: hasIncoming('upcomingEvents')
      ? normalizedUpcomingEvents(incoming.upcomingEvents)
      : destinationChanged
        ? []
        : existing.upcomingEvents,
    placesOfInterest: hasIncoming('placesOfInterest')
      ? normalizedPlacesOfInterest(incoming.placesOfInterest)
      : destinationChanged
        ? []
        : existing.placesOfInterest,
    suggestedQuestions: hasIncoming('suggestedQuestions')
      ? normalizedQuestions(incoming.suggestedQuestions)
      : existing.suggestedQuestions,
  };
}
