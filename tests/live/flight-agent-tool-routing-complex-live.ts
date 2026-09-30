process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_ROUTING_TEST_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent, MemorySession, Runner, setDefaultOpenAIKey, tool } from '@openai/agents';
import { z } from 'zod';

const { ApplyFilterTool } = await import('../../src/agents/flight/tools/filter/tool.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { FLIGHT_PROMPT } = await import('../../src/agents/flight/prompt.js');

setDefaultOpenAIKey(flightAgentConfig.openaiApiKey);

const flightSearchSchema = z.object({
  onds: z.array(
    z.object({
      origin: z.string(),
      destination: z.string(),
      outbound_date: z.string(),
      return_date: z.string().nullable(),
    }),
  ).min(1),
  trip_type: z.enum(['oneway', 'roundtrip', 'multicity']),
  passengers: z.object({
    adults: z.number().int().min(1),
    children: z.number().int().min(0),
    infants: z.number().int().min(0),
  }),
  cabin_class: z.enum(['economy', 'premium_economy', 'business', 'first']),
});

const filterTypeValues = [
  'baggage',
  'departureTime',
  'arrivalTime',
  'stops',
  'totalDuration',
  'layoverDuration',
  'price',
  'airline',
  'layoverAirport',
  'departureAirport',
  'arrivalAirport',
];

const applyFilterSchema = z.object({
  filters: z.array(
    z.object({
      filterType: z.enum(filterTypeValues),
      filterCode: z.string().nullable(),
      minDurationMinutes: z.number().int().min(0).nullable(),
      maxDurationMinutes: z.number().int().min(0).nullable(),
      minPrice: z.number().min(0).nullable(),
      maxPrice: z.number().min(0).nullable(),
      airlineNames: z.array(z.string()).nullable(),
      layoverAirportNames: z.array(z.string()).nullable(),
      departureAirportNames: z.array(z.string()).nullable(),
      arrivalAirportNames: z.array(z.string()).nullable(),
      rawUserFilter: z.string().nullable(),
    }),
  ).min(1),
});

function buildDynamicOptions(version) {
  return {
    airlines: [
      { Code: `AC${version}`, Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
      { Code: `AC${version}+`, Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
      { Code: `EK${version}`, Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
      { Code: `QR${version}`, Text: 'Qatar Airways', Name: 'Qatar Airways', IsDisabled: false },
    ],
    layovers: [
      { Code: `DXB${version}`, Text: 'Dubai', AirportCityName: 'Dubai', IsDisabled: false },
      {
        Code: `FRA${version}`,
        Text: 'Frankfurt Airport',
        AirportCityName: 'Frankfurt',
        IsDisabled: false,
      },
      { Code: `DOH${version}`, Text: 'Doha Airport', AirportCityName: 'Doha', IsDisabled: false },
    ],
  };
}

function buildMockFlights(version, firstOnd) {
  return [
    {
      id: `mock-${version}-1`,
      airline_code: `AC${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'EVENING',
      arrival_time_window: 'MORNING',
      total_duration_minutes: 900,
      layover_duration_minutes: 120,
      layover_airport_codes: [`DXB${version}`],
      stops: 0,
      baggage: ['0', '1', '2'],
      price: { amount: 450, currency: 'USD' },
    },
    {
      id: `mock-${version}-2`,
      airline_code: `EK${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'MORNING',
      arrival_time_window: 'EVENING',
      total_duration_minutes: 1200,
      layover_duration_minutes: 180,
      layover_airport_codes: [`FRA${version}`, `DOH${version}`],
      stops: 2,
      baggage: ['0', '1'],
      price: { amount: 600, currency: 'USD' },
    },
    {
      id: `mock-${version}-3`,
      airline_code: `QR${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'AFTERNOON',
      arrival_time_window: 'MORNING',
      total_duration_minutes: 1260,
      layover_duration_minutes: 240,
      layover_airport_codes: [`DOH${version}`],
      stops: 1,
      baggage: ['1', '2'],
      price: { amount: 520, currency: 'USD' },
    },
  ];
}

const MockFlightSearchTool = tool({
  name: 'flight_search',
  description:
    'Start a new flight search when route, date, trip type, passengers, or cabin changes.',
  parameters: flightSearchSchema,
  strict: true,
  execute(input, runContext) {
    const context: any = runContext.context;
    const version = (context.searchVersion || 0) + 1;
    const searchKey = `mock_sid_${context.scenarioId}_${version}`;
    const dynamicOptions = buildDynamicOptions(version);
    const flights = buildMockFlights(version, input.onds[0]);

    context.searchVersion = version;
    context.searchKey = searchKey;
    context.lastSearch = input;
    context.airlineFilterOptions = dynamicOptions.airlines;
    context.layoverAirportFilterOptions = dynamicOptions.layovers;
    context.flightResults = flights;
    context.filteredFlightResults = flights;

    // A fresh search must reset filters and any payload tied to the previous SID.
    context.lastAppliedFilters = [];
    context.lastFinalFilterPayload = [];
    context.lastApplyFilterPayload = null;
    context.lastApplyFilterFeedback = [];
    context.toolCallLog.push({
      tool: 'flight_search',
      searchKey,
      searchVersion: version,
      input,
      airlineCodes: dynamicOptions.airlines.map((option) => option.Code),
      layoverCodes: dynamicOptions.layovers.map((option) => option.Code),
    });

    return {
      ok: true,
      source: 'mock',
      searchKey,
      searchParams: input,
      airlineFilters: dynamicOptions.airlines,
      layoverAirportFilters: dynamicOptions.layovers,
      flights,
    };
  },
});

const MockApplyFilterTool = tool({
  name: 'apply_filter',
  description:
    'Apply supported filters to the current flight search. Requires the latest searchKey.',
  parameters: applyFilterSchema,
  strict: true,
  async execute(input, runContext) {
    const context: any = runContext.context;
    context.rawApplyFilterInputs ||= [];
    context.rawApplyFilterInputs.push({
      searchKeyAtCall: context.searchKey || null,
      input,
    });

    // Delegate to the production dummy filter service so API payload mapping is tested too.
    return ApplyFilterTool.invoke(runContext, JSON.stringify(input), {});
  },
});

function buildInstructions(runContext) {
  const hasActiveSearch = Boolean(runContext?.context?.searchKey);
  return `${FLIGHT_PROMPT}

Current search state:
- UID is available in context.
- Active search exists: ${hasActiveSearch ? 'yes' : 'no'}.
`;
}

const RoutingTestAgent = new Agent({
  name: 'FlightAgentToolRoutingTest',
  instructions: buildInstructions,
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: [MockFlightSearchTool, MockApplyFilterTool],
});

const routingRunner = new Runner({
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  workflowName: 'flight-agent-tool-routing-test',
  traceIncludeSensitiveData: false,
});

const scenarios = [
  {
    id: 'routing_01',
    title: 'New search only',
    turns: [
      {
        user: 'Find flights from New York to Delhi on 20 Dec for 1 adult.',
        tools: ['flight_search'],
        search: { origin: /New York|NYC/i, destination: /Delhi/i, adults: 1 },
        newSearch: true,
        filtersCleared: true,
      },
    ],
  },
  {
    id: 'routing_02',
    title: 'New search plus filter in same query',
    turns: [
      {
        user: 'Find flights from New York to Delhi on 20 Dec and show only non-stop flights.',
        tools: ['flight_search', 'apply_filter'],
        search: { origin: /New York|NYC/i, destination: /Delhi/i },
        payload: { stop: ['0'] },
        newSearch: true,
      },
    ],
  },
  {
    id: 'routing_03',
    title: 'Apply airline filter after existing search',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Now show only Air Canada flights.',
        tools: ['apply_filter'],
        airlineNames: ['Air Canada'],
      },
    ],
  },
  {
    id: 'routing_04',
    title: 'Date change after filters',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Show Air Canada flights with checked baggage.',
        tools: ['apply_filter'],
        payload: { baggage: ['0'] },
        airlineNames: ['Air Canada'],
      },
      {
        user: 'Change departure date to 22 Dec.',
        tools: ['flight_search'],
        search: { outboundDate: /-12-22$/ },
        newSearch: true,
        filtersCleared: true,
        optionsRefreshed: true,
      },
    ],
  },
  {
    id: 'routing_05',
    title: 'Date change plus filters in same query',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Change departure date to 22 Dec and show Emirates flights with checked baggage.',
        tools: ['flight_search', 'apply_filter'],
        search: { outboundDate: /-12-22$/ },
        payload: { baggage: ['0'] },
        airlineNames: ['Emirates'],
        newSearch: true,
        optionsRefreshed: true,
      },
    ],
  },
  {
    id: 'routing_06',
    title: 'Destination change triggers new search then filter',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Actually change destination to Tokyo and keep it non-stop.',
        tools: ['flight_search', 'apply_filter'],
        search: { origin: /New York|NYC/i, destination: /Tokyo/i },
        payload: { stop: ['0'] },
        newSearch: true,
      },
    ],
  },
  {
    id: 'routing_07',
    title: 'Trip type change triggers new search',
    turns: [
      { user: 'Find one-way flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Make it round trip and return on 5 Jan.',
        tools: ['flight_search'],
        search: { tripType: 'roundtrip', returnDate: /-01-05$/ },
        newSearch: true,
        filtersCleared: true,
      },
    ],
  },
  {
    id: 'routing_08',
    title: 'Passenger change plus duration filter',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec for 1 adult.', tools: ['flight_search'] },
      {
        user: 'Make it 2 adults and 1 child, and show flights under 20 hours.',
        tools: ['flight_search', 'apply_filter'],
        search: { adults: 2, children: 1 },
        payload: { departdurationfilter: [0, 1200] },
        newSearch: true,
      },
    ],
  },
  {
    id: 'routing_09',
    title: 'Cabin change plus airline filter',
    turns: [
      { user: 'Find economy flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Change this to business class and prefer Qatar Airways.',
        tools: ['flight_search', 'apply_filter'],
        search: { cabinClass: 'business' },
        airlineNames: ['Qatar Airways'],
        newSearch: true,
        optionsRefreshed: true,
      },
    ],
  },
  {
    id: 'routing_10',
    title: 'Multi-city search initiation',
    turns: [
      {
        user:
          'Search multi-city flights: New York to London on 10 Dec, London to Dubai on 15 Dec, Dubai to Delhi on 20 Dec.',
        tools: ['flight_search'],
        search: { tripType: 'multicity', ondCount: 3 },
        newSearch: true,
        filtersCleared: true,
      },
    ],
  },
  {
    id: 'routing_11',
    title: 'Multi-city search plus layover filter',
    turns: [
      {
        user:
          'Search multi-city NYC to London on 10 Dec, London to Dubai on 15 Dec, and show flights with layover in Frankfurt.',
        tools: ['flight_search', 'apply_filter'],
        search: { tripType: 'multicity', ondCount: 2 },
        layoverNames: ['Frankfurt'],
        newSearch: true,
      },
    ],
  },
  {
    id: 'routing_12',
    title: 'Multiple filters grouped after existing search',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user:
          'Show Air Canada or Emirates, departing evening, arriving morning, with carry-on baggage.',
        tools: ['apply_filter'],
        payload: {
          departtimeslotfilter: ['EVENING'],
          departlandtimeslotfilter: ['MORNING'],
          baggage: ['1'],
        },
        airlineNames: ['Air Canada', 'Emirates'],
      },
    ],
  },
  {
    id: 'routing_13',
    title: 'Stops max bucket validation',
    turns: [
      { user: 'Find flights from New York to Delhi on 20 Dec.', tools: ['flight_search'] },
      {
        user: 'Show flights with 5 stops.',
        tools: ['apply_filter'],
        payload: { stop: ['3'] },
        rejectStopValuesAboveThree: true,
      },
    ],
  },
  {
    id: 'routing_14',
    title: 'Core parameter changes after multiple filters',
    turns: [
      {
        user:
          'Find round-trip flights from New York to Delhi departing 20 Dec and returning 5 Jan.',
        tools: ['flight_search'],
      },
      {
        user:
          'Show Air Canada flights with layover in Dubai, a personal item, total duration under 20 hours, and layover duration under 4 hours.',
        tools: ['apply_filter'],
        payload: {
          baggage: ['2'],
          departdurationfilter: [0, 1200],
          departlayoverfilter: [0, 240],
        },
        airlineNames: ['Air Canada'],
        layoverNames: ['Dubai'],
      },
      {
        user: 'Change return date to 8 Jan.',
        tools: ['flight_search'],
        search: { tripType: 'roundtrip', returnDate: /-01-08$/ },
        newSearch: true,
        filtersCleared: true,
        optionsRefreshed: true,
      },
    ],
  },
  {
    id: 'routing_15',
    title: 'Complex mixed flow in same chat',
    turns: [
      {
        user: 'Find flights from New York to Delhi on 20 Dec for 1 adult.',
        tools: ['flight_search'],
        newSearch: true,
      },
      {
        user: 'Show Air Canada flights with checked baggage and layover in Dubai.',
        tools: ['apply_filter'],
        payload: { baggage: ['0'] },
        airlineNames: ['Air Canada'],
        layoverNames: ['Dubai'],
      },
      {
        user:
          'Change it to 2 adults and business class, but keep Emirates only and duration under 22 hours.',
        tools: ['flight_search', 'apply_filter'],
        search: { adults: 2, cabinClass: 'business' },
        payload: { departdurationfilter: [0, 1320] },
        airlineNames: ['Emirates'],
        newSearch: true,
        optionsRefreshed: true,
      },
      {
        user: 'Now show morning departures and two or more stops.',
        tools: ['apply_filter'],
        payload: { departtimeslotfilter: ['MORNING'], stop: ['3'] },
      },
    ],
  },
];

function snapshotContext(context) {
  return {
    searchKey: context.searchKey || null,
    searchVersion: context.searchVersion || 0,
    lastSearch: context.lastSearch || null,
    lastAppliedFilters: context.lastAppliedFilters || [],
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    lastApplyFilterPayload: context.lastApplyFilterPayload || null,
    airlineCodes: (context.airlineFilterOptions || []).map((option) => option.Code),
    layoverCodes: (context.layoverAirportFilterOptions || []).map((option) => option.Code),
    toolCallLog: (context.toolCallLog || []).map((entry) => ({
      tool: entry.tool,
      searchKey: entry.searchKey,
      searchVersion: entry.searchVersion || null,
      input: entry.input || null,
      finalFilterPayload: entry.finalFilterPayload || null,
      apiPayload: entry.apiPayload || null,
    })),
  };
}

function valueMatches(actual, expected) {
  return expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
}

function findPayloadFilter(payload, filterType) {
  return (payload || []).find((filter) => filter.filterType === filterType);
}

function optionCodesForNames(options, names) {
  const requested = names.map((name) => name.toLowerCase());
  return options
    .filter((option) =>
      requested.some(
        (name) =>
          String(option.Name || '').toLowerCase() === name ||
          String(option.Text || '').toLowerCase() === name ||
          String(option.AirportCityName || '').toLowerCase() === name,
      ),
    )
    .map((option) => option.Code);
}

function validateSearch(expected, search) {
  const errors = [];
  const firstOnd = search?.onds?.[0];

  const checks = {
    origin: firstOnd?.origin,
    destination: firstOnd?.destination,
    outboundDate: firstOnd?.outbound_date,
    returnDate: firstOnd?.return_date,
    tripType: search?.trip_type,
    adults: search?.passengers?.adults,
    children: search?.passengers?.children,
    cabinClass: search?.cabin_class,
    ondCount: search?.onds?.length,
  };

  for (const [key, expectedValue] of Object.entries(expected || {})) {
    if (!valueMatches(checks[key], expectedValue)) {
      errors.push(`Search payload ${key}: expected ${expectedValue}, got ${checks[key]}.`);
    }
  }
  return errors;
}

function validateExpectedPayload(expectedPayload, finalPayload) {
  const errors = [];
  for (const [filterType, expectedValues] of Object.entries(expectedPayload || {})) {
    const actual = findPayloadFilter(finalPayload, filterType);
    if (!actual) {
      errors.push(`Missing final payload filter ${filterType}.`);
      continue;
    }
    if (JSON.stringify(actual.Values) !== JSON.stringify(expectedValues)) {
      errors.push(
        `Payload ${filterType}: expected ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actual.Values)}.`,
      );
    }
  }
  return errors;
}

function validateDynamicFilterNames({ names, options, filterType, finalPayload }) {
  if (!names) {
    return [];
  }
  const expectedCodes = optionCodesForNames(options, names);
  const payloadFilter = findPayloadFilter(finalPayload, filterType);
  const actualCodes = payloadFilter?.Values?.[0]?.split(',') || [];
  return JSON.stringify(actualCodes) === JSON.stringify(expectedCodes)
    ? []
    : [
        `${filterType} payload should use latest option codes ${JSON.stringify(expectedCodes)}, got ${JSON.stringify(actualCodes)}.`,
      ];
}

function validateTurn({
  config,
  actualCalls,
  context,
  before,
  previousSid,
  previousSearchVersion,
}) {
  const errors = [];
  const actualTools = actualCalls.map((entry) => entry.tool);
  if (JSON.stringify(actualTools) !== JSON.stringify(config.tools)) {
    errors.push(
      `Tool order expected ${config.tools.join(' -> ') || '(none)'}, got ${actualTools.join(' -> ') || '(none)'}.`,
    );
  }

  errors.push(...validateSearch(config.search, context.lastSearch));
  errors.push(...validateExpectedPayload(config.payload, context.lastFinalFilterPayload));
  errors.push(
    ...validateDynamicFilterNames({
      names: config.airlineNames,
      options: context.airlineFilterOptions || [],
      filterType: 'airline',
      finalPayload: context.lastFinalFilterPayload,
    }),
  );
  errors.push(
    ...validateDynamicFilterNames({
      names: config.layoverNames,
      options: context.layoverAirportFilterOptions || [],
      filterType: 'outboundlayover',
      finalPayload: context.lastFinalFilterPayload,
    }),
  );

  const applyCalls = actualCalls.filter((entry) => entry.tool === 'apply_filter');
  for (const applyCall of applyCalls) {
    if (applyCall.searchKey !== context.searchKey) {
      errors.push(`Apply filter used stale SID ${applyCall.searchKey}; latest SID is ${context.searchKey}.`);
    }
  }

  if (config.newSearch && previousSid && context.searchKey === previousSid) {
    errors.push(`Expected a fresh SID after re-search, but SID remained ${context.searchKey}.`);
  }

  if (config.optionsRefreshed && context.searchVersion <= previousSearchVersion) {
    errors.push(
      `Expected dynamic filter options to refresh after search version ${previousSearchVersion}.`,
    );
  }

  if (
    config.optionsRefreshed &&
    JSON.stringify(before.airlineCodes) ===
      JSON.stringify((context.airlineFilterOptions || []).map((option) => option.Code))
  ) {
    errors.push('Airline option codes were not refreshed after the new search.');
  }

  if (
    config.optionsRefreshed &&
    JSON.stringify(before.layoverCodes) ===
      JSON.stringify((context.layoverAirportFilterOptions || []).map((option) => option.Code))
  ) {
    errors.push('Layover option codes were not refreshed after the new search.');
  }

  if (
    config.filtersCleared &&
    ((context.lastAppliedFilters || []).length || (context.lastFinalFilterPayload || []).length)
  ) {
    errors.push('Expected a pure new search to clear old active filters and final payload.');
  }

  if (config.rejectStopValuesAboveThree) {
    const stopValues = findPayloadFilter(context.lastFinalFilterPayload, 'stop')?.Values || [];
    if (
      stopValues
        .flatMap((value) => String(value).split(','))
        .some((value) => Number(value) > 3)
    ) {
      errors.push(`Stop payload contains unsupported value above 3: ${JSON.stringify(stopValues)}.`);
    }
  }

  const latestSearchCall = [...context.toolCallLog]
    .reverse()
    .find((entry) => entry.tool === 'flight_search');
  if (latestSearchCall) {
    const staleApply = context.toolCallLog
      .slice(context.toolCallLog.indexOf(latestSearchCall) + 1)
      .find(
        (entry) =>
          entry.tool === 'apply_filter' && entry.searchKey !== latestSearchCall.searchKey,
      );
    if (staleApply) {
      errors.push(
        `Stale SID detected after latest search: apply_filter used ${staleApply.searchKey}, expected ${latestSearchCall.searchKey}.`,
      );
    }
  }

  return { errors, actualTools };
}

async function runScenario(scenario) {
  const session = new MemorySession({ sessionId: scenario.id });
  const context: any = {
    UID: scenario.id,
    scenarioId: scenario.id,
    toolCallLog: [],
  };
  const turns = [];

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const config = scenario.turns[index];
    const before = snapshotContext(context);
    const beforeCallCount = context.toolCallLog.length;
    const previousSid = context.searchKey || null;
    const previousSearchVersion = context.searchVersion || 0;

    let responseText = '';
    let runError = null;
    try {
      const result = await routingRunner.run(RoutingTestAgent, config.user, {
        context,
        session,
        maxTurns: flightAgentConfig.maxTurns,
      });
      responseText = result.finalOutput || '';
    } catch (error: any) {
      runError = `${error?.name || 'Error'}: ${error?.message || error}`;
    }

    const actualCalls = context.toolCallLog.slice(beforeCallCount);
    const validation = validateTurn({
      config,
      actualCalls,
      context,
      before,
      previousSid,
      previousSearchVersion,
    });
    if (runError) {
      validation.errors.push(runError);
    }

    turns.push({
      turn: index + 1,
      user: config.user,
      response: responseText,
      expectedTools: config.tools,
      actualTools: validation.actualTools,
      contextBefore: before,
      contextAfter: snapshotContext(context),
      payloadMismatches: validation.errors.filter((error) => /payload|filter|option/i.test(error)),
      staleSidIssues: validation.errors.filter((error) => /SID|stale/i.test(error)),
      pass: validation.errors.length === 0,
      errors: validation.errors,
    });
  }

  return {
    id: scenario.id,
    title: scenario.title,
    pass: turns.every((turn) => turn.pass),
    turns,
  };
}

function buildTextReport(summary, results) {
  const lines = [
    '# Flight Agent complex tool-calling report',
    `Generated: ${summary.generatedAt}`,
    `Model: ${summary.model}`,
    `Total scenarios: ${summary.totalTests}`,
    `Passed scenarios: ${summary.passedTests}`,
    `Failed scenarios: ${summary.failedTests}`,
    `Total turns: ${summary.totalTurns}`,
    `Passed turns: ${summary.passedTurns}`,
    `Failed turns: ${summary.failedTurns}`,
    `Success percentage: ${summary.successPercentage}%`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.title}`);
    for (const turn of result.turns) {
      lines.push(
        `- Turn ${turn.turn}: expected ${turn.expectedTools.join(' -> ') || '(none)'}, actual ${turn.actualTools.join(' -> ') || '(none)'}: ${turn.pass ? 'PASS' : `FAIL - ${turn.errors.join(' | ')}`}`,
      );
    }
    lines.push('');
  }

  lines.push(`Recurring issues: ${summary.recurringIssues.join(' | ')}`);
  lines.push(`Fixes applied: ${summary.fixesApplied.join(' | ')}`);
  return `${lines.join('\n')}\n`;
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

const allTurns = results.flatMap((result) => result.turns);
const failedTurns = allTurns.filter((turn) => !turn.pass);
const summary = {
  generatedAt: new Date().toISOString(),
  model: flightAgentConfig.model,
  totalTests: results.length,
  passedTests: results.filter((result) => result.pass).length,
  failedTests: results.filter((result) => !result.pass).length,
  totalTurns: allTurns.length,
  passedTurns: allTurns.length - failedTurns.length,
  failedTurns: failedTurns.length,
  successPercentage: Number(
    (((allTurns.length - failedTurns.length) / allTurns.length) * 100).toFixed(1),
  ),
  recurringIssues: failedTurns.length
    ? [...new Set(failedTurns.flatMap((turn) => turn.errors))]
    : ['No recurring issues found.'],
  fixesApplied: [
    'Instrumented mock flight_search creates a fresh SID and refreshes dynamic airline/layover options.',
    'Instrumented apply_filter delegates to the production dummy filter service and validates the current SID.',
    'Removed the child-age routing conflict: passenger count changes now trigger flight_search because the current schema accepts counts, not ages.',
  ],
};

const report = { summary, scenarios: results };
const resultsDir = path.join(process.cwd(), 'tests', 'results');
const jsonPath = path.join(resultsDir, 'flight-agent-tool-routing-complex-latest.json');
const textPath = path.join(resultsDir, 'flight-agent-tool-routing-complex-latest.txt');

await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(textPath, buildTextReport(summary, results));

console.log(buildTextReport(summary, results));
console.log(`JSON report: ${jsonPath}`);
console.log(`Text report: ${textPath}`);

if (summary.failedTests > 0) {
  process.exitCode = 1;
}
