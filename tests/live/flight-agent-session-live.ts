process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '4';

import assert from 'node:assert/strict';
import test from 'node:test';
const { clearFlightAgentSession, getFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');

test('MemorySession reuses chat history and tool context across two turns', async () => {
  const sessionId = `memory-session-${Date.now()}`;
  const requestPrefix = `${sessionId}-request`;

  await clearFlightAgentSession(sessionId);

  const firstSession = getFlightAgentSession(sessionId);
  const firstContext: any = {
    UID: sessionId,
    toolCallLog: [],
  };

  const firstTurn = await runFlightAgent({
    input: 'Find flights from Delhi to Mumbai tomorrow',
    requestId: `${requestPrefix}-1`,
    sessionId,
    context: firstContext,
  });

  assert.ok(firstTurn.context.searchKey, 'first turn should store searchKey in context');
  assert.deepEqual(
    (firstTurn.context.toolCallLog as any[]).map((entry) => entry.tool),
    ['flight_search'],
    'first turn should call only flight_search',
  );

  const secondTurn = await runFlightAgent({
    input: 'Now show only morning flights',
    requestId: `${requestPrefix}-2`,
    sessionId,
  });

  const reusedSession = getFlightAgentSession(sessionId);
  assert.equal(reusedSession, firstSession, 'same chat should reuse the same MemorySession');
  assert.equal(
    secondTurn.context,
    firstTurn.context,
    'same chat should reuse app context for searchKey-dependent tools',
  );
  assert.equal(
    secondTurn.context.searchKey,
    firstTurn.context.searchKey,
    'second turn should keep the active searchKey',
  );
  assert.deepEqual(
    (secondTurn.context.toolCallLog as any[]).map((entry) => entry.tool),
    ['flight_search', 'apply_filter'],
    'follow-up filter should apply to the existing search',
  );
  assert.ok(
    (secondTurn.context.lastAppliedFilters as any[])?.some(
      (filter) => filter.filterType === 'departureTime' && filter.filterCode === 'MORNING',
    ),
    'second turn should apply the morning departure filter',
  );

  await clearFlightAgentSession(sessionId);
});

test('new chat gets a separate MemorySession', async () => {
  const firstChatId = `new-chat-a-${Date.now()}`;
  const secondChatId = `new-chat-b-${Date.now()}`;

  await clearFlightAgentSession(firstChatId);
  await clearFlightAgentSession(secondChatId);

  const firstSession = getFlightAgentSession(firstChatId);
  const secondSession = getFlightAgentSession(secondChatId);

  assert.notEqual(firstSession, secondSession, 'different chats should not share MemorySession');

  await clearFlightAgentSession(firstChatId);
  await clearFlightAgentSession(secondChatId);
});
