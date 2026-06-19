import { tool } from '@openai/agents';
import { z } from 'zod';
import { log } from '../logger.js';

const flightSearchSchema = z.object({
  onds: z
    .array(
      z.object({
        origin: z
          .string()
          .describe('Origin city, airport, or IATA code, for example Delhi or DEL.'),
        destination: z
          .string()
          .describe('Destination city, airport, or IATA code, for example Mumbai or BOM.'),
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

function createSearchKey(UID) {
  return `search_${UID}_${Date.now()}`;
}

const dummyAirlineFilters = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'CA', Text: 'Air China', Name: 'Air China', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: 'QR', Text: 'Qatar Airways', Name: 'Qatar Airways', IsDisabled: false },
  { Code: '6E', Text: 'IndiGo', Name: 'IndiGo', IsDisabled: true },
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

function getDummyAirportFiltersForLocation(location) {
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

function buildDummyFlights({ onds, trip_type, passengers, cabin_class }) {
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

function getFlightContext(runContext) {
  const appContext = runContext?.context || {};
  // UID is stable per chat/user and is reused by later tools such as apply_filter.
  appContext.UID ||= appContext.uid || 'demo-user';
  appContext.uid ||= appContext.UID;
  appContext.toolCallLog ||= [];
  return appContext;
}

export const FlightSearchTool = tool({
  name: 'flight_search',
  description:
    'Search for flights when origin, destination, travel date, trip type, passengers, and cabin class are known. Returns dummy sample flight data only.',
  parameters: flightSearchSchema,
  strict: true,
  execute(input, context) {
    const appContext = getFlightContext(context);
    const searchKey = createSearchKey(appContext.UID);
    const result = buildDummyFlights(input);

    result.UID = appContext.UID;
    result.searchKey = searchKey;

    // Store the latest search state in context for follow-up filter turns.
    appContext.searchKey = searchKey;
    appContext.sid = searchKey;
    appContext.lastSearch = input;
    appContext.flightResults = result.flights;
    appContext.filteredFlightResults = result.flights;
    // Real API integration should save its dynamic filter arrays into context.
    // ApplyFilterTool uses these arrays as source of truth and never generates codes.
    appContext.airlineFilterOptions ||= dummyAirlineFilters;
    appContext.layoverAirportFilterOptions ||= dummyLayoverAirportFilters;
    appContext.DepartAirports ||= getDummyAirportFiltersForLocation(input.onds[0]?.origin);
    appContext.DepLandAirports ||= getDummyAirportFiltersForLocation(
      input.onds[input.onds.length - 1]?.destination,
    );
    appContext.departureAirportFilterOptions = appContext.DepartAirports;
    appContext.arrivalAirportFilterOptions = appContext.DepLandAirports;
    result.airlineFilterOptions = appContext.airlineFilterOptions;
    result.layoverAirportFilterOptions = appContext.layoverAirportFilterOptions;
    result.DepartAirports = appContext.DepartAirports;
    result.DepLandAirports = appContext.DepLandAirports;

    // A new search creates a new result set, so old filters must not leak in.
    appContext.lastAppliedFilters = [];
    appContext.lastFinalFilterPayload = [];
    appContext.lastApplyFilterPayload = null;
    appContext.lastApplyFilterFeedback = [];

    appContext.toolCallLog.push({ tool: 'flight_search', searchKey, input });

    log('info', 'flight_search.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID: appContext.UID,
      searchKey,
      input,
    });

    return result;
  },
});
