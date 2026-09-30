import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const resultsDir = path.resolve('tests/results');
const jsonReportPath = path.join(resultsDir, 'flight-agent-airport-all-options-latest.json');
const textReportPath = path.join(resultsDir, 'flight-agent-airport-all-options-latest.txt');

function optionCodes(options = [], { nearbyOnly = false } = {}) {
  return (Array.isArray(options) ? options : [])
    .filter((option) => option && (!nearbyOnly || option.IsNearby === true))
    .map((option) => option.Code)
    .filter(Boolean);
}

function codesFromPayload(payload = [], filterType) {
  const filter = payload.find((item) => item.filterType === filterType);
  if (!filter) {
    return [];
  }

  return filter.Values.flatMap((value) =>
    String(value)
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean),
  );
}

function latestApplyCall(calls = []) {
  return [...calls].reverse().find((call) => call.tool === 'apply_filter') || null;
}

function expectCodes({ payload, filterType, expectedCodes }) {
  const actualCodes = codesFromPayload(payload, filterType);
  const missingCodes = expectedCodes.filter((code) => !actualCodes.includes(code));
  return missingCodes.length === 0
    ? []
    : [`Expected ${filterType} to include ${missingCodes.join(', ')}; got ${actualCodes.join(', ') || '(none)'}.`];
}

function expectNoApplyOnSuggestion({ calls }) {
  return calls.some((call) => call.tool === 'apply_filter')
    ? ['Expected airport option question to be answered from context without apply_filter.']
    : [];
}

function expectApplyPayload({ context, calls, expected }) {
  const applyCall = latestApplyCall(calls);
  if (!applyCall) {
    return ['Expected apply_filter call, got none.'];
  }

  const payload = applyCall.finalFilterPayload || [];
  return expected.flatMap((expectation) => {
    if (expectation.filterType === 'outbounddepart') {
      return expectCodes({
        payload,
        filterType: 'outbounddepart',
        expectedCodes: optionCodes(context.DepartAirports, {
          nearbyOnly: expectation.nearbyOnly,
        }),
      });
    }

    if (expectation.filterType === 'outboundarrival') {
      return expectCodes({
        payload,
        filterType: 'outboundarrival',
        expectedCodes: optionCodes(context.DepLandAirports, {
          nearbyOnly: expectation.nearbyOnly,
        }),
      });
    }

    if (expectation.filterType === 'baggage') {
      return expectCodes({ payload, filterType: 'baggage', expectedCodes: ['0'] });
    }

    return [`Unsupported expectation ${expectation.filterType}.`];
  });
}

async function runTurn({ context, scenarioId, turn, index }) {
  const beforeCallCount = context.toolCallLog.length;
  const result = await runFlightAgent({
    input: turn.user,
    sessionId: scenarioId,
    requestId: `${scenarioId}-turn-${index}`,
    context,
  });
  const calls = context.toolCallLog.slice(beforeCallCount);
  const errors = turn.check({ context, calls, response: result.output || '' });

  return {
    user: turn.user,
    response: result.output || '',
    actualTools: calls.map((call) => call.tool),
    payloads: calls.map((call) => ({
      tool: call.tool,
      finalFilterPayload: call.finalFilterPayload || null,
      filters: call.filters || null,
    })),
    pass: errors.length === 0,
    errors,
  };
}

