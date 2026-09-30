process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_E2E_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '8';

import assert from 'node:assert/strict';
import test from 'node:test';
import { clearFlightAgentSession, runFlightAgent } from '../../src/agents/flight/runner.js';

const PRICE_NOTE = 'Note: Prices shown are per person.';

function toolCallsForTurn(context, beforeCount) {
  return context.toolCallLog.slice(beforeCount);
}

async function runTurn({ sessionId, context, input, turn }) {
  const beforeCount = context.toolCallLog.length;
  const result = await runFlightAgent({
    sessionId,
    requestId: `${sessionId}-turn-${turn}`,
    context,
    input,
  });

  return {
    response: result.output || '',
    calls: toolCallsForTurn(context, beforeCount),
  };
}

function assertHasPriceNote(response) {
  assert.match(response, /Note: Prices shown are per person\./);
  assert.equal(response.split(PRICE_NOTE).length - 1, 1);
}

function assertNoPriceNote(response) {
  assert.doesNotMatch(response, /Prices shown are per person/i);
}

test('search results and search updates include the per-person price note', async () => {
  const sessionId = 'price-note-search-results';
  const context = {
    UID: 'price-note-user',
    uid: 'price-note-user',
    toolCallLog: [],
  };

  await clearFlightAgentSession(sessionId);

  const initialSearch = await runTurn({
    sessionId,
    context,
    turn: 1,
    input: 'Find flights from Jabalpur to Delhi on July 15, 2026 for 1 adult economy.',
  });
  assert.deepEqual(initialSearch.calls.map((call) => call.tool), ['flight_search']);
  assertHasPriceNote(initialSearch.response);

  const passengerUpdate = await runTurn({
    sessionId,
    context,
    turn: 2,
    input: 'Update it to 2 adults.',
  });
  assert.deepEqual(passengerUpdate.calls.map((call) => call.tool), ['flight_search']);
  assertHasPriceNote(passengerUpdate.response);

  const dateUpdate = await runTurn({
    sessionId,
    context,
    turn: 3,
    input: 'Change the departure date to July 18, 2026.',
  });
  assert.deepEqual(dateUpdate.calls.map((call) => call.tool), ['flight_search']);
  assertHasPriceNote(dateUpdate.response);

  await clearFlightAgentSession(sessionId);
});

test('pure filter confirmation does not include the per-person price note', async () => {
  const sessionId = 'price-note-filter-only';
  const context = {
    UID: 'price-note-filter-user',
    uid: 'price-note-filter-user',
    toolCallLog: [],
  };

  await clearFlightAgentSession(sessionId);

  await runTurn({
    sessionId,
    context,
    turn: 1,
    input: 'Find flights from NYC to LAX on July 15, 2026.',
  });

  const filterTurn = await runTurn({
    sessionId,
    context,
    turn: 2,
    input: 'Show only non-stop flights.',
  });
  assert.deepEqual(filterTurn.calls.map((call) => call.tool), ['apply_filter']);
  assertNoPriceNote(filterTurn.response);

  await clearFlightAgentSession(sessionId);
});

test('missing-search feedback does not include the per-person price note', async () => {
  const sessionId = 'price-note-no-results';
  const context = {
    UID: 'price-note-no-results-user',
    uid: 'price-note-no-results-user',
    toolCallLog: [],
  };

  await clearFlightAgentSession(sessionId);

  const missingSearch = await runTurn({
    sessionId,
    context,
    turn: 1,
    input: 'Show only non-stop Emirates flights.',
  });
  assert.deepEqual(missingSearch.calls.map((call) => call.tool), []);
  assertNoPriceNote(missingSearch.response);

  await clearFlightAgentSession(sessionId);
});
