import { tool } from '@openai/agents';
import { modelFacingToolOutput } from './model-output.js';
import { z } from 'zod';
import { setActiveFlightSearch } from '../context/flight-context.js';
import {
  getRequestClock,
  getRequestState,
} from '../../../shared/runtime/request-context.js';
import type { FlightAppContext, FlightContext } from '../types.js';
import type { SourceOption } from './filter/normalization.js';
import { initializeFlightSearchRuntime } from '../context/search-runtime-store.js';
import { log } from '../../../shared/logging/logger.js';
import {
  addDays,
  getFlightSearchDateLimits,
  parseIsoDate,
  toIsoDate,
} from '../date/calendar.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  recordFlightToolFailure,
  recordFlightToolSuccess,
  type FlightToolFailure,
  type FlightToolFieldIssue,
} from './recovery.js';

const flightSearchSchema = z.object({
  onds: z
    .array(
      z.object({
        origin: z
          .string()
          .describe('One clean departure city/location name only, for example Delhi. Put DEL in origin_iata, not in this name.'),
        destination: z
          .string()
          .describe('One clean arrival city/location name only, for example New York. Put NYC in destination_iata, not in this name.'),
        origin_iata: z.string().nullish()
          .describe('Confirmed three-letter departure airport/metropolitan IATA code only, otherwise null.'),
        destination_iata: z.string().nullish()
          .describe('Confirmed three-letter arrival airport/metropolitan IATA code only, otherwise null.'),
        origin_airport_name: z.string().nullish()
          .describe('Explicit or confirmed departure airport name only, otherwise null. Never append it to origin.'),
        destination_airport_name: z.string().nullish()
          .describe('Explicit or confirmed arrival airport name only, otherwise null. Never append it to destination.'),
        outbound_date: z
          .string()
          .describe('Departure date in YYYY-MM-DD format when possible.'),
        return_date: z
          .string()
          .nullable()
          .describe('Return date for round trips, otherwise null.'),
      }),
    )
    .min(1)
    .describe('Origin-destination route segments for one-way, roundtrip, or multicity search.'),
  trip_type: z
    .enum(['oneway', 'roundtrip', 'multicity'])
    .describe('Trip type. Use oneway by default unless return date or multicity is requested.'),
  passengers: z
    .object({
      adults: z.number().int().min(1).describe('Adult passenger count. Default to 1.'),
      children: z.number().int().min(0).describe('Child passenger count. Default to 0.'),
      infants: z.number().int().min(0).describe('Infant passenger count. Default to 0.'),
    })
    .describe('Passenger counts.'),
  cabin_class: z
    .enum(['economy', 'premium_economy', 'business', 'first'])
    .describe('Coach or cabin class. Default to economy.'),
});

type FlightSearchInput = z.infer<typeof flightSearchSchema>;
type FlightFilterOptionKey =
  | 'airlineFilterOptions'
  | 'layoverAirportFilterOptions'
  | 'departAirports'
  | 'depLandAirports';

function createSearchKey(UID: string): string {
  return `search_${UID}_${Date.now()}`;
}

