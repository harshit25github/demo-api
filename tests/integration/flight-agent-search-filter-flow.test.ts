process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const { ApplyFilterTool: ApplyFilterToolDefinition } = await import('../../src/agents/flight/tools/filter/tool.js');
const { FlightSearchTool: FlightSearchToolDefinition } = await import('../../src/agents/flight/tools/search-tool.js');
const { createProdFlightContext, getFlightSearchState } = await import(
  '../../src/agents/flight/context/flight-context.js'
);
const { getFlightSearchRuntime } = await import(
  '../../src/agents/flight/context/search-runtime-store.js'
);

const ApplyFilterTool: any = ApplyFilterToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;

const REPORT_JSON = 'tests/results/flight-agent-search-filter-flow-latest.json';
const REPORT_TXT = 'tests/results/flight-agent-search-filter-flow-latest.txt';

const airlineFilterOptions = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: 'QR', Text: 'Qatar Airways', Name: 'Qatar Airways', IsDisabled: false },
  { Code: 'XX', Text: 'Disabled Airways', Name: 'Disabled Airways', IsDisabled: true },
];

const layoverAirportFilterOptions = [
  { Code: 'DXB', Text: 'Dubai', AirportCityName: 'Dubai', IsDisabled: false },
  { Code: 'DOH', Text: 'Doha Hamad International Airport', AirportCityName: 'Doha', IsDisabled: false },
  { Code: 'SIN', Text: 'Singapore Changi', AirportCityName: 'Singapore', IsDisabled: true },
];

