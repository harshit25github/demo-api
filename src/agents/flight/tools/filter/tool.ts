import { tool } from '@openai/agents';
import { modelFacingToolOutput } from '../model-output.js';
import { getRequestState, getScopedRequestText } from '../../../../shared/runtime/request-context.js';
import {
  getFlightSearchRuntime,
  initializeFlightSearchRuntime,
  updateFlightSearchRuntime,
} from '../../context/search-runtime-store.js';
import { log } from '../../../../shared/logging/logger.js';
import {
  applyFilterSchema,
  normalizeApplyFilter,
  type FlightFilter,
  type SourceOption,
} from './normalization.js';
import {
  buildRemovalFilterPayloads,
  mergeApplyFilterState,
  mergeFinalAndRemovalPayloads,
} from './filter-state.js';
import {
  applyFilters,
  buildFinalFilterPayload,
  getSearchResultFlights,
} from './payload.js';
import type { FlightAppContext } from '../../types.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  recordFlightToolFailure,
  recordFlightToolSuccess,
} from '../recovery.js';

function standaloneClearAllRequest(value: unknown): boolean {
  const message = String(value || '').trim().replace(/\s+/g, ' ');
  return /^(?:please\s+)?(?:remove|clear|reset|drop|delete)\s+(?:all|every)\s+(?:the\s+)?(?:current\s+)?(?:flight\s+)?filters(?:\s+(?:from|on)\s+(?:the\s+|my\s+)?(?:current\s+)?(?:flight\s+)?(?:results|search|flights))?[.!?\s]*$/i.test(message);
}

function resetFilter(rawUserFilter: string): FlightFilter {
  return {
    filterType: 'reset', filterCode: null,
    minDurationMinutes: null, maxDurationMinutes: null,
    minPrice: null, maxPrice: null,
    airlineNames: null, layoverAirportNames: null,
    departureAirportNames: null, arrivalAirportNames: null,
    rawUserFilter,
  };
}

