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
        departure_time: '09:00',
        arrival_time: '11:10',
        departure_time_window: 'MORNING',
        arrival_time_window: 'MORNING',
        duration: '2h 10m',
        total_duration_hours: 2.17,
        total_duration_minutes: 130,
        layover_duration_hours: 0,
        layover_duration_minutes: 0,
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
        departure_time: '14:30',
        arrival_time: '17:05',
        departure_time_window: 'AFTERNOON',
        arrival_time_window: 'EVENING',
        duration: '2h 35m',
        total_duration_hours: 2.58,
        total_duration_minutes: 155,
        layover_duration_hours: 0.75,
        layover_duration_minutes: 45,
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
        departure_time: '05:45',
        arrival_time: '13:40',
        departure_time_window: 'EARLYMORNING',
        arrival_time_window: 'AFTERNOON',
        duration: '7h 55m',
        total_duration_hours: 7.92,
        total_duration_minutes: 475,
        layover_duration_hours: 2.25,
        layover_duration_minutes: 135,
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
  appContext.UID ||= 'demo-user';
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
    appContext.lastSearch = input;
    appContext.flightResults = result.flights;
    appContext.filteredFlightResults = result.flights;
    // Real API integration should save its layover airport filter array into
    // appContext.layoverAirportFilterOptions for ApplyFilterTool follow-up turns.

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
