import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplyFilterTool as ApplyFilterToolDefinition } from '../../src/agents/flight/tools/filter/tool.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import { GetGeneratedContractsContextTool as GetGeneratedContractsContextToolDefinition } from '../../src/agents/flight/tools/contracts-tool.js';
import {
  clearFlightSearchRuntime,
  getFlightSearchRuntime,
  restoreFlightSearchRuntime,
  snapshotFlightSearchRuntime,
  updateFlightSearchRuntime,
} from '../../src/agents/flight/context/search-runtime-store.js';

const ApplyFilterTool: any = ApplyFilterToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;
const GetGeneratedContractsContextTool: any = GetGeneratedContractsContextToolDefinition;

const testAirlineFilterOptions = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'CA', Text: 'Air China', Name: 'Air China', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: '6E', Text: 'IndiGo', Name: 'IndiGo', IsDisabled: true },
  { Code: 'UA', Text: 'United', Name: 'United', IsDisabled: false },
  { Code: 'UA+', Text: 'United', Name: 'United', IsDisabled: false },
];

const testLayoverAirportFilterOptions = [
  { Code: 'DXB', Text: 'Dubai', AirportCityName: 'Dubai', IsDisabled: false },
  {
    Code: 'DOH',
    Text: 'Doha Hamad International Airport',
    AirportCityName: 'Doha',
    IsDisabled: false,
  },
  { Code: 'LHR', Text: 'London Heathrow', AirportCityName: 'London', IsDisabled: false },
  { Code: 'HND', Text: 'Tokyo Haneda', AirportCityName: 'Tokyo', IsDisabled: false },
  { Code: 'NRT', Text: 'Tokyo Narita', AirportCityName: 'Tokyo', IsDisabled: false },
  { Code: 'SIN', Text: 'Singapore Changi', AirportCityName: 'Singapore', IsDisabled: true },
];

const testFlightEndpointAirportOptions = [
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
  {
    Code: 'DSB',
    Price: 999,
    Text: 'Disabled Airport',
    Name: null,
    Count: 0,
    IsNearby: true,
    IsDisabled: true,
    AirportCityName: null,
  },
];

const londonHeathrowAirportOption = {
  Code: 'LHR',
  Price: 455,
  Text: 'London Heathrow',
  Name: null,
  Count: 88,
  IsNearby: false,
  IsDisabled: false,
  AirportCityName: 'London',
};

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function createContext(): any {
  return {
    requestId: 'test-request',
    sessionId: 'test-session',
    toolCallLog: [],
    flight: {
      uid: 'test-user-123',
      // Simulates the application adding active-search filter options to prod Flight context.
      airlineFilterOptions: testAirlineFilterOptions,
      layoverAirportFilterOptions: testLayoverAirportFilterOptions,
      departAirports: testFlightEndpointAirportOptions,
      depLandAirports: testFlightEndpointAirportOptions,
    },
  };
}

const baseSearchPayload = {
  onds: [
    {
      origin: 'Delhi',
      destination: 'Mumbai',
      outbound_date: '2026-06-05',
      return_date: null,
    },
  ],
  trip_type: 'oneway',
  passengers: {
    adults: 1,
    children: 0,
    infants: 0,
  },
  cabin_class: 'economy',
};

function createApiFilter({
  filterType,
  filterCode = null,
  minDurationMinutes = null,
  maxDurationMinutes = null,
  minPrice = null,
  maxPrice = null,
  airlineNames = null,
  layoverAirportNames = null,
  departureAirportNames = null,
  arrivalAirportNames = null,
  rawUserFilter = null,
}: any): any {
  return {
    filterType,
    filterCode,
    minDurationMinutes,
    maxDurationMinutes,
    minPrice,
    maxPrice,
    airlineNames,
    layoverAirportNames,
    departureAirportNames,
    arrivalAirportNames,
    rawUserFilter,
  };
}

function findPayloadFilter(payload: any[], filterType: string): any {
  return payload.find((filter) => filter.filterType === filterType);
}

function setAppliedFilters(context: any, filters: any[]) {
  updateFlightSearchRuntime(context.flight.searchKey, {
    appliedFilters: filters,
  });
}

test('FlightSearchTool creates search and stores searchKey in context', async () => {
  const context = createContext();

  const result = parseToolResult(
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {}),
  );

  assert.equal(result.UID, context.flight.uid);
  assert.equal(result.searchKey, context.flight.searchKey);
  assert.match(context.flight.searchKey, /^search_test-user-123_/);
  assert.equal(context.flight.searchResults.length, 3);
  assert.deepEqual(result.flights.map((contract) => contract.display), [true, true, true]);
  assert.deepEqual(
    context.flight.searchResults.map((contract) => contract.display),
    [true, true, true],
  );
  assert.equal(result.airlineFilters, undefined);
  assert.equal(context.flight.airlineFilterOptions, testAirlineFilterOptions);
  assert.equal(context.flight.departAirports, testFlightEndpointAirportOptions);
  assert.equal(context.flight.depLandAirports, testFlightEndpointAirportOptions);
  assert.deepEqual(result.DepartAirports, testFlightEndpointAirportOptions);
  assert.deepEqual(result.DepLandAirports, testFlightEndpointAirportOptions);
  assert.deepEqual(context.toolCallLog.map((entry) => entry.tool), ['flight_search']);
});

test('GetGeneratedContractsContextTool returns all current contracts and ranking summaries', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: null,
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.resultSource, 'searchResults');
  assert.equal(result.contracts.length, 3);
  assert.equal(result.summary.totalAvailable, 3);
  assert.equal(result.summary.cheapestOption.optionNumber, 3);
  assert.equal(result.summary.shortestDurationOption.optionNumber, 1);
  assert.equal(result.summary.bestValueOption.optionNumber, 3);
  assert.equal('lastGeneratedContractsContext' in context, false);
  assert.deepEqual(context.toolCallLog.map((entry) => entry.tool), [
    'flight_search',
    'getGeneratedContractsContext',
  ]);
});