export function validateFlightSearchInput(
  input: FlightSearchInput,
  localDate?: string | null,
): FlightToolFailure | null {
  const fieldIssues: FlightToolFieldIssue[] = [];
  const today = parseIsoDate(localDate);
  const limits = localDate ? getFlightSearchDateLimits(localDate) : null;
  let previousOutbound: Date | null = null;

  input.onds.forEach((segment, index) => {
    const prefix = `onds.${index}`;
    if (!segment.origin.trim()) {
      fieldIssues.push({ path: `${prefix}.origin`, problem: 'Departure location is empty.' });
    }
    if (!segment.destination.trim()) {
      fieldIssues.push({ path: `${prefix}.destination`, problem: 'Arrival location is empty.' });
    }
    for (const endpoint of ['origin', 'destination'] as const) {
      const codeField = `${endpoint}_iata` as const;
      const code = segment[codeField];
      if (code != null && !/^[A-Z]{3}$/.test(code)) {
        fieldIssues.push({ path: `${prefix}.${codeField}`, problem: 'IATA must contain only three uppercase letters.' });
      } else if (code) {
        for (const nameField of [endpoint, `${endpoint}_airport_name` as const]) {
          if (new RegExp(`(?:^|[\\s(])${code}(?:$|[\\s)])`).test(segment[nameField] || '')) {
            fieldIssues.push({ path: `${prefix}.${nameField}`, problem: 'Name field includes its IATA code.',
              constraint: `Keep only the confirmed name here and preserve ${code} in ${codeField}.` });
          }
        }
      }
    }

    const outbound = parseIsoDate(segment.outbound_date);
    if (!outbound) {
      fieldIssues.push({
        path: `${prefix}.outbound_date`,
        problem: 'Departure date is not a valid YYYY-MM-DD calendar date.',
        constraint: 'Provide a valid YYYY-MM-DD date derived from the current turn clock and the user\'s allowed timing.',
      });
    } else {
      if (today && outbound <= today) {
        fieldIssues.push({
          path: `${prefix}.outbound_date`,
          problem: 'Departure date must be after the current local date.',
          acceptedValue: toIsoDate(addDays(today, 1)),
          constraint: 'Use the earliest accepted date only when the user allowed date flexibility.',
        });
      }
      if (limits && outbound > limits.maxDate) {
        fieldIssues.push({
          path: `${prefix}.outbound_date`,
          problem: 'Departure date is outside the flight search window.',
          acceptedValue: limits.maxDateString,
          constraint: `Departure must be on or before ${limits.maxDateString}; use this boundary only when the user allowed date flexibility.`,
        });
      }
      if (previousOutbound && outbound < previousOutbound) {
        fieldIssues.push({
          path: `${prefix}.outbound_date`,
          problem: 'Multi-city segment dates must be chronological.',
        });
      }
      previousOutbound = outbound;

      if (segment.return_date !== null) {
        const returnDate = parseIsoDate(segment.return_date);
        if (!returnDate) {
          fieldIssues.push({
            path: `${prefix}.return_date`,
            problem: 'Return date is not a valid YYYY-MM-DD calendar date.',
          });
        } else if (returnDate <= outbound) {
          fieldIssues.push({
            path: `${prefix}.return_date`,
            problem: 'Return date must be after the departure date.',
          });
        } else if (limits && returnDate > limits.maxDate) {
          fieldIssues.push({
            path: `${prefix}.return_date`,
            problem: 'Return date is outside the flight search window.',
            acceptedValue: limits.maxDateString,
            constraint: `Return must be on or before ${limits.maxDateString}.`,
          });
        }
      }
    }
  });

  if (input.trip_type === 'roundtrip' && !input.onds[0]?.return_date) {
    fieldIssues.push({
      path: 'onds.0.return_date',
      problem: 'Round-trip search requires return timing.',
      constraint: 'Use a reliable return date or trip duration; otherwise ask one narrow question.',
    });
  }

  if (fieldIssues.length === 0) return null;
  return createFlightToolFailure({
    code: 'INVALID_SEARCH_INPUT',
    message: 'The flight search input needs correction. Repair only the listed fields from reliable evidence and retry with a changed payload.',
    fieldIssues,
  });
}

const dummyAirlineFilters = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'CA', Text: 'Air China', Name: 'Air China', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: 'QR', Text: 'Qatar Airways', Name: 'Qatar Airways', IsDisabled: false },
  { Code: '6E', Text: 'IndiGo', Name: 'IndiGo', IsDisabled: true },
  { Code: 'UA', Text: 'United', Name: 'United', IsDisabled: false },
  { Code: 'UA+', Text: 'United', Name: 'United', IsDisabled: false },
];

const dummyLayoverAirportFilters = [
  { Code: 'AMS', Text: 'Amsterdam Schiphol', Name: null, AirportCityName: 'Amsterdam', IsDisabled: false },
  { Code: 'DXB', Text: 'Dubai', Name: null, AirportCityName: 'Dubai', IsDisabled: false },
  { Code: 'DOH', Text: 'Doha Hamad International Airport', Name: null, AirportCityName: 'Doha', IsDisabled: false },
  { Code: 'FRA', Text: 'Frankfurt Airport', Name: null, AirportCityName: 'Frankfurt', IsDisabled: false },
  { Code: 'SIN', Text: 'Singapore Changi', Name: null, AirportCityName: 'Singapore', IsDisabled: true },
];

const losAngelesAirportFilters = [
  {
    Code: 'LAX',
    Price: 341.23,
    Text: 'Los Angeles Intl',
    Name: null,
    Count: 241,
    IsNearby: false,
    IsDisabled: false,
    AirportCityName: null,
  },
  {
    Code: 'BUR',
    Price: 420.6,
    Text: 'Burbank Bob Hope Airport',
    Name: null,
    Count: 161,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: null,
  },
  {
    Code: 'ONT',
    Price: 316.4,
    Text: 'Ontario',
    Name: null,
    Count: 97,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: null,
  },
  {
    Code: 'SNA',
    Price: 399.40002,
    Text: 'Santa Ana John Wayne',
    Name: null,
    Count: 86,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: null,
  },
];

