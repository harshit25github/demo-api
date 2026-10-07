import { Agent, setDefaultOpenAIKey } from '@openai/agents';
import type { RunContext } from '@openai/agents';
import { assertOpenAIConfig, flightAgentConfig } from './config.js';
import { buildActiveSearchSummary, buildPricePredictionRouteSummary } from './context/prompt-summary.js';
import { buildFlightDateDynamicPromptContext } from './date/prompt-context.js';
import {
  getRequestClock,
  getRequestState,
} from '../../shared/runtime/request-context.js';
import { getFlightSearchRuntime } from './context/search-runtime-store.js';
import { FLIGHT_PROMPT } from './prompt.js';
import { flightManagerOutputSchema, FLIGHT_MANAGER_INSTRUCTIONS } from './manager-output.js';
import { flightTools } from './tools/index.js';
import { previousFlightSuggestions } from './tools/suggested-questions-tool.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey!);

const MAX_FILTER_OPTIONS_PER_GROUP = 12;

type DynamicRecord = Record<string, any>;

function getAvailableOptions(options: unknown = []): DynamicRecord[] {
  const list = Array.isArray(options) ? options : [];
  return list.filter((option): option is DynamicRecord => Boolean(option));
}

function compactText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatFilterOption(option: DynamicRecord): string | null {
  const code = compactText(option.Code);
  const label = compactText(option.Text || option.Name || option.AirportCityName);

  if (!code && !label) {
    return null;
  }

  if (!code || !label || code.toLowerCase() === label.toLowerCase()) {
    return code || label;
  }

  return `${code}=${label}`;
}

function formatOptionList(options: unknown): string {
  const values = getAvailableOptions(options)
    .map(formatFilterOption)
    .filter((value): value is string => Boolean(value));

  if (values.length === 0) {
    return 'none';
  }

  const visibleValues = values.slice(0, MAX_FILTER_OPTIONS_PER_GROUP);
  const hiddenCount = values.length - visibleValues.length;
  return `${visibleValues.join('; ')}${hiddenCount > 0 ? `; +${hiddenCount} more` : ''}`;
}