test('GetGeneratedContractsContextTool returns specific 1-based contract indexes', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: [2],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.contracts.length, 1);
  assert.equal(result.contracts[0].optionNumber, 2);
  assert.equal(result.contracts[0].airline, 'Air China');
});

test('GetGeneratedContractsContextTool read mode never changes visibility', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  context.flight.searchResults = context.flight.searchResults.map((contract, index) => ({
    ...contract,
    display: index === 1,
  }));
  const before = structuredClone(context.flight.searchResults);

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: null,
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.visibleCount, 1);
  assert.deepEqual(result.visibleIndexes, [2]);
  assert.deepEqual(result.selectedIndexes, []);
  assert.deepEqual(context.flight.searchResults, before);
});

test('GetGeneratedContractsContextTool select mode atomically updates context and runtime', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'select',
        indexes: [1, 3],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.selectedIndexes, [1, 3]);
  assert.equal(result.visibleCount, 2);
  assert.deepEqual(result.contracts.map((contract) => contract.optionNumber), [1, 3]);
  assert.deepEqual(
    context.flight.searchResults.map((contract) => contract.display),
    [true, false, true],
  );
  const runtime = getFlightSearchRuntime(context.flight.searchKey);
  assert.deepEqual(runtime.visibleFlights.map((contract) => contract.display), [true, false, true]);
  assert.deepEqual(runtime.sourceFlights.map((contract) => contract.display), [true, true, true]);
});

test('GetGeneratedContractsContextTool show_all restores every current contract', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({ mode: 'select', indexes: [1, 2] }),
    {},
  );

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({ mode: 'show_all', indexes: null }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.selectedIndexes, [1, 2, 3]);
  assert.equal(result.visibleCount, 3);
  assert.deepEqual(
    context.flight.searchResults.map((contract) => contract.display),
    [true, true, true],
  );
  const runtime = getFlightSearchRuntime(context.flight.searchKey);
  assert.deepEqual(runtime.visibleFlights.map((contract) => contract.display), [true, true, true]);
  assert.deepEqual(runtime.sourceFlights.map((contract) => contract.display), [true, true, true]);
});

test('GetGeneratedContractsContextTool show_all rejects indexes without mutation', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({ mode: 'select', indexes: [2] }),
    {},
  );
  const before = structuredClone(context.flight.searchResults);

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({ mode: 'show_all', indexes: [1] }),
      {},
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_SELECTION');
  assert.deepEqual(context.flight.searchResults, before);
});

test('read-then-select chooses contracts without changing the tool contract', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  const readResult = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: null,
      }),
      {},
    ),
  );

  const selectResult = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'select',
        indexes: [3],
      }),
      {},
    ),
  );

  assert.equal(selectResult.ok, true);
  assert.equal(readResult.contracts.length, 3);
  assert.deepEqual(selectResult.selectedIndexes, [3]);
  assert.deepEqual(
    context.flight.searchResults.map((contract) => contract.display),
    [false, false, true],
  );
});

test('invalid contract selections leave the current visibility unchanged', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({
      mode: 'select',
      indexes: [2],
    }),
    {},
  );
  const selectedState = structuredClone(context.flight.searchResults);

  for (const indexes of [[], [2, 2], [2, 9]]) {
    const result = parseToolResult(
      await GetGeneratedContractsContextTool.invoke(
        { context },
        JSON.stringify({
          mode: 'select',
          indexes,
        }),
        {},
      ),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(context.flight.searchResults, selectedState);
  }
});

test('selection preserves nested result metadata and runtime snapshots preserve visibility', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  context.flight.searchResults = {
    contracts: context.flight.searchResults,
    metadata: { currency: 'USD', page: 1 },
  };

  await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({
      mode: 'select',
      indexes: [2],
    }),
    {},
  );

  assert.deepEqual(context.flight.searchResults.metadata, { currency: 'USD', page: 1 });
  assert.deepEqual(
    context.flight.searchResults.contracts.map((contract) => contract.display),
    [false, true, false],
  );

  const searchKey = context.flight.searchKey;
  const snapshot = snapshotFlightSearchRuntime(searchKey);
  clearFlightSearchRuntime(searchKey);
  restoreFlightSearchRuntime(searchKey, snapshot);
  assert.deepEqual(
    getFlightSearchRuntime(searchKey).visibleFlights.map((contract) => contract.display),
    [false, true, false],
  );
});

test('GetGeneratedContractsContextTool reports out-of-range contract indexes', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: [4],
      }),
      {},
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INDEX_OUT_OF_RANGE');
  assert.deepEqual(result.missingIndexes, [4]);
  assert.equal(result.totalAvailable, 3);
});

test('GetGeneratedContractsContextTool returns NO_CONTRACTS with hydrated search context', async () => {
  const context = {
    ...createContext(),
    flight: {
      ...createContext().flight,
      searchKey: 'prefilled-search-key',
      tripType: baseSearchPayload.trip_type,
      cabinClass: baseSearchPayload.cabin_class,
      outboundDate: baseSearchPayload.onds[0].outbound_date,
      segments: [
        {
          date: baseSearchPayload.onds[0].outbound_date,
          origin: baseSearchPayload.onds[0].origin,
          destination: baseSearchPayload.onds[0].destination,
        },
      ],
      passengerData: baseSearchPayload.passengers,
      searchResults: [],
    },
  };

  const result = parseToolResult(
    await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({
        mode: 'read',
        indexes: null,
      }),
      {},
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_CONTRACTS');
  assert.equal(result.resultState, 'unavailable');
  assert.equal(result.recovery.retrySafe, false);
  assert.deepEqual(result.visibleIndexes, []);
  assert.equal(result.searchKey, 'prefilled-search-key');
  assert.deepEqual(result.searchParams, baseSearchPayload);
  assert.deepEqual(context.toolCallLog.map((entry) => entry.tool), [
    'getGeneratedContractsContext',
  ]);
});

test('contract reads preserve an empty filtered result set and its active constraints', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({ filters: [createApiFilter({
      filterType: 'price',
      maxPrice: 1,
      rawUserFilter: 'under $1',
    })] }),
    {},
  );
  const flightBefore = structuredClone(context.flight);
  const runtimeBefore = snapshotFlightSearchRuntime(context.flight.searchKey);
  const callsBefore = context.toolCallLog.length;

  const result = parseToolResult(await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({ mode: 'read', indexes: null }),
    {},
  ));

  assert.equal(result.ok, true);
  assert.equal(result.resultState, 'empty');
  assert.equal(result.originalCount, 3);
  assert.equal(result.summary.totalAvailable, 0);
  assert.equal(result.summary.cheapestOption, null);
  assert.deepEqual(result.contracts, []);
  assert.deepEqual(result.visibleIndexes, []);
  assert.deepEqual(result.filters, runtimeBefore.appliedFilters);
  assert.equal(result.filters[0].maxPrice, 1);
  assert.deepEqual(context.flight, flightBefore);
  assert.deepEqual(snapshotFlightSearchRuntime(context.flight.searchKey), runtimeBefore);
  assert.deepEqual(context.toolCallLog.slice(callsBefore).map((entry) => entry.tool), [
    'getGeneratedContractsContext',
  ]);
});