export const ApplyFilterTool = tool({
  name: 'apply_filter',
  description:
    'Apply every filter addition/removal explicitly requested in the current user message to an active search in one call. Never call this tool, including reset, merely to inspect, compare, rank, recommend, or recover options from an empty filtered set; those tasks preserve all active filters. Standalone clear-all is allowed only when the user explicitly asks to clear every filter and uses one reset entry with other fields null; a mixed explicit reset-and-add request includes reset plus the requested additions. Preserve each operation clause in rawUserFilter, excluding unrelated reset wording from additions. Do not remove every type separately; filters=[] is invalid. Requires context.flight.searchKey from a successful search; when absent, create the requested search from reliable route/date context before filtering. Airline/airport names and group wording are resolved against complete current arrays, even if prompt summaries are abbreviated. Baggage: checked=0, carry-on=1, personal item=2. Times: EARLYMORNING, MORNING, AFTERNOON, EVENING. Stops: non-stop=0, one stop=2, two-or-more=3. Duration and price are maximum-only. Read the complete returned filters list, feedback, and count before claiming any constraint was applied.',
  parameters: applyFilterSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction('apply_filter', {
    requiredFields: ['filters'],
  }),
  execute(input, context) {
    const appContext = getRequestState(context?.context as FlightAppContext);
    const flightContext = appContext.flight;
    // Filter intent is parsed out of the user's own words, so this must be the
    // FLIGHT subtask, not the whole turn: on "find flights to Dubai and plan my
    // trip", trip-planning words must not reach the filter parser. Under the
    // Manager the SDK supplies that subtask as the nested run's `toolInput`;
    // running standalone there is none, so the turn message is the fallback.
    const requestedFilterText = getScopedRequestText(context, appContext.currentUserMessage);
    const filters = standaloneClearAllRequest(requestedFilterText)
      ? [resetFilter(requestedFilterText)] : input.filters;

    // UID comes from SDK run context and will be sent to the real API.
    // TODO: Read UID from context
    const UID = flightContext.uid;

    // searchKey is written by FlightSearchTool and identifies active results.
    // Without it, apply-filter has no search result set to filter.
    // TODO: Read searchKey from context
    const searchKey = flightContext.searchKey;

    if (!searchKey) {
      log('info', 'apply_filter.missing_search', {
        requestId: appContext.requestId,
        sessionId: appContext.sessionId,
        UID,
        filters,
      });

      const failure = createFlightToolFailure({
        code: 'MISSING_SEARCH',
        message: 'No active flight search exists. If complete search intent is already available, create the search before applying filters; otherwise ask only for the genuinely missing blocking field.',
        retrySafe: true,
        requiredState: ['context.flight.searchKey'],
        fieldIssues: [
          {
            path: 'context.flight.searchKey',
            problem: 'A successful flight search must exist before filters can be applied.',
          },
        ],
        details: { feedback: [] },
      });
      return recordFlightToolFailure({
        appContext,
        toolName: 'apply_filter',
        failure,
        input,
      });
    }

    // Existing filters are the active state from earlier apply_filter turns.
    const searchRuntime =
      getFlightSearchRuntime(searchKey) ||
      initializeFlightSearchRuntime(
        searchKey,
        getSearchResultFlights(flightContext.searchResults),
      );
    const existingFilters = (searchRuntime?.appliedFilters || []) as FlightFilter[];

    // New filters are only what the latest user turn requested.
    // The application adds the active search's airline array to shared SDK context.
    // Airline codes must only be resolved from this context array, never from a static map.
    const airlineFilterOptions =
      (flightContext.airlineFilterOptions as SourceOption[] | null) || [];
    // The application adds the active search's layover airport array to shared SDK context.
    // Codes must only be resolved from this context array, never generated manually.
    const layoverAirportFilterOptions =
      (flightContext.layoverAirportFilterOptions as SourceOption[] | null) || [];
    // Departure and arrival airport filters use the API arrays returned by flight_search.
    // Do not generate airport codes manually; only use Code from these source arrays.
    const departureAirportFilterOptions = flightContext.departAirports as SourceOption[];
    const arrivalAirportFilterOptions = flightContext.depLandAirports as SourceOption[];
    const { feedback, normalizedFilters: newFilters } = normalizeApplyFilter(
      filters,
      airlineFilterOptions,
      layoverAirportFilterOptions,
      departureAirportFilterOptions,
      arrivalAirportFilterOptions,
    );

    // Merge state: add new checkbox values, remove explicit values, and
    // replace only the requested filter type for "only/instead/change".
    const updatedFilters = mergeApplyFilterState(existingFilters, newFilters);

    // Final API-ready array in the exact Apply Filter API format.
    // TODO: Build real Apply Filter API payload here using UID, searchKey, and updated filters.
    const removalPayloads = buildRemovalFilterPayloads(existingFilters, newFilters, updatedFilters);
    const finalFilterPayload = mergeFinalAndRemovalPayloads(
      buildFinalFilterPayload(updatedFilters),
      removalPayloads,
    );
    console.log('FINAL_APPLY_FILTER_PAYLOAD', finalFilterPayload);

    const applyFilterApiPayload = {
      UID,
      searchKey,
      filters: finalFilterPayload,
    };

    // TODO: Pass `finalFilterPayload` to the real Apply Filter API.
    // TODO: Call real Apply Filter API here.
    //
    // Example real API integration:
    //
    // const payload = buildApplyFilterPayload({
    //   uid: UID,
    //   searchKey,
    //   filters: finalFilterPayload,
    // });
    //
    // const apiResponse = await applyFilterApi(payload);
    //
    // return mapApplyFilterResponse(apiResponse);

    // TODO: Remove dummy response once real API integration is done.
    const baseFlights = searchRuntime?.sourceFlights || [];
    const filteredFlights = applyFilters(baseFlights, updatedFilters).map((contract) => ({
      ...contract,
      display: true,
    }));

    // Keep only prod-owned visible results in context. Dummy-only active filter
    // state remains in the runtime store behind searchKey.
    flightContext.searchResults = filteredFlights;
    flightContext.suggestedQuestions = [];
    flightContext.totalResultsFound = filteredFlights.length;
    flightContext.showFlight = true;
    flightContext.directFlightOnly = updatedFilters.some(
      (filter) => filter.filterType === 'stops' && filter.filterCode === '0',
    );
    updateFlightSearchRuntime(searchKey, {
      visibleFlights: filteredFlights,
      appliedFilters: updatedFilters,
      finalFilterPayload,
      lastApplyFilterPayload: applyFilterApiPayload,
      feedback,
    });
    const recovery = recordFlightToolSuccess({ appContext, toolName: 'apply_filter' });
    appContext.toolCallLog.push({
      tool: 'apply_filter',
      ok: true,
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      apiPayload: applyFilterApiPayload,
      feedback,
      ...(recovery || {}),
    });

    log('info', 'apply_filter.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID,
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      feedback,
      resultCount: filteredFlights.length,
    });

    // TODO: Map real API response into tool output format here.
    return modelFacingToolOutput('apply_filter', {
      ok: true,
      source: 'dummy',
      message: 'Sample filtered flight results only. No live API was called.',
      UID,
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      apiPayload: applyFilterApiPayload,
      feedback,
      summary: {
        originalCount: baseFlights.length,
        filteredCount: filteredFlights.length,
      },
      flights: filteredFlights,
    });
  },
});
