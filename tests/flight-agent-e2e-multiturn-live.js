process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_E2E_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '8';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, flightAgentConfig, runFlightAgent } = await import(
  '../src/flight-agent/index.js'
);

const REPORT_JSON = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-e2e-multiturn-latest.json',
);
const REPORT_TXT = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-e2e-multiturn-latest.txt',
);

function getPayloadValues(finalPayload, filterType) {
  const found = (finalPayload || []).find((filter) => filter.filterType === filterType);
  return found?.Values || [];
}

function valueListIncludes(finalPayload, filterType, expectedValue) {
  return getPayloadValues(finalPayload, filterType)
    .flatMap((value) => String(value).split(','))
    .includes(String(expectedValue));
}

function findLatestApplyCall(actualCalls) {
  return [...actualCalls].reverse().find((call) => call.tool === 'apply_filter') || null;
}

function finalPayloadFromTurn(actualCalls, context) {
  return (
    findLatestApplyCall(actualCalls)?.finalFilterPayload ||
    context.lastFinalFilterPayload ||
    []
  );
}

function snapshotContext(context) {
  return {
    searchKey: context.searchKey || null,
    sid: context.sid || null,
    lastSearch: context.lastSearch || null,
    flightCount: context.flightResults?.length || 0,
    filteredCount: context.filteredFlightResults?.length || 0,
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    lastAppliedFilters: context.lastAppliedFilters || [],
    lastApplyFilterFeedback: context.lastApplyFilterFeedback || [],
    generatedContextSummary: context.lastGeneratedContractsContext?.summary || null,
    airlineCodes: (context.airlineFilterOptions || []).map((option) => option.Code),
    layoverCodes: (context.layoverAirportFilterOptions || []).map((option) => option.Code),
    departureAirportCodes: (
      context.DepartAirports ||
      context.departureAirportFilterOptions ||
      []
    ).map((option) => option.Code),
    arrivalAirportCodes: (
      context.DepLandAirports ||
      context.arrivalAirportFilterOptions ||
      []
    ).map((option) => option.Code),
    toolCallLogCount: context.toolCallLog?.length || 0,
  };
}

