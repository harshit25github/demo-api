import type { FilterValues, PayloadOracle } from '../fixtures/manager-flight-complex-state.js';
import { getVisibleFlightContracts } from '../../public/chat-dashboard/flightContracts.js';

/** Test reporting reads native SDK evidence; production need not track delegates. */
export function managerSpecialistNames(result: { result?: { newItems?: readonly unknown[] } }): string[] {
  return (result.result?.newItems || []).flatMap((item: any) =>
    item?.type === 'tool_call_item' && typeof item.rawItem?.name === 'string'
      ? [item.rawItem.name]
      : []);
}

/** Use the client's existing flags/result-display behavior, never response text. */
export function flightCardsVisible(context: { flight?: unknown }): boolean {
  return getVisibleFlightContracts(context.flight || {}).length > 0;
}

export interface ObservedFlightToolCall {
  callId: string;
  tool: string;
  input: any;
  output?: any;
  completed: boolean;
}

export function parseToolValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Read normalized active values independently of the filter payload builder. */
export function activeFilterValues(filters: any[]): FilterValues {
  const result: Record<string, Array<string | number>> = {};
  for (const filter of filters) {
    const value = filter.filterType === 'price' ? filter.maxPrice
      : ['totalDuration', 'layoverDuration'].includes(filter.filterType) ? filter.maxDurationMinutes
      : filter.filterCode;
    if (value !== null && value !== undefined) {
      (result[filter.filterType] ||= []).push(value);
    }
  }
  return result;
}

export function filterValueIssues(actual: FilterValues, expected: FilterValues): string[] {
  const issues: string[] = [];
  for (const type of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    const observed = [...new Set(actual[type] || [])].sort();
    const intended = [...new Set(expected[type] || [])].sort();
    if (JSON.stringify(observed) !== JSON.stringify(intended)) {
      issues.push(`filter ${type}: expected ${JSON.stringify(intended)}, got ${JSON.stringify(observed)}`);
    }
  }
  return issues;
}

/** All current airports selected and unrestricted can be equivalent, but only
 * with complete source options AND original-result membership as evidence. */
export function fullAirportGroupEvidence(
  actual: FilterValues,
  expected: FilterValues,
  sources: { departureAirport: any[]; arrivalAirport: any[]; flights: any[] },
): { values: FilterValues; acceptableDeviations: string[] } {
  const values = { ...actual };
  const acceptableDeviations: string[] = [];
  for (const type of ['departureAirport', 'arrivalAirport'] as const) {
    const intended = expected[type];
    if (!intended?.length || actual[type]?.length || !sources.flights.length) continue;
    const codes = sources[type].map((option) => option?.Code);
    if (!codes.length || codes.some((code) => typeof code !== 'string' || !code)) continue;
    if (JSON.stringify([...new Set(codes)].sort()) !== JSON.stringify([...new Set(intended)].sort())) continue;
    const field = type === 'departureAirport' ? 'departure_airport_code' : 'arrival_airport_code';
    if (!sources.flights.every((flight) => intended.includes(flight?.[field]))) continue;
    values[type] = codes;
    acceptableDeviations.push(`Unrestricted ${type} is equivalent to the requested complete airport group; all original results belong to that group.`);
  }
  return { values, acceptableDeviations };
}

export function payloadFieldIssues(actual: any, expected: PayloadOracle): string[] {
  return Object.entries(expected).flatMap(([path, intended]) => {
    const observed = path.split('.').reduce((value, key) => value?.[key], actual);
    const matches = Array.isArray(intended) ? intended.includes(observed) : observed === intended;
    return matches ? [] : [`payload ${path}: expected ${JSON.stringify(intended)}, got ${JSON.stringify(observed)}`];
  });
}

/** A search that succeeded and returned options, read from the tool's own output. */
export function searchProducedResults(call: ObservedFlightToolCall | undefined): boolean {
  return Array.isArray(call?.output?.flights) && call.output.flights.length > 0;
}

/**
 * The search after a prediction must follow the prediction's outcome: the
 * top-ranked date (or pair) on success, a date inside the requested window on
 * a fallback. Read from the actual tool inputs and outputs, never the reply.
 */