test('numbered options on an empty filtered set are unavailable without changing search or filters', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({ filters: [createApiFilter({
      filterType: 'price', maxPrice: 1, rawUserFilter: 'under $1',
    })] }),
    {},
  );
  const flightBefore = structuredClone(context.flight);
  const runtimeBefore = snapshotFlightSearchRuntime(context.flight.searchKey);

  for (const mode of ['read', 'select']) {
    const result = parseToolResult(await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({ mode, indexes: [1] }),
      {},
    ));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'INDEX_OUT_OF_RANGE');
    assert.equal(result.resultState, 'empty');
    assert.equal(result.totalAvailable, 0);
    assert.deepEqual(result.missingIndexes, [1]);
    assert.deepEqual(result.filters, runtimeBefore.appliedFilters);
    assert.match(result.recovery.fieldIssues[0].constraint, /No option indexes are available/);
    assert.equal(result.recovery.stateChanged, false);
    assert.deepEqual(context.flight, flightBefore);
    assert.deepEqual(snapshotFlightSearchRuntime(context.flight.searchKey), runtimeBefore);
  }
});

test('missing contract records are unavailable even when search runtime still has flights', async () => {
  for (const hasPriorSearch of [false, true]) {
    const context = createContext();
    if (hasPriorSearch) {
      await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
      delete context.flight.searchResults;
    }
    const flightBefore = structuredClone(context.flight);
    const runtimeBefore = snapshotFlightSearchRuntime(context.flight.searchKey);

    const result = parseToolResult(await GetGeneratedContractsContextTool.invoke(
      { context },
      JSON.stringify({ mode: 'read', indexes: null }),
      {},
    ));

    assert.equal(result.ok, false);
    assert.equal(result.code, 'NO_CONTRACTS');
    assert.equal(result.resultState, 'unavailable');
    assert.equal(result.recovery.retrySafe, false);
    assert.equal(result.recovery.stateChanged, false);
    assert.deepEqual(context.flight, flightBefore);
    assert.deepEqual(snapshotFlightSearchRuntime(context.flight.searchKey), runtimeBefore);
  }
});

test('completed empty searches can be inspected without inventing available options', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  context.flight.searchResults = [];
  updateFlightSearchRuntime(context.flight.searchKey, { sourceFlights: [], visibleFlights: [] });
  const runtimeBefore = snapshotFlightSearchRuntime(context.flight.searchKey);

  const result = parseToolResult(await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({ mode: 'read', indexes: null }),
    {},
  ));

  assert.equal(result.ok, true);
  assert.equal(result.resultState, 'empty');
  assert.equal(result.originalCount, 0);
  assert.deepEqual(result.filters, []);
  assert.equal(result.summary.totalAvailable, 0);
  assert.deepEqual(snapshotFlightSearchRuntime(context.flight.searchKey), runtimeBefore);
});

test('new search and filter results reset prior contract visibility', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  await GetGeneratedContractsContextTool.invoke(
    { context },
    JSON.stringify({
      mode: 'select',
      indexes: [2],
    }),
    {},
  );

  const filterResult = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['Air Canada', 'Air China'],
            rawUserFilter: 'Show Air Canada and Air China',
          }),
        ],
      }),
      {},
    ),
  );
  assert.deepEqual(filterResult.flights.map((contract) => contract.display), [true, true]);

  const newSearchResult = parseToolResult(
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {}),
  );
  assert.deepEqual(newSearchResult.flights.map((contract) => contract.display), [true, true, true]);
});

test('ApplyFilterTool resolves airline names from search options and preserves exact codes', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['air canada', 'AIR CHINA'],
            rawUserFilter: 'Show air canada and AIR CHINA flights',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+,CA'],
  });
  assert.deepEqual(result.feedback, []);
  assert.equal(result.summary.filteredCount, 2);
  assert.deepEqual(result.flights.map((contract) => contract.display), [true, true]);
  assert.deepEqual(
    context.flight.searchResults.map((contract) => contract.display),
    [true, true],
  );
});

test('ApplyFilterTool applies disabled airlines when present in source options', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'stops',
            filterCode: '2',
            rawUserFilter: 'one stop',
          }),
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['Air China', 'IndiGo'],
            rawUserFilter: 'Show Air China and IndiGo flights',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop').Values, ['2']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'airline').Values, ['CA,6E']);
  assert.deepEqual(result.feedback, []);
});

test('ApplyFilterTool does not report United Airlines missing when United source rows match', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'stops',
            filterCode: '2',
            rawUserFilter: 'one-stop flights',
          }),
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['United Airlines'],
            rawUserFilter: 'one-stop flights with United Airlines',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop'), {
    filterType: 'stop',
    Values: ['2'],
  });
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'airline'), {
    filterType: 'airline',
    Values: ['UA,UA+'],
  });
  assert.deepEqual(result.feedback, []);
});