function formatPayloadFromCalls(actualCalls) {
  return actualCalls.map((call) => ({
    tool: call.tool,
    searchKey: call.searchKey || null,
    input: call.input || null,
    filters: call.filters || null,
    finalFilterPayload: call.finalFilterPayload || null,
    feedback: call.feedback || null,
    indexes: call.indexes ?? null,
  }));
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectTools(expectedTools) {
  return ({ actualTools }) => {
    if (!sameSequence(actualTools, expectedTools)) {
      return [`Expected tools ${expectedTools.join(' -> ') || '(none)'}, got ${actualTools.join(' -> ') || '(none)'}.`];
    }
    return [];
  };
}

function expectOneOfToolSequences(acceptedSequences) {
  return ({ actualTools }) => {
    if (!acceptedSequences.some((sequence) => sameSequence(actualTools, sequence))) {
      return [
        `Expected one of ${acceptedSequences
          .map((sequence) => sequence.join(' -> ') || '(none)')
          .join(' OR ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
      ];
    }
    return [];
  };
}

function expectSearchKeyCreated() {
  return ({ after }) => (after.searchKey ? [] : ['Expected searchKey to be created.']);
}

function expectSearchKeyChanged() {
  return ({ before, after }) =>
    before.searchKey && before.searchKey === after.searchKey
      ? [`Expected a new searchKey, but it stayed ${after.searchKey}.`]
      : [];
}

function expectApplyUsesLatestSearchKey() {
  return ({ before, actualCalls }) => {
    const errors = [];
    let latestSearchKey = before.searchKey || null;

    for (const call of actualCalls) {
      if (call.tool === 'flight_search') {
        latestSearchKey = call.searchKey;
      }

      if (call.tool === 'apply_filter') {
        if (!latestSearchKey) {
          errors.push('apply_filter ran without a valid active searchKey.');
        } else if (call.searchKey !== latestSearchKey) {
          errors.push(
            `apply_filter used stale searchKey ${call.searchKey}; latest expected ${latestSearchKey}.`,
          );
        }
      }
    }

    return errors;
  };
}

function expectNoApplyWithoutSearchKey() {
  return ({ before, actualCalls }) => {
    let latestSearchKey = before.searchKey || null;
    const errors = [];

    for (const call of actualCalls) {
      if (call.tool === 'flight_search') {
        latestSearchKey = call.searchKey;
      }
      if (call.tool === 'apply_filter' && !latestSearchKey) {
        errors.push('apply_filter was called before any valid searchKey existed.');
      }
    }

    return errors;
  };
}

function expectPayloadIncludes(filterType, expectedValue) {
  return ({ actualCalls, context }) => {
    const finalPayload = finalPayloadFromTurn(actualCalls, context);
    return valueListIncludes(finalPayload, filterType, expectedValue)
      ? []
      : [
          `Expected final payload ${filterType} to include ${expectedValue}; got ${JSON.stringify(
            finalPayload,
          )}.`,
        ];
  };
}

function expectDurationPayload(filterType, maxMinutes) {
  return ({ actualCalls, context }) => {
    const values = getPayloadValues(finalPayloadFromTurn(actualCalls, context), filterType);
    return values[0] === 0 && values[1] === maxMinutes
      ? []
      : [`Expected ${filterType} Values [0, ${maxMinutes}], got ${JSON.stringify(values)}.`];
  };
}

function expectNoStopValueAboveThree() {
  return ({ actualCalls, context }) => {
    const values = getPayloadValues(finalPayloadFromTurn(actualCalls, context), 'stop');
    const unsupported = values
      .flatMap((value) => String(value).split(','))
      .filter((value) => Number(value) > 3);

    return unsupported.length
      ? [`Stop payload contains unsupported value(s): ${unsupported.join(', ')}.`]
      : [];
  };
}

function expectResponseMentionsAny(patterns) {
  return ({ response }) =>
    patterns.some((pattern) => pattern.test(response))
      ? []
      : [`Expected response to mention one of ${patterns.map(String).join(', ')}.`];
}

function expectNoInternalToolLeak() {
  return ({ response }) =>
    /\b(flight_search|apply_filter|getGeneratedContractsContext|searchKey|FINAL_APPLY_FILTER_PAYLOAD)\b/i.test(
      response,
    )
      ? ['Response exposed internal tool/config details.']
      : [];
}

function expectNonEmptyResponse() {
  return ({ response }) => (response.trim() ? [] : ['Expected a non-empty agent response.']);
}

function expectConditionalNewarkHandling() {
  return ({ actualCalls, actualTools, after, context }) => {
    if (sameSequence(actualTools, ['flight_search'])) {
      const origin = after.lastSearch?.onds?.[0]?.origin || '';
      return /newark|ewr/i.test(origin)
        ? []
        : [`Expected re-search origin to be Newark/EWR; got ${origin || '(missing)'}.`];
    }

    if (sameSequence(actualTools, ['apply_filter'])) {
      const finalPayload = finalPayloadFromTurn(actualCalls, context);
      return valueListIncludes(finalPayload, 'outbounddepart', 'EWR')
        ? []
        : [`Expected Newark departure filter EWR; got ${JSON.stringify(finalPayload)}.`];
    }

    return ['Expected Newark turn to either re-search or apply departure airport filter.'];
  };
}

const commonChecks = [expectApplyUsesLatestSearchKey(), expectNoApplyWithoutSearchKey(), expectNoInternalToolLeak(), expectNonEmptyResponse()];

const scenarios = [
  {
    id: 'scenario-1-search-filters-alternates-research',
    title: 'Search -> filters -> alternate/nearby airports -> re-search/re-filter',
    turns: [
      {
        user: 'Find flights from NYC to LAX next Friday for 1 adult.',
        expectedTools: ['flight_search'],
        expectedPayload: { search: 'NYC -> LAX next Friday, 1 adult' },
        checks: [expectTools(['flight_search']), expectSearchKeyCreated()],
      },
      {
        user: 'Show only non-stop with checked baggage.',
        expectedTools: ['apply_filter'],
        expectedPayload: { stop: ['0'], baggage: ['0'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('stop', '0'),
          expectPayloadIncludes('baggage', '0'),
        ],
      },
      {
        user: 'What alternate arrival airports can I use around LA?',
        expectedTools: [],
        expectedPayload: { answerFromContext: 'arrival airport source options' },
        checks: [
          expectTools([]),
          expectResponseMentionsAny([/\bBUR\b/i, /\bONT\b/i, /\bSNA\b/i, /Burbank/i, /Ontario/i]),
        ],
      },
      {
        user: 'Okay use nearby arrival airports only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: ['BUR', 'ONT', 'SNA'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('outboundarrival', 'BUR'),
          expectPayloadIncludes('outboundarrival', 'ONT'),
          expectPayloadIncludes('outboundarrival', 'SNA'),
        ],
      },
      {
        user: 'Actually change departure to Newark only.',
        expectedTools: ['apply_filter OR flight_search'],
        expectedPayload: { outbounddepart: ['EWR'], searchOrigin: 'Newark/EWR' },
        checks: [
          expectOneOfToolSequences([['apply_filter'], ['flight_search']]),
          expectConditionalNewarkHandling(),
        ],
      },
      {
        user: 'Now show cheapest among these.',
        expectedTools: ['getGeneratedContractsContext'],
        expectedPayload: { indexes: null },
        checks: [expectTools(['getGeneratedContractsContext'])],
      },
    ],
  },
  {
    id: 'scenario-2-messy-spellings-mixed-filters',
    title: 'Messy spellings + mixed filters + result reasoning',
    turns: [
      {
        user: 'Search flight delhi to newyork on 20 dec, economy.',
        expectedTools: ['flight_search'],
        expectedPayload: { search: 'Delhi -> New York on Dec 20, economy' },
        checks: [expectTools(['flight_search']), expectSearchKeyCreated()],
      },
      {
        user: 'show me emrates and air canda only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['EK', 'AC', 'AC+'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('airline', 'AC'),
          expectPayloadIncludes('airline', 'AC+'),
        ],
      },
      {
        user: 'layover in amsterdem if possible.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundlayover: ['AMS'] },
        checks: [expectTools(['apply_filter']), expectPayloadIncludes('outboundlayover', 'AMS')],
      },
      {
        user: 'also checked bag and carry on.',
        expectedTools: ['apply_filter'],
        expectedPayload: { baggage: ['0', '1'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('baggage', '0'),
          expectPayloadIncludes('baggage', '1'),
        ],
      },
      {
        user: 'make duration below 22 hrs.',
        expectedTools: ['apply_filter'],
        expectedPayload: { departdurationfilter: [0, 1320] },
        checks: [expectTools(['apply_filter']), expectDurationPayload('departdurationfilter', 1320)],
      },
      {
        user: 'which one is best value?',
        expectedTools: ['getGeneratedContractsContext'],
        expectedPayload: { indexes: null },
        checks: [expectTools(['getGeneratedContractsContext'])],
      },
    ],
  },
  {
    id: 'scenario-3-core-changes-latest-searchkey',
    title: 'Core changes inside same chat + latest searchKey validation',
    turns: [
      {
        user: 'Find NYC to Dubai flights on Dec 10 for 1 adult.',
        expectedTools: ['flight_search'],
        expectedPayload: { search: 'NYC -> Dubai on Dec 10, 1 adult' },
        checks: [expectTools(['flight_search']), expectSearchKeyCreated()],
      },
      {
        user: 'Show Qatar and Emirates with layover under 5 hours.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['QR', 'EK'], departlayoverfilter: [0, 300] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'QR'),
          expectPayloadIncludes('airline', 'EK'),
          expectDurationPayload('departlayoverfilter', 300),
        ],
      },
      {
        user: 'Actually make it 2 adults and business class.',
        expectedTools: ['flight_search'],
        expectedPayload: { passengers: { adults: 2 }, cabin_class: 'business' },
        checks: [expectTools(['flight_search']), expectSearchKeyChanged()],
      },
      {
        user: 'Keep Emirates only and arrival in morning.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['EK'], departlandtimeslotfilter: ['MORNING'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('departlandtimeslotfilter', 'MORNING'),
        ],
      },
      {
        user: 'Change date to Dec 12 and show flights with 2 or more stops.',
        expectedTools: ['flight_search', 'apply_filter'],
        expectedPayload: { stop: ['3'] },
        checks: [
          expectTools(['flight_search', 'apply_filter']),
          expectSearchKeyChanged(),
          expectPayloadIncludes('stop', '3'),
          expectNoStopValueAboveThree(),
        ],
      },
      {
        user: 'Compare current options.',
        expectedTools: ['getGeneratedContractsContext'],
        expectedPayload: { indexes: null },
        checks: [expectTools(['getGeneratedContractsContext'])],
      },
    ],
  },
  {
    id: 'scenario-4-filter-before-search-pending-filters',
    title: 'Filter before search -> pending filters -> nearby/misspelled airport -> trip change',
    turns: [
      {
        user: 'Only show emrates with checked bag and layover in dubia.',
        expectedTools: [],
        expectedPayload: { blocked: 'missing origin/destination/date' },
        checks: [
          expectTools([]),
          expectResponseMentionsAny([/origin/i, /destination/i, /travel date|date/i]),
        ],
      },
      {
        user: 'Route is NYC to LAX on Dec 20, economy.',
        expectedTools: ['flight_search', 'apply_filter'],
        expectedPayload: { airline: ['EK'], baggage: ['0'], outboundlayover: ['DXB'] },
        checks: [
          expectTools(['flight_search', 'apply_filter']),
          expectSearchKeyCreated(),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('baggage', '0'),
          expectPayloadIncludes('outboundlayover', 'DXB'),
        ],
      },
      {
        user: 'Use nearby arrival airports if any, maybe Ontaro.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: ['ONT'] },
        checks: [expectTools(['apply_filter']), expectPayloadIncludes('outboundarrival', 'ONT')],
      },
      {
        user: 'Actually make it round trip returning Jan 5.',
        expectedTools: ['flight_search'],
        expectedPayload: { trip_type: 'roundtrip', returnDate: 'Jan 5' },
        checks: [expectTools(['flight_search']), expectSearchKeyChanged()],
      },
      {
        user: 'Which is shortest or cheapest now?',
        expectedTools: ['getGeneratedContractsContext'],
        expectedPayload: { indexes: null },
        checks: [expectTools(['getGeneratedContractsContext'])],
      },
    ],
  },
  {
    id: 'scenario-5-multicity-messy-flow',
    title: 'Multi-city messy flow + filters + core passenger/cabin change',
    turns: [
      {
        user:
          'Search multi-city flights: NYC to London on Dec 10, London to Dubai on Dec 15, Dubai to Delhi on Dec 20 for 2 adults economy.',
        expectedTools: ['flight_search'],
        expectedPayload: { trip_type: 'multicity', ondCount: 3 },
        checks: [expectTools(['flight_search']), expectSearchKeyCreated()],
      },
      {
        user: 'show qatar airwys or emrates only with carry on.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['QR', 'EK'], baggage: ['1'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'QR'),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('baggage', '1'),
        ],
      },
      {
        user: 'also layover in amsterdem and checked baggage.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundlayover: ['AMS'], baggage: ['0'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('outboundlayover', 'AMS'),
          expectPayloadIncludes('baggage', '0'),
        ],
      },
      {
        user: 'Actually make it 3 adults and business class.',
        expectedTools: ['flight_search'],
        expectedPayload: { passengers: { adults: 3 }, cabin_class: 'business' },
        checks: [expectTools(['flight_search']), expectSearchKeyChanged()],
      },
      {
        user: 'Keep Emirates only and evening arrival.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['EK'], departlandtimeslotfilter: ['EVENING'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('departlandtimeslotfilter', 'EVENING'),
        ],
      },
      {
        user: 'Compare current options.',
        expectedTools: ['getGeneratedContractsContext'],
        expectedPayload: { indexes: null },
        checks: [expectTools(['getGeneratedContractsContext'])],
      },
    ],
  },
];

async function runTurn({ scenario, turn, turnNumber, context }) {
  const before = snapshotContext(context);
  const beforeCallCount = context.toolCallLog.length;
  const result = await runFlightAgent({
    input: turn.user,
    sessionId: scenario.id,
    requestId: `${scenario.id}-turn-${turnNumber}`,
    context,
  });
  const actualCalls = context.toolCallLog.slice(beforeCallCount);
  const actualTools = actualCalls.map((call) => call.tool);
  const after = snapshotContext(context);

  const checkArgs = {
    scenario,
    turn,
    turnNumber,
    before,
    after,
    actualCalls,
    actualTools,
    context,
    response: result.output || '',
  };
  const errors = [...commonChecks, ...(turn.checks || [])].flatMap((check) => check(checkArgs));

  return {
    turn: turnNumber,
    user: turn.user,
    agentResponse: result.output || '',
    expectedTool: turn.expectedTools.join(' -> ') || '(none)',
    actualTool: actualTools.join(' -> ') || '(none)',
    expectedPayload: turn.expectedPayload || null,
    actualPayload: formatPayloadFromCalls(actualCalls),
    contextBefore: before,
    contextAfter: after,
    searchKeyUsed: actualCalls
      .filter((call) => call.searchKey)
      .map((call) => ({ tool: call.tool, searchKey: call.searchKey })),
    latestSearchKey: after.searchKey,
    appliedFilters: after.lastFinalFilterPayload,
    pass: errors.length === 0,
    issueFound: errors,
    suggestedFix: errors.length
      ? 'Review Flight Agent routing prompt/tool schema for this turn and re-run this suite.'
      : '',
  };
}

async function runScenario(scenario) {
  const context = {
    UID: `e2e-${scenario.id}`,
    uid: `e2e-${scenario.id}`,
    toolCallLog: [],
  };

  await clearFlightAgentSession(scenario.id);
  const turns = [];

  for (let index = 0; index < scenario.turns.length; index += 1) {
    turns.push(
      await runTurn({
        scenario,
        turn: scenario.turns[index],
        turnNumber: index + 1,
        context,
      }),
    );
  }

  await clearFlightAgentSession(scenario.id);

  return {
    id: scenario.id,
    title: scenario.title,
    pass: turns.every((turn) => turn.pass),
    turns,
  };
}

function buildTextReport(summary, results) {
  const lines = [
    '# Flight Agent E2E multi-turn report',
    `Generated: ${summary.generatedAt}`,
    `Model: ${summary.model}`,
    `Total scenarios: ${summary.totalScenarios}`,
    `Passed scenarios: ${summary.passedScenarios}`,
    `Failed scenarios: ${summary.failedScenarios}`,
    `Total turns: ${summary.totalTurns}`,
    `Passed turns: ${summary.passedTurns}`,
    `Failed turns: ${summary.failedTurns}`,
    `Success percentage: ${summary.successPercentage}%`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.title}`);
    for (const turn of result.turns) {
      lines.push(`- Turn ${turn.turn}: ${turn.user}`);
      lines.push(`  - Expected: ${turn.expectedTool}`);
      lines.push(`  - Actual: ${turn.actualTool}`);
      lines.push(`  - searchKey: ${turn.latestSearchKey || '(none)'}`);
      lines.push(`  - Result: ${turn.pass ? 'PASS' : `FAIL - ${turn.issueFound.join(' | ')}`}`);
    }
    lines.push('');
  }

  lines.push('## Failed scenarios with reasons');
  if (summary.failedTurns === 0) {
    lines.push('- None.');
  } else {
    for (const turn of results.flatMap((result) => result.turns).filter((turn) => !turn.pass)) {
      lines.push(`- Turn ${turn.turn} "${turn.user}": ${turn.issueFound.join(' | ')}`);
    }
  }

  lines.push('');
  lines.push(`Recurring issues: ${summary.recurringIssues.join(' | ')}`);
  lines.push(`Fixes applied: ${summary.fixesApplied.join(' | ')}`);
  lines.push(`JSON report: ${REPORT_JSON}`);
  lines.push(`Text report: ${REPORT_TXT}`);
  return `${lines.join('\n')}\n`;
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

const allTurns = results.flatMap((result) => result.turns);
const failedTurns = allTurns.filter((turn) => !turn.pass);
const summary = {
  generatedAt: new Date().toISOString(),
  model: flightAgentConfig.model,
  totalScenarios: results.length,
  passedScenarios: results.filter((result) => result.pass).length,
  failedScenarios: results.filter((result) => !result.pass).length,
  totalTurns: allTurns.length,
  passedTurns: allTurns.length - failedTurns.length,
  failedTurns: failedTurns.length,
  successPercentage: Number(
    (((allTurns.length - failedTurns.length) / allTurns.length) * 100).toFixed(1),
  ),
  recurringIssues: failedTurns.length
    ? [...new Set(failedTurns.flatMap((turn) => turn.issueFound))]
    : ['No recurring issues found.'],
  fixesApplied: [
    'Hydrated flight_search dummy context with airline and layover source arrays for real apply_filter matching.',
    'Added route-aware dummy departure/arrival airport source arrays for NYC, LA, Dubai, and Delhi test flows.',
    'Exposed active source options in dynamic Flight Agent instructions for alternate/nearby option questions.',
  ],
};

const report = { summary, scenarios: results };
await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(REPORT_TXT, buildTextReport(summary, results));

console.log(buildTextReport(summary, results));

if (summary.failedTurns > 0) {
  process.exitCode = 1;
}
