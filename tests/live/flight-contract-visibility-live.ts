import assert from 'node:assert/strict';

const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

flightAgentConfig.modelSettings.timeoutMs = Number(
  process.env.FLIGHT_VISIBILITY_LIVE_TIMEOUT_MS || 80_000,
);

const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');

const CONTRACT_TOOL = 'getGeneratedContractsContext';
const SUGGESTED_TOOL = 'update_flight_suggested_questions';

const contracts = [
  {
    id: 'contract-1',
    airline: 'Air Canada',
    airline_code: 'AC',
    flight_number: 'AC 101',
    origin: 'JFK',
    destination: 'DEL',
    departure_time: '09:00',
    arrival_time: '23:10',
    duration: '14h 10m',
    total_duration_minutes: 850,
    stops: 1,
    baggage: ['1', '0'],
    cabin_class: 'economy',
    price: { amount: 820, currency: 'USD' },
    display: true,
  },
  {
    id: 'contract-2',
    airline: 'Emirates',
    airline_code: 'EK',
    flight_number: 'EK 204',
    origin: 'JFK',
    destination: 'DEL',
    departure_time: '22:20',
    arrival_time: '02:05',
    duration: '18h 45m',
    total_duration_minutes: 1125,
    stops: 1,
    baggage: ['1', '0'],
    cabin_class: 'economy',
    price: { amount: 680, currency: 'USD' },
    display: true,
  },
  {
    id: 'contract-3',
    airline: 'Qatar Airways',
    airline_code: 'QR',
    flight_number: 'QR 702',
    origin: 'JFK',
    destination: 'DEL',
    departure_time: '11:15',
    arrival_time: '06:50',
    duration: '16h 20m',
    total_duration_minutes: 980,
    stops: 1,
    baggage: ['1'],
    cabin_class: 'economy',
    price: { amount: 790, currency: 'USD' },
    display: true,
  },
  {
    id: 'contract-4',
    airline: 'Lufthansa',
    airline_code: 'LH',
    flight_number: 'LH 401',
    origin: 'JFK',
    destination: 'DEL',
    departure_time: '16:30',
    arrival_time: '17:50',
    duration: '15h 20m',
    total_duration_minutes: 920,
    stops: 1,
    baggage: ['1', '0'],
    cabin_class: 'economy',
    price: { amount: 750, currency: 'USD' },
    display: true,
  },
];

function createContext(caseId) {
  return {
    requestId: `request-${caseId}`,
    sessionId: `session-${caseId}`,
    toolCallLog: [],
    flight: {
      uid: 'visibility-live-user',
      searchKey: `search-${caseId}`,
      tripType: 'oneway',
      cabinClass: 'economy',
      outboundDate: '2026-12-20',
      inboundDate: '',
      segments: [{ date: '2026-12-20', origin: 'JFK', destination: 'DEL' }],
      passengerData: {
        total: 1,
        adults: 1,
        seniors: 0,
        children: 0,
        lapInfants: 0,
        seatInfants: 0,
        childrenAges: [],
      },
      searchResults: structuredClone(contracts),
      showFlight: true,
      bookingStatus: 'results_shown',
      totalResultsFound: contracts.length,
      suggestedQuestions: [],
    },
  };
}

function contractCalls(context) {
  return context.toolCallLog.filter((entry) => entry.tool === CONTRACT_TOOL);
}

function visibleIndexes(context) {
  return context.flight.searchResults
    .map((contract, index) => (contract.display !== false ? index + 1 : null))
    .filter(Boolean);
}