test('ApplyFilterTool does not add airline payload when no requested airline is available', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['Unknown Airways'],
            rawUserFilter: 'Show Unknown Airways flights',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(findPayloadFilter(result.finalFilterPayload, 'airline'), undefined);
  assert.equal(result.filters.some((filter) => filter.filterType === 'airline'), false);
  assert.deepEqual(result.feedback, [
    'The requested airline was not found in the current flight results.',
  ]);
});

test('ApplyFilterTool can return ok with zero matching flights, which is not a fulfilled result request', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({ filters: [createApiFilter({
        filterType: 'price',
        maxPrice: 1,
        rawUserFilter: 'under $1',
      })] }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.summary.filteredCount, 0);
  assert.deepEqual(result.flights, []);
});

test('ApplyFilterTool resolves layover airport by city, airport name, and IATA code', async () => {
  const cases = [
    ['Dubai', 'DXB'],
    ['London Heathrow', 'LHR'],
    ['DXB', 'DXB'],
  ];

  for (const [requestedLayover, expectedCode] of cases) {
    const context = createContext();
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

    const result = parseToolResult(
      await ApplyFilterTool.invoke(
        { context },
        JSON.stringify({
          filters: [
            createApiFilter({
              filterType: 'layoverAirport',
              layoverAirportNames: [requestedLayover],
              rawUserFilter: `Show flights with layover in ${requestedLayover}`,
            }),
          ],
        }),
        {},
      ),
    );

    assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), {
      filterType: 'outboundlayover',
      Values: [expectedCode],
    });
    assert.deepEqual(result.feedback, []);
  }
});

test('ApplyFilterTool supports multiple layovers and cities matching multiple airports', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Dubai', 'Doha'],
            rawUserFilter: 'Show flights with layover in Dubai or Doha',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover').Values, [
    'DXB,DOH',
  ]);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Tokyo'],
            rawUserFilter: 'Show only Tokyo layovers',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover').Values, [
    'HND,NRT',
  ]);
});

test('ApplyFilterTool resolves layover airport aliases without false missing feedback', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Heathrow Airport'],
            rawUserFilter: 'Show layovers at Heathrow Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['LHR'],
  });
  assert.deepEqual(result.feedback, []);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Heathrow Airport', 'Heathrow'],
            rawUserFilter: 'Show layovers at Heathrow Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['LHR'],
  });
  assert.deepEqual(result.feedback, []);
});

test('ApplyFilterTool handles missing, partial, and disabled layover airports', async () => {
  const missingContext = createContext();
  await FlightSearchTool.invoke({ context: missingContext }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: missingContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Unknown Airport'],
            rawUserFilter: 'Show layovers at Unknown Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), undefined);
  assert.deepEqual(result.feedback, [
    'The requested layover airport was not found in the current flight results.',
  ]);

  const partialContext = createContext();
  await FlightSearchTool.invoke({ context: partialContext }, JSON.stringify(baseSearchPayload), {});

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: partialContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Dubai', 'Unknown Airport'],
            rawUserFilter: 'Show layovers in Dubai or Unknown Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover').Values, ['DXB']);
  assert.match(result.feedback[0], /Unknown Airport was not available as a layover airport/i);

  const disabledContext = createContext();
  await FlightSearchTool.invoke({ context: disabledContext }, JSON.stringify(baseSearchPayload), {});

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: disabledContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Singapore'],
            rawUserFilter: 'Show Singapore layovers',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['SIN'],
  });
  assert.deepEqual(result.feedback, []);
});

test('ApplyFilterTool adds layover airport without breaking existing multi-filter flow', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['Air Canada'],
            rawUserFilter: 'Air Canada',
          }),
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['Tokyo'],
            rawUserFilter: 'Tokyo layover',
          }),
          createApiFilter({
            filterType: 'stops',
            filterCode: '2',
            rawUserFilter: 'one stop',
          }),
          createApiFilter({
            filterType: 'price',
            maxPrice: 500,
            rawUserFilter: 'under $500',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop').Values, ['2']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'airline').Values, ['AC,AC+']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover').Values, [
    'HND,NRT',
  ]);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'price').Values, [0, 500]);
});

test('ApplyFilterTool resolves departure airport by code and airport name', async () => {
  const cases = [
    ['LAX', 'LAX'],
    ['Burbank', 'BUR'],
  ];

  for (const [requestedAirport, expectedCode] of cases) {
    const context = createContext();
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

    const result = parseToolResult(
      await ApplyFilterTool.invoke(
        { context },
        JSON.stringify({
          filters: [
            createApiFilter({
              filterType: 'departureAirport',
              departureAirportNames: [requestedAirport],
              rawUserFilter: `Show departure airport ${requestedAirport}`,
            }),
          ],
        }),
        {},
      ),
    );

    assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart'), {
      filterType: 'outbounddepart',
      Values: [expectedCode],
    });
    assert.deepEqual(result.feedback, []);
  }
});

test('ApplyFilterTool applies nearby departure airports only', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            rawUserFilter: 'Show nearby departure airports only',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart'), {
    filterType: 'outbounddepart',
    Values: ['BUR,ONT,SNA,DSB'],
  });
  assert.equal(result.feedback.length, 1);
  assert.match(result.feedback[0], /nearby\/alternate departure airport filter using BUR, ONT, SNA, DSB/i);
});

test('ApplyFilterTool resolves arrival airport by code and airport name', async () => {
  const cases = [
    ['ONT', 'ONT'],
    ['Los Angeles Intl', 'LAX'],
  ];

  for (const [requestedAirport, expectedCode] of cases) {
    const context = createContext();
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

    const result = parseToolResult(
      await ApplyFilterTool.invoke(
        { context },
        JSON.stringify({
          filters: [
            createApiFilter({
              filterType: 'arrivalAirport',
              arrivalAirportNames: [requestedAirport],
              rawUserFilter: `Show arrival airport ${requestedAirport}`,
            }),
          ],
        }),
        {},
      ),
    );

    assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival'), {
      filterType: 'outboundarrival',
      Values: [expectedCode],
    });
    assert.deepEqual(result.feedback, []);
  }
});

