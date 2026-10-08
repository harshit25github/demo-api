import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplyFilterTool as ApplyFilterToolDefinition } from '../../src/agents/flight/tools/filter/tool.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import {
  PROD_FLIGHT_CONTEXT_KEYS,
  createProdFlightContext,
  ensureFlightRuntimeContext,
  getFlightSearchState,
} from '../../src/agents/flight/context/flight-context.js';
import {
  createRequestContext,
  getRequestClock,
  getRequestState,
} from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';

const ApplyFilterTool: any = ApplyFilterToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;

const expectedDefaultFlightContext = {
  pax: 1,
  uid: '',
  cntKey: '',
  deeplink: null,
  tripType: 'oneway',
  searchKey: '',
  cabinClass: 'economy',
  showFlight: false,
  inboundDate: '',
  redirectUrl: null,
  outboundDate: null,
  bookingStatus: null,
  segments: [{ date: '', origin: '', destination: '' }],
  passengerData: {
    total: 1,
    adults: 1,
    seniors: 0,
    children: 0,
    lapInfants: 0,
    seatInfants: 0,
    childrenAges: [],
  },
  searchResults: null,
  departAirports: [],
  resolvedOrigin: { userCity: null, airportIATA: null },
  depLandAirports: [],
  resolvedDestination: { userCity: null, airportIATA: null },
  directFlightOnly: false,
  totalResultsFound: 0,
  _awaitingWebSearch: false,
  suggestedQuestions: [],
  lastPricePrediction: null,
  airlineFilterOptions: null,
  layoverAirportFilterOptions: null,
  flight_estimated_cost_total: null,
  flight_estimated_cost_per_person: null,
};

const searchInput = {
  onds: [
    {
      origin: 'DEL',
      destination: 'BOM',
      outbound_date: '2026-09-10',
      return_date: null,
    },
  ],
  trip_type: 'oneway',
  passengers: { adults: 2, children: 0, infants: 0 },
  cabin_class: 'economy',
};

function assertExactProdFlightKeys(flight) {
  assert.deepEqual(Object.keys(flight), PROD_FLIGHT_CONTEXT_KEYS);
}

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

test('Flight context initializes with the exact prod keys and defaults', () => {
  const context = ensureFlightRuntimeContext({});

  assertExactProdFlightKeys(context.flight);
  assert.deepEqual(context.flight, expectedDefaultFlightContext);
  assert.equal(context.flightDate, undefined);
});

test('Legacy local fields hydrate into prod fields and are removed', () => {
  const context = ensureFlightRuntimeContext({
    UID: 'legacy-user',
    searchKey: 'legacy-search-key',
    lastSearch: searchInput,
    flightResults: [{ id: 'legacy-result' }],
    DepartAirports: [{ Code: 'DEL' }],
    DepLandAirports: [{ Code: 'BOM' }],
    flight: {
      uid: 'legacy-user',
      searchKey: 'legacy-search-key',
      clock: { localDate: '2026-08-04', timeZone: 'Asia/Kolkata' },
      dateIntent: { status: 'RESOLVED', searchDate: '2026-09-10' },
    },
  });

  assertExactProdFlightKeys(context.flight);
  assert.equal(context.flight.uid, 'legacy-user');
  assert.equal(context.flight.searchKey, 'legacy-search-key');
  assert.equal(context.flight.outboundDate, '2026-09-10');
  assert.equal(context.flight.resolvedOrigin.userCity, 'DEL');
  assert.equal(context.flight.resolvedDestination.userCity, 'BOM');
  assert.deepEqual(context.flight.searchResults, [{ id: 'legacy-result' }]);
  assert.equal(context.flightDate, undefined);
  for (const legacyKey of [
    'UID',
    'searchKey',
    'lastSearch',
    'flightResults',
    'DepartAirports',
    'DepLandAirports',
  ]) {
    assert.equal(Object.hasOwn(context, legacyKey), false);
  }
});

test('Request clock stays in ephemeral runtime and outside prod Flight context', () => {
  const context: any = { flight: createProdFlightContext() };
  const before = JSON.stringify(context);
  const requestContext = createRequestContext(
    context,
    createRequestClock({
      now: new Date('2026-08-04T10:00:00.000Z'),
      timeZone: 'Asia/Kolkata',
    }),
  );

  assertExactProdFlightKeys(context.flight);
  assert.deepEqual(getRequestClock(requestContext), {
    localDate: '2026-08-04',
    localDateTime: '2026-08-04T15:30:00+05:30',
    timeZone: 'Asia/Kolkata',
  });
  assert.equal(context.flightDate, undefined);
  assert.equal(JSON.stringify(context), before);
});

test('Request clocks stay isolated when two turns share durable session state', () => {
  const context = ensureFlightRuntimeContext({});
  const firstRequest = createRequestContext(context, createRequestClock({
    now: new Date('2026-07-31T10:00:00.000Z'),
    timeZone: 'Asia/Kolkata',
  }));
  const secondRequest = createRequestContext(context, createRequestClock({
    now: new Date('2026-08-01T10:00:00.000Z'),
    timeZone: 'America/New_York',
  }));

  assert.equal(getRequestState(firstRequest), context);
  assert.equal(getRequestState(secondRequest), context);
  assert.equal(getRequestClock(firstRequest)?.localDate, '2026-07-31');
  assert.equal(getRequestClock(firstRequest)?.timeZone, 'Asia/Kolkata');
  assert.equal(getRequestClock(secondRequest)?.localDate, '2026-08-01');
  assert.equal(getRequestClock(secondRequest)?.timeZone, 'America/New_York');
  assert.equal((context as any).runtime, undefined);
  assert.equal(context.flightDate, undefined);
});

test('Search and filter tools preserve the prod Flight schema', async () => {
  const context: any = {
    requestId: 'schema-request',
    sessionId: 'schema-session',
    flight: createProdFlightContext({ flight: { uid: 'schema-user' } }),
  };

  const searchResult = parseToolResult(
    await FlightSearchTool.invoke({ context }, JSON.stringify(searchInput), {}),
  );
  assert.ok(searchResult.searchKey);
  assertExactProdFlightKeys(context.flight);
  assert.equal(context.flight.searchKey, searchResult.searchKey);
  assert.equal(context.flight.pax, 2);

  const filterResult = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          {
            filterType: 'stops',
            filterCode: '0',
            minDurationMinutes: null,
            maxDurationMinutes: null,
            minPrice: null,
            maxPrice: null,
            airlineNames: null,
            layoverAirportNames: null,
            departureAirportNames: null,
            arrivalAirportNames: null,
            rawUserFilter: 'non-stop flights',
          },
        ],
      }),
      {},
    ),
  );
  assert.equal(filterResult.ok, true);
  assertExactProdFlightKeys(context.flight);
  assert.equal(context.flight.directFlightOnly, true);
  assert.equal(context.flight.searchKey, searchResult.searchKey);
});

test('A route change clears a stale resolved airport code', async () => {
  const context: any = {
    flight: createProdFlightContext({ flight: { uid: 'route-user' } }),
  };
  await FlightSearchTool.invoke({ context }, JSON.stringify(searchInput), {});

  const changedRoute = {
    ...searchInput,
    onds: [{ ...searchInput.onds[0], destination: 'Chicago' }],
  };
  await FlightSearchTool.invoke({ context }, JSON.stringify(changedRoute), {});

  assertExactProdFlightKeys(context.flight);
  assert.equal(context.flight.resolvedDestination.userCity, 'Chicago');
  assert.equal(context.flight.resolvedDestination.airportIATA, null);
  assert.equal(getFlightSearchState(context).destination, 'Chicago');
});