const endpointAirportOptions = [
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

const oneAdult = { adults: 1, children: 0, infants: 0 };

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function createContext(scenarioId) {
  return {
    requestId: `flow-request-${scenarioId}`,
    sessionId: `flow-session-${scenarioId}`,
    toolCallLog: [],
    flight: createProdFlightContext({
      flight: {
        uid: `flow-user-${scenarioId}`,
        airlineFilterOptions,
        layoverAirportFilterOptions,
        departAirports: endpointAirportOptions,
        depLandAirports: endpointAirportOptions,
      },
    }),
  };
}

function searchPayload({
  origin = 'NYC',
  destination = 'LAX',
  outbound_date = '2026-12-20',
  return_date = null,
  trip_type = 'oneway',
  passengers = oneAdult,
  cabin_class = 'economy',
} = {}) {
  return {
    onds: [{ origin, destination, outbound_date, return_date }],
    trip_type,
    passengers,
    cabin_class,
  };
}

function filterPayload({
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
}) {
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

function toolDisplayName(toolName) {
  return toolName === 'flight_search' ? 'flight_search_tool' : 'apply_filter_tool';
}

async function waitForClockTick() {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function invokeFlightSearch(context, input) {
  const previousSearchKey = context.flight.searchKey || null;
  await waitForClockTick();

  const result = parseToolResult(
    await FlightSearchTool.invoke({ context }, JSON.stringify(input), {}),
  );

  assert.equal(result.UID, context.flight.uid);
  assert.ok(result.searchKey);
  assert.equal(context.flight.searchKey, result.searchKey);
  const activeSearch = getFlightSearchState(context);
  assert.deepEqual(
    {
      onds: activeSearch.onds,
      trip_type: activeSearch.trip_type,
      passengers: activeSearch.passengers,
      cabin_class: activeSearch.cabin_class,
    },
    input,
  );
  assert.deepEqual(context.flight.departAirports, endpointAirportOptions);
  assert.deepEqual(context.flight.depLandAirports, endpointAirportOptions);

  if (previousSearchKey) {
    assert.notEqual(result.searchKey, previousSearchKey);
  }

  return {
    tool: 'flight_search_tool',
    searchKey: result.searchKey,
    previousSearchKey,
    UID: result.UID,
    payload: input,
  };
}

async function invokeApplyFilter(context, filters) {
  assert.ok(context.flight.searchKey, 'apply_filter_tool must not run without searchKey');
  const searchKeyAtCall = context.flight.searchKey;

  const result = parseToolResult(
    await ApplyFilterTool.invoke({ context }, JSON.stringify({ filters }), {}),
  );

  assert.equal(result.ok, true);
  assert.equal(result.searchKey, searchKeyAtCall);
  assert.equal(result.apiPayload.searchKey, searchKeyAtCall);
  assert.equal(
    (getFlightSearchRuntime(searchKeyAtCall)?.lastApplyFilterPayload as any).searchKey,
    searchKeyAtCall,
  );

  return {
    tool: 'apply_filter_tool',
    searchKey: result.searchKey,
    payload: { filters },
    finalFilterPayload: result.finalFilterPayload,
    feedback: result.feedback,
    summary: result.summary,
  };
}

function assertFinalPayloadEquals(actual, expected) {
  assert.deepEqual(actual, expected);
}

function assertNoStopValueAboveThree(finalFilterPayload) {
  const stopFilter = finalFilterPayload.find((filter) => filter.filterType === 'stop');
  assert.ok(stopFilter, 'Expected stop filter payload');

  const stopValues = stopFilter.Values.flatMap((value) => String(value).split(','));
  for (const value of stopValues) {
    assert.ok(Number(value) <= 3, `Stop value ${value} must not be greater than 3`);
  }
}

function buildTurnReport(turn, actualCalls, status, error = null) {
  return {
    user: turn.user,
    expectedToolCalls: turn.expectedTools,
    actualToolCalls: actualCalls.map((call) => call.tool),
    payloads: actualCalls.map((call) => ({
      tool: call.tool,
      searchKey: call.searchKey,
      input: call.payload,
      finalFilterPayload: call.finalFilterPayload || null,
      feedback: call.feedback || [],
    })),
    searchKeysUsed: actualCalls.map((call) => call.searchKey).filter(Boolean),
    status,
    remarks: error ? error.message : turn.remarks || 'Passed',
  };
}

async function executeTurn(context, turn) {
  const actualCalls = [];

  if (!turn.actions?.length) {
    return {
      actualCalls,
      finalBehavior:
        turn.finalBehavior || 'No tool call. Ask for origin, destination, and travel date first.',
    };
  }

  for (const action of turn.actions) {
    if (action.type === 'search') {
      const call = await invokeFlightSearch(context, action.input);
      actualCalls.push(call);
      continue;
    }

    if (action.type === 'filter') {
      const call = await invokeApplyFilter(context, action.filters);
      actualCalls.push(call);

      if (action.expectedPayload) {
        assertFinalPayloadEquals(call.finalFilterPayload, action.expectedPayload);
      }

      if (action.expectFeedbackMatching) {
        for (const pattern of action.expectFeedbackMatching) {
          assert.ok(
            call.feedback.some((message) => pattern.test(message)),
            `Expected feedback matching ${pattern}`,
          );
        }
      }

      if (action.expectNoStopValueAboveThree) {
        assertNoStopValueAboveThree(call.finalFilterPayload);
      }

      if (action.expectZeroMinimumDuration) {
        for (const filterType of action.expectZeroMinimumDuration) {
          const payloadFilter = call.finalFilterPayload.find((filter) => filter.filterType === filterType);
          assert.ok(payloadFilter, `Expected ${filterType} payload`);
          assert.equal(payloadFilter.Values[0], 0);
        }
      }

      continue;
    }

    throw new Error(`Unknown action type: ${action.type}`);
  }

  assert.deepEqual(
    actualCalls.map((call) => call.tool),
    turn.expectedTools,
  );

  return { actualCalls };
}

async function runSetupSearch(context, input) {
  const call = await invokeFlightSearch(context, input);
  return {
    setupSearchKey: call.searchKey,
    setupPayload: input,
  };
}

const scenarios = [
  {
    id: 'scenario_01',
    name: 'Search initiation then multi-filter',
    turns: [
      {
        user: 'Find flights from NYC to LAX on 20 Dec for 1 adult.',
        expectedTools: ['flight_search_tool'],
        actions: [{ type: 'search', input: searchPayload() }],
      },
      {
        user: 'Show non-stop flights from LAX departure airport with checked baggage.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({ filterType: 'stops', filterCode: '0', rawUserFilter: 'non-stop flights' }),
              filterPayload({
                filterType: 'departureAirport',
                departureAirportNames: ['LAX'],
                rawUserFilter: 'from LAX departure airport',
              }),
              filterPayload({ filterType: 'baggage', filterCode: '0', rawUserFilter: 'checked baggage' }),
            ],
            expectedPayload: [
              { filterType: 'stop', Values: ['0'] },
              { filterType: 'baggage', Values: ['0'] },
              { filterType: 'outbounddepart', Values: ['LAX'] },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_02',
    name: 'Filter before search should fail safely',
    turns: [
      {
        user: 'Show Air Canada flights with layover in Dubai.',
        expectedTools: [],
        actions: [],
        finalBehavior:
          'No active search exists, so filters are not applied. Ask only for origin, destination, and travel date.',
      },
    ],
  },
  {
    id: 'scenario_03',
    name: 'Search plus filters in same query',
    turns: [
      {
        user: 'Find NYC to LAX flights on 20 Dec and show Emirates flights with arrival airport ONT.',
        expectedTools: ['flight_search_tool', 'apply_filter_tool'],
        actions: [
          { type: 'search', input: searchPayload() },
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'airline',
                airlineNames: ['Emirates'],
                rawUserFilter: 'show Emirates flights',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                arrivalAirportNames: ['ONT'],
                rawUserFilter: 'arrival airport ONT',
              }),
            ],
            expectedPayload: [
              { filterType: 'airline', Values: ['EK'] },
              { filterType: 'outboundarrival', Values: ['ONT'] },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_04',
    name: 'Airline plus departure and arrival airport filters',
    setupSearch: searchPayload(),
    turns: [
      {
        user: 'Show Air Canada or Emirates flights departing from BUR and arriving at LAX.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'airline',
                airlineNames: ['Air Canada', 'Emirates'],
                rawUserFilter: 'Air Canada or Emirates',
              }),
              filterPayload({
                filterType: 'departureAirport',
                departureAirportNames: ['BUR'],
                rawUserFilter: 'departing from BUR',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                arrivalAirportNames: ['LAX'],
                rawUserFilter: 'arriving at LAX',
              }),
            ],
            expectedPayload: [
              { filterType: 'airline', Values: ['AC,AC+,EK'] },
              { filterType: 'outbounddepart', Values: ['BUR'] },
              { filterType: 'outboundarrival', Values: ['LAX'] },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_05',
    name: 'Nearby airport filter',
    setupSearch: searchPayload(),
    turns: [
      {
        user: 'Show flights using nearby departure airports and nearby arrival airports.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'departureAirport',
                rawUserFilter: 'nearby departure airports',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                rawUserFilter: 'nearby arrival airports',
              }),
            ],
            expectedPayload: [
              { filterType: 'outbounddepart', Values: ['BUR,ONT,SNA,DSB'] },
              { filterType: 'outboundarrival', Values: ['BUR,ONT,SNA,DSB'] },
            ],
            expectFeedbackMatching: [
              /nearby\/alternate departure airport filter using BUR, ONT, SNA/i,
              /nearby\/alternate arrival airport filter using BUR, ONT, SNA/i,
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_06',
    name: 'Core search change after filters',
    turns: [
      {
        user: 'Find flights from NYC to LAX on 20 Dec for 1 adult.',
        expectedTools: ['flight_search_tool'],
        actions: [{ type: 'search', input: searchPayload() }],
      },
      {
        user: 'Show Emirates flights with checked baggage and total duration under 20 hours.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'airline',
                airlineNames: ['Emirates'],
                rawUserFilter: 'Emirates flights',
              }),
              filterPayload({ filterType: 'baggage', filterCode: '0', rawUserFilter: 'checked baggage' }),
              filterPayload({
                filterType: 'totalDuration',
                maxDurationMinutes: 1200,
                rawUserFilter: 'total duration under 20 hours',
              }),
            ],
            expectedPayload: [
              { filterType: 'baggage', Values: ['0'] },
              { filterType: 'airline', Values: ['EK'] },
              { filterType: 'departdurationfilter', Values: [0, 1200] },
            ],
            expectZeroMinimumDuration: ['departdurationfilter'],
          },
        ],
      },
      {
        user: 'Change destination to Chicago.',
        expectedTools: ['flight_search_tool'],
        actions: [
          {
            type: 'search',
            input: searchPayload({ destination: 'Chicago' }),
          },
        ],
        remarks: 'New search resets previous filter state and creates a fresh searchKey.',
      },
    ],
    afterScenario(context, scenarioReport) {
      const runtime = getFlightSearchRuntime(context.flight.searchKey);
      assert.deepEqual(runtime.finalFilterPayload, []);
      assert.deepEqual(runtime.appliedFilters, []);
      const searchKeys = scenarioReport.turns
        .flatMap((turn) => turn.searchKeysUsed)
        .filter(Boolean);
      assert.notEqual(searchKeys[0], searchKeys.at(-1));
    },
  },
  {
    id: 'scenario_07',
    name: 'Core search change plus filters after existing search',
    setupSearch: searchPayload(),
    turns: [
      {
        user: 'Change date to 25 Dec and show flights under 18 hours with carry-on baggage.',
        expectedTools: ['flight_search_tool', 'apply_filter_tool'],
        actions: [
          {
            type: 'search',
            input: searchPayload({ outbound_date: '2026-12-25' }),
          },
          {
            type: 'filter',
            filters: [
              filterPayload({ filterType: 'baggage', filterCode: '1', rawUserFilter: 'carry-on baggage' }),
              filterPayload({
                filterType: 'totalDuration',
                maxDurationMinutes: 1080,
                rawUserFilter: 'under 18 hours',
              }),
            ],
            expectedPayload: [
              { filterType: 'baggage', Values: ['1'] },
              { filterType: 'departdurationfilter', Values: [0, 1080] },
            ],
            expectZeroMinimumDuration: ['departdurationfilter'],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_08',
    name: 'Stops bucket validation with other filters',
    setupSearch: searchPayload(),
    turns: [
      {
        user: 'Show flights with 5 stops, evening departure, and arrival at SNA.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({ filterType: 'stops', filterCode: '5', rawUserFilter: '5 stops' }),
              filterPayload({
                filterType: 'departureTime',
                filterCode: 'EVENING',
                rawUserFilter: 'evening departure',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                arrivalAirportNames: ['SNA'],
                rawUserFilter: 'arrival at SNA',
              }),
            ],
            expectedPayload: [
              { filterType: 'stop', Values: ['3'] },
              { filterType: 'departtimeslotfilter', Values: ['EVENING'] },
              { filterType: 'outboundarrival', Values: ['SNA'] },
            ],
            expectNoStopValueAboveThree: true,
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_09',
    name: 'Layover plus airport filters together',
    setupSearch: searchPayload(),
    turns: [
      {
        user: 'Show flights with layover in Dubai, departing from LAX, arriving at Ontario, and layover under 4 hours.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'layoverAirport',
                layoverAirportNames: ['Dubai'],
                rawUserFilter: 'layover in Dubai',
              }),
              filterPayload({
                filterType: 'departureAirport',
                departureAirportNames: ['LAX'],
                rawUserFilter: 'departing from LAX',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                arrivalAirportNames: ['Ontario'],
                rawUserFilter: 'arriving at Ontario',
              }),
              filterPayload({
                filterType: 'layoverDuration',
                maxDurationMinutes: 240,
                rawUserFilter: 'layover under 4 hours',
              }),
            ],
            expectedPayload: [
              { filterType: 'outboundlayover', Values: ['DXB'] },
              { filterType: 'outbounddepart', Values: ['LAX'] },
              { filterType: 'outboundarrival', Values: ['ONT'] },
              { filterType: 'departlayoverfilter', Values: [0, 240] },
            ],
            expectZeroMinimumDuration: ['departlayoverfilter'],
          },
        ],
      },
    ],
  },
  {
    id: 'scenario_10',
    name: 'Full complex mixed flow',
    turns: [
      {
        user: 'Find flights from NYC to LAX on 20 Dec for 1 adult economy.',
        expectedTools: ['flight_search_tool'],
        actions: [{ type: 'search', input: searchPayload() }],
      },
      {
        user: 'Show Air Canada flights with checked baggage, departing from nearby airports and arriving at LAX.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'airline',
                airlineNames: ['Air Canada'],
                rawUserFilter: 'Air Canada flights',
              }),
              filterPayload({ filterType: 'baggage', filterCode: '0', rawUserFilter: 'checked baggage' }),
              filterPayload({
                filterType: 'departureAirport',
                rawUserFilter: 'departing from nearby airports',
              }),
              filterPayload({
                filterType: 'arrivalAirport',
                arrivalAirportNames: ['LAX'],
                rawUserFilter: 'arriving at LAX',
              }),
            ],
            expectedPayload: [
              { filterType: 'baggage', Values: ['0'] },
              { filterType: 'airline', Values: ['AC,AC+'] },
              { filterType: 'outbounddepart', Values: ['BUR,ONT,SNA,DSB'] },
              { filterType: 'outboundarrival', Values: ['LAX'] },
            ],
          },
        ],
      },
      {
        user: 'Change cabin to business and keep Emirates only with total duration under 20 hours.',
        expectedTools: ['flight_search_tool', 'apply_filter_tool'],
        actions: [
          {
            type: 'search',
            input: searchPayload({ cabin_class: 'business' }),
          },
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'airline',
                airlineNames: ['Emirates'],
                rawUserFilter: 'keep Emirates only',
              }),
              filterPayload({
                filterType: 'totalDuration',
                maxDurationMinutes: 1200,
                rawUserFilter: 'total duration under 20 hours',
              }),
            ],
            expectedPayload: [
              { filterType: 'airline', Values: ['EK'] },
              { filterType: 'departdurationfilter', Values: [0, 1200] },
            ],
            expectZeroMinimumDuration: ['departdurationfilter'],
          },
        ],
      },
      {
        user: 'Now show morning departure, night arrival, and two or more stops.',
        expectedTools: ['apply_filter_tool'],
        actions: [
          {
            type: 'filter',
            filters: [
              filterPayload({
                filterType: 'departureTime',
                filterCode: 'MORNING',
                rawUserFilter: 'morning departure',
              }),
              filterPayload({
                filterType: 'arrivalTime',
                filterCode: 'EVENING',
                rawUserFilter: 'night arrival',
              }),
              filterPayload({
                filterType: 'stops',
                filterCode: '3',
                rawUserFilter: 'two or more stops',
              }),
            ],
            expectedPayload: [
              { filterType: 'stop', Values: ['3'] },
              { filterType: 'departtimeslotfilter', Values: ['MORNING'] },
              { filterType: 'departlandtimeslotfilter', Values: ['EVENING'] },
              { filterType: 'airline', Values: ['EK'] },
              { filterType: 'departdurationfilter', Values: [0, 1200] },
            ],
            expectNoStopValueAboveThree: true,
          },
        ],
      },
    ],
    afterScenario(context, scenarioReport) {
      const turn1SearchKey = scenarioReport.turns[0].searchKeysUsed[0];
      const turn3SearchKey = scenarioReport.turns[2].searchKeysUsed[0];
      const turn4SearchKey = scenarioReport.turns[3].searchKeysUsed[0];
      assert.notEqual(turn1SearchKey, turn3SearchKey);
      assert.equal(turn4SearchKey, turn3SearchKey);
    },
  },
];

