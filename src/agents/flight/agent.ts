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
import { flightManagerOutputSchema } from './manager-output.js';
import { flightTools } from './tools/index.js';

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
  const suggestions = context?.flight?.suggestedQuestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return 'none';
  }

  return suggestions.map((suggestion) => compactText(suggestion)).join('\n');
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
- Hydrated flight result records present (not validated): ${hasHydratedResults ? 'yes' : 'no'}.

### Current Existing Search Parameters — Fallback Context

The latest user message is the highest authority. These Current Existing Search Parameters are fallback values for fields the user did not mention; they never override an explicit new value in the latest message.

Priority order when fields conflict: (1) current explicit user input in the latest message, (2) these Current Existing Search Parameters and hydrated flight context for fields the latest message does not mention, (3) older chat history only to fill still-missing fields. Older history never overrides steps 1 or 2.

Parameters cover departure location, arrival location, outbound date, return date, passengers, trip type, cabin class, segments, booking/page state, and generated contracts availability.

- Existing search parameters: ${buildActiveSearchSummary(context)}
- Current price-prediction route codes: ${buildPricePredictionRouteSummary(context)}.
- Active filter source options: ${compactText(buildActiveFilterOptionsSummary(context))}

### Already applied filters that belong to the current search

${buildAppliedFiltersSummary(context)}

- Already-applied filters are valid only when they belong to this same current route/date/passenger/cabin search. Filters from an older or different search are excluded above and must not be treated as active.
- This list reflects filters applied in earlier turns only. A filter applied in the current turn is reported by the \`apply_filter\` tool result (its \`activeFilters\` field), not here.
- Do not generate suggested questions that re-apply or duplicate any active filter. If most or all common filters are already applied, suggest result reasoning or offer to remove or relax an active filter instead.

### Previous suggested questions stored in context.summary.suggestedQuestions

${buildPreviousSuggestedQuestionsSummary(context)}

### Required turn behavior

- Apply the latest message as a partial update. Reuse every unchanged route, date, trip, passenger, cabin, and active-filter value shown above.
- Do not ask again for departure location, arrival location, dates, trip type, passengers, or cabin when available above or in relevant conversation history.
- If the user says “actually make it X” after naming an arrival location, treat X as the updated arrival location unless current wording explicitly changes the departure location.
- Normal search intent such as “find flights next week” uses flight_search. Only explicit fare/date intelligence uses price_prediction_tool.
- A follow-up such as “any cheaper dates?” is explicit fare/date intelligence. Use the current search route and dates, then call price_prediction_tool before answering; current contract prices cannot establish cheaper dates. Do not ask for a specific airport when the current city or metropolitan route code is available above.
- For explicit price intelligence with vague timing, derive the requested range from the current turn clock before calling price_prediction_tool.
- “Remove all filters” means one apply_filter call with a single reset entry, not one removal call per active filter. Do not start a new flight search for that request. Stop after the reset succeeds.
- If a date-intelligence request is missing the departure location or arrival location, retain any supplied timing and ask only for the missing endpoint.
- Use fresh generated-contract context for every current-option comparison or recommendation.
- Use only the active source options shown above for airline and airport filters.
- Tool recovery metadata is authoritative feedback: repair only listed fields, retry only with a changed safe payload, and ask only when the correction remains materially ambiguous.
- Suggested questions are optional. Call their tool at most once after core work; never retry it or let it block a successful result.

### Manager tool mode — final output only
You are an internal specialist called by the Manager. Complete the scoped Flight task using all the search, filter, context, verification, and recovery rules above. Your final output is structured feedback to the Manager, not a reply to the user. This section overrides earlier instructions about the wording of a final user answer, asking the user directly, or ending with the per-person price note.

Return only the required structured fields: status, completedTask, resultSummary, and missingInformation. Set completedTask to the concrete Flight work actually done, not a planned action. Keep resultSummary to concise verified facts or a short safe failure explanation; do not draft polished conversational prose or enumerate flight cards. Set status to success only when the assigned task was fulfilled, partial when useful work remains but another part is unresolved, needs_input when a blocking user detail is required, and failure when no useful result could be produced. For needs_input, put only the smallest useful question or missing fields in missingInformation; otherwise use an empty array.

Translate earlier "ask the user" directions into needs_input feedback for the Manager. When a requested numbered option is unavailable in the current filtered results, report that limitation and the available count; do not request a date or other search detail already present in context. Apply the earlier prediction wording rules to resultSummary, but never expose internal tool failures, IDs, search keys, payloads, or reasoning. Flight cards and context updates remain in shared application state. Do not include card arrays or the exact per-person price note in this output; the Manager receives verified presentation guidance separately.

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
  outputType: flightManagerOutputSchema,
});
