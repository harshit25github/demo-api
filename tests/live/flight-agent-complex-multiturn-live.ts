process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '4';

const { runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const fs = await import('node:fs/promises');
const path = await import('node:path');

const cases = [
  {
    id: 'complex_search_only_oneway',
    title: 'Search-only one-way flow',
    turns: ['Find one-way economy flights from SFO to JFK on 2026-07-15 for 2 adults'],
    expectedToolSequence: ['flight_search'],
    expectedContextUpdates: [
      'searchKey is created',
      'lastSearch has SFO/JFK route',
      'lastSearch passengers.adults is 2',
      'lastSearch cabin_class is economy',
    ],
    validate: [
      hasSearchKey(),
      lastSearchField('onds.0.origin', /SFO|San Francisco/i),
      lastSearchField('onds.0.destination', /JFK|New York/i),
      lastSearchField('passengers.adults', 2),
      lastSearchField('cabin_class', 'economy'),
    ],
  },
  {
    id: 'complex_search_plus_nonstop_morning',
    title: 'Search + stops/departure filter in one query',
    turns: ['Find flights from Delhi to Mumbai on 2026-07-10 with non-stop only and morning departure'],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'searchKey is created by flight_search',
      'apply_filter uses same searchKey',
      'lastAppliedFilters has stops code 0 and departureTime code MORNING',
    ],
    validate: [
      hasSearchKey(),
      lastFilter('stops', '0'),
      lastFilter('departureTime', 'MORNING'),
      filteredCount(1),
      filterUsesCurrentSearchKey(),
    ],
  },
  {
    id: 'complex_multiple_filters_after_search',
    title: 'Multiple filters after existing search',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-11',
      'Show only one-stop flights with checked baggage and evening arrival',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'searchKey persists across turns',
      'lastAppliedFilters has stops code 2, baggage code 0, and arrivalTime code EVENING',
    ],
    validate: [
      hasSearchKey(),
      lastFilter('stops', '2'),
      lastFilter('baggage', '0'),
      lastFilter('arrivalTime', 'EVENING'),
      filteredCount(1),
    ],
  },
  {
    id: 'complex_filter_without_search',
    title: 'Filter-only without searchKey',
    turns: ['Only show flights with carry-on baggage and morning departures'],
    expectedToolSequence: [],
    expectedContextUpdates: [
      'searchKey remains missing',
      'agent asks for origin, destination, and travel date',
    ],
    validate: [
      noSearchKey(),
      finalResponseMatches(/origin/i),
      finalResponseMatches(/destination/i),
      finalResponseMatches(/travel date|date/i),
    ],
  },
  {
    id: 'complex_route_date_passenger_cabin_change',
    title: 'Route/date/passenger/cabin change after search',
    turns: [
      'Find flights from Dubai to Delhi on 2026-07-15',
      'Actually make it business class for 2 adults from Dubai to Mumbai on 2026-07-18',
    ],
    expectedToolSequence: ['flight_search', 'flight_search'],
    expectedContextUpdates: [
      'second turn creates a new searchKey',
      'lastSearch changes destination to Mumbai',
      'lastSearch has 2 adults and business cabin',
    ],
    validate: [
      searchCallCount(2),
      searchKeysAreUnique(),
      lastSearchField('onds.0.destination', /Mumbai/i),
      lastSearchField('passengers.adults', 2),
      lastSearchField('cabin_class', 'business'),
    ],
  },
  {
    id: 'complex_roundtrip_all_details',
    title: 'Round-trip flow with all details',
    turns: ['Find round trip flights from NYC to London departing 2026-08-01 returning 2026-08-10 for 2 adults'],
    expectedToolSequence: ['flight_search'],
    expectedContextUpdates: [
      'searchKey is created',
      'lastSearch trip_type is roundtrip',
      'return_date is set',
    ],
    validate: [
      hasSearchKey(),
      lastSearchField('trip_type', 'roundtrip'),
      lastSearchField('onds.0.return_date', '2026-08-10'),
      lastSearchField('passengers.adults', 2),
    ],
  },
  {
    id: 'complex_roundtrip_missing_then_supplied',
    title: 'Round-trip missing return, then supplied',
    turns: [
      'Find round trip flights from NYC to London departing 2026-08-01',
      'Use return date 2026-08-10 for NYC to London round trip departing 2026-08-01',
    ],
    expectedToolSequence: ['flight_search'],
    expectedContextUpdates: [
      'first turn does not search because return date is missing',
      'second turn searches after return date is supplied',
      'searchKey is created on second turn',
    ],
    validate: [
      turnToolSequence(1, []),
      turnToolSequence(2, ['flight_search']),
      hasSearchKey(),
      lastSearchField('trip_type', 'roundtrip'),
      lastSearchField('onds.0.return_date', '2026-08-10'),
    ],
  },
  {
    id: 'complex_oneway_then_stop_filter',
    title: 'One-way flow then one-stop filter',
    turns: [
      'Find one-way flights from Bangalore to Singapore on 2026-09-05 for 3 people',
      'Only one-stop options',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastSearch trip_type is oneway',
      'lastSearch passengers.adults is 3',
      'lastAppliedFilters has stops code 2',
    ],
    validate: [
      lastSearchField('trip_type', 'oneway'),
      lastSearchField('passengers.adults', 3),
      lastFilter('stops', '2'),
      filteredCount(1),
    ],
  },
  {
    id: 'complex_baggage_filter',
    title: 'Baggage filter after search',
    turns: [
      'Search flights from Mumbai to Delhi on 2026-07-20',
      'Show flights with checked baggage only',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastAppliedFilters baggage includes code 0',
      'filtered results are grounded in apply_filter',
    ],
    validate: [
      lastFilter('baggage', '0'),
      filteredCount(1),
    ],
  },
  {
    id: 'complex_two_or_more_stops_filter',
    title: 'Two-stop or more stops filter',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-21',
      'Show two-stop or more flights',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastAppliedFilters stops includes one-plus stops code 3',
      'filtered results count uses API code 3',
    ],
    validate: [
      lastFilter('stops', '3'),
      filteredCount(2),
    ],
  },
  {
    id: 'complex_departure_arrival_filter',
    title: 'Departure + arrival time filter',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-22',
      'Show early morning departures that arrive in the afternoon',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastAppliedFilters departureTime includes EARLYMORNING',
      'lastAppliedFilters arrivalTime includes AFTERNOON',
    ],
    validate: [
      lastFilter('departureTime', 'EARLYMORNING'),
      lastFilter('arrivalTime', 'AFTERNOON'),
      filteredCount(1),
    ],
  },
  {
    id: 'complex_total_duration_filter',
    title: 'Total duration filter',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-23',
      'Show flights under 3 hours total duration',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastAppliedFilters totalDuration maxDurationMinutes is at or below 180',
      'filtered results are produced by apply_filter',
    ],
    validate: [
      durationMaxAtMost('totalDuration', 'maxDurationMinutes', 180),
      filteredCount(2),
    ],
  },
  {
    id: 'complex_layover_duration_filter',
    title: 'Layover duration filter',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-24',
      'Only show flights with layover under 1 hour',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'lastAppliedFilters layoverDuration maxDurationMinutes is at or below 60',
      'apply_filter uses existing searchKey',
    ],
    validate: [
      durationMaxAtMost('layoverDuration', 'maxDurationMinutes', 60),
      filterUsesCurrentSearchKey(),
    ],
  },
  {
    id: 'complex_unclear_query',
    title: 'Unclear user query',
    turns: ['Can you find something good for me?'],
    expectedToolSequence: [],
    expectedContextUpdates: [
      'no searchKey is created',
      'agent asks a clarifying question instead of calling tools',
    ],
    validate: [
      noSearchKey(),
      noToolCalls(),
      finalResponseMatches(/where|origin|destination|from|to|date|travel/i),
    ],
  },
  {
    id: 'complex_user_changes_mind_mid_conversation',
    title: 'User changes mind after filtering',
    turns: [
      'Find flights from Delhi to Mumbai on 2026-07-25',
      'Show non-stop only',
      'Actually switch to Delhi to Bangalore on 2026-07-26 for 2 adults business class with evening arrivals only',
    ],
    expectedToolSequence: ['flight_search', 'apply_filter', 'flight_search', 'apply_filter'],
    expectedContextUpdates: [
      'first searchKey is created',
      'non-stop filter is applied',
      'changed route/passengers/cabin triggers new flight_search',
      'evening arrival filter is applied after new search',
    ],
    validate: [
      searchCallCount(2),
      filterCallCount(2),
      searchKeysAreUnique(),
      lastSearchField('onds.0.destination', /Bangalore/i),
      lastSearchField('passengers.adults', 2),
      lastSearchField('cabin_class', 'business'),
      lastFilter('arrivalTime', 'EVENING'),
    ],
  },
];

