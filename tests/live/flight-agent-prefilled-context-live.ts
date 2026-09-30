process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_PREFILLED_TEST_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

import fs from 'node:fs/promises';
import path from 'node:path';
import { Agent, MemorySession, Runner, setDefaultOpenAIKey, tool } from '@openai/agents';
import { z } from 'zod';

const { ApplyFilterTool } = await import('../../src/agents/flight/tools/filter/tool.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { buildFlightAgentInstructions } = await import('../../src/agents/flight/agent.js');

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

const applyFilterSchema = z.object({
  filters: z.array(
    z.object({
      filterType: z.enum([
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
      ]),
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

function buildOptions(version) {
  return {
    airlines: [
      { Code: `AC${version}`, Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
      { Code: `AC${version}+`, Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
      { Code: `EK${version}`, Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
      { Code: `QR${version}`, Text: 'Qatar Airways', Name: 'Qatar Airways', IsDisabled: false },
    ],
    layovers: [
      { Code: `DXB${version}`, Text: 'Dubai', AirportCityName: 'Dubai', IsDisabled: false },
      { Code: `DOH${version}`, Text: 'Doha Airport', AirportCityName: 'Doha', IsDisabled: false },
    ],
  };
}

function buildFlights(version, search) {
  const firstOnd = search.onds[0];
  return [
    {
      id: `prefilled-${version}-1`,
      airline_code: `AC${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'MORNING',
      arrival_time_window: 'EVENING',
      total_duration_minutes: 900,
      layover_duration_minutes: 120,
      layover_airport_codes: [`DXB${version}`],
      stops: 1,
      baggage: ['0', '1', '2'],
      price: { amount: 450, currency: 'USD' },
    },
    {
      id: `prefilled-${version}-2`,
      airline_code: `EK${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'MORNING',
      arrival_time_window: 'MORNING',
      total_duration_minutes: 1100,
      layover_duration_minutes: 180,
      layover_airport_codes: [`DXB${version}`],
      stops: 1,
      baggage: ['0', '1'],
      price: { amount: 550, currency: 'USD' },
    },
    {
      id: `prefilled-${version}-3`,
      airline_code: `QR${version}`,
      origin: firstOnd.origin,
      destination: firstOnd.destination,
      departure_time_window: 'EVENING',
      arrival_time_window: 'MORNING',
      total_duration_minutes: 1250,
      layover_duration_minutes: 240,
      layover_airport_codes: [`DOH${version}`],
      stops: 2,
      baggage: ['1', '2'],
      price: { amount: 500, currency: 'USD' },
    },
  ];
}

function createPrefilledFlightContext(scenarioId): any {
  const searchKey = `prefilled_sid_${scenarioId}_0`;
  const lastSearch = {
    onds: [
      {
        origin: 'New York',
        destination: 'Delhi',
        outbound_date: '2026-12-20',
        return_date: null,
      },
    ],
    trip_type: 'oneway',
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin_class: 'economy',
  };
  const options = buildOptions(0);
  const flights = buildFlights(0, lastSearch);

  return {
    UID: `prefilled-user-${scenarioId}`,
    uid: `prefilled-user-${scenarioId}`,
    cnt: flights.length,
    searchKey,
    sid: searchKey,
    searchVersion: 0,
    origin: lastSearch.onds[0].origin,
    destination: lastSearch.onds[0].destination,
    onds: lastSearch.onds,
    departureDate: lastSearch.onds[0].outbound_date,
    returnDate: lastSearch.onds[0].return_date,
    tripType: lastSearch.trip_type,
    passengers: lastSearch.passengers,
    cabinClass: lastSearch.cabin_class,
    lastSearch,
    airlineFilterOptions: options.airlines,
    layoverAirportFilterOptions: options.layovers,
    flightResults: flights,
    filteredFlightResults: flights,
    lastAppliedFilters: [],
    lastFinalFilterPayload: [],
    lastApplyFilterPayload: null,
    lastApplyFilterFeedback: [],
    toolCallLog: [],
    scenarioId,
  };
}

function syncSearchContext(context, input, searchKey, version, options, flights) {
  context.searchVersion = version;
  context.searchKey = searchKey;
  context.sid = searchKey;
  context.lastSearch = input;
  context.origin = input.onds[0].origin;
  context.destination = input.onds[input.onds.length - 1].destination;
  context.onds = input.onds;
  context.departureDate = input.onds[0].outbound_date;
  context.returnDate = input.onds[0].return_date;
  context.tripType = input.trip_type;
  context.passengers = input.passengers;
  context.cabinClass = input.cabin_class;
  context.airlineFilterOptions = options.airlines;
  context.layoverAirportFilterOptions = options.layovers;
  context.flightResults = flights;
  context.filteredFlightResults = flights;
  context.cnt = flights.length;

  // New search result sets cannot retain payloads tied to the previous SID.
  context.lastAppliedFilters = [];
  context.lastFinalFilterPayload = [];
  context.lastApplyFilterPayload = null;
  context.lastApplyFilterFeedback = [];
}

const HydratedFlightSearchTool = tool({
  name: 'flight_search',
  description:
    'Start a new search when route, date, trip type, passenger counts, or cabin changes.',
  parameters: flightSearchSchema,
  strict: true,
  execute(input, runContext) {
    const context = runContext.context as any;
    const version = context.searchVersion + 1;
    const searchKey = `prefilled_sid_${context.scenarioId}_${version}`;
    const options = buildOptions(version);
    const flights = buildFlights(version, input);

    syncSearchContext(context, input, searchKey, version, options, flights);
    context.toolCallLog.push({
      tool: 'flight_search',
      searchKey,
      searchVersion: version,
      input,
      airlineCodes: options.airlines.map((option) => option.Code),
      layoverCodes: options.layovers.map((option) => option.Code),
    });

    return {
      ok: true,
      source: 'hydrated-context-test',
      searchKey,
      searchParams: input,
      airlineFilters: options.airlines,
      layoverAirportFilters: options.layovers,
      flights,
    };
  },
});

const HydratedApplyFilterTool = tool({
  name: 'apply_filter',
  description: 'Apply supported filters to the current hydrated flight search.',
  parameters: applyFilterSchema,
  strict: true,
  execute(input, runContext) {
    return ApplyFilterTool.invoke(runContext, JSON.stringify(input), {});
  },
});

const HydratedContextAgent = new Agent({
  name: 'FlightAgentPrefilledContextTest',
  instructions: buildFlightAgentInstructions,
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: [HydratedFlightSearchTool, HydratedApplyFilterTool],
});

const runner = new Runner({
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  workflowName: 'flight-agent-prefilled-context-test',
  traceIncludeSensitiveData: false,
});

const scenarios = [
  {
    id: 'prefilled_01',
    name: 'Pure airline filter',
    turns: [
      {
        user: 'Show only Air Canada flights.',
        tools: ['apply_filter'],
        payload: { airline: ['AC0,AC0+'] },
        useInitialSid: true,
      },
    ],
  },
  {
    id: 'prefilled_02',
    name: 'Pure baggage filter',
    useLowercaseAliasesOnly: true,
    turns: [
      {
        user: 'Show flights with checked baggage.',
        tools: ['apply_filter'],
        payload: { baggage: ['0'] },
        useInitialSid: true,
      },
    ],
  },
  {
    id: 'prefilled_03',
    name: 'Pure layover filter',
    turns: [
      {
        user: 'Show flights with layover in Dubai.',
        tools: ['apply_filter'],
        payload: { outboundlayover: ['DXB0'] },
        useInitialSid: true,
      },
    ],
  },
  {
    id: 'prefilled_04',
    name: 'Multiple filters together',
    turns: [
      {
        user:
          'Show Emirates flights, morning departure, checked baggage, and duration under 20 hours.',
        tools: ['apply_filter'],
        payload: {
          airline: ['EK0'],
          departtimeslotfilter: ['MORNING'],
          baggage: ['0'],
          departdurationfilter: [0, 1200],
        },
        useInitialSid: true,
        groupedApplyFilter: true,
      },
    ],
  },
  {
    id: 'prefilled_05',
    name: 'Destination change',
    turns: [
      {
        user: 'Change destination to Tokyo.',
        tools: ['flight_search'],
        search: { origin: /New York/i, destination: /Tokyo/i, outboundDate: '2026-12-20' },
        newSearch: true,
      },
    ],
  },
  {
    id: 'prefilled_06',
    name: 'Date change',
    turns: [
      {
        user: 'Change departure date to 25 Dec.',
        tools: ['flight_search'],
        search: { origin: /New York/i, destination: /Delhi/i, outboundDate: '2026-12-25' },
        newSearch: true,
      },
    ],
  },
  {
    id: 'prefilled_07',
    name: 'Passenger change',
    turns: [
      {
        user: 'Make it 2 adults and 1 child.',
        tools: ['flight_search'],
        search: { adults: 2, children: 1 },
        newSearch: true,
      },
    ],
  },
  {
    id: 'prefilled_08',
    name: 'Cabin change',
    turns: [
      {
        user: 'Change cabin to business class.',
        tools: ['flight_search'],
        search: { cabinClass: 'business' },
        newSearch: true,
      },
    ],
  },
  {
    id: 'prefilled_09',
    name: 'Core search change plus filter',
    turns: [
      {
        user: 'Change destination to Tokyo and show only Qatar Airways flights.',
        tools: ['flight_search', 'apply_filter'],
        search: { destination: /Tokyo/i },
        payload: { airline: ['QR1'] },
        newSearch: true,
        useLatestSid: true,
      },
    ],
  },
  {
    id: 'prefilled_10',
    name: 'Multi-turn mixed flow',
    turns: [
      {
        user: 'Show Air Canada flights with checked baggage.',
        tools: ['apply_filter'],
        payload: { airline: ['AC0,AC0+'], baggage: ['0'] },
        useInitialSid: true,
      },
      {
        user: 'Now change departure date to 25 Dec and keep Emirates only.',
        tools: ['flight_search', 'apply_filter'],
        search: { outboundDate: '2026-12-25' },
        payload: { airline: ['EK1'] },
        newSearch: true,
        useLatestSid: true,
      },
      {
        user: 'Now show flights under 18 hours.',
        tools: ['apply_filter'],
        payload: { airline: ['EK1'], departdurationfilter: [0, 1080] },
        useLatestSid: true,
      },
    ],
  },
];

function findPayloadFilter(payload, filterType) {
  return (payload || []).find((filter) => filter.filterType === filterType);
}

function valueMatches(actual, expected) {
  return expected instanceof RegExp ? expected.test(String(actual)) : actual === expected;
}

function validatePayload(expectedPayload, actualPayload) {
  const errors = [];
  for (const [filterType, expectedValues] of Object.entries(expectedPayload || {})) {
    const actualFilter = findPayloadFilter(actualPayload, filterType);
    if (!actualFilter) {
      errors.push(`Missing payload filter ${filterType}.`);
    } else if (JSON.stringify(actualFilter.Values) !== JSON.stringify(expectedValues)) {
      errors.push(
        `Payload ${filterType}: expected ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actualFilter.Values)}.`,
      );
    }
  }
  return errors;
}

function validateSearch(expectedSearch, actualSearch) {
  const errors = [];
  const firstOnd = actualSearch?.onds?.[0];
  const values = {
    origin: firstOnd?.origin,
    destination: actualSearch?.onds?.[actualSearch.onds.length - 1]?.destination,
    outboundDate: firstOnd?.outbound_date,
    adults: actualSearch?.passengers?.adults,
    children: actualSearch?.passengers?.children,
    cabinClass: actualSearch?.cabin_class,
  };

  for (const [field, expected] of Object.entries(expectedSearch || {})) {
    if (!valueMatches(values[field], expected)) {
      errors.push(`Search ${field}: expected ${expected}, got ${values[field]}.`);
    }
  }
  return errors;
}

function snapshotContext(context) {
  return {
    UID: context.UID,
    uid: context.uid,
    cnt: context.cnt,
    searchKey: context.searchKey,
    sid: context.sid,
    searchVersion: context.searchVersion,
    lastSearch: context.lastSearch,
    lastAppliedFilters: context.lastAppliedFilters,
    lastFinalFilterPayload: context.lastFinalFilterPayload,
    lastApplyFilterPayload: context.lastApplyFilterPayload,
    airlineCodes: context.airlineFilterOptions.map((option) => option.Code),
    layoverCodes: context.layoverAirportFilterOptions.map((option) => option.Code),
    toolCallLog: context.toolCallLog.map((entry) => ({
      tool: entry.tool,
      searchKey: entry.searchKey,
      searchVersion: entry.searchVersion || null,
      input: entry.input || null,
      finalFilterPayload: entry.finalFilterPayload || null,
      apiPayload: entry.apiPayload || null,
    })),
  };
}

function validateTurn({ config, context, initialSid, previousSid, actualCalls }) {
  const errors = [];
  const actualTools = actualCalls.map((entry) => entry.tool);
  if (JSON.stringify(actualTools) !== JSON.stringify(config.tools)) {
    errors.push(
      `Tool order expected ${config.tools.join(' -> ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
    );
  }

  errors.push(...validatePayload(config.payload, context.lastFinalFilterPayload));
  errors.push(...validateSearch(config.search, context.lastSearch));

  const applyCalls = actualCalls.filter((entry) => entry.tool === 'apply_filter');
  if (config.groupedApplyFilter && applyCalls.length !== 1) {
    errors.push(`Expected one grouped apply_filter call, got ${applyCalls.length}.`);
  }

  if (config.useInitialSid) {
    for (const call of applyCalls) {
      if (call.searchKey !== initialSid) {
        errors.push(`Expected pre-filled SID ${initialSid}, apply_filter used ${call.searchKey}.`);
      }
    }
  }

  if (config.newSearch) {
    if (context.searchKey === previousSid) {
      errors.push(`Expected new searchKey after core change, still using ${context.searchKey}.`);
    }
    if (context.sid !== context.searchKey) {
      errors.push(`Expected sid alias ${context.searchKey}, got ${context.sid}.`);
    }
  }

  if (config.useLatestSid) {
    for (const call of applyCalls) {
      if (call.searchKey !== context.searchKey) {
        errors.push(`Stale SID: apply_filter used ${call.searchKey}, latest is ${context.searchKey}.`);
      }
    }
  }

  if (context.UID !== context.uid) {
    errors.push(`Expected UID/uid aliases to match, got ${context.UID}/${context.uid}.`);
  }
  if (context.cnt !== context.flightResults.length) {
    errors.push(`Expected cnt=${context.flightResults.length}, got ${context.cnt}.`);
  }

  return { errors, actualTools };
}

async function runScenario(scenario) {
  const session = new MemorySession({ sessionId: scenario.id });
  const context = createPrefilledFlightContext(scenario.id);
  if (scenario.useLowercaseAliasesOnly) {
    delete context.UID;
    delete context.searchKey;
  }
  const initialSid = context.searchKey || context.sid;
  const turns = [];

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const config = scenario.turns[index];
    const before = snapshotContext(context);
    const beforeCallCount = context.toolCallLog.length;
    const previousSid = context.searchKey;
    let response = '';
    let runtimeError = null;

    try {
      const result = await runner.run(HydratedContextAgent, config.user, {
        context,
        session,
        maxTurns: flightAgentConfig.maxTurns,
      });
      response = result.finalOutput || '';
    } catch (error: any) {
      runtimeError = `${error?.name || 'Error'}: ${error?.message || error}`;
    }

    const actualCalls = context.toolCallLog.slice(beforeCallCount);
    const validation = validateTurn({
      config,
      context,
      initialSid,
      previousSid,
      actualCalls,
    });
    if (runtimeError) {
      validation.errors.push(runtimeError);
    }

    turns.push({
      turn: index + 1,
      userQuery: config.user,
      agentResponse: response,
      expectedToolCalls: config.tools,
      actualToolCalls: validation.actualTools,
      actualPayloads: actualCalls,
      contextBefore: before,
      contextAfter: snapshotContext(context),
      pass: validation.errors.length === 0,
      issues: validation.errors,
    });
  }

  return {
    id: scenario.id,
    scenarioName: scenario.name,
    pass: turns.every((turn) => turn.pass),
    turns,
  };
}

function suggestedFixes(results) {
  const errors = results.flatMap((result) => result.turns.flatMap((turn) => turn.issues));
  const fixes = [];
  if (errors.some((error) => /Tool order/i.test(error))) {
    fixes.push('Tighten routing instructions for hydrated context and partial core-search changes.');
  }
  if (errors.some((error) => /Search .*expected/i.test(error))) {
    fixes.push('Expose existing lastSearch values to the agent and reuse unchanged core fields.');
  }
  if (errors.some((error) => /SID|searchKey/i.test(error))) {
    fixes.push('Synchronize searchKey/sid aliases and require apply_filter to use the latest value.');
  }
  if (errors.some((error) => /Payload/i.test(error))) {
    fixes.push('Review filter mapping and grouped apply_filter payload instructions.');
  }
  return fixes.length ? fixes : ['No additional fixes needed.'];
}

function textReport(summary, results) {
  const lines = [
    '# Flight Agent pre-filled flightContext report',
    `Generated: ${summary.generatedAt}`,
    `Model: ${summary.model}`,
    `Total scenarios: ${summary.totalScenarios}`,
    `Passed scenarios: ${summary.passedScenarios}`,
    `Failed scenarios: ${summary.failedScenarios}`,
    `Total turns: ${summary.totalTurns}`,
    `Passed turns: ${summary.passedTurns}`,
    `Failed turns: ${summary.failedTurns}`,
    `Success percentage: ${summary.successPercentage}%`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.scenarioName}`);
    for (const turn of result.turns) {
      lines.push(`- Query: ${turn.userQuery}`);
      lines.push(`  Expected: ${turn.expectedToolCalls.join(' -> ')}`);
      lines.push(`  Actual: ${turn.actualToolCalls.join(' -> ') || '(none)'}`);
      lines.push(`  Result: ${turn.pass ? 'PASS' : `FAIL - ${turn.issues.join(' | ')}`}`);
    }
    lines.push('');
  }

  lines.push(`Issues found: ${summary.issuesFound.join(' | ')}`);
  lines.push(`Suggested fixes: ${summary.suggestedFixes.join(' | ')}`);
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
  totalScenarios: results.length,
  passedScenarios: results.filter((result) => result.pass).length,
  failedScenarios: results.filter((result) => !result.pass).length,
  totalTurns: allTurns.length,
  passedTurns: allTurns.length - failedTurns.length,
  failedTurns: failedTurns.length,
  successPercentage: Number(
    (((allTurns.length - failedTurns.length) / allTurns.length) * 100).toFixed(1),
  ),
  issuesFound: failedTurns.length
    ? [...new Set(failedTurns.flatMap((turn) => turn.issues))]
    : ['No issues found in the final run.'],
  suggestedFixes: suggestedFixes(results),
};

const report = { summary, scenarios: results };
const resultsDir = path.join(process.cwd(), 'tests', 'results');
const jsonPath = path.join(resultsDir, 'flight-agent-prefilled-context-latest.json');
const textPath = path.join(resultsDir, 'flight-agent-prefilled-context-latest.txt');

await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(textPath, textReport(summary, results));

console.log(textReport(summary, results));
console.log(`JSON report: ${jsonPath}`);
console.log(`Text report: ${textPath}`);

if (summary.failedScenarios > 0) {
  process.exitCode = 1;
}