const newYorkAirportFilters = [
  {
    Code: 'JFK',
    Price: 520.1,
    Text: 'John F Kennedy Intl',
    Name: null,
    Count: 210,
    IsNearby: false,
    IsDisabled: false,
    AirportCityName: 'New York',
  },
  {
    Code: 'EWR',
    Price: 498.4,
    Text: 'Newark Liberty Intl',
    Name: null,
    Count: 178,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: 'Newark',
  },
  {
    Code: 'LGA',
    Price: 530.2,
    Text: 'LaGuardia',
    Name: null,
    Count: 96,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: 'New York',
  },
];

const dubaiAirportFilters = [
  {
    Code: 'DXB',
    Price: 610.35,
    Text: 'Dubai International',
    Name: null,
    Count: 170,
    IsNearby: false,
    IsDisabled: false,
    AirportCityName: 'Dubai',
  },
  {
    Code: 'DWC',
    Price: 655.8,
    Text: 'Al Maktoum International',
    Name: null,
    Count: 42,
    IsNearby: true,
    IsDisabled: false,
    AirportCityName: 'Dubai',
  },
];

const delhiAirportFilters = [
  {
    Code: 'DEL',
    Price: 730.15,
    Text: 'Indira Gandhi International',
    Name: null,
    Count: 190,
    IsNearby: false,
    IsDisabled: false,
    AirportCityName: 'Delhi',
  },
];

function getDummyAirportFiltersForLocation(location: string | undefined): SourceOption[] {
  const text = String(location || '').trim().toLowerCase();
  if (/\b(nyc|new york|jfk|ewr|newark|lga)\b/.test(text)) {
    return newYorkAirportFilters;
  }
  if (/\b(lax|los angeles|la)\b/.test(text)) {
    return losAngelesAirportFilters;
  }
  if (/\b(dubai|dxb|dwc)\b/.test(text)) {
    return dubaiAirportFilters;
  }
  if (/\b(delhi|del)\b/.test(text)) {
    return delhiAirportFilters;
  }
  return losAngelesAirportFilters;
}