function getPath(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value);
}

function hasSearchKey() {
  return (context) => {
    if (!context.searchKey) {
      throw new Error('Expected searchKey to be set');
    }
  };
}

function noSearchKey() {
  return (context) => {
    if (context.searchKey) {
      throw new Error(`Expected no searchKey, got ${context.searchKey}`);
    }
  };
}

function noToolCalls() {
  return (context) => {
    if (context.toolCallLog.length !== 0) {
      throw new Error(`Expected no tool calls, got ${context.toolCallLog.map((entry) => entry.tool).join(' -> ')}`);
    }
  };
}

function lastSearchField(path, expected) {
  return (context) => {
    const actual = getPath(context.lastSearch, path);
    if (expected instanceof RegExp) {
      if (!expected.test(String(actual))) {
        throw new Error(`Expected lastSearch.${path} to match ${expected}, got ${actual}`);
      }
      return;
    }
    if (actual !== expected) {
      throw new Error(`Expected lastSearch.${path}=${expected}, got ${actual}`);
    }
  };
}

function lastFilter(filterType, filterCode) {
  return (context) => {
    const actual = context.lastAppliedFilters || [];
    const found = actual.some(
      (filter) => filter.filterType === filterType && filter.filterCode === filterCode,
    );
    if (!found) {
      throw new Error(
        `Expected lastAppliedFilters to include ${filterType}:${filterCode}, got ${JSON.stringify(actual)}`,
      );
    }
  };
}

