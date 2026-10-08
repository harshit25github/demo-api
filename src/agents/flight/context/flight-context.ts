import {
  finiteNumber,
  firstNonEmptyString,
  flightSegmentsFromSearch,
  isRecord,
  mergeFlightSearchStates,
  nonEmptyString,
  nonNegativeInteger,
  normalizePassengerData,
  normalizeResolvedLocation,
  partialFlightSearchState,
  readFlightSearchState,
  writeFlightSearchState,
} from './search-state.js';
import {
  getFlightSearchRuntime,
  initializeFlightSearchRuntime,
  updateFlightSearchRuntime,
} from './search-runtime-store.js';
import type { FlightAppContext, FlightContext } from '../types.js';

type MutableRecord = Record<string, any>;

export const PROD_FLIGHT_CONTEXT_KEYS = Object.freeze([
  'pax',
  'uid',
  'cntKey',
  'deeplink',
  'tripType',
  'searchKey',
  'cabinClass',
  'showFlight',
  'inboundDate',
  'redirectUrl',
  'outboundDate',
  'bookingStatus',
  'segments',
  'passengerData',
  'searchResults',
  'departAirports',
  'resolvedOrigin',
  'depLandAirports',
  'resolvedDestination',
  'directFlightOnly',
  'totalResultsFound',
  '_awaitingWebSearch',
  'suggestedQuestions',
  'lastPricePrediction',
  'airlineFilterOptions',
  'layoverAirportFilterOptions',
  'flight_estimated_cost_total',
  'flight_estimated_cost_per_person',
]);

const LEGACY_TOP_LEVEL_FLIGHT_KEYS = Object.freeze([
  'UID',
  'uid',
  'cntKey',
  'deeplink',
  'tripType',
  'searchKey',
  'sid',
  'cabinClass',
  'showFlight',
  'inboundDate',
  'redirectUrl',
  'outboundDate',
  'departureDate',
  'returnDate',
  'return_date',
  'bookingStatus',
  'origin',
  'destination',
  'onds',
  'segments',
  'passengers',
  'passengerData',
  'pax',
  'flightResults',
  'filteredFlightResults',
  'generatedContracts',
  'contracts',
  'DepartAirports',
  'DepLandAirports',
  'departAirports',
  'depLandAirports',
  'resolvedOrigin',
  'resolvedDestination',
  'directFlightOnly',
  'totalResultsFound',
  '_awaitingWebSearch',
  'suggestedQuestions',
  'lastPricePrediction',
  'airlineFilterOptions',
  'airlineFilters',
  'layoverAirportFilterOptions',
  'layoverAirportFilters',
  'departureAirportFilterOptions',
  'departureAirportFilters',
  'arrivalAirportFilterOptions',
  'arrivalAirportFilters',
  'lastSearch',
  'searchParams',
  'lastAppliedFilters',
  'lastFinalFilterPayload',
  'lastApplyFilterPayload',
  'lastApplyFilterFeedback',
  'lastGeneratedContractsContext',
  'flightSearchOptionSources',
  'flight_estimated_cost_total',
  'flight_estimated_cost_per_person',
]);