test('ApplyFilterTool resolves endpoint airport aliases without false missing feedback', async () => {
  const departureContext = createContext();
  departureContext.flight.searchKey = 'search-test-departure-airport-alias';
  departureContext.flight.departAirports = [londonHeathrowAirportOption];

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: departureContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['Heathrow Airport'],
            rawUserFilter: 'Depart from Heathrow Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart'), {
    filterType: 'outbounddepart',
    Values: ['LHR'],
  });
  assert.deepEqual(result.feedback, []);

  const arrivalContext = createContext();
  arrivalContext.flight.searchKey = 'search-test-arrival-airport-alias';
  arrivalContext.flight.depLandAirports = [londonHeathrowAirportOption];

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: arrivalContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['Heathrow Airport', 'Heathrow'],
            rawUserFilter: 'Arrive at Heathrow Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival'), {
    filterType: 'outboundarrival',
    Values: ['LHR'],
  });
  assert.deepEqual(result.feedback, []);
});

test('ApplyFilterTool supports multiple departure and arrival airports', async () => {
  const departureContext = createContext();
  await FlightSearchTool.invoke({ context: departureContext }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: departureContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['LAX', 'Burbank', 'Disabled Airport'],
            rawUserFilter: 'Depart from LAX, Burbank, or Disabled Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart').Values, [
    'LAX,BUR,DSB',
  ]);

  const arrivalContext = createContext();
  await FlightSearchTool.invoke({ context: arrivalContext }, JSON.stringify(baseSearchPayload), {});

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: arrivalContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['LAX', 'ONT', 'Disabled Airport'],
            rawUserFilter: 'Arrive at LAX, Ontario, or Disabled Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival').Values, [
    'LAX,ONT,DSB',
  ]);
});

test('ApplyFilterTool applies all departure airports from source options', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['all departure airports'],
            rawUserFilter: 'Apply all departure airports.',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart'), {
    filterType: 'outbounddepart',
    Values: ['LAX,BUR,ONT,SNA,DSB'],
  });
});

test('ApplyFilterTool applies all arrival airports from source options', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['all arrival airports'],
            rawUserFilter: 'Apply all arrival airports.',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival'), {
    filterType: 'outboundarrival',
    Values: ['LAX,BUR,ONT,SNA,DSB'],
  });
});

test('ApplyFilterTool applies all nearby departure and arrival airports together', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['all nearby airports'],
            rawUserFilter: 'Use all nearby airports.',
          }),
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['all nearby airports'],
            rawUserFilter: 'Use all nearby airports.',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart').Values, [
    'BUR,ONT,SNA,DSB',
  ]);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival').Values, [
    'BUR,ONT,SNA,DSB',
  ]);
});

test('ApplyFilterTool applies all these alternate airports from context', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['all these alternate airports'],
            rawUserFilter: 'Enable all these alternate airports.',
          }),
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['all these alternate airports'],
            rawUserFilter: 'Enable all these alternate airports.',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart').Values, [
    'BUR,ONT,SNA,DSB',
  ]);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival').Values, [
    'BUR,ONT,SNA,DSB',
  ]);
});

test('ApplyFilterTool combines all arrival airports with baggage filter', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['all arrival airports'],
            rawUserFilter: 'Apply all arrival airports',
          }),
          createApiFilter({
            filterType: 'baggage',
            filterCode: '0',
            rawUserFilter: 'checked baggage only',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival').Values, [
    'LAX,BUR,ONT,SNA,DSB',
  ]);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['0']);
});

test('ApplyFilterTool applies disabled endpoint airports and handles missing with feedback', async () => {
  const disabledContext = createContext();
  await FlightSearchTool.invoke({ context: disabledContext }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: disabledContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['Disabled Airport'],
            rawUserFilter: 'Depart from Disabled Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart'), {
    filterType: 'outbounddepart',
    Values: ['DSB'],
  });
  assert.deepEqual(result.feedback, []);

  const disabledArrivalContext = createContext();
  await FlightSearchTool.invoke(
    { context: disabledArrivalContext },
    JSON.stringify(baseSearchPayload),
    {},
  );

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: disabledArrivalContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['Disabled Airport'],
            rawUserFilter: 'Arrive at Disabled Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival'), {
    filterType: 'outboundarrival',
    Values: ['DSB'],
  });
  assert.deepEqual(result.feedback, []);

  const missingContext = createContext();
  await FlightSearchTool.invoke({ context: missingContext }, JSON.stringify(baseSearchPayload), {});

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: missingContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['Unknown Airport'],
            rawUserFilter: 'Arrive at Unknown Airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(findPayloadFilter(result.finalFilterPayload, 'outboundarrival'), undefined);
  assert.deepEqual(result.feedback, [
    'The requested arrival airport was not found in the current flight results.',
  ]);
});

test('ApplyFilterTool adds endpoint airports without breaking existing multi-filter flow', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureAirport',
            departureAirportNames: ['LAX'],
            rawUserFilter: 'Depart from LAX',
          }),
          createApiFilter({
            filterType: 'arrivalAirport',
            arrivalAirportNames: ['ONT'],
            rawUserFilter: 'Arrive at ONT',
          }),
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'checked baggage',
          }),
          createApiFilter({
            filterType: 'stops',
            rawUserFilter: 'one stop',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop').Values, ['2']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['0']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outbounddepart').Values, ['LAX']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundarrival').Values, ['ONT']);
});

test('ApplyFilterTool filters after search exists', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'stops',
            filterCode: '0',
            rawUserFilter: 'non-stop',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.searchKey, context.flight.searchKey);
  assert.equal(result.filters[0].filterType, 'stops');
  assert.equal(result.filters[0].filterCode, '0');
  assert.equal(result.apiPayload.UID, context.flight.uid);
  assert.equal(result.apiPayload.searchKey, context.flight.searchKey);
  assert.deepEqual(result.finalFilterPayload, [
    {
      filterType: 'stop',
      Values: ['0'],
    },
  ]);
  assert.deepEqual(result.apiPayload.filters, result.finalFilterPayload);
  assert.equal(result.summary.filteredCount, 1);
  assert.equal(result.flights[0].stops, 0);
});