async function runScenario(scenario) {
  const context = createContext(scenario.id);
  const scenarioReport: any = {
    id: scenario.id,
    name: scenario.name,
    setup: null,
    turns: [],
    expectedToolCalls: scenario.turns.flatMap((turn) => turn.expectedTools),
    actualToolCalls: [],
    status: 'PASS',
    issues: [],
  };

  try {
    if (scenario.setupSearch) {
      scenarioReport.setup = await runSetupSearch(context, scenario.setupSearch);
    }

    for (const turn of scenario.turns) {
      try {
        const { actualCalls, finalBehavior } = await executeTurn(context, turn);
        scenarioReport.turns.push(buildTurnReport(turn, actualCalls, 'PASS'));
        scenarioReport.actualToolCalls.push(...actualCalls.map((call) => call.tool));

        if (!turn.actions?.length) {
          assert.deepEqual(actualCalls.map((call) => call.tool), turn.expectedTools);
          assert.equal(context.flight.searchKey, '');
          scenarioReport.turns.at(-1).finalBehavior = finalBehavior;
        }
      } catch (error: any) {
        scenarioReport.status = 'FAIL';
        scenarioReport.issues.push(error.message);
        scenarioReport.turns.push(buildTurnReport(turn, [], 'FAIL', error));
      }
    }

    if (scenario.afterScenario) {
      scenario.afterScenario(context, scenarioReport);
    }
  } catch (error: any) {
    scenarioReport.status = 'FAIL';
    scenarioReport.issues.push(error.message);
  }

  const runtime = getFlightSearchRuntime(context.flight.searchKey);
  scenarioReport.finalContext = {
    uid: context.flight.uid,
    searchKey: context.flight.searchKey || null,
    activeSearch: getFlightSearchState(context),
    finalFilterPayload: runtime?.finalFilterPayload || [],
    applyFilterFeedback: runtime?.feedback || [],
  };
  scenarioReport.pass = scenarioReport.status === 'PASS';

  return scenarioReport;
}