function filteredCount(expected) {
  return (context) => {
    const actual = context.filteredFlightResults?.length || 0;
    if (actual !== expected) {
      throw new Error(`Expected filteredFlightResults count ${expected}, got ${actual}`);
    }
  };
}

function durationMaxAtMost(filterType, field, max) {
  return (context) => {
    const durationFilter = context.lastAppliedFilters?.find(
      (filter) => filter.filterType === filterType,
    );
    const actual = durationFilter?.[field];
    if (typeof actual !== 'number' || actual > max) {
      throw new Error(`Expected ${filterType}.${field} <= ${max}, got ${actual}`);
    }
  };
}

function searchCallCount(expected) {
  return (context) => {
    const actual = context.toolCallLog.filter((entry) => entry.tool === 'flight_search').length;
    if (actual !== expected) {
      throw new Error(`Expected ${expected} flight_search calls, got ${actual}`);
    }
  };
}

function filterCallCount(expected) {
  return (context) => {
    const actual = context.toolCallLog.filter((entry) => entry.tool === 'apply_filter').length;
    if (actual !== expected) {
      throw new Error(`Expected ${expected} apply_filter calls, got ${actual}`);
    }
  };
}

function searchKeysAreUnique() {
  return (context) => {
    const keys = context.toolCallLog
      .filter((entry) => entry.tool === 'flight_search')
      .map((entry) => entry.searchKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`Expected unique searchKeys, got ${keys.join(', ')}`);
    }
  };
}

function filterUsesCurrentSearchKey() {
  return (context) => {
    const filterCalls = context.toolCallLog.filter((entry) => entry.tool === 'apply_filter');
    for (const call of filterCalls) {
      if (call.searchKey !== context.searchKey) {
        throw new Error(`Expected apply_filter searchKey ${context.searchKey}, got ${call.searchKey}`);
      }
    }
  };
}

function turnToolSequence(turnNumber, expected) {
  return (_context, result) => {
    const actual = result.turns[turnNumber - 1]?.toolCalls || [];
    assertSequence(actual, expected, `turn ${turnNumber}`);
  };
}