function getSearchFilterOptions(
  flightContext: FlightContext,
  key: FlightFilterOptionKey,
  createDummyOptions: () => SourceOption[],
): SourceOption[] {
  const existing = flightContext[key];
  if (Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  const options = createDummyOptions();
  flightContext[key] = options;
  return options;
}

function buildDummyFlights({
  onds,
  trip_type,
  passengers,
  cabin_class,
}: FlightSearchInput): Record<string, any> {
  const firstOnd = onds[0];
  const lastOnd = onds[onds.length - 1];
  const passengerCount = passengers.adults + passengers.children + passengers.infants;

  return {
    source: 'dummy',
    message: 'Sample flight results only. No live API was called.',
    searchParams: {
      onds,
      trip_type,
      passengers,
      cabin_class,
    },
    summary: {
      route: `${firstOnd.origin} to ${lastOnd.destination}`,
      passengerCount,
      optionCount: 2,
    },
    flights: [
      {
        id: 'dummy-flight-1',
        airline: 'Air Canada',
        airline_code: 'AC',
        flight_number: 'AC 101',
        origin: firstOnd.origin,
        destination: firstOnd.destination,
        departure_airport_code: 'LAX',
        arrival_airport_code: 'LAX',
        departure_time: '09:00',
        arrival_time: '11:10',
        departure_time_window: 'MORNING',
        arrival_time_window: 'MORNING',
        duration: '2h 10m',
        total_duration_hours: 2.17,
        total_duration_minutes: 130,
        layover_duration_hours: 0,
        layover_duration_minutes: 0,
        layover_airport_codes: [],
        stops: 0,
        baggage: ['2', '1'],
        cabin_class,
        price: {
          amount: 199,
          currency: 'USD',
        },
      },
      {
        id: 'dummy-flight-2',
        airline: 'Air China',
        airline_code: 'CA',
        flight_number: 'CA 204',
        origin: firstOnd.origin,
        destination: firstOnd.destination,
        departure_airport_code: 'BUR',
        arrival_airport_code: 'ONT',
        departure_time: '14:30',
        arrival_time: '17:05',
        departure_time_window: 'AFTERNOON',
        arrival_time_window: 'EVENING',
        duration: '2h 35m',
        total_duration_hours: 2.58,
        total_duration_minutes: 155,
        layover_duration_hours: 0.75,
        layover_duration_minutes: 45,
        layover_airport_codes: ['AMS', 'DXB'],
        stops: 1,
        baggage: ['2', '1', '0'],
        cabin_class,
        price: {
          amount: 179,
          currency: 'USD',
        },
      },
      {
        id: 'dummy-flight-3',
        airline: 'Emirates',
        airline_code: 'EK',
        flight_number: 'EK 309',
        origin: firstOnd.origin,
        destination: firstOnd.destination,
        departure_airport_code: 'SNA',
        arrival_airport_code: 'SNA',
        departure_time: '05:45',
        arrival_time: '13:40',
        departure_time_window: 'EARLYMORNING',
        arrival_time_window: 'AFTERNOON',
        duration: '7h 55m',
        total_duration_hours: 7.92,
        total_duration_minutes: 475,
        layover_duration_hours: 2.25,
        layover_duration_minutes: 135,
        layover_airport_codes: ['DXB', 'DOH'],
        stops: 2,
        baggage: ['2'],
        cabin_class,
        price: {
          amount: 149,
          currency: 'USD',
        },
      },
    ],
  };
}

function getFlightContext(runContext: { context?: unknown } | undefined): FlightAppContext {
  return getRequestState(runContext?.context as FlightAppContext);
}

export const FlightSearchTool = tool({
  name: 'flight_search',
  description:
    'Run a requested new or changed search after departure location, arrival location, and outbound date are known from the scoped request, current context, or explicitly supplied history. Round trips also need return timing or a known duration; ask only for that blocker if missing. Passenger counts suffice; do not request child/infant ages. Reuse unchanged values and default only unknown optional fields. Do not re-search for existing-option reasoning or filter removal. Validation occurs before state mutation; input failures permit only changed, evidence-supported recovery. Returns dummy sample flight data until the production adapter is connected.',
  parameters: flightSearchSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction('flight_search', {
    requiredFields: ['onds', 'trip_type', 'passengers', 'cabin_class'],
  }),
  execute(input, context) {
    const appContext = getFlightContext(context);
    const failure = validateFlightSearchInput(
      input,
      getRequestClock(context?.context as object | undefined)?.localDate,
    );
    if (failure) {
      return recordFlightToolFailure({
        appContext,
        toolName: 'flight_search',
        failure,
        input,
      });
    }
    const uid = appContext.flight.uid || 'demo-user';
    const searchKey = createSearchKey(uid);
    const result: Record<string, any> = buildDummyFlights(input);
    result.flights = result.flights.map((contract: Record<string, unknown>) => ({
      ...contract,
      display: true,
    }));

    result.UID = uid;
    result.searchKey = searchKey;
    result.summary.optionCount = result.flights.length;

    // Store the latest search state in context for follow-up filter turns.
    appContext.flight.searchKey = searchKey;
    setActiveFlightSearch(appContext, input);
    const flightContext = appContext.flight;
    flightContext.searchKey = searchKey;
    flightContext.searchResults = result.flights;
    flightContext.suggestedQuestions = [];
    flightContext.showFlight = true;
    flightContext.bookingStatus = 'results_shown';
    flightContext.totalResultsFound = result.flights.length;
    flightContext.directFlightOnly = false;
    // Real API integration should save its dynamic filter arrays into context.
    // ApplyFilterTool uses these arrays as source of truth and never generates codes.
    flightContext.airlineFilterOptions = getSearchFilterOptions(
      flightContext,
      'airlineFilterOptions',
      () => dummyAirlineFilters,
    );
    flightContext.layoverAirportFilterOptions = getSearchFilterOptions(
      flightContext,
      'layoverAirportFilterOptions',
      () => dummyLayoverAirportFilters,
    );
    flightContext.departAirports = getSearchFilterOptions(
      flightContext,
      'departAirports',
      () => getDummyAirportFiltersForLocation(input.onds[0]?.origin),
    );
    flightContext.depLandAirports = getSearchFilterOptions(
      flightContext,
      'depLandAirports',
      () => getDummyAirportFiltersForLocation(input.onds[input.onds.length - 1]?.destination),
    );
    result.airlineFilterOptions = flightContext.airlineFilterOptions;
    result.layoverAirportFilterOptions = flightContext.layoverAirportFilterOptions;
    result.DepartAirports = flightContext.departAirports;
    result.DepLandAirports = flightContext.depLandAirports;

    // Dummy filter state lives outside the serialized context. The real API owns
    // equivalent state behind searchKey.
    initializeFlightSearchRuntime(searchKey, result.flights);

    const recovery = recordFlightToolSuccess({ appContext, toolName: 'flight_search' });
    appContext.toolCallLog.push({
      tool: 'flight_search',
      searchKey,
      input,
      ok: true,
      ...(recovery || {}),
    });

    log('info', 'flight_search.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID: uid,
      searchKey,
      input,
    });

    return modelFacingToolOutput('flight_search', result);
  },
});