function formatAirportOptionList(options: unknown): string {
  const availableOptions = getAvailableOptions(options);
  const mainOptions = availableOptions.filter((option) => !option.IsNearby);
  const nearbyOptions = availableOptions.filter((option) => option.IsNearby);
  const parts: string[] = [];

  if (mainOptions.length > 0) {
    parts.push(`main ${formatOptionList(mainOptions)}`);
  }

  if (nearbyOptions.length > 0) {
    parts.push(`nearby ${formatOptionList(nearbyOptions)}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'none';
}

function buildActiveFilterOptionsSummary(context: DynamicRecord): string {
  const flight = context?.flight || {};
  const airlineOptions = flight.airlineFilterOptions;
  const layoverAirportOptions = flight.layoverAirportFilterOptions;
  const departureAirportOptions = flight.departAirports;
  const arrivalAirportOptions = flight.depLandAirports;

  return [
    `airlines: ${formatOptionList(airlineOptions)}`,
    `layoverAirports: ${formatOptionList(layoverAirportOptions)}`,
    `departureAirports: ${formatAirportOptionList(departureAirportOptions)}`,
    `arrivalAirports: ${formatAirportOptionList(arrivalAirportOptions)}`,
  ].join('\n');
}

function hasFlightResultRecords(searchResults: unknown): boolean {
  if (Array.isArray(searchResults)) {
    return searchResults.length > 0;
  }
  if (!searchResults || typeof searchResults !== 'object') {
    return false;
  }
  return ['flights', 'contracts', 'results', 'data'].some(
    (key) => {
      const records = (searchResults as DynamicRecord)[key];
      return Array.isArray(records) && records.length > 0;
    },
  );
}

function buildPreviousSuggestedQuestionsSummary(context: DynamicRecord): string {
  // The set shown when the turn began: a search or filter clears the live copy
  // mid-turn, and these instructions are rebuilt before every model call.
  const suggestions = previousFlightSuggestions(context);
  if (suggestions.length === 0) {
    return 'none';
  }

  return suggestions.map((suggestion) => compactText(suggestion)).join('\n');
}

type PredictionPick = { departureDate?: string; outboundDate?: string; returnDate?: string };

/**
 * The last successful price prediction, so a later turn can search its strongest
 * date without predicting again, and suggestions can name that date.
 */
function buildLastPredictionSummary(context: DynamicRecord): string {
  const prediction = context?.flight?.lastPricePrediction;
  if (!prediction || prediction.status !== 'SUCCESS') {
    return 'none';
  }
  const ranked: PredictionPick[] = prediction.tripType === 'roundtrip'
    ? prediction.cheapestCombinations || []
    : prediction.cheapestDates || [];
  const dates = ranked
    .slice(0, 3)
    .map((pick) => (pick.outboundDate ? `${pick.outboundDate} returning ${pick.returnDate}` : pick.departureDate))
    .filter(Boolean);
  if (dates.length === 0) {
    return 'none';
  }
  const route = `${prediction.route?.originCity || 'unknown'} to ${prediction.route?.destinationCity || 'unknown'}`;
  return `${route} (${prediction.tripType || 'oneway'}), strongest dates in rank order: ${dates.join('; ')}`;
}

function formatAppliedFilter(filter: DynamicRecord = {}): string | null {
  const rawLabel = compactText(filter.rawUserFilter);
  if (rawLabel) {
    return rawLabel;
  }

  const names =
    filter.airlineNames ||
    filter.layoverAirportNames ||
    filter.departureAirportNames ||
    filter.arrivalAirportNames;
  if (Array.isArray(names) && names.length > 0) {
    return `${filter.filterType}: ${names.map(compactText).filter(Boolean).join(', ')}`;
  }

  if (filter.filterType === 'price' && filter.maxPrice !== null) {
    return `Price: up to ${filter.maxPrice}`;
  }
  if (filter.filterType === 'totalDuration' && filter.maxDurationMinutes !== null) {
    return `Total duration: up to ${filter.maxDurationMinutes} minutes`;
  }
  if (filter.filterType === 'layoverDuration' && filter.maxDurationMinutes !== null) {
    return `Layover duration: up to ${filter.maxDurationMinutes} minutes`;
  }

  const codeLabels = {
    baggage: { '0': 'Checked baggage', '1': 'Carry-on baggage', '2': 'Personal item' },
    stops: { '0': 'Non-stop', '2': 'One stop', '3': 'Two or more stops' },
    departureTime: {
      EARLYMORNING: 'Early-morning departure',
      MORNING: 'Morning departure',
      AFTERNOON: 'Afternoon departure',
      EVENING: 'Evening departure',
    },
    arrivalTime: {
      EARLYMORNING: 'Early-morning arrival',
      MORNING: 'Morning arrival',
      AFTERNOON: 'Afternoon arrival',
      EVENING: 'Evening arrival',
    },
  };
  return (codeLabels as DynamicRecord)[filter.filterType]?.[filter.filterCode] || filter.filterType || null;
}

function buildAppliedFiltersSummary(context: DynamicRecord): string {
  const searchKey = context?.flight?.searchKey;
  const appliedFilters = getFlightSearchRuntime(searchKey)?.appliedFilters;
  if (!Array.isArray(appliedFilters) || appliedFilters.length === 0) {
    return 'none';
  }

  const labels = appliedFilters
    .map((filter) => formatAppliedFilter(filter as DynamicRecord))
    .filter(Boolean);
  return labels.length > 0 ? labels.join('\n') : 'none';
}

export function buildFlightAgentInstructions(runContext: { context?: unknown }): string {
  const requestContext =
    runContext.context && typeof runContext.context === 'object' ? runContext.context : {};
  const context = getRequestState(requestContext) as DynamicRecord;
  const clock = getRequestClock(requestContext);
  const hasHydratedSearchKey = Boolean(context.flight?.searchKey);
  const hasHydratedResults = hasFlightResultRecords(context.flight?.searchResults);
  
  return `${FLIGHT_PROMPT}

## Current search state

${buildFlightDateDynamicPromptContext(clock)}
- UID is available in context.
- Hydrated search key present (not validated): ${hasHydratedSearchKey ? 'yes' : 'no'}.
- For the final suggestions update, any known trip detail counts, including a search key that is not validated: pass three grounded suggestions, and an empty array only when nothing about the trip is known.
- Hydrated flight result records present (not validated): ${hasHydratedResults ? 'yes' : 'no'}.

### Current Existing Search Parameters — Fallback Context

The latest user message is the highest authority. These Current Existing Search Parameters are fallback values for fields the user did not mention; they never override an explicit new value in the latest message.

Priority order when fields conflict: (1) current explicit user input in the scoped task, (2) populated Current Existing Search Parameters and hydrated flight context for unchanged fields, (3) prior facts explicitly carried by Manager, or session history actually available in this run, for still-missing fields. Unknown/null values and automatic defaults do not override confirmed user facts. Flight does not have access to the Manager's full conversation.

Parameters cover departure location, arrival location, outbound date, return date, passengers, trip type, cabin class, segments, booking/page state, and generated contracts availability.

- Existing search parameters: ${buildActiveSearchSummary(context)}
- Current price-prediction route codes: ${buildPricePredictionRouteSummary(context)}.
- Last successful price prediction: ${buildLastPredictionSummary(context)}.
- Active filter source options (abbreviated when marked +N more): ${compactText(buildActiveFilterOptionsSummary(context))}

### Already applied filters that belong to the current search

${buildAppliedFiltersSummary(context)}

- Already-applied filters are valid only when they belong to this same current route/date/passenger/cabin search. Filters from an older or different search are excluded above and must not be treated as active.
- This list reflects filters applied in earlier turns only. After a current-turn \`apply_filter\` call, its complete \`filters\` list is authoritative. It replaces this earlier list; do not union removed or reset filters back into active state.
- Do not generate suggested questions that re-apply or duplicate any active filter. If most or all common filters are already applied, suggest result reasoning or offer to remove or relax an active filter instead.

### Previous suggested questions stored in context.flight.suggestedQuestions

${buildPreviousSuggestedQuestionsSummary(context)}

### Required turn behavior

- Apply the latest message as a partial update. Reuse unchanged route, date, trip, passenger, and cabin values. Preserve active filters only while working on the same search; a new search clears them unless the request includes carrying them forward.
- Do not ask again for departure location, arrival location, dates, trip type, passengers, or cabin when available above or explicitly carried by Manager from relevant conversation history.
- If the user says “actually make it X” after naming an arrival location, treat X as the updated arrival location unless current wording explicitly changes the departure location.
- An exact date, a relative expression that resolves to one intended day, or a fixed outbound/return pair uses flight_search directly when results are requested.
- Any explicit or implicit flexible window that permits multiple travel dates uses price_prediction_tool first, even without cheapest/best/price wording. This includes “any day next week”, “find flights next week” with no fixed day, “between Oct 10 and Oct 20”, “sometime next month”, and “I’m flexible during these dates”. If results were requested, search the strongest returned in-window date; if the user asked only for date guidance, do not search.
- A follow-up such as “any cheaper dates?” is explicit fare/date intelligence. Use the current search route and dates, then call price_prediction_tool before answering; current contract prices cannot establish cheaper dates. Do not ask for a specific airport when the current city or metropolitan route code is available above.
- For explicit price intelligence or implicit flexible-window intent, derive the exact requested bounds from the current turn clock and preserve that bracket when calling price_prediction_tool.
- A standalone “Remove all filters” means one apply_filter call with a single reset entry. Do not start a new flight search for that request. For a mixed reset-and-add request, send reset plus the requested new constraints together and verify both outcomes.
- If a date-intelligence request is missing the departure location or arrival location, retain any supplied timing and ask only for the missing endpoint.
- Use fresh generated-contract context for every current-option fact, comparison, or recommendation, even when cards are absent from history or a prior filter returned zero matches.
- Current-option inspection is read-only unless the scoped Manager subtask explicitly says the user requested a filter change. Never call apply_filter or reset active filters to expose more options, work around zero matches, or inspect the unfiltered base set. Preserve the empty filtered set and report that no current option matches.
- Source options above may be abbreviated. For airline and airport filters, pass the user's names/group wording to apply_filter, which resolves against complete current arrays. Do not infer unavailability from a missing summary entry or invent codes.
- Tool recovery metadata is authoritative feedback: repair only listed fields, retry only with a changed safe payload, and ask only when the correction remains materially ambiguous.
- Before drafting suggested questions, read any Manager-carried historical used/reversed-action note as an exclusion checklist. Do not suggest reapplying or removing those same preference intents on the unchanged trip, even after reset or a fresh read. Choose unused option details, airport constraints, or trip refinements instead; a filter reset does not reset suggestion history.
- Keep every business outcome from this turn in the suggestions check: a successful fallback search/filter does not erase unavailable date intelligence. Do not re-offer a generic cheaper/best-date lookup after that failure. Prefer current-option details, relaxing a current filter, or an unused trip refinement; source-array membership alone does not prove a new filter combination will match the current sparse results.
- End every turn with exactly one update_flight_suggested_questions call after all other tools, including clarification and no-action turns. Retry it once only after INVALID_SUGGESTED_QUESTIONS, and never let it block or change a completed result.

`;
}

const flightAgentDefinition = {
  name: 'FlightAgent',
  instructions: (runContext: RunContext<unknown>) => buildFlightAgentInstructions(runContext),
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: flightTools,
};

/** Kept for standalone runs and handoff comparison during the transition. */
export const FlightAgent = new Agent(flightAgentDefinition);

/** Same Flight intelligence and tools, with a typed internal result for Manager runs. */
export const FlightManagerAgent = new Agent({
  ...flightAgentDefinition,
  instructions: (runContext: RunContext<unknown>) =>
    `${buildFlightAgentInstructions(runContext)}\n\n${FLIGHT_MANAGER_INSTRUCTIONS}`,
  outputType: flightManagerOutputSchema,
});