function finalResponseMatches(pattern) {
  return (_context, result) => {
    const response = result.turns.at(-1)?.response || '';
    if (!pattern.test(response)) {
      throw new Error(`Expected final response to match ${pattern}, got ${response}`);
    }
  };
}

function assertSequence(actual, expected, label = 'tool sequence') {
  const actualText = actual.join(' -> ');
  const expectedText = expected.join(' -> ');
  if (actualText !== expectedText) {
    throw new Error(`Expected ${label} ${expectedText || '(none)'}, got ${actualText || '(none)'}`);
  }
}

function assertNoFlightContractsWithoutTool(result) {
  const flightDetailPattern = /Sample Air|Demo Airlines|Example Express|SA 101|DA 204|EE 309|USD\s+\d+/i;
  for (const turn of result.turns) {
    if (turn.toolCalls.length === 0 && flightDetailPattern.test(turn.response)) {
      throw new Error(`Turn ${turn.turn} appears to mention flight contract details without a tool call`);
    }
  }
}

function snapshotContext(context) {
  return {
    UID: context.UID,
    searchKey: context.searchKey || null,
    lastSearch: context.lastSearch || null,
    lastAppliedFilters: context.lastAppliedFilters || null,
    lastApplyFilterPayload: context.lastApplyFilterPayload || null,
    flightResultsCount: context.flightResults?.length || 0,
    filteredFlightResultsCount: context.filteredFlightResults?.length || 0,
    toolCallLog: context.toolCallLog.map((entry) => ({
      tool: entry.tool,
      searchKey: entry.searchKey,
      input: entry.input || null,
      filters: entry.filters || null,
      apiPayload: entry.apiPayload || null,
    })),
  };
}

function getRecurringIssues(results) {
  const failed = results.filter((result) => !result.pass);
  const issues = [];

  if (failed.some((result) => result.failureReason.includes('tool sequence'))) {
    issues.push('Some turns did not choose the expected tool sequence.');
  }
  if (failed.some((result) => result.failureReason.includes('searchKey'))) {
    issues.push('Some context state checks failed around searchKey creation or reuse.');
  }
  if (failed.some((result) => result.failureReason.includes('lastAppliedFilters'))) {
    issues.push('Some filter payloads did not map user wording to the expected schema values.');
  }
  if (failed.some((result) => result.failureReason.includes('lastSearch'))) {
    issues.push('Some search payloads did not map changed route/date/passenger/cabin inputs as expected.');
  }

  return issues.length ? issues : ['No recurring issues found in this run.'];
}

function getSuggestedFixes(results) {
  const issues = getRecurringIssues(results).join(' ');
  const fixes = [];

  if (/tool sequence/i.test(issues)) {
    fixes.push('Tighten prompt routing examples for mixed search+filter turns and changed-search turns.');
  }
  if (/filter payload/i.test(issues)) {
    fixes.push('Add explicit examples mapping natural-language filters to apply_filter schema values.');
  }
  if (/search payload/i.test(issues)) {
    fixes.push('Add examples for changed route/date/passenger/cabin requests that must restart search.');
  }
  if (/searchKey/i.test(issues)) {
    fixes.push('Persist search state through the SDK context and expose active-search state in instructions.');
  }

  return fixes.length ? fixes : ['No prompt/tool fixes are needed based on this run.'];
}