const scenarios = [
  {
    id: 'all-departure-after-options',
    title: 'Airport options then apply all departure airports',
    turns: [
      {
        user: 'Find flights from NYC to LHR on July 20 for 1 adult.',
        check: ({ calls }) =>
          calls.some((call) => call.tool === 'flight_search') ? [] : ['Expected flight_search.'],
      },
      {
        user: 'What alternate airports are available?',
        check: expectNoApplyOnSuggestion,
      },
      {
        user: 'Apply all departure airports.',
        check: (args) =>
          expectApplyPayload({
            ...args,
            expected: [{ filterType: 'outbounddepart' }],
          }),
      },
    ],
  },
  {
    id: 'all-arrival-airports',
    title: 'Apply all arrival airports',
    turns: [
      {
        user: 'Find flights from NYC to LHR on July 20 for 1 adult.',
        check: ({ calls }) =>
          calls.some((call) => call.tool === 'flight_search') ? [] : ['Expected flight_search.'],
      },
      {
        user: 'Apply all arrival airports.',
        check: (args) =>
          expectApplyPayload({
            ...args,
            expected: [{ filterType: 'outboundarrival' }],
          }),
      },
    ],
  },
  {
    id: 'all-nearby-airports',
    title: 'Use all nearby airports',
    turns: [
      {
        user: 'Find flights from NYC to LHR on July 20 for 1 adult.',
        check: ({ calls }) =>
          calls.some((call) => call.tool === 'flight_search') ? [] : ['Expected flight_search.'],
      },
      {
        user: 'Use all nearby airports.',
        check: (args) =>
          expectApplyPayload({
            ...args,
            expected: [
              { filterType: 'outbounddepart', nearbyOnly: true },
              { filterType: 'outboundarrival', nearbyOnly: true },
            ],
          }),
      },
    ],
  },
  {
    id: 'all-these-alternate-airports',
    title: 'Enable all these alternate airports after suggestions',
    turns: [
      {
        user: 'Find flights from NYC to LHR on July 20 for 1 adult.',
        check: ({ calls }) =>
          calls.some((call) => call.tool === 'flight_search') ? [] : ['Expected flight_search.'],
      },
      {
        user: 'Show departure and arrival airport options.',
        check: expectNoApplyOnSuggestion,
      },
      {
        user: 'Enable all these alternate airports.',
        check: (args) =>
          expectApplyPayload({
            ...args,
            expected: [
              { filterType: 'outbounddepart', nearbyOnly: true },
              { filterType: 'outboundarrival', nearbyOnly: true },
            ],
          }),
      },
    ],
  },
  {
    id: 'all-arrival-plus-baggage',
    title: 'Apply all arrival airports and checked baggage',
    turns: [
      {
        user: 'Find flights from NYC to LHR on July 20 for 1 adult.',
        check: ({ calls }) =>
          calls.some((call) => call.tool === 'flight_search') ? [] : ['Expected flight_search.'],
      },
      {
        user: 'Apply all arrival airports and show checked baggage only.',
        check: (args) =>
          expectApplyPayload({
            ...args,
            expected: [{ filterType: 'outboundarrival' }, { filterType: 'baggage' }],
          }),
      },
    ],
  },
];

const report = [];

for (const scenario of scenarios) {
  await clearFlightAgentSession(scenario.id);
  const context = {
    UID: `airport-all-${scenario.id}`,
    uid: `airport-all-${scenario.id}`,
    toolCallLog: [],
  };
  const turns = [];

  for (const [index, turn] of scenario.turns.entries()) {
    turns.push(await runTurn({ context, scenarioId: scenario.id, turn, index: index + 1 }));
  }

  report.push({
    id: scenario.id,
    title: scenario.title,
    pass: turns.every((turn) => turn.pass),
    turns,
  });
}

const totalTurns = report.flatMap((scenario) => scenario.turns);
const summary = {
  generatedAt: new Date().toISOString(),
  model: flightAgentConfig.model,
  totalScenarios: report.length,
  passedScenarios: report.filter((scenario) => scenario.pass).length,
  failedScenarios: report.filter((scenario) => !scenario.pass).length,
  totalTurns: totalTurns.length,
  passedTurns: totalTurns.filter((turn) => turn.pass).length,
  failedTurns: totalTurns.filter((turn) => !turn.pass).length,
};

const textLines = [
  '# Flight Agent airport all-options report',
  `Generated: ${summary.generatedAt}`,
  `Model: ${summary.model}`,
  `Scenarios: ${summary.passedScenarios}/${summary.totalScenarios} passed`,
  `Turns: ${summary.passedTurns}/${summary.totalTurns} passed`,
  '',
  ...report.flatMap((scenario) => [
    `## ${scenario.pass ? 'PASS' : 'FAIL'} - ${scenario.title}`,
    ...scenario.turns.map(
      (turn, index) =>
        `- Turn ${index + 1}: ${turn.user} -> ${turn.actualTools.join(' -> ') || '(none)'} - ${
          turn.pass ? 'PASS' : `FAIL: ${turn.errors.join(' | ')}`
        }`,
    ),
    '',
  ]),
];

await mkdir(resultsDir, { recursive: true });
await writeFile(jsonReportPath, JSON.stringify({ summary, scenarios: report }, null, 2));
await writeFile(textReportPath, textLines.join('\n'));

console.log(textLines.join('\n'));
console.log(`JSON report: ${jsonReportPath}`);
console.log(`Text report: ${textReportPath}`);

if (summary.failedTurns > 0) {
  process.exitCode = 1;
}
