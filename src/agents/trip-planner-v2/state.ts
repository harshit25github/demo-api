import { sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import type { RequestClock } from '../../shared/time/request-clock.js';
import { knownCityIataCode } from '../../shared/travel/city-codes.js';
import { isRecord } from '../../shared/types/json.js';
import { createClientSummary, type ClientSummary } from './client-summary.js';
import type { TripCost, TripDay, TripFact, TripOption, TripPlanUpdate, TripPresentation } from './result.js';
import { isOutOfTripScope } from './scope.js';

export interface SavedTripOption extends Omit<TripOption, 'code'> {
  code: string | null;
}

export interface TripPlanCard {
  country: string;
  knownFor: string;
  bestTime: string;
  cost: TripCost;
}

export interface TripPlan {
  destination: ClientSummary['destination'];
  card: TripPlanCard | null;
  days: TripDay[];
}

export interface SavedTripFact extends TripFact {
  checkedOn: string | null;
}

/** What the app shows with this request's reply. Never persisted. */
export interface TripTurnView {
  requestId: string | null;
  presentation: TripPresentation;
  presentationDays: number[];
}

/** Trip-owned state in context.tripPlanner. The trip facts themselves live in the client summary. */
export interface TripPlannerV2State {
  dateHint?: string | null;
  options?: SavedTripOption[];
  plan?: TripPlan | null;
  facts?: SavedTripFact[];
  lastQuestion?: string | null;
  suggestions?: string[];
  photos?: Record<string, string>;
  turnView?: TripTurnView | null;
}

const ASSISTANT_STYLE = /^\s*(?:would\s+you\s+like|do\s+you\s+want|should\s+i|can\s+i)\b/i;

export function getTripState(context: Record<string, any>): TripPlannerV2State {
  if (!isRecord(context.tripPlanner)) context.tripPlanner = {};
  return context.tripPlanner as TripPlannerV2State;
}

/** One plain line: no links, markdown emphasis or line breaks, which would break line-based cards. */
export function plainText(value: string): string {
  return sanitizeNoLinks(value).text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

function code(value: string): string | null {
  const candidate = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(candidate) ? candidate : null;
}

export function savedOptions(options: TripOption[]): SavedTripOption[] {
  const seen = new Set<string>();
  return options
    .map((option) => ({
      code: code(option.code),
      city: plainText(option.city),
      country: plainText(option.country),
      why: plainText(option.why),
      bestTime: plainText(option.bestTime),
      cost: option.cost,
    }))
    .filter((option) => {
      const key = `${option.city}|${option.country}`.toLowerCase();
      if (!option.city || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cleanDay(day: TripDay): TripDay {
  const block = (value: string) => plainText(value) || 'Free time';
  return {
    day: day.day,
    title: plainText(day.title) || `Day ${day.day}`,
    morning: block(day.morning),
    afternoon: block(day.afternoon),
    evening: block(day.evening),
    places: [...new Set(day.places.map(plainText).filter(Boolean))],
  };
}

/** A full plan replaces the saved one; a days update replaces only those days. */
export function mergePlan(
  existing: TripPlan | null | undefined,
  update: TripPlanUpdate,
  destination: ClientSummary['destination'],
): TripPlan {
  const days = new Map<number, TripDay>();
  if (update.scope === 'days' && existing) for (const day of existing.days) days.set(day.day, day);
  for (const day of update.days) days.set(day.day, cleanDay(day));
  for (const day of update.removeDays) days.delete(day);
  const card = update.card
    ? { country: plainText(update.card.country), knownFor: plainText(update.card.knownFor), bestTime: plainText(update.card.bestTime), cost: update.card.cost }
    : existing?.card ?? null;
  return { destination: { ...destination }, card, days: [...days.values()].sort((left, right) => left.day - right.day) };
}

/** The code the plan's photo is looked up by. The summary never gets an invented code; this is for the photo only. */
export function planPhotoCode(plan: TripPlan): string | null {
  return plan.destination.iata ?? knownCityIataCode(plan.destination.city);
}

export function mergeFacts(existing: SavedTripFact[] = [], facts: TripFact[], checkedOn: string | null): SavedTripFact[] {
  const merged = [...existing];
  for (const fact of facts) {
    const text = plainText(fact.text);
    const source = plainText(fact.source);
    if (!text || !source || merged.some((saved) => saved.text.toLowerCase() === text.toLowerCase())) continue;
    merged.push({ text, source, day: fact.day, checkedOn });
  }
  return merged.slice(-10);
}

/** placesOfInterest for the client summary: every named place in the current plan, once. */
export function placesOfInterestFromPlan(plan: TripPlan): ClientSummary['placesOfInterest'] {
  const places: ClientSummary['placesOfInterest'] = [];
  for (const day of plan.days) {
    for (const placeName of day.places) {
      if (places.some((place) => place.placeName.toLowerCase() === placeName.toLowerCase())) continue;
      places.push({ placeName, description: `Day ${day.day}: ${day.title}` });
    }
  }
  return places;
}

/** update suggested questions: up to three 3-8 word chips, new and in scope. Invalid ones are dropped, never retried. */
export function acceptedSuggestions(values: string[], previous: string[] = []): string[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const seen = new Set(previous.map(normalize));
  const accepted: string[] = [];
  for (const value of values) {
    const suggestion = plainText(value);
    const words = suggestion.split(' ').filter(Boolean).length;
    const key = normalize(suggestion);
    if (words < 3 || words > 8 || ASSISTANT_STYLE.test(suggestion) || isOutOfTripScope(suggestion) || seen.has(key)) continue;
    seen.add(key);
    accepted.push(suggestion);
  }
  return accepted.slice(0, 3);
}

function place(endpoint: ClientSummary['origin']): string {
  if (!endpoint.city && !endpoint.iata) return 'not set';
  return endpoint.city && endpoint.iata ? `${endpoint.city} (${endpoint.iata})` : endpoint.city ?? endpoint.iata ?? 'not set';
}

function inclusiveDays(outboundDate: string, returnDate: string): number {
  return Math.round((Date.parse(returnDate) - Date.parse(outboundDate)) / (24 * 60 * 60 * 1000)) + 1;
}

function dates(summary: ClientSummary, dateHint: string | null | undefined): string {
  if (summary.outbound_date && summary.return_date) {
    return `${summary.outbound_date} to ${summary.return_date} (plan ${inclusiveDays(summary.outbound_date, summary.return_date)} days)`;
  }
  const parts = [
    summary.outbound_date ? `from ${summary.outbound_date}` : null,
    summary.return_date ? `until ${summary.return_date}` : null,
    summary.duration_days ? `${summary.duration_days} days` : null,
    dateHint ? `timing "${dateHint}"` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'not set';
}

function travelers(passengers: ClientSummary['passengerData']): string {
  const breakdown = [
    passengers.adults !== null ? `${passengers.adults} adults` : null,
    passengers.seniors !== null ? `${passengers.seniors} seniors` : null,
    passengers.children !== null
      ? `${passengers.children} children${passengers.childrenAges.length ? ` aged ${passengers.childrenAges.join(', ')}` : ''}`
      : null,
    passengers.lapInfants !== null ? `${passengers.lapInfants} lap infants` : null,
    passengers.seatInfants !== null ? `${passengers.seatInfants} seat infants` : null,
  ].filter(Boolean);
  if (passengers.total === null && !breakdown.length) return 'not set';
  return [passengers.total !== null ? String(passengers.total) : 'total not set', breakdown.length ? `(${breakdown.join(', ')})` : null]
    .filter(Boolean)
    .join(' ');
}

function budget(value: ClientSummary['budget']): string {
  if (value.amount === null) return 'not set';
  const money = `${value.currency ?? 'currency not set'} ${value.amount}`;
  if (value.per_person === true) return `${money} per person${value.total !== null ? ` (total ${value.total})` : ''}`;
  return value.per_person === false ? `${money} total` : `${money}, per person or total not said`;
}

/** What Trip reads each run, appended after its static instructions so they stay cached. */
export function describeTripForModel(context: Record<string, any>, clock: RequestClock | null): string {
  const summary = createClientSummary(context.summaryContext);
  const trip = isRecord(context.tripPlanner) ? (context.tripPlanner as TripPlannerV2State) : {};
  const plan = trip.plan?.days.length
    ? [
        `plan for ${place(trip.plan.destination)}:`,
        ...trip.plan.days.map((day) =>
          `  Day ${day.day} ${day.title} | ${day.morning} | ${day.afternoon} | ${day.evening}${day.places.length ? ` | places: ${day.places.join(', ')}` : ''}`),
      ]
    : ['plan: none'];
  const lines = [
    `destination: ${place(summary.destination)}`,
    `origin: ${place(summary.origin)}`,
    `dates: ${dates(summary, trip.dateHint)}`,
    `travelers: ${travelers(summary.passengerData)}`,
    `budget: ${budget(summary.budget)}`,
    `tripType: ${summary.tripType.join(', ') || 'none'}`,
    `options shown: ${trip.options?.length ? trip.options.map((option, index) => `${index + 1} ${option.city}, ${option.country}${option.code ? ` (${option.code})` : ''}`).join(' · ') : 'none'}`,
    ...plan,
    ...(trip.facts?.length ? ['researched facts:', ...trip.facts.map((fact) => `  ${fact.text} (${fact.source}, checked ${fact.checkedOn ?? 'earlier'})`)] : []),
    `last question: ${trip.lastQuestion ?? 'none'}`,
    `chips shown: ${trip.suggestions?.length ? trip.suggestions.join(' · ') : 'none'}`,
  ];
  return [
    `<today>${clock ? `${clock.localDate} · ${clock.timeZone}` : 'unknown'}</today>`,
    `<saved_trip>\n${lines.join('\n')}\n</saved_trip>`,
    `<traveler_said>${String(context.currentUserMessage || '').trim()}</traveler_said>`,
  ].join('\n');
}

function short(value: string, length = 40): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/** The Manager's trip lines: enough to resolve "the second one" or "day 2" without the plan text in its history. */
export function describeTripForManager(context: Record<string, any>): string[] {
  const summary = createClientSummary(context.summaryContext);
  const trip = isRecord(context.tripPlanner) ? (context.tripPlanner as TripPlannerV2State) : {};
  const fact = (value: string | number | null) => (value === null || value === '' ? 'unknown' : short(String(value), 60));
  const days = trip.plan?.days ?? [];
  return [
    `- Current trip summary: ${fact(summary.origin.city)} to ${fact(summary.destination.city)}, outbound ${fact(summary.outbound_date)}, return ${fact(summary.return_date)}, duration ${fact(summary.duration_days)} days, travelers ${fact(summary.passengerData.total)}.`,
    `- Trip options shown: ${trip.options?.length ? trip.options.map((option, index) => `${index + 1} ${short(`${option.city}, ${option.country}`)}`).join('; ') : 'none'}.`,
    `- Current trip plan: ${days.length ? `${days.length} days (${days.slice(0, 14).map((day) => `D${day.day} ${short(day.title, 30)}`).join('; ')}${days.length > 14 ? '; …' : ''})` : 'none'}.`,
    `- Last Trip question: ${trip.lastQuestion ? `"${short(trip.lastQuestion, 120)}"` : 'none'}.`,
  ];
}