export function predictionSearchIssues(calls: ObservedFlightToolCall[]): string[] {
  const predictionIndex = calls.findIndex((call) => call.tool === 'price_prediction_tool' && call.completed);
  if (predictionIndex < 0) return [];
  const search = calls.slice(predictionIndex + 1).find((call) => call.tool === 'flight_search');
  if (!search) return [];
  const prediction = calls[predictionIndex];
  const ond = search.input?.onds?.[0] || {};
  if (prediction.output?.status === 'SUCCESS') {
    const top = prediction.output.cheapestCombinations?.[0] || prediction.output.cheapestDates?.[0];
    const outbound = top?.outboundDate || top?.departureDate;
    const issues: string[] = [];
    if (outbound && ond.outbound_date !== outbound) {
      issues.push(`search after a successful prediction used ${ond.outbound_date}, not the top-ranked date ${outbound}`);
    }
    if (top?.returnDate && ond.return_date !== top.returnDate) {
      issues.push(`search after a successful prediction returned ${ond.return_date}, not the top-ranked return ${top.returnDate}`);
    }
    return issues;
  }
  const { startDate, endDate } = prediction.input || {};
  if (startDate && endDate && !(ond.outbound_date >= startDate && ond.outbound_date <= endDate)) {
    return [`fallback search date ${ond.outbound_date} is outside the requested window ${startDate}..${endDate}`];
  }
  return [];
}

/** Cities the prompts' examples and these conversations use; enough to catch borrowed ones. */
const KNOWN_CITIES = [
  'delhi', 'mumbai', 'dubai', 'new york', 'los angeles', 'london', 'goa', 'tokyo', 'san francisco',
  'boston', 'newark', 'paris', 'singapore', 'bali', 'rome', 'amsterdam', 'doha', 'frankfurt',
  'chicago', 'miami', 'toronto', 'bangkok', 'sydney', 'burbank',
];

/**
 * A suggestion may name only places the traveler gave, the current search's
 * endpoints, or cities in the current filter source options (layover and
 * endpoint airports). The prompt forbids inventing a departure or arrival.
 */
export function inventedPlaceIssues(suggestions: string[], allowedText: string): string[] {
  const allowed = allowedText.toLowerCase();
  return suggestions.flatMap((suggestion) => KNOWN_CITIES
    .filter((city) => new RegExp(`\\b${city}\\b`, 'i').test(suggestion) && !allowed.includes(city))
    .map((city) => `suggestion names ${city}, which the traveler has not given: "${suggestion}"`));
}

const RELAXING_SUGGESTION =/^(?:remove|drop|clear|relax|allow|undo|reset|show all|include|loosen|widen|any)\b/i;

/**
 * Suggestion rules the update tool cannot see for itself: an action already in
 * effect, an option number that does not exist, or the same three as last turn.
 */
export function suggestionIssues({
  suggestions,
  previous,
  activeFilters,
  airlineOptions,
  resultCount,
}: {
  suggestions: string[];
  previous: string[];
  activeFilters: any[];
  airlineOptions: any[];
  resultCount: number;
}): string[] {
  const issues: string[] = [];
  const active = activeFilterValues(activeFilters);
  const activeAirlines = new Set((active.airline || []).flatMap((code) =>
    airlineOptions.filter((option) => option?.Code === code).map((option) => String(option.Text || option.Name || ''))));
  for (const suggestion of suggestions) {
    const adds = !RELAXING_SUGGESTION.test(suggestion.trim());
    if (adds && active.stops?.includes('0') && /\bnon[ -]?stop\b/i.test(suggestion)) {
      issues.push(`suggestion re-offers the active nonstop filter: "${suggestion}"`);
    }
    if (adds && /^(?:show|only|filter|keep)\b/i.test(suggestion)) {
      for (const name of activeAirlines) {
        if (name && suggestion.toLowerCase().includes(name.toLowerCase())) {
          issues.push(`suggestion re-offers the active ${name} filter: "${suggestion}"`);
        }
      }
    }
    const option = suggestion.match(/\boption\s+(\d+)\b/i);
    if (option && Number(option[1]) > resultCount) {
      issues.push(`suggestion names option ${option[1]} but only ${resultCount} current option(s) exist: "${suggestion}"`);
    }
    // Ranking current options, not a price window such as "Cheapest this week".
    const ranks = /\b(?:cheapest|fastest|shortest|quickest|lowest|best value|compare)\b/i.test(suggestion) &&
      /\b(?:options?|flights?|ones?)\b/i.test(suggestion) && !/\b(?:dates?|days?|weeks?|weekends?|months?)\b/i.test(suggestion);
    if (ranks && resultCount < 2) {
      issues.push(`suggestion ranks or compares options but only ${resultCount} current option(s) exist: "${suggestion}"`);
    }
  }
  const normalize = (items: string[]) => items.map((item) => item.trim().toLowerCase()).sort().join('|');
  if (previous.length === 3 && suggestions.length === 3 && normalize(previous) === normalize(suggestions)) {
    issues.push('suggestions repeated the previous three unchanged');
  }
  return issues;
}