async function runCase({ id, input, expectedModes, prepareContext, validate }: any) {
  const sessionId = `flight-visibility-${id}-${Date.now()}`;
  const context = createContext(id);
  prepareContext?.(context);
  await clearFlightAgentSession(sessionId);

  try {
    const result = await runFlightAgent({
      input,
      sessionId,
      context,
      now: new Date('2026-08-24T10:00:00.000Z'),
      timeZone: 'Asia/Kolkata',
    });

    assert.equal(result.error, undefined, `${id}: Flight Agent returned an error`);
    const calls = contractCalls(result.context);
    assert.deepEqual(
      calls.map((call) => call.mode),
      expectedModes,
      `${id}: unexpected contract-tool modes`,
    );
    assert.equal(
      (result.context.toolCallLog as any[]).at(-1)?.tool,
      SUGGESTED_TOOL,
      `${id}: suggested-question updater was not the final tool`,
    );
    assert.doesNotMatch(
      result.output,
      /searchKey|display=true|display=false/i,
      `${id}: internal visibility metadata leaked to the response`,
    );
    validate({ result, calls });

    return {
      id,
      input,
      model: flightAgentConfig.model,
      reasoningEffort: flightAgentConfig.modelSettings.reasoning?.effort || null,
      latencyMs: result.latencyMs,
      toolCalls: (result.context.toolCallLog as any[]).map((entry) => ({
        tool: entry.tool,
        mode: entry.mode || null,
        indexes: entry.indexes ?? null,
      })),
      visibleIndexes: visibleIndexes(result.context),
      response: result.output,
      pass: true,
    };
  } finally {
    await clearFlightAgentSession(sessionId);
  }
}

assert.equal(flightAgentConfig.model, 'gpt-5.5');
assert.equal(flightAgentConfig.modelSettings.reasoning?.effort, 'low');

const report = [];
const showAllOnly = process.argv.includes('--show-all-only');

if (!showAllOnly) {
report.push(
  await runCase({
    id: 'explicit-compare',
    input: 'Compare option 1 and option 3.',
    expectedModes: ['select'],
    validate({ result, calls }) {
      assert.deepEqual(calls[0].indexes, [1, 3]);
      assert.deepEqual(visibleIndexes(result.context), [1, 3]);
    },
  }),
);

report.push(
  await runCase({
    id: 'cheapest',
    input: 'Show me the cheapest option.',
    expectedModes: ['read', 'select'],
    validate({ result, calls }) {
      assert.equal(calls[0].indexes, null);
      assert.ok(calls[1].indexes.length >= 1 && calls[1].indexes.length <= 3);
      assert.ok(calls[1].indexes.includes(2), 'cheapest: option 2 was not selected');
      assert.ok(visibleIndexes(result.context).includes(2));
    },
  }),
);

report.push(
  await runCase({
    id: 'generic-compare',
    input: 'Compare the best current options for me.',
    expectedModes: ['read', 'select'],
    validate({ result, calls }) {
      assert.equal(calls[0].indexes, null);
      assert.ok(calls[1].indexes.length >= 1 && calls[1].indexes.length <= 3);
      assert.deepEqual(
        visibleIndexes(result.context),
        [...calls[1].indexes].sort((left, right) => left - right),
      );
    },
  }),
);

report.push(
  await runCase({
    id: 'informational-read',
    input: 'Which airline operates option 2?',
    expectedModes: ['read'],
    validate({ result, calls }) {
      assert.deepEqual(calls[0].indexes, [2]);
      assert.deepEqual(visibleIndexes(result.context), [1, 2, 3, 4]);
    },
  }),
);
}

report.push(
  await runCase({
    id: 'show-all-again',
    input: 'Show me all the options again.',
    expectedModes: ['show_all'],
    prepareContext(context) {
      context.flight.searchResults = context.flight.searchResults.map((contract, index) => ({
        ...contract,
        display: index < 2,
      }));
    },
    validate({ result, calls }) {
      assert.equal(calls[0].indexes, null);
      assert.deepEqual(visibleIndexes(result.context), [1, 2, 3, 4]);
      assert.equal(
        result.context.toolCallLog.some((entry) => entry.tool === 'flight_search'),
        false,
      );
      assert.equal(
        result.context.toolCallLog.some((entry) => entry.tool === 'apply_filter'),
        false,
      );
    },
  }),
);

console.log('FLIGHT_CONTRACT_VISIBILITY_LIVE_REPORT');
console.log(JSON.stringify(report, null, 2));