async function runCase(testCase) {
  const context = {
    UID: testCase.id,
    toolCallLog: [],
  };
  const turns = [];

  for (let index = 0; index < testCase.turns.length; index += 1) {
    const message = testCase.turns[index];
    const beforeCallCount = context.toolCallLog.length;
    const response = await runFlightAgent({
      input: message,
      sessionId: testCase.id,
      requestId: `${testCase.id}-turn-${index + 1}`,
      context,
    });

    turns.push({
      turn: index + 1,
      user: message,
      response: response.output,
      toolCalls: context.toolCallLog.slice(beforeCallCount).map((entry) => entry.tool),
      toolPayloads: context.toolCallLog.slice(beforeCallCount).map((entry) => ({
        tool: entry.tool,
        input: entry.input || null,
        filters: entry.filters || null,
        searchKey: entry.searchKey,
      })),
      contextAfter: snapshotContext(context),
    });
  }

  const result = {
    id: testCase.id,
    title: testCase.title,
    model: flightAgentConfig.model,
    conversationTurns: testCase.turns,
    expectedToolSequence: testCase.expectedToolSequence,
    actualToolSequence: context.toolCallLog.map((entry) => entry.tool),
    expectedContextUpdates: testCase.expectedContextUpdates,
    actualContextUpdates: snapshotContext(context),
    turns,
    finalResponse: turns.at(-1)?.response || '',
    pass: true,
    failureReason: '',
  };

  try {
    assertSequence(result.actualToolSequence, result.expectedToolSequence);
    for (const validator of testCase.validate) {
      validator(context, result);
    }
    assertNoFlightContractsWithoutTool(result);
  } catch (error) {
    result.pass = false;
    result.failureReason = error instanceof Error ? error.message : String(error);
  }

  return result;
}

function printReport(results) {
  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const successRate = ((passed / results.length) * 100).toFixed(1);

  console.log('# Flight Agent complex multi-turn live test report');
  console.log(`Model: ${flightAgentConfig.model}`);
  console.log(`Total test cases: ${results.length}`);
  console.log(`Passed cases: ${passed}`);
  console.log(`Failed cases: ${failed}`);
  console.log(`Success percentage: ${successRate}%`);
  console.log('');

  for (const result of results) {
    console.log(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.title}`);
    console.log(`ID: ${result.id}`);
    console.log(`Conversation turns: ${JSON.stringify(result.conversationTurns)}`);
    console.log(`Expected tool sequence: ${result.expectedToolSequence.join(' -> ') || '(none)'}`);
    console.log(`Actual tool sequence: ${result.actualToolSequence.join(' -> ') || '(none)'}`);
    console.log(`Expected context updates: ${JSON.stringify(result.expectedContextUpdates)}`);
    console.log(`Actual context updates: ${JSON.stringify(result.actualContextUpdates)}`);
    console.log(`Final response: ${JSON.stringify(result.finalResponse)}`);
    if (!result.pass) {
      console.log(`Failure reason: ${result.failureReason}`);
    }
    console.log('Turn details:');
    for (const turn of result.turns) {
      console.log(`- Turn ${turn.turn}`);
      console.log(`  user: ${JSON.stringify(turn.user)}`);
      console.log(`  response: ${JSON.stringify(turn.response)}`);
      console.log(`  tools: ${turn.toolCalls.join(' -> ') || '(none)'}`);
      console.log(`  toolPayloads: ${JSON.stringify(turn.toolPayloads)}`);
      console.log(`  contextAfter: ${JSON.stringify(turn.contextAfter)}`);
    }
    console.log('');
  }

  const failedResults = results.filter((result) => !result.pass);
  console.log('## Failed scenarios');
  if (failedResults.length === 0) {
    console.log('- None');
  } else {
    for (const result of failedResults) {
      console.log(`- ${result.title}: ${result.failureReason}`);
    }
  }

  console.log('');
  console.log('## Recurring issues');
  for (const issue of getRecurringIssues(results)) {
    console.log(`- ${issue}`);
  }

  console.log('');
  console.log('## Suggested prompt/tool fixes');
  for (const fix of getSuggestedFixes(results)) {
    console.log(`- ${fix}`);
  }

  console.log('');
  console.log('## Final recommendation');
  if (failed === 0) {
    console.log('- The current FlightSearchTool + ApplyFilterTool flow is ready for the next integration step with real APIs or UI context rendering.');
  } else {
    console.log('- Fix the failed routing or schema-mapping cases before integrating real APIs.');
  }
}

const results = [];

for (const testCase of cases) {
  results.push(await runCase(testCase));
}

const resultsDir = path.join(process.cwd(), 'tests', 'results');
await fs.mkdir(resultsDir, { recursive: true });
await fs.writeFile(
  path.join(resultsDir, 'flight-agent-complex-multiturn-latest.json'),
  JSON.stringify(
    {
      model: flightAgentConfig.model,
      total: results.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      results,
    },
    null,
    2,
  ),
);

printReport(results);
