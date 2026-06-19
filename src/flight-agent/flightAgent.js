import { Agent, setDefaultOpenAIKey } from '@openai/agents';
import { assertOpenAIConfig, flightAgentConfig } from './config.js';
import { FLIGHT_PROMPT } from './instructions.js';
import { flightTools } from './tools/index.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey);

function buildActiveSearchSummary(context) {
  const lastSearch = context?.lastSearch;
  if (!lastSearch) {
    return 'none';
  }

  return JSON.stringify({
    onds: lastSearch.onds,
    trip_type: lastSearch.trip_type,
    passengers: lastSearch.passengers,
    cabin_class: lastSearch.cabin_class,
  });
}

function summarizeFilterOptions(options = []) {
  const list = Array.isArray(options) ? options : [];
  return list
    .filter((option) => option && option.IsDisabled !== true)
    .map((option) => ({
      Code: option.Code,
      Text: option.Text || option.Name || option.AirportCityName || null,
      AirportCityName: option.AirportCityName || null,
      IsNearby: Boolean(option.IsNearby),
    }));
}

function buildActiveFilterOptionsSummary(context) {
  return JSON.stringify({
    airlines: summarizeFilterOptions(context?.airlineFilterOptions || context?.airlineFilters),
    layoverAirports: summarizeFilterOptions(
      context?.layoverAirportFilterOptions || context?.layoverAirportFilters,
    ),
    departureAirports: summarizeFilterOptions(
      context?.DepartAirports ||
        context?.departureAirportFilterOptions ||
        context?.departureAirportFilters,
    ),
    arrivalAirports: summarizeFilterOptions(
      context?.DepLandAirports ||
        context?.arrivalAirportFilterOptions ||
        context?.arrivalAirportFilters,
    ),
  });
}

export function buildFlightAgentInstructions(runContext) {
  const context = runContext?.context || {};
  const hasActiveSearch = Boolean(context.searchKey || context.sid);
  const hasCurrentResults = Boolean(
    context.filteredFlightResults?.length ||
      context.flightResults?.length ||
      context.generatedContracts?.length ||
      context.contracts?.length,
  );
  return `${FLIGHT_PROMPT}

Current search state:
- UID is available in context.
- Active search exists: ${hasActiveSearch ? 'yes' : 'no'}.
- Current flight result records available in shared context: ${hasCurrentResults ? 'yes' : 'no'}.
- Existing search parameters: ${buildActiveSearchSummary(context)}
- Active filter source options: ${buildActiveFilterOptionsSummary(context)}
- For a partial core-search change, reuse every unchanged existing search parameter above.
- Do not ask again for origin, destination, dates, trip type, passengers, or cabin when already available above.
- For cheapest/best/compare/shortest-duration/current-option reasoning, call getGeneratedContractsContext even when cards are not shown in chat history.
- If the user asks what airline, layover-airport, departure-airport, arrival-airport, alternate, or nearby options are available, answer from Active filter source options without calling tools.
- If the user asks to use, apply, select, keep, or show one of those options, call apply_filter using the active searchKey.
`;
}

export const FlightAgent = new Agent({
  name: 'FlightAgent',
  instructions: buildFlightAgentInstructions,
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: flightTools,
});
