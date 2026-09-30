process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '4';

import assert from 'node:assert/strict';
import test from 'node:test';
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');

const testAirlineFilterOptions = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'CA', Text: 'Air China', Name: 'Air China', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: '6E', Text: 'IndiGo', Name: 'IndiGo', IsDisabled: true },
];

function toolNames(context) {
  return context.toolCallLog.map((entry) => entry.tool);
}

function payloadFilter(context, filterType) {
  return context.lastFinalFilterPayload?.find((filter) => filter.filterType === filterType);
}

test('airline filters use latest search options and existing searchKey', async () => {
  const sessionId = `airline-filter-${Date.now()}`;
  await clearFlightAgentSession(sessionId);

  const firstTurn = await runFlightAgent({
    input: 'Find flights from Delhi to Mumbai on 2026-07-15',
    sessionId,
    context: {
      UID: sessionId,
      toolCallLog: [],
      // Simulates the application adding active-search airline options to shared context.
      airlineFilterOptions: testAirlineFilterOptions,
    },
  });

  assert.deepEqual(toolNames(firstTurn.context), ['flight_search']);
  assert.ok(firstTurn.context.searchKey);

  const secondTurn = await runFlightAgent({
    input: 'Show only Air Canada and Air China flights',
    sessionId,
  });

  assert.deepEqual(toolNames(secondTurn.context), ['flight_search', 'apply_filter']);
  assert.deepEqual(payloadFilter(secondTurn.context, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+,CA'],
  });

  const thirdTurn = await runFlightAgent({
    input: 'Also include IndiGo and require one stop',
    sessionId,
  });

  assert.deepEqual(toolNames(thirdTurn.context), [
    'flight_search',
    'apply_filter',
    'apply_filter',
  ]);
  assert.deepEqual(payloadFilter(thirdTurn.context, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+,CA'],
  });
  assert.deepEqual(payloadFilter(thirdTurn.context, 'stop'), {
    filterType: 'stop',
    Values: ['2'],
  });
  assert.match(thirdTurn.context.lastApplyFilterFeedback?.[0] || '', /IndiGo.*not available/i);

  const fourthTurn = await runFlightAgent({
    input: 'Show only Emirates flights under $190',
    sessionId,
  });

  assert.deepEqual(toolNames(fourthTurn.context), [
    'flight_search',
    'apply_filter',
    'apply_filter',
    'apply_filter',
  ]);
  assert.deepEqual(payloadFilter(fourthTurn.context, 'airline'), {
    filterType: 'airline',
    Values: ['EK'],
  });
  assert.deepEqual(payloadFilter(fourthTurn.context, 'price'), {
    filterType: 'price',
    Values: [0, 190],
  });

  await clearFlightAgentSession(sessionId);
});