/** Flexible-date fallback must not promise an unsolicited range-wide sweep. */
export function dateSweepPromiseIssues(feedback: string): string[] {
  const sweep = new RegExp([
    String.raw`\b(?:day[ -]by[ -]day|(?:separate|individual)\s+(?:flight\s+)?search(?:es)?|search(?:ing)?\s+(?:each|every)\s+(?:day|date)|compare\s+manually)\b`,
    String.raw`\bsearch\b.{0,160}\bto compare\b`,
    String.raw`\bsearch(?:es)?\s+(?:per|for each|for every)\s+(?:day|date)\b`,
    String.raw`\b(?:dates?|days?)\s+(?:individually|one by one|one at a time)\b`,
    String.raw`\b(?:which|tell me|pick|choose|share|give me)\s+(?:\d+\s*[–-]\s*\d+|\d+|one or two|two or three|a few|a couple of|some|other|more|specific)\s+(?:(?:more|other|specific)\s+)?(?:dates?|days?)\b`,
  ].join('|'), 'i');
  return sweep.test(feedback) ? ['failed prediction offered a date-by-date search sweep as a replacement comparison'] : [];
}

/** A flexible window is a choice of one date; the Manager must not turn it into per-date coverage. */
export function subtaskEnrichmentIssues(user: string, subtasks: readonly string[]): string[] {
  const perDate = /\b(?:which|what)\s+(?:of\s+the\s+)?dates?\s+(?:have|has|had)\b|\bper[ -](?:day|date)\b|\b(?:each|every)\s+(?:day|date)\b|\bacross\s+(?:every|each|all)\s+(?:days?|dates?)\b/i;
  if (perDate.test(user)) return [];
  const enriched = subtasks.find((subtask) => perDate.test(subtask));
  return enriched ? [`Manager subtask asked for per-date coverage the traveler did not request: "${enriched.slice(0, 200)}"`] : [];
}

export function failedPredictionCtaIssues(suggestions: string[]): string[] {
  const genericFailedLookup = /\b(?:cheaper|cheapest|better|best|strongest)\s+(?:(?:travel|departure|return|nearby)\s+)?dates?\b/i;
  return suggestions.some((suggestion) => genericFailedLookup.test(suggestion))
    ? ['suggestions re-offered generic date intelligence after this turn could not verify it'] : [];
}

/** A corrected suggestions draft is the only automatically accepted duplicate. */
export function comparableToolSequence(calls: ObservedFlightToolCall[]): string[] {
  const last = calls.at(-1);
  const previous = calls.at(-2);
  const rejected = previous?.output?.ok === false || [
    'INVALID_SUGGESTED_QUESTIONS', 'EMPTY_CTA_NOT_ALLOWED', 'REPEATED_CTA_INTENT',
  ].includes(String(previous?.output?.code || ''));
  return calls.filter((call, index) => !(
    index === calls.length - 2 && previous?.tool === 'update_flight_suggested_questions' &&
    last?.tool === previous.tool && rejected
  )).map((call) => call.tool);
}