test('Search plus filter uses tools sequentially through shared context', async () => {
  const context = createContext();

  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  const filtered = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureTime',
            filterCode: 'MORNING',
            rawUserFilter: 'morning departure',
          }),
          createApiFilter({
            filterType: 'baggage',
            filterCode: '1',
            rawUserFilter: 'carry-on bag',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(filtered.summary.filteredCount, 1);
  assert.deepEqual(context.toolCallLog.map((entry) => entry.tool), [
    'flight_search',
    'apply_filter',
  ]);
});

test('ApplyFilterTool fails gracefully when searchKey is missing', async () => {
  const context = createContext();

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'stops',
            filterCode: '0',
            rawUserFilter: 'non-stop',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MISSING_SEARCH');
  assert.deepEqual(result.recovery.requiredState, ['context.flight.searchKey']);
  assert.equal(result.recovery.retrySafe, true);
  assert.equal(result.recovery.stateChanged, false);
  assert.equal(context.searchKey, undefined);
  assert.equal(context.toolCallLog.length, 1);
  assert.equal(context.toolCallLog[0].tool, 'apply_filter');
  assert.equal(context.toolCallLog[0].code, 'MISSING_SEARCH');
});

test('ApplyFilterTool maps raw baggage, time, and stops text to exact API codes', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'checked baggage',
          }),
          createApiFilter({
            filterType: 'arrivalTime',
            rawUserFilter: 'night arrival',
          }),
          createApiFilter({
            filterType: 'stops',
            rawUserFilter: 'one stop',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.filters.map((filter) => [filter.filterType, filter.filterCode]),
    [
      ['baggage', '0'],
      ['arrivalTime', 'EVENING'],
      ['stops', '2'],
    ],
  );
  assert.deepEqual(result.finalFilterPayload, [
    {
      filterType: 'stop',
      Values: ['2'],
    },
    {
      filterType: 'departlandtimeslotfilter',
      Values: ['EVENING'],
    },
    {
      filterType: 'baggage',
      Values: ['0'],
    },
  ]);
  assert.equal(result.summary.filteredCount, 1);
  assert.equal(result.flights[0].stops, 1);
});

test('ApplyFilterTool maps all requested stop counts to supported API buckets', async () => {
  const cases = [
    ['non-stop flights', null, '0'],
    ['one-stop flights', null, '2'],
    ['flights with 2 stops', '2', '3'],
    ['flights with 3 stops', '3', '3'],
    ['flights with 4 stops', '4', '3'],
    ['flights with 5 stops', '5', '3'],
    ['flights with 12 stops', '12', '3'],
    ['flights with two or more stops', null, '3'],
    ['flights with more than 2 stops', null, '3'],
    ['flights with multiple stops', null, '3'],
  ];

  for (const [rawUserFilter, filterCode, expectedCode] of cases) {
    const context = createContext();
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

    const result = parseToolResult(
      await ApplyFilterTool.invoke(
        { context },
        JSON.stringify({
          filters: [
            createApiFilter({
              filterType: 'stops',
              filterCode,
              rawUserFilter,
            }),
          ],
        }),
        {},
      ),
    );

    assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop'), {
      filterType: 'stop',
      Values: [expectedCode],
    });
    assert.equal(Number(findPayloadFilter(result.finalFilterPayload, 'stop').Values[0]) <= 3, true);
    if (expectedCode === '3') {
      assert.equal(result.flights.every((flight) => flight.stops >= 2), true);
    }
  }
});

test('ApplyFilterTool never sends stale stop codes greater than 3', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  setAppliedFilters(context, [
    createApiFilter({
      filterType: 'stops',
      filterCode: '9',
      rawUserFilter: null,
    }),
  ]);

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'baggage',
            filterCode: '1',
            rawUserFilter: 'add carry-on baggage',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'stop'), {
    filterType: 'stop',
    Values: ['3'],
  });
  assert.equal(
    result.finalFilterPayload
      .filter((filter) => filter.filterType === 'stop')
      .flatMap((filter) => filter.Values)
      .some((value) => Number(value) > 3),
    false,
  );
});

test('ApplyFilterTool sends duration filters in minutes', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'totalDuration',
            rawUserFilter: 'under 3 hours total duration',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.filters[0].filterType, 'totalDuration');
  assert.equal(result.filters[0].filterCode, null);
  assert.equal(result.filters[0].maxDurationMinutes, 180);
  assert.deepEqual(result.finalFilterPayload, [
    {
      filterType: 'departdurationfilter',
      Values: [0, 180],
    },
  ]);
  assert.deepEqual(result.apiPayload.filters, result.finalFilterPayload);
  assert.equal(result.summary.filteredCount, 2);
});

test('ApplyFilterTool builds final API payload with multiple values per filter type', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'stops',
            rawUserFilter: 'one stop',
          }),
          createApiFilter({
            filterType: 'stops',
            rawUserFilter: '1+ stops',
          }),
          createApiFilter({
            filterType: 'departureTime',
            rawUserFilter: 'evening departure',
          }),
          createApiFilter({
            filterType: 'departureTime',
            rawUserFilter: 'morning departure',
          }),
          createApiFilter({
            filterType: 'arrivalTime',
            rawUserFilter: 'afternoon arrival',
          }),
          createApiFilter({
            filterType: 'arrivalTime',
            rawUserFilter: 'night arrival',
          }),
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'cabin bag',
          }),
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'checked bag',
          }),
          createApiFilter({
            filterType: 'price',
            minPrice: 500,
            maxPrice: 1200,
            rawUserFilter: 'between 500 and 1200 dollars',
          }),
          createApiFilter({
            filterType: 'totalDuration',
            minDurationMinutes: 0,
            maxDurationMinutes: 1425,
            rawUserFilter: 'total duration up to 23 hours 45 minutes',
          }),
          createApiFilter({
            filterType: 'layoverDuration',
            minDurationMinutes: 0,
            maxDurationMinutes: 1215,
            rawUserFilter: 'layover duration up to 20 hours 15 minutes',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.finalFilterPayload, [
    {
      filterType: 'stop',
      Values: ['2,3'],
    },
    {
      filterType: 'departtimeslotfilter',
      Values: ['EVENING', 'MORNING'],
    },
    {
      filterType: 'departlandtimeslotfilter',
      Values: ['AFTERNOON', 'EVENING'],
    },
    {
      filterType: 'baggage',
      Values: ['1', '0'],
    },
    {
      filterType: 'price',
      Values: [0, 1200],
    },
    {
      filterType: 'departdurationfilter',
      Values: [0, 1425],
    },
    {
      filterType: 'departlayoverfilter',
      Values: [0, 1215],
    },
  ]);
  assert.equal('lastFinalFilterPayload' in context, false);
  assert.deepEqual(result.apiPayload.filters, result.finalFilterPayload);
  assert.equal(result.feedback.length, 1);
  assert.match(result.feedback[0], /price minimum of 500.*ignored/i);
});

