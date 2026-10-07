import type { FilterValues } from '../fixtures/manager-flight-complex-state.js';
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

export function payloadFieldIssues(actual: any, expected: Record<string, string | number | null | readonly string[]>): string[] {
  return Object.entries(expected).flatMap(([path, intended]) => {
    const observed = path.split('.').reduce((value, key) => value?.[key], actual);
    const matches = Array.isArray(intended) ? intended.includes(observed) : observed === intended;
    return matches ? [] : [`payload ${path}: expected ${JSON.stringify(intended)}, got ${JSON.stringify(observed)}`];
  });
}

/** Flexible-date fallback must not promise an unsolicited range-wide sweep. */
export function dateSweepPromiseIssues(feedback: string): string[] {
  const sweep = /\b(?:day[ -]by[ -]day|(?:separate|individual)\s+(?:flight\s+)?search(?:es)?|search(?:ing)?\s+(?:each|every)\s+(?:day|date)|compare\s+manually)\b|\bsearch\b.{0,160}\bto compare\b/i;
  return sweep.test(feedback) ? ['failed prediction offered a date-by-date search sweep as a replacement comparison'] : [];
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