function buildTextReport(report) {
  const lines = [
    'Flight Agent Search + Filter Flow Report',
    `Total scenarios: ${report.summary.totalScenarios}`,
    `Passed scenarios: ${report.summary.passedScenarios}`,
    `Failed scenarios: ${report.summary.failedScenarios}`,
    `Total turns: ${report.summary.totalTurns}`,
    `Passed turns: ${report.summary.passedTurns}`,
    `Failed turns: ${report.summary.failedTurns}`,
    `Success percentage: ${report.summary.successPercentage}%`,
    '',
  ];

  for (const scenario of report.scenarios) {
    lines.push(`${scenario.id}: ${scenario.name}`);
    lines.push(`Status: ${scenario.status}`);
    if (scenario.setup) {
      lines.push(`Setup searchKey: ${scenario.setup.setupSearchKey}`);
    }
    lines.push(`Expected tools: ${scenario.expectedToolCalls.join(', ') || 'none'}`);
    lines.push(`Actual tools: ${scenario.actualToolCalls.join(', ') || 'none'}`);
    for (const [index, turn] of scenario.turns.entries()) {
      lines.push(`  Turn ${index + 1}: ${turn.user}`);
      lines.push(`    Expected: ${turn.expectedToolCalls.join(', ') || 'none'}`);
      lines.push(`    Actual: ${turn.actualToolCalls.join(', ') || 'none'}`);
      lines.push(`    Search keys: ${turn.searchKeysUsed.join(', ') || 'none'}`);
      lines.push(`    Status: ${turn.status}`);
      if (turn.finalBehavior) {
        lines.push(`    Final behavior: ${turn.finalBehavior}`);
      }
      if (turn.payloads.length) {
        lines.push(`    Payloads: ${JSON.stringify(turn.payloads)}`);
      }
      lines.push(`    Remarks: ${turn.remarks}`);
    }
    if (scenario.issues.length) {
      lines.push(`Issues: ${scenario.issues.join(' | ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

test('Flight Agent complex search and filter flow scenarios', async () => {
  const scenarioReports = [];

  for (const scenario of scenarios) {
    scenarioReports.push(await runScenario(scenario));
  }

  const totalTurns = scenarioReports.reduce((count, scenario) => count + scenario.turns.length, 0);
  const passedTurns = scenarioReports.reduce(
    (count, scenario) => count + scenario.turns.filter((turn) => turn.status === 'PASS').length,
    0,
  );
  const passedScenarios = scenarioReports.filter((scenario) => scenario.pass).length;
  const failedScenarios = scenarioReports.length - passedScenarios;

  const report = {
    summary: {
      totalScenarios: scenarioReports.length,
      passedScenarios,
      failedScenarios,
      totalTurns,
      passedTurns,
      failedTurns: totalTurns - passedTurns,
      successPercentage: Number(((passedScenarios / scenarioReports.length) * 100).toFixed(2)),
      fixesApplied: [],
      recurringIssues: failedScenarios ? ['See failed scenario issues.'] : [],
    },
    scenarios: scenarioReports,
  };

  await fs.mkdir('tests/results', { recursive: true });
  await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(REPORT_TXT, `${buildTextReport(report)}\n`);

  assert.equal(failedScenarios, 0, 'All search + filter flow scenarios must pass');
});