function hasOwn(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function firstDefined(...values: any[]): any {
  return values.find((value) => value !== undefined);
}

function firstArray(...values: unknown[]): any[] | undefined {
  return values.find(Array.isArray);
}

export function resultCount(searchResults: unknown): number | null {
  if (Array.isArray(searchResults)) {
    return searchResults.length;
  }
  if (!isRecord(searchResults)) {
    return null;
  }
  const records = firstArray(
    searchResults.flights,
    searchResults.contracts,
    searchResults.results,
    searchResults.data,
  );
  return records ? records.length : null;
}

export function createProdFlightContext(source: MutableRecord = {}): FlightContext {
  const context = isRecord(source.flight) ? source : { ...source, flight: source };
  const flight = isRecord(context.flight) ? context.flight : {};
  const state = readFlightSearchState(context);
  const passengerData = normalizePassengerData(
    firstDefined(flight.passengerData, context.passengerData, state.passengers),
    firstDefined(flight.pax, context.pax),
  );
  const searchResults = firstDefined(
    flight.searchResults,
    context.filteredFlightResults,
    context.flightResults,
    context.generatedContracts,
    context.contracts,
    null,
  );
  const origin = state.origin || null;
  const destination = state.destination || null;
  const countedResults = resultCount(searchResults);

  return {
    pax: nonNegativeInteger(firstDefined(flight.pax, context.pax), passengerData.total) || 1,
    uid: hasOwn(flight, 'uid')
      ? nonEmptyString(flight.uid) || ''
      : firstNonEmptyString(context.uid, context.UID) || '',
    cntKey: firstNonEmptyString(flight.cntKey, context.cntKey) || '',
    deeplink: firstDefined(flight.deeplink, context.deeplink, null),
    tripType: state.trip_type || 'oneway',
    searchKey: isRecord(source.flight)
      ? nonEmptyString(flight.searchKey) || ''
      : firstNonEmptyString(context.searchKey, context.sid) || '',
    cabinClass: state.cabin_class || 'economy',
    showFlight:
      typeof firstDefined(flight.showFlight, context.showFlight) === 'boolean'
        ? firstDefined(flight.showFlight, context.showFlight)
        : Boolean(countedResults),
    inboundDate: state.return_date || '',
    redirectUrl: firstDefined(flight.redirectUrl, context.redirectUrl, null),
    outboundDate: state.outbound_date || null,
    bookingStatus: firstDefined(flight.bookingStatus, context.bookingStatus, null),
    segments: flightSegmentsFromSearch(state),
    passengerData,
    searchResults,
    departAirports:
      firstArray(
        flight.departAirports,
        context.departAirports,
        context.DepartAirports,
        context.departureAirportFilterOptions,
        context.departureAirportFilters,
      ) || [],
    resolvedOrigin: normalizeResolvedLocation(
      {
        ...firstDefined(flight.resolvedOrigin, context.resolvedOrigin, {}),
        ...('origin_iata' in state ? { userCity: origin, airportIATA: state.origin_iata } : {}),
        ...('origin_airport_name' in state ? { airportName: state.origin_airport_name } : {}),
      },
      origin,
    ),
    depLandAirports:
      firstArray(
        flight.depLandAirports,
        context.depLandAirports,
        context.DepLandAirports,
        context.arrivalAirportFilterOptions,
        context.arrivalAirportFilters,
      ) || [],
    resolvedDestination: normalizeResolvedLocation(
      {
        ...firstDefined(flight.resolvedDestination, context.resolvedDestination, {}),
        ...('destination_iata' in state ? { userCity: destination, airportIATA: state.destination_iata } : {}),
        ...('destination_airport_name' in state ? { airportName: state.destination_airport_name } : {}),
      },
      destination,
    ),
    directFlightOnly: Boolean(
      firstDefined(flight.directFlightOnly, context.directFlightOnly, false),
    ),
    totalResultsFound: nonNegativeInteger(
      firstDefined(flight.totalResultsFound, context.totalResultsFound),
      countedResults || 0,
    ),
    _awaitingWebSearch: Boolean(
      firstDefined(flight._awaitingWebSearch, context._awaitingWebSearch, false),
    ),
    suggestedQuestions:
      firstArray(flight.suggestedQuestions, context.suggestedQuestions) || [],
    lastPricePrediction: firstDefined(
      flight.lastPricePrediction,
      context.lastPricePrediction,
      null,
    ),
    airlineFilterOptions: firstDefined(
      flight.airlineFilterOptions,
      context.airlineFilterOptions,
      context.airlineFilters,
      null,
    ),
    layoverAirportFilterOptions: firstDefined(
      flight.layoverAirportFilterOptions,
      context.layoverAirportFilterOptions,
      context.layoverAirportFilters,
      null,
    ),
    flight_estimated_cost_total: finiteNumber(
      firstDefined(flight.flight_estimated_cost_total, context.flight_estimated_cost_total),
    ),
    flight_estimated_cost_per_person: finiteNumber(
      firstDefined(
        flight.flight_estimated_cost_per_person,
        context.flight_estimated_cost_per_person,
      ),
    ),
  };
}

function removeLegacyTopLevelFlightAliases(appContext: MutableRecord): void {
  for (const key of LEGACY_TOP_LEVEL_FLIGHT_KEYS) {
    delete appContext[key];
  }
}

function migrateLegacySearchRuntime(
  appContext: MutableRecord,
  flightContext: FlightContext,
): void {
  const searchKey = flightContext.searchKey;
  if (!searchKey) {
    return;
  }
  const sourceFlights = Array.isArray(appContext.flightResults)
    ? appContext.flightResults
    : Array.isArray(flightContext.searchResults)
      ? flightContext.searchResults
      : [];
  const existingRuntime = getFlightSearchRuntime(searchKey);
  if (!existingRuntime) {
    initializeFlightSearchRuntime(searchKey, sourceFlights);
  }
  if (Array.isArray(appContext.lastAppliedFilters)) {
    updateFlightSearchRuntime(searchKey, {
      appliedFilters: appContext.lastAppliedFilters,
      finalFilterPayload: Array.isArray(appContext.lastFinalFilterPayload)
        ? appContext.lastFinalFilterPayload
        : [],
      lastApplyFilterPayload: appContext.lastApplyFilterPayload || null,
      feedback: Array.isArray(appContext.lastApplyFilterFeedback)
        ? appContext.lastApplyFilterFeedback
        : [],
    });
  }
}

export function ensureFlightRuntimeContext(context: unknown = {}): FlightAppContext {
  const appContext = isRecord(context) ? context : {};
  appContext.flight = createProdFlightContext(appContext);
  delete appContext.flightDate;
  migrateLegacySearchRuntime(appContext, appContext.flight);
  appContext.toolCallLog = Array.isArray(appContext.toolCallLog) ? appContext.toolCallLog : [];
  removeLegacyTopLevelFlightAliases(appContext);
  return appContext as FlightAppContext;
}

export function getFlightSearchState(context: MutableRecord = {}): MutableRecord {
  const appContext = isRecord(context.flight)
    ? context
    : { flight: createProdFlightContext(context) };
  return readFlightSearchState(appContext);
}

export function prepareFlightAgentTurnContext(
  context: MutableRecord,
  { requestId = null, sessionId = null }: {
    requestId?: string | null;
    sessionId?: string | null;
  } = {},
): FlightAppContext {
  const appContext = ensureFlightRuntimeContext(context);
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  if (!appContext.flight.searchKey) {
    appContext.flight.suggestedQuestions = [];
  }
  return appContext;
}

function mergeFlightMetadata(
  baseFlight: FlightContext,
  incomingContext: MutableRecord,
): FlightContext {
  const incomingFlight = createProdFlightContext(incomingContext);
  const rawFlight = isRecord(incomingContext?.flight) ? incomingContext.flight : incomingContext;
  const merged = { ...baseFlight };
  const simpleStringFields = ['uid', 'cntKey', 'searchKey', 'cabinClass', 'bookingStatus'];
  for (const key of simpleStringFields) {
    if (nonEmptyString(incomingFlight[key])) {
      merged[key] = incomingFlight[key];
    }
  }
  for (const key of ['deeplink', 'redirectUrl', 'lastPricePrediction']) {
    if (hasOwn(rawFlight, key) && incomingFlight[key] !== null) {
      merged[key] = incomingFlight[key];
    }
  }
  for (const key of [
    'showFlight',
    'directFlightOnly',
    '_awaitingWebSearch',
  ]) {
    if (hasOwn(rawFlight, key) && typeof incomingFlight[key] === 'boolean') {
      merged[key] = incomingFlight[key];
    }
  }
  for (const key of [
    'searchResults',
    'departAirports',
    'depLandAirports',
    'suggestedQuestions',
    'airlineFilterOptions',
    'layoverAirportFilterOptions',
  ]) {
    if (hasOwn(rawFlight, key) && incomingFlight[key] !== undefined) {
      merged[key] = incomingFlight[key];
    }
  }
  for (const key of [
    'totalResultsFound',
    'flight_estimated_cost_total',
    'flight_estimated_cost_per_person',
  ]) {
    if (hasOwn(rawFlight, key) && incomingFlight[key] !== null) {
      merged[key] = incomingFlight[key];
    }
  }
  if (hasOwn(rawFlight, 'resolvedOrigin')) {
    merged.resolvedOrigin = incomingFlight.resolvedOrigin;
  }
  if (hasOwn(rawFlight, 'resolvedDestination')) {
    merged.resolvedDestination = incomingFlight.resolvedDestination;
  }
  return merged;
}

export function mergeFlightAgentContext(
  existingContext: unknown,
  incomingContext: unknown,
) {
  if (!isRecord(existingContext)) {
    return ensureFlightRuntimeContext(incomingContext || {});
  }
  if (!isRecord(incomingContext) || existingContext === incomingContext) {
    return ensureFlightRuntimeContext(existingContext);
  }

  const target = ensureFlightRuntimeContext(existingContext);
  const previousFlight = target.flight;
  const previousSearch = getFlightSearchState(target);
  const incomingSearch = readFlightSearchState(incomingContext);

  for (const [key, value] of Object.entries(incomingContext)) {
    if (key !== 'flight' && key !== 'flightDate' && !LEGACY_TOP_LEVEL_FLIGHT_KEYS.includes(key)) {
      target[key] = value;
    }
  }

  target.flight = mergeFlightMetadata(previousFlight, incomingContext);
  writeFlightSearchState(
    target.flight,
    mergeFlightSearchStates(previousSearch, incomingSearch),
  );
  delete target.flightDate;
  removeLegacyTopLevelFlightAliases(target);
  return target;
}

export function setActiveFlightSearch(context: MutableRecord, input: MutableRecord) {
  const appContext = ensureFlightRuntimeContext(context);
  writeFlightSearchState(appContext.flight, partialFlightSearchState(input));
  return appContext;
}
