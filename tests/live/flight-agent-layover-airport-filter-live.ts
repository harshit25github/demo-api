process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '4';

import assert from 'node:assert/strict';
import test from 'node:test';
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');

const testAirlineFilterOptions = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
];

const testLayoverAirportFilterOptions = [
  { Code: 'DXB', Text: 'Dubai', AirportCityName: 'Dubai', IsDisabled: false },
  {
    Code: 'DOH',
    Text: 'Doha Hamad International Airport',
    AirportCityName: 'Doha',
    IsDisabled: false,
  },
  { Code: 'HND', Text: 'Tokyo Haneda', AirportCityName: 'Tokyo', IsDisabled: false },
  { Code: 'NRT', Text: 'Tokyo Narita', AirportCityName: 'Tokyo', IsDisabled: false },
];

function toolNames(context) {
  return context.toolCallLog.map((entry) => entry.tool);
}

function payloadFilter(context, filterType) {
  return context.lastFinalFilterPayload?.find((filter) => filter.filterType === filterType);
}

test('layover airport filter uses shared context and works with other filters', async () => {
  const sessionId = `layover-airport-filter-${Date.now()}`;
  await clearFlightAgentSession(sessionId);

  const firstTurn = await runFlightAgent({
    input: 'Find flights from Delhi to London on 2026-07-15',
    sessionId,
    context: {
      UID: sessionId,
      toolCallLog: [],
      airlineFilterOptions: testAirlineFilterOptions,
      // Simulates the application saving the latest search's layover options in shared context.
      layoverAirportFilterOptions: testLayoverAirportFilterOptions,
    },
  });

  assert.deepEqual(toolNames(firstTurn.context), ['flight_search']);

  const secondTurn = await runFlightAgent({
    input: 'Show Air Canada flights under $190 with a layover in Dubai or Doha',
    sessionId,
  });

  assert.deepEqual(toolNames(secondTurn.context), ['flight_search', 'apply_filter']);
  assert.deepEqual(payloadFilter(secondTurn.context, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+'],
  });
  assert.deepEqual(payloadFilter(secondTurn.context, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['DXB,DOH'],
  });
  assert.deepEqual(payloadFilter(secondTurn.context, 'price'), {
    filterType: 'price',
    Values: [0, 190],
  });

  const thirdTurn = await runFlightAgent({
    input: 'Switch the layover to Tokyo',
    sessionId,
  });

  assert.deepEqual(toolNames(thirdTurn.context), [
    'flight_search',
    'apply_filter',
    'apply_filter',
  ]);
  assert.deepEqual(payloadFilter(thirdTurn.context, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['HND,NRT'],
  });
  assert.deepEqual(payloadFilter(thirdTurn.context, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+'],
  });
  assert.deepEqual(payloadFilter(thirdTurn.context, 'price'), {
    filterType: 'price',
    Values: [0, 190],
  });

  await clearFlightAgentSession(sessionId);
});
