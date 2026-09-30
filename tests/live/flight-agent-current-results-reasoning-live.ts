import assert from 'node:assert/strict';
import test from 'node:test';
import { clearFlightAgentSession, runFlightAgent } from '../../src/agents/flight/runner.js';

const baseSearchPayload = {
  onds: [
    {
      origin: 'New York',
      destination: 'Delhi',
      outbound_date: '2026-12-20',
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

const currentFlightResults = [
  {
    id: 'contract-1',
    airline: 'Air Canada',
    airline_code: 'AC',
    flight_number: 'AC 101',
    origin: 'New York',
    destination: 'Delhi',
    departure_time: '09:00',
    arrival_time: '23:10',
    duration: '14h 10m',
    total_duration_minutes: 850,
    stops: 1,
    baggage: ['1', '0'],
    cabin_class: 'economy',
    price: { amount: 820, currency: 'USD' },
  },
  {
    id: 'contract-2',
    airline: 'Emirates',
    airline_code: 'EK',
    flight_number: 'EK 204',
    origin: 'New York',
    destination: 'Delhi',
    departure_time: '22:20',
    arrival_time: '02:05',
    duration: '18h 45m',
    total_duration_minutes: 1125,
    stops: 1,
    baggage: ['1', '0'],
    cabin_class: 'economy',
    price: { amount: 760, currency: 'USD' },
  },
  {
    id: 'contract-3',
    airline: 'Qatar Airways',
    airline_code: 'QR',
    flight_number: 'QR 702',
    origin: 'New York',
    destination: 'Delhi',
    departure_time: '11:15',
    arrival_time: '06:50',
    duration: '16h 20m',
    total_duration_minutes: 980,
    stops: 1,
    baggage: ['1'],
    cabin_class: 'economy',
    price: { amount: 790, currency: 'USD' },
  },
];

function createHydratedContext(): any {
  return {
    UID: 'current-results-test-user',
    uid: 'current-results-test-user',
    searchKey: 'prefilled-current-results-search',
    sid: 'prefilled-current-results-search',
    lastSearch: baseSearchPayload,
    flightResults: currentFlightResults,
    filteredFlightResults: currentFlightResults,
    toolCallLog: [],
  };
}

async function runReasoningCase({ name, input }) {
  const sessionId = `current-results-${name}-${Date.now()}`;
  const context = createHydratedContext();

  await clearFlightAgentSession(sessionId);
  const result = await runFlightAgent({ input, sessionId, context });
  await clearFlightAgentSession(sessionId);

  const tools = context.toolCallLog.map((entry) => entry.tool);

  assert.deepEqual(
    tools,
    ['getGeneratedContractsContext'],
    `${name}: expected only getGeneratedContractsContext, got ${tools.join(' -> ')}`,
  );
  assert.equal(context.lastGeneratedContractsContext?.ok, true);
  assert.equal(context.lastGeneratedContractsContext?.summary?.cheapestOption?.airline, 'Emirates');
  assert.ok(result.output.length > 0, `${name}: expected a final response`);

  return {
    input,
    output: result.output,
    tools,
    cheapest:
      context.lastGeneratedContractsContext.summary.cheapestOption.airline,
  };
}

test('current-result reasoning queries call generated contracts context only', async () => {
  const cases = [
    {
      name: 'cheapest-flight',
      input: 'Show me the cheapest flight.',
    },
    {
      name: 'cheapest-flight-option',
      input: 'Show me the cheapest flight option.',
    },
    {
      name: 'best-option',
      input: 'Which option should I choose?',
    },
    {
      name: 'compare-current-contracts',
      input: 'Compare the current contracts.',
    },
    {
      name: 'shortest-duration',
      input: 'Which flight has shortest duration?',
    },
  ];

  const report = [];

  for (const currentCase of cases) {
    report.push(await runReasoningCase(currentCase));
  }

  console.log(
    'CURRENT_RESULTS_REASONING_REPORT',
    JSON.stringify(report, null, 2),
  );
});
