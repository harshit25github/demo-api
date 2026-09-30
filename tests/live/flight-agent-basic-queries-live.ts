process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_E2E_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const REPORT_JSON = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-basic-queries-latest.json',
);
const REPORT_TXT = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-basic-queries-latest.txt',
);

const PRICE_NOTE = 'Note: Prices shown are per person.';
const SUGGESTED_TOOL = 'update_flight_suggested_questions';
const ORIGIN_WORDING = /origin|departure|departing|flying from|fly from|from/i;
const DESTINATION_WORDING = /destination|going|flying to|fly to|to/i;
const DATE_WORDING = /date|travel date|when/i;

const scenarios = [
  {
    id: 'basic-looking-for-flights',
    title: 'Generic search intent with all blocking details missing',
    turns: [
      {
        user: "I'm looking for a flight",
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [ORIGIN_WORDING, DESTINATION_WORDING, DATE_WORDING],
        responseMustNotInclude: [/passenger|adult|child|infant|cabin|class/i, /Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-economy-flight-missing-search',
    title: 'Cabin-only query acknowledges economy and asks required fields',
    turns: [
      {
        user: 'I need an economy flight',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [/economy/i, ORIGIN_WORDING, DESTINATION_WORDING, DATE_WORDING],
        responseMustNotInclude: [/Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-typo-destination-only',
    title: 'Typo search intent with destination only',
    turns: [
      {
        user: 'lookif fro flight to delhi',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [ORIGIN_WORDING, DATE_WORDING],
        responseMustNotInclude: [/Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-destination-only',
    title: 'Destination-only query acknowledges destination',
    turns: [
      {
        user: 'Flights to Delhi',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [/Delhi/i, ORIGIN_WORDING, DATE_WORDING],
        responseMustNotInclude: [/Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-origin-only',
    title: 'Origin-only query acknowledges origin',
    turns: [
      {
        user: 'From Mumbai',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [/Mumbai/i, DESTINATION_WORDING, DATE_WORDING],
        responseMustNotInclude: [/Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-route-without-date',
    title: 'Route present but travel date missing',
    turns: [
      {
        user: 'Looking for flights from Mumbai to Delhi.',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [/date|travel date/i],
        responseMustNotInclude: [/passenger|adult|child|infant|cabin|class/i, /Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-short-route-with-date',
    title: 'Short route/date query starts search',
    turns: [
      {
        user: 'Delhi to Mumbai tomorrow.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        responseMustInclude: [/Note: Prices shown are per person\./i],
      },
    ],
  },
  {
    id: 'basic-natural-search-with-passengers',
    title: 'Natural search with passengers starts search',
    turns: [
      {
        user: 'Looking for flight to Delhi from Mumbai on July 20 for 2 people.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        responseMustInclude: [/Note: Prices shown are per person\./i],
      },
    ],
  },
  {
    id: 'basic-progressive-missing-details',
    title: 'Destination-only query then user supplies origin and date',
    turns: [
      {
        user: 'I want to fly to Delhi.',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [ORIGIN_WORDING, DATE_WORDING],
        responseMustNotInclude: [/Prices shown are per person/i],
        responseShouldBeConversational: true,
      },
      {
        user: 'From Mumbai on July 20.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        responseMustInclude: [/Note: Prices shown are per person\./i],
      },
    ],
  },
  {
    id: 'basic-roundtrip-missing-return',
    title: 'Round-trip query missing return date asks only return date',
    turns: [
      {
        user: 'Looking for round trip flights from Delhi to Mumbai on July 20.',
        expectedTools: [SUGGESTED_TOOL],
        responseMustInclude: [/return|fly back/i],
        responseMustNotInclude: [/origin/i, /destination/i, /passenger|adult|child|infant|cabin|class/i],
        responseShouldBeConversational: true,
      },
    ],
  },
  {
    id: 'basic-search-plus-filter',
    title: 'Basic search plus non-stop filter',
    turns: [
      {
        user: 'Looking for flights from Delhi to Mumbai tomorrow, non-stop only.',
        expectedTools: ['flight_search', 'apply_filter', SUGGESTED_TOOL],
        responseMustNotInclude: [/searchKey|payload|flight_search|apply_filter/i],
      },
    ],
  },
];

function snapshotContext(context) {
  return {
    searchKey: context.searchKey || null,
    sid: context.sid || null,
    lastSearch: context.lastSearch || null,
    flightCount: context.flightResults?.length || 0,
    filteredCount: context.filteredFlightResults?.length || 0,
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    feedback: context.lastApplyFilterFeedback || [],
    suggestedQuestions: context.flight?.suggestedQuestions || [],
  };
}

function formatCalls(calls) {
  return calls.map((call) => ({
    tool: call.tool,
    searchKey: call.searchKey || null,
    input: call.input || null,
    finalFilterPayload: call.finalFilterPayload || null,
    feedback: call.feedback || null,
  }));
}

function isBareFormResponse(response) {
  const cleanedLines = response
    .replace(/\*\*/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (cleanedLines.length === 0) {
    return false;
  }

  const labelOnly = /^(origin|origin city\/airport|departure city|destination|travel date|date|return date|route)(\?|:)?$/i;
  return cleanedLines.every((line) => labelOnly.test(line));
}

function isConversationalMissingInfoResponse(response) {
  if (isBareFormResponse(response)) {
    return false;
  }

  const normalized = response.replace(/\s+/g, ' ').trim();
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount >= 5;
}

function validateTurn({ turn, actualTools, response }) {
  const issues = [];

  if (JSON.stringify(actualTools) !== JSON.stringify(turn.expectedTools)) {
    issues.push(
      `Expected tools ${turn.expectedTools.join(' -> ') || '(none)'}, got ${
        actualTools.join(' -> ') || '(none)'
      }.`,
    );
  }

  for (const pattern of turn.responseMustInclude || []) {
    if (!pattern.test(response)) {
      issues.push(`Response did not include ${pattern}.`);
    }
  }

  for (const pattern of turn.responseMustNotInclude || []) {
    if (pattern.test(response)) {
      issues.push(`Response unexpectedly matched ${pattern}.`);
    }
  }

  if (turn.responseShouldBeConversational && !isConversationalMissingInfoResponse(response)) {
    issues.push('Missing-info response should be conversational, not form-like labels.');
  }

  if (actualTools.includes('flight_search')) {
    const noteCount = response.split(PRICE_NOTE).length - 1;
    if (noteCount !== 1) {
      issues.push(`Search response should include one per-person price note; found ${noteCount}.`);
    }
  }

  if (!actualTools.includes('flight_search') && /Prices shown are per person/i.test(response)) {
    issues.push('Non-search response should not include the per-person price note.');
  }

  if (/\b(searchKey|payload|flight_search|apply_filter|getGeneratedContractsContext|update_flight_suggested_questions)\b/i.test(response)) {
    issues.push('Response exposed internal tool/payload details.');
  }

  return issues;
}

function validateSuggestedQuestions({ context, result }) {
  const issues = [];
  const suggestions = context.flight?.suggestedQuestions || [];

  if (suggestions.length !== 3) {
    issues.push(`Expected exactly 3 suggested questions, got ${suggestions.length}.`);
  }

  for (const suggestion of suggestions) {
    if (result.output?.includes(suggestion)) {
      issues.push(`Assistant response exposed suggested question: ${suggestion}`);
    }
    if (/^(would you|do you want|should i|can i|shall i)\b/i.test(suggestion)) {
      issues.push(`Suggested question is assistant-style: ${suggestion}`);
    }
    if (
      /\b(origin|departure city|departing city|from city|destination|arrival city|travel date|return date|date range)\b/i.test(
        suggestion,
      ) ||
      /where should i fly/i.test(suggestion)
    ) {
      issues.push(`Suggested question violates mandatory-field rule: ${suggestion}`);
    }
    if (/\b(suggest|pick|recommend|choose)\s+(?:a\s+)?(?:travel\s+)?date/i.test(suggestion)) {
      issues.push(`Suggested question violates travel-date recommendation rule: ${suggestion}`);
    }
    if (
      !context.searchKey &&
      /\b(apply|show flights|compare current|which flight|fare differences|departure times)\b/i.test(
        suggestion,
      )
    ) {
      issues.push(`Advanced suggested question appeared without searchKey: ${suggestion}`);
    }
  }

  return issues;
}

async function runScenario(scenario) {
  const context = {
    UID: `basic-${scenario.id}`,
    uid: `basic-${scenario.id}`,
    toolCallLog: [],
  };
  const turns = [];

  await clearFlightAgentSession(scenario.id);

  for (const [index, turn] of scenario.turns.entries()) {
    const beforeCallCount = context.toolCallLog.length;
    const before = snapshotContext(context);
    const startedAt = Date.now();

    const result = await runFlightAgent({
      input: turn.user,
      sessionId: scenario.id,
      requestId: `${scenario.id}-turn-${index + 1}`,
      context,
    });

    const calls = context.toolCallLog.slice(beforeCallCount);
    const actualTools = calls.map((call) => call.tool);
    const response = result.output || '';
    const issues = [
      ...validateTurn({ turn, actualTools, response }),
      ...validateSuggestedQuestions({ context, result }),
    ];

    turns.push({
      turn: index + 1,
      user: turn.user,
      expectedTools: turn.expectedTools,
      actualTools,
      agentResponse: response,
      actualPayload: formatCalls(calls),
      contextBefore: before,
      contextAfter: snapshotContext(context),
      latencyMs: Date.now() - startedAt,
      pass: issues.length === 0,
      issues,
    });
  }

  await clearFlightAgentSession(scenario.id);

  return {
    id: scenario.id,
    title: scenario.title,
    pass: turns.every((turn) => turn.pass),
    turns,
  };
}

function buildTextReport(report) {
  const lines = [
    '# Flight Agent basic query report',
    `Generated: ${report.summary.generatedAt}`,
    `Model: ${report.summary.model}`,
    `Scenarios: ${report.summary.passedScenarios}/${report.summary.totalScenarios} passed`,
    `Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`,
    '',
  ];

  for (const scenario of report.scenarios) {
    lines.push(`## ${scenario.pass ? 'PASS' : 'FAIL'} - ${scenario.title}`);
    for (const turn of scenario.turns) {
      lines.push(`Turn ${turn.turn}`);
      lines.push(`User: ${turn.user}`);
      lines.push(`Expected tools: ${turn.expectedTools.join(' -> ') || '(none)'}`);
      lines.push(`Actual tools: ${turn.actualTools.join(' -> ') || '(none)'}`);
      lines.push(`Agent: ${turn.agentResponse.replace(/\r?\n/g, '\\n')}`);
      lines.push(`Result: ${turn.pass ? 'PASS' : `FAIL - ${turn.issues.join(' | ')}`}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

const scenarioReports = [];
for (const scenario of scenarios) {
  scenarioReports.push(await runScenario(scenario));
}

const allTurns = scenarioReports.flatMap((scenario) => scenario.turns);
const report = {
  summary: {
    generatedAt: new Date().toISOString(),
    model: flightAgentConfig.model,
    totalScenarios: scenarioReports.length,
    passedScenarios: scenarioReports.filter((scenario) => scenario.pass).length,
    failedScenarios: scenarioReports.filter((scenario) => !scenario.pass).length,
    totalTurns: allTurns.length,
    passedTurns: allTurns.filter((turn) => turn.pass).length,
    failedTurns: allTurns.filter((turn) => !turn.pass).length,
  },
  scenarios: scenarioReports,
};

await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(REPORT_TXT, `${buildTextReport(report)}\n`);

console.log(buildTextReport(report));
console.log(`JSON report: ${REPORT_JSON}`);
console.log(`Text report: ${REPORT_TXT}`);

if (report.summary.failedTurns > 0) {
  process.exitCode = 1;
}