test('ApplyFilterTool preserves, removes, and replaces active filter state', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({
      filters: [
        createApiFilter({
          filterType: 'baggage',
          rawUserFilter: 'carry-on baggage',
        }),
        createApiFilter({
          filterType: 'departureTime',
          rawUserFilter: 'morning departure',
        }),
      ],
    }),
    {},
  );

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'add checked baggage',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['1', '0']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'departtimeslotfilter').Values, [
    'MORNING',
  ]);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'remove carry-on baggage',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['0']);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'departureTime',
            rawUserFilter: 'evening departure instead',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['0']);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'departtimeslotfilter').Values, [
    'EVENING',
  ]);
});

test('ApplyFilterTool emits API clear payloads for full filter removals', async () => {
  const cases = [
    {
      name: 'baggage',
      existing: [createApiFilter({ filterType: 'baggage', filterCode: '0' })],
      removal: createApiFilter({
        filterType: 'baggage',
        rawUserFilter: 'Remove all baggage filters',
      }),
      expected: { filterType: 'baggage', Values: [] },
    },
    {
      name: 'stops',
      existing: [createApiFilter({ filterType: 'stops', filterCode: '2' })],
      removal: createApiFilter({
        filterType: 'stops',
        rawUserFilter: 'Clear stop filter',
      }),
      expected: { filterType: 'stop', Values: ['all'] },
    },
    {
      name: 'departure time',
      existing: [createApiFilter({ filterType: 'departureTime', filterCode: 'MORNING' })],
      removal: createApiFilter({
        filterType: 'departureTime',
        rawUserFilter: 'Remove all departure time filters',
      }),
      expected: { filterType: 'departtimeslotfilter', Values: [] },
    },
    {
      name: 'arrival time',
      existing: [createApiFilter({ filterType: 'arrivalTime', filterCode: 'EVENING' })],
      removal: createApiFilter({
        filterType: 'arrivalTime',
        rawUserFilter: 'Remove all arrival time filters',
      }),
      expected: { filterType: 'departlandtimeslotfilter', Values: [] },
    },
    {
      name: 'departure airports',
      existing: [createApiFilter({ filterType: 'departureAirport', filterCode: 'LAX' })],
      removal: createApiFilter({
        filterType: 'departureAirport',
        rawUserFilter: 'Remove all departure airports',
      }),
      expected: { filterType: 'outbounddepart', Values: ['all'] },
    },
    {
      name: 'layover airports',
      existing: [createApiFilter({ filterType: 'layoverAirport', filterCode: 'DXB' })],
      removal: createApiFilter({
        filterType: 'layoverAirport',
        rawUserFilter: 'Remove all layover airports',
      }),
      expected: { filterType: 'outboundlayover', Values: ['all'] },
    },
    {
      name: 'airlines',
      existing: [createApiFilter({ filterType: 'airline', filterCode: 'UA' })],
      removal: createApiFilter({
        filterType: 'airline',
        rawUserFilter: 'Clear airline filter',
      }),
      expected: { filterType: 'airline', Values: ['all'] },
    },
  ];

  for (const testCase of cases) {
    const context = createContext();
    await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
    setAppliedFilters(context, testCase.existing);

    const result = parseToolResult(
      await ApplyFilterTool.invoke(
        { context },
        JSON.stringify({ filters: [testCase.removal] }),
        {},
      ),
    );

    assert.deepEqual(
      findPayloadFilter(result.finalFilterPayload, testCase.expected.filterType),
      testCase.expected,
      `Expected clear payload for ${testCase.name}`,
    );
    assert.equal(
      result.filters.some((filter) => filter.filterType === testCase.existing[0].filterType),
      false,
      `Expected ${testCase.name} to be removed from active state`,
    );
  }
});

test('ApplyFilterTool emits reset payload when all filters are removed', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  setAppliedFilters(context, [
    createApiFilter({ filterType: 'stops', filterCode: '2' }),
    createApiFilter({ filterType: 'airline', filterCode: 'UA' }),
    createApiFilter({ filterType: 'baggage', filterCode: '0' }),
  ]);
  const priorCallCount = context.toolCallLog.length;

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'reset',
            rawUserFilter: 'Reset filters',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(result.finalFilterPayload, [{ filterType: 'reset', Values: [] }]);
  assert.deepEqual(result.filters, []);
  assert.equal(
    context.toolCallLog.slice(priorCallCount)
      .filter((entry: any) => entry.tool === 'apply_filter').length,
    1,
  );
  assert.equal(context.flight.totalResultsFound, result.summary.originalCount);
});

