import type { ClientSummary, TripChanges } from './schema.js';
import { isOutOfTripScope } from './scope.js';

type Passengers = ClientSummary['passengerData'];
type ClearField = TripChanges['clear'][number];

const PASSENGER_CATEGORIES = ['adults', 'seniors', 'children', 'lapInfants', 'seatInfants'] as const;
const JOURNEY_TYPES = new Set(['oneway', 'roundtrip', 'multicity']);
const PARTY_TYPES = new Set(['solo', 'couple', 'family', 'friends', 'business']);
const PACE_TYPES = new Set(['relaxed', 'balanced', 'fast-paced']);
const CANONICAL_TRIP_TYPES: Record<string, string> = {
  'one-way': 'oneway',
  'one way': 'oneway',
  'round-trip': 'roundtrip',
  'round trip': 'roundtrip',
  'multi-city': 'multicity',
  'multi city': 'multicity',
  'fast paced': 'fast-paced',
};
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function threeLetterCode(value: unknown): string | null {
  const code = text(value)?.toUpperCase() ?? null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function calendarDate(value: unknown): string | null {
  const date = text(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? date
    : null;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sameText(left: string | null, right: string | null): boolean {
  return (left ?? '').toLowerCase() === (right ?? '').toLowerCase();
}

function endpoint(value: unknown): ClientSummary['origin'] {
  const source = isRecord(value) ? value : {};
  return { city: text(source.city), iata: threeLetterCode(source.iata) };
}

function emptyPassengers(): Passengers {
  return { total: null, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] };
}

function emptyBudget(): ClientSummary['budget'] {
  return { amount: null, currency: null, per_person: null, total: null };
}

function canonicalTripType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return CANONICAL_TRIP_TYPES[normalized] ?? normalized;
}

function tripTypeCategory(value: string): Set<string> | null {
  return [JOURNEY_TYPES, PARTY_TYPES, PACE_TYPES].find((category) => category.has(value)) ?? null;
}

/** Any stored summary, including v1's Trip-only shape, in exactly the client's shape and key order. */
export function createClientSummary(value: unknown): ClientSummary {
  const source = isRecord(value) ? value : {};
  const budget = isRecord(source.budget) ? source.budget : {};
  const passengers = isRecord(source.passengerData) ? source.passengerData : {};
  const tripTypes = Array.isArray(source.tripType) ? source.tripType.map(text).filter((item): item is string => Boolean(item)) : [];
  const places = Array.isArray(source.placesOfInterest) ? source.placesOfInterest : [];
  return {
    origin: endpoint(source.origin),
    destination: endpoint(source.destination),
    outbound_date: calendarDate(source.outbound_date),
    return_date: calendarDate(source.return_date),
    duration_days: positiveInteger(source.duration_days),
    budget: {
      amount: amount(budget.amount),
      currency: threeLetterCode(budget.currency),
      per_person: typeof budget.per_person === 'boolean' ? budget.per_person : null,
      total: amount(budget.total),
    },
    tripType: tripTypes.filter((item, index) => tripTypes.findIndex((other) => sameText(other, item)) === index),
    placesOfInterest: places
      .filter(isRecord)
      .map((place) => ({ placeName: text(place.placeName), description: text(place.description) }))
      .filter((place): place is { placeName: string; description: string } => Boolean(place.placeName && place.description)),
    passengerData: {
      // v1's Trip-only shape kept the traveler count in pax; the client keeps it in passengerData.total.
      total: count(passengers.total) ?? positiveInteger(source.pax),
      adults: count(passengers.adults),
      seniors: count(passengers.seniors),
      children: count(passengers.children),
      lapInfants: count(passengers.lapInfants),
      seatInfants: count(passengers.seatInfants),
      childrenAges: Array.isArray(passengers.childrenAges)
        ? passengers.childrenAges.map(count).filter((age): age is number => age !== null)
        : [],
    },
  };
}

/** The Summary Extractor's convention: return date minus outbound date, so Oct 4-10 is 6. */
export function durationFromDates(outboundDate: string, returnDate: string): number | null {
  const outbound = calendarDate(outboundDate);
  const inbound = calendarDate(returnDate);
  if (!outbound || !inbound) return null;
  const days = Math.round((Date.parse(inbound) - Date.parse(outbound)) / DAY_MS);
  return days < 0 ? null : Math.max(1, days);
}

interface SummaryUpdate {
  summary: ClientSummary;
  destinationChanged: boolean;
  datesChanged: boolean;
  limitations: string[];
}

function clearField(summary: ClientSummary, field: ClearField): void {
  if (field === 'origin' || field === 'destination') summary[field] = { city: null, iata: null };
  else if (field === 'budget') summary.budget = emptyBudget();
  else if (field === 'tripType') summary.tripType = [];
  else if (field === 'passengerData') summary.passengerData = emptyPassengers();
  else if (field === 'duration_days') summary.duration_days = null;
  else summary[field] = null;
}

function mergeEndpoint(existing: ClientSummary['origin'], patch: TripChanges['origin']): ClientSummary['origin'] {
  if (!patch) return existing;
  const city = text(patch.city);
  const iata = threeLetterCode(patch.iata);
  // A different place replaces the whole endpoint, so an old code never sticks to a new city.
  if (city && !sameText(city, existing.city)) return { city, iata };
  if (!city && iata && existing.iata && iata !== existing.iata) return { city: null, iata };
  return { city: city ?? existing.city, iata: iata ?? existing.iata };
}

function sameEndpoint(left: ClientSummary['origin'], right: ClientSummary['origin']): boolean {
  return sameText(left.city, right.city) && left.iata === right.iata;
}

function applyDates(summary: ClientSummary, changes: TripChanges, limitations: string[]): void {
  let outbound = summary.outbound_date;
  let inbound = summary.return_date;
  if (changes.outbound_date !== null) {
    const date = calendarDate(changes.outbound_date);
    if (date) outbound = date;
    else limitations.push('A travel date could not be saved because it is not a real calendar date.');
  }
  if (changes.return_date !== null) {
    const date = calendarDate(changes.return_date);
    if (date) inbound = date;
    else limitations.push('A travel date could not be saved because it is not a real calendar date.');
  }
  if (outbound && inbound && inbound < outbound) {
    limitations.push('The return date was before the departure date, so the dates were not changed.');
    return;
  }
  summary.outbound_date = outbound;
  summary.return_date = inbound;
}

function budgetTotal(summary: ClientSummary): number | null {
  const { amount: budgetAmount, per_person: perPerson } = summary.budget;
  const travelers = summary.passengerData.total;
  if (budgetAmount === null) return null;
  if (perPerson === false) return budgetAmount;
  // Currency and basis are never assumed: an unknown basis leaves the total unknown.
  return perPerson === true && travelers ? Math.round(budgetAmount * travelers * 100) / 100 : null;
}

function applyPassengers(passengers: Passengers, patch: NonNullable<TripChanges['passengerData']>): void {
  const stated = new Set<string>();
  if (patch.total !== null) passengers.total = patch.total;
  for (const category of PASSENGER_CATEGORIES) {
    if (patch[category] !== null) {
      passengers[category] = patch[category];
      stated.add(category);
    }
  }
  if (patch.childrenAges.length > 0) {
    passengers.childrenAges = [...patch.childrenAges];
    // Explicit ages name the children, so they also give the count when it was not said.
    if (passengers.children === null) passengers.children = patch.childrenAges.length;
  }
  const complete = () => PASSENGER_CATEGORIES.every((category) => passengers[category] !== null);
  const sum = () => PASSENGER_CATEGORIES.reduce((total, category) => total + (passengers[category] ?? 0), 0);
  if (complete() && passengers.total !== null && sum() !== passengers.total) {
    if (PASSENGER_CATEGORIES.every((category) => stated.has(category))) {
      passengers.total = sum();
    } else {
      // A new total makes unstated zero categories unknown; known counts stay.
      for (const category of PASSENGER_CATEGORIES) {
        if (!stated.has(category) && passengers[category] === 0) passengers[category] = null;
      }
      if (complete() && sum() !== passengers.total) {
        for (const category of PASSENGER_CATEGORIES) if (!stated.has(category)) passengers[category] = null;
      }
    }
  }
  if (complete() && passengers.total === null) passengers.total = sum();
  if (passengers.children !== null && passengers.childrenAges.length > 0 && passengers.childrenAges.length !== passengers.children) {
    passengers.childrenAges = [];
  }
}

function applyTripTypes(summary: ClientSummary, patch: TripChanges['tripType']): void {
  // Stored values keep their spelling; comparisons use the canonical form.
  let values = [...summary.tripType];
  if (patch) {
    const removed = new Set(patch.remove.map(canonicalTripType));
    values = values.filter((value) => !removed.has(canonicalTripType(value)));
    for (const value of patch.add.map(canonicalTripType)) {
      if (!value || isOutOfTripScope(value) || values.some((existing) => canonicalTripType(existing) === value)) continue;
      // A new journey type, party or pace replaces the old one in the same category.
      const category = tripTypeCategory(value);
      if (category) values = values.filter((existing) => !category.has(canonicalTripType(existing)));
      values.push(value);
    }
  }
  const travelers = summary.passengerData.total;
  if (travelers !== null && travelers > 1) values = values.filter((value) => canonicalTripType(value) !== 'solo');
  if (travelers !== null && travelers > 2) values = values.filter((value) => canonicalTripType(value) !== 'couple');
  summary.tripType = values;
}

/**
 * Applies Trip's update to the client summary with the deterministic rules of the
 * Summary Extractor prompt (src/agents/summary/prompt.ts), now in code.
 */
export function applyTripChanges(current: unknown, changes: TripChanges | null): SummaryUpdate {
  const before = createClientSummary(current);
  const summary = createClientSummary(current);
  const limitations: string[] = [];
  if (changes) {
    for (const field of changes.clear) clearField(summary, field);
    summary.origin = mergeEndpoint(summary.origin, changes.origin);
    summary.destination = mergeEndpoint(summary.destination, changes.destination);
    applyDates(summary, changes, limitations);
    if (changes.passengerData) applyPassengers(summary.passengerData, changes.passengerData);
    if (changes.budget) {
      if (changes.budget.amount !== null) summary.budget.amount = changes.budget.amount;
      const currency = threeLetterCode(changes.budget.currency);
      if (currency) summary.budget.currency = currency;
      if (changes.budget.per_person !== null) summary.budget.per_person = changes.budget.per_person;
    }
    if (changes.budget || summary.passengerData.total !== before.passengerData.total || changes.clear.includes('budget')) {
      summary.budget.total = budgetTotal(summary);
    }
  }
  applyTripTypes(summary, changes?.tripType ?? null);

  const datesChanged = summary.outbound_date !== before.outbound_date || summary.return_date !== before.return_date;
  // One counting convention: exact dates set this turn decide the length; a stated length counts only without them.
  if (datesChanged && summary.outbound_date && summary.return_date) {
    summary.duration_days = durationFromDates(summary.outbound_date, summary.return_date);
  } else if (changes?.duration_days) {
    summary.duration_days = changes.duration_days;
  }
  const hadDestination = Boolean(before.destination.city || before.destination.iata);
  return {
    summary,
    destinationChanged: hadDestination && !sameEndpoint(before.destination, summary.destination),
    datesChanged,
    limitations: [...new Set(limitations)],
  };
}
