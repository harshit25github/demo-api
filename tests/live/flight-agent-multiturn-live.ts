process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

import assert from 'node:assert/strict';
const { runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const SUGGESTED_TOOL = 'update_flight_suggested_questions';

const cases = [
  {
    id: 'search_only',
    title: 'Search-only flow',
    context: { UID: 'mt-search-only' },
    turns: ['Find flights from Delhi to Mumbai tomorrow'],
    expectedToolSequence: ['flight_search', SUGGESTED_TOOL],
    expectedFinalBehavior: 'Creates a new search, stores searchKey, and responds with search confirmation.',
    validate(context) {
      assert.ok(context.searchKey, 'searchKey should be set');
      assert.equal(context.flightResults?.length, 3, 'dummy search should store 3 results');
      assert.equal(context.filteredFlightResults?.length, 3, 'unfiltered search should expose all results');
    },
  },
  {
    id: 'search_plus_filter',
    title: 'Search + filter in same user query',
    context: { UID: 'mt-search-plus-filter' },
    turns: ['Find flights from Delhi to Mumbai tomorrow with non-stop only'],
    expectedToolSequence: ['flight_search', 'apply_filter', SUGGESTED_TOOL],
    expectedFinalBehavior: 'Starts a search, stores searchKey, then applies the non-stop filter.',
    validate(context) {
      assert.ok(context.searchKey, 'searchKey should be set before filter');
      assertFilter(context, 'stops', '0');
      assert.equal(context.filteredFlightResults?.length, 1, 'non-stop filter should return 1 dummy result');
    },
  },
  {
    id: 'filter_after_search',
    title: 'Filter-only after search already exists',
    context: { UID: 'mt-filter-after-search' },
    turns: [
      'Find flights from Delhi to Mumbai tomorrow',
      'Show only morning departure flights',
    ],
    expectedToolSequence: ['flight_search', SUGGESTED_TOOL, 'apply_filter', SUGGESTED_TOOL],
    expectedFinalBehavior: 'Uses existing searchKey and applies departure-time filter on the second turn.',
    validate(context) {
      assert.ok(context.searchKey, 'searchKey should persist across turns');
      assertFilter(context, 'departureTime', 'MORNING');
      assert.equal(context.filteredFlightResults?.length, 1, 'morning departure filter should return 1 dummy result');
    },
  },
  {
    id: 'filter_without_search',
    title: 'Filter-only without existing searchKey',
    context: { UID: 'mt-filter-without-search' },
    turns: ['Show me non-stop flights'],
    expectedToolSequence: [SUGGESTED_TOOL],
    expectedFinalBehavior: 'Does not apply filters; asks for origin, destination, and travel date.',
    validate(context, result) {
      assert.equal(context.searchKey, undefined, 'searchKey should not be created');
      assert.deepEqual(
        context.toolCallLog.map((entry) => entry.tool),
        [SUGGESTED_TOOL],
        'only suggested questions update tool should be called',
      );
      assert.match(result.turns.at(-1).response, /origin|departure city|flying from|from/i);
      assert.match(result.turns.at(-1).response, /destination/i);
      assert.match(result.turns.at(-1).response, /travel date|date/i);
    },
  },
  {
    id: 'change_search_inputs',
    title: 'Changed date/passenger after search triggers new search',
    context: { UID: 'mt-change-search-inputs' },
    turns: [
      'Find flights from Delhi to Mumbai tomorrow',
      'Change it to 2 adults from Delhi to Bangalore the day after tomorrow',
    ],
    expectedToolSequence: ['flight_search', SUGGESTED_TOOL, 'flight_search', SUGGESTED_TOOL],
    expectedFinalBehavior: 'Treats changed route/date/passengers as a new search and creates a new searchKey.',
    validate(context, result) {
      const searchCalls = context.toolCallLog.filter((entry) => entry.tool === 'flight_search');
      assert.equal(searchCalls.length, 2, 'should call flight_search twice');
      assert.notEqual(searchCalls[0].searchKey, searchCalls[1].searchKey, 'new search should create a new searchKey');
      assert.equal(context.lastSearch?.onds?.[0]?.destination, 'Bangalore');
      assert.equal(context.lastSearch?.passengers?.adults, 2);
      assert.equal(result.turns[0].contextAfter.searchKey, searchCalls[0].searchKey);
      assert.equal(result.turns[1].contextAfter.searchKey, searchCalls[1].searchKey);
    },
  },
];

function assertFilter(context, filterType, filterCode) {
  assert.ok(
    context.lastAppliedFilters?.some(
      (filter) => filter.filterType === filterType && filter.filterCode === filterCode,
    ),
    `Expected ${filterType} filter code ${filterCode}`,
  );
}

function snapshotContext(context) {
  return {
    UID: context.UID,
    searchKey: context.searchKey || null,
    lastSearch: context.lastSearch || null,
    lastAppliedFilters: context.lastAppliedFilters || null,
    flightResultsCount: context.flightResults?.length || 0,
    filteredFlightResultsCount: context.filteredFlightResults?.length || 0,
    suggestedQuestions: context.flight?.suggestedQuestions || [],
  };
}

function assertSuggestedQuestionsUpdated(context, response) {
  const suggestions = context.flight?.suggestedQuestions || [];
  assert.equal(suggestions.length, 3, 'suggestedQuestions should contain exactly 3 items');

  for (const suggestion of suggestions) {
    assert.equal(typeof suggestion, 'string', 'suggested question should be a string');
    assert.ok(suggestion.trim(), 'suggested question should not be empty');
    assert.ok(
      !response.includes(suggestion),
      `response should not expose suggested question: ${suggestion}`,
    );
  }
}

async function runCase(testCase) {
  const context: any = {
    ...testCase.context,
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
      contextAfter: snapshotContext(context),
    });

    assertSuggestedQuestionsUpdated(context, response.output || '');
  }

  const actualToolSequence = context.toolCallLog.map((entry) => entry.tool);
  const result = {
    id: testCase.id,
    title: testCase.title,
    model: flightAgentConfig.model,
    expectedToolSequence: testCase.expectedToolSequence,
    actualToolSequence,
    expectedContextUpdates: testCase.expectedFinalBehavior,
    turns,
    finalContext: snapshotContext(context),
  };

  assert.deepEqual(actualToolSequence, testCase.expectedToolSequence, `${testCase.id} tool sequence mismatch`);
  testCase.validate(context, result);

  return result;
}

function printReport(results) {
  console.log(`# Flight Agent multi-turn live test report`);
  console.log(`Model: ${flightAgentConfig.model}`);
  console.log(`Cases: ${results.length}`);
  console.log('');

  for (const result of results) {
    console.log(`## ${result.title}`);
    console.log(`Expected tool sequence: ${result.expectedToolSequence.join(' -> ') || '(none)'}`);
    console.log(`Actual tool sequence: ${result.actualToolSequence.join(' -> ') || '(none)'}`);
    console.log(`Expected final behavior: ${result.expectedContextUpdates}`);
    console.log(`Final context: ${JSON.stringify(result.finalContext)}`);
    console.log('Turns:');

    for (const turn of result.turns) {
      console.log(`- Turn ${turn.turn} user: ${turn.user}`);
      console.log(`  response: ${turn.response}`);
      console.log(`  tools: ${turn.toolCalls.join(' -> ') || '(none)'}`);
      console.log(`  contextAfter: ${JSON.stringify(turn.contextAfter)}`);
    }

    console.log('');
  }
}

const results = [];

for (const testCase of cases) {
  results.push(await runCase(testCase));
}

printReport(results);