test('ApplyFilterTool atomically clears a standalone remove-all request even with per-type tool input', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  setAppliedFilters(context, [
    createApiFilter({ filterType: 'stops', filterCode: '2' }),
    createApiFilter({ filterType: 'airline', filterCode: 'UA' }),
    createApiFilter({ filterType: 'baggage', filterCode: '0' }),
  ]);
  context.currentUserMessage = 'remove all filters';
  const priorCallCount = context.toolCallLog.length;

  const result = parseToolResult(await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({ filters: [createApiFilter({
      filterType: 'stops', filterCode: '2', rawUserFilter: 'remove all filters',
    })] }),
    {},
  ));

  assert.deepEqual(result.filters, []);
  assert.deepEqual(result.finalFilterPayload, [{ filterType: 'reset', Values: [] }]);
  assert.equal(context.flight.totalResultsFound, result.summary.originalCount);
  assert.equal(context.toolCallLog.slice(priorCallCount).filter((entry: any) => entry.tool === 'apply_filter').length, 1);
});

test('ApplyFilterTool preserves specific filtering in a mixed clear-and-filter request', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});
  context.currentUserMessage = 'remove all filters and show nonstop only';

  const result = parseToolResult(await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({ filters: [createApiFilter({
      filterType: 'stops', filterCode: '0', rawUserFilter: 'nonstop only',
    })] }),
    {},
  ));

  assert.ok(result.filters.some((filter: any) => filter.filterType === 'stops' && filter.filterCode === '0'));
  assert.notDeepEqual(result.finalFilterPayload, [{ filterType: 'reset', Values: [] }]);
});

test('ApplyFilterTool preserves remaining values during partial layover and airline removal', async () => {
  const layoverContext = createContext();
  await FlightSearchTool.invoke({ context: layoverContext }, JSON.stringify(baseSearchPayload), {});
  setAppliedFilters(layoverContext, [
    createApiFilter({ filterType: 'layoverAirport', filterCode: 'DXB' }),
    createApiFilter({ filterType: 'layoverAirport', filterCode: 'DOH' }),
    createApiFilter({ filterType: 'layoverAirport', filterCode: 'LHR' }),
  ]);

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: layoverContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'layoverAirport',
            layoverAirportNames: ['LHR'],
            rawUserFilter: 'Remove LHR layover airport',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['DXB,DOH'],
  });

  const airlineContext = createContext();
  airlineContext.flight.airlineFilterOptions = [
    ...airlineContext.flight.airlineFilterOptions,
    { Code: 'AA', Text: 'American Airlines', Name: 'American Airlines', IsDisabled: false },
    { Code: 'DL', Text: 'Delta Air Lines', Name: 'Delta Air Lines', IsDisabled: false },
  ];
  await FlightSearchTool.invoke({ context: airlineContext }, JSON.stringify(baseSearchPayload), {});
  setAppliedFilters(airlineContext, [
    createApiFilter({ filterType: 'airline', filterCode: 'UA' }),
    createApiFilter({ filterType: 'airline', filterCode: 'AA' }),
    createApiFilter({ filterType: 'airline', filterCode: 'DL' }),
  ]);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context: airlineContext },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'airline',
            airlineNames: ['American Airlines'],
            rawUserFilter: 'Remove American Airlines',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'airline'), {
    filterType: 'airline',
    Values: ['UA,DL'],
  });
});

test('ApplyFilterTool replaces same filter type when add intent is absent', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  await ApplyFilterTool.invoke(
    { context },
    JSON.stringify({
      filters: [
        createApiFilter({
          filterType: 'baggage',
          rawUserFilter: 'checked baggage',
        }),
      ],
    }),
    {},
  );

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'baggage',
            rawUserFilter: 'carry-on baggage',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'baggage').Values, ['1']);
  assert.equal(
    result.filters.some((filter) => filter.filterType === 'baggage' && filter.filterCode === '0'),
    false,
  );
});

test('ApplyFilterTool supports max-only price updates, feedback, and remove', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  let result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'price',
            rawUserFilter: 'between 150 and 200 dollars',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'price').Values, [0, 200]);
  assert.equal(result.filters.find((filter) => filter.filterType === 'price').minPrice, 0);
  assert.equal(result.feedback.length, 1);
  assert.match(result.feedback[0], /price minimum of 150.*ignored/i);
  assert.equal(result.summary.filteredCount, 3);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'price',
            rawUserFilter: 'under $180',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'price').Values, [0, 180]);
  assert.deepEqual(result.feedback, []);
  assert.equal(result.summary.filteredCount, 2);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'price',
            minPrice: 500,
            rawUserFilter: 'above $500',
          }),
        ],
      }),
      {},
    ),
  );

  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'price').Values, [0, 180]);
  assert.equal(result.feedback.length, 1);
  assert.match(result.feedback[0], /no price update was applied/i);

  result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'price',
            rawUserFilter: 'remove price filter',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(findPayloadFilter(result.finalFilterPayload, 'price'), undefined);
  assert.equal(
    result.filters.some((filter) => filter.filterType === 'price'),
    false,
  );
});

test('ApplyFilterTool ignores duration minimums, removes max caps, and returns feedback', async () => {
  const context = createContext();
  await FlightSearchTool.invoke({ context }, JSON.stringify(baseSearchPayload), {});

  const result = parseToolResult(
    await ApplyFilterTool.invoke(
      { context },
      JSON.stringify({
        filters: [
          createApiFilter({
            filterType: 'totalDuration',
            minDurationMinutes: 60,
            maxDurationMinutes: 5000,
            rawUserFilter: 'total duration between 1 and 83 hours',
          }),
          createApiFilter({
            filterType: 'layoverDuration',
            rawUserFilter: 'layover between 1 and 4 hours',
          }),
        ],
      }),
      {},
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'departdurationfilter').Values, [
    0, 5000,
  ]);
  assert.deepEqual(findPayloadFilter(result.finalFilterPayload, 'departlayoverfilter').Values, [
    0, 240,
  ]);
  assert.equal(
    result.filters.find((filter) => filter.filterType === 'totalDuration').minDurationMinutes,
    0,
  );
  assert.equal(
    result.filters.find((filter) => filter.filterType === 'layoverDuration').minDurationMinutes,
    0,
  );
  assert.equal(result.feedback.length, 2);
  assert.match(result.feedback[0], /total duration minimum of 60 minutes was ignored/i);
  assert.match(result.feedback[1], /layover duration minimum of 60 minutes was ignored/i);
});
