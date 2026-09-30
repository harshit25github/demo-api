process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT ||= 'low';
process.env.OPENAI_TRIP_PLANNER_VERBOSITY ||= 'low';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearTripPlannerSession, runTripPlannerAgent } = await import('../../src/agents/trip-planner/runner.js');
const { createTripPlannerSummaryContext } = await import('../../src/agents/trip-planner/context/summary-context.js');
const { tripPlannerAgentConfig } = await import('../../src/agents/trip-planner/config.js');
const { validateTripPlannerScopeText, validateTripPlannerSuggestedQuestions } = await import('../../src/agents/trip-planner/scope-policy.js');

const RESULTS_DIR = path.resolve('tests/results');
const JSON_REPORT = path.join(
  RESULTS_DIR,
  'trip-planner-agent-owned-context-latest.json',
);
const MARKDOWN_REPORT = path.join(
  RESULTS_DIR,
  'trip-planner-agent-owned-context-latest.md',
);

const CONTEXT_TOOL = 'update_trip_planner_context';
const SUGGESTIONS_TOOL = 'update_trip_planner_suggested_questions';

function commonSummary(overrides = {}) {
  return createTripPlannerSummaryContext({
    pax: null,
    budget: {
      total: 1800,
      amount: 1800,
      currency: 'USD',
      per_person: false,
    },
    origin: { city: 'Delhi', iata: 'DEL' },
    destination: { city: 'Paris', iata: 'PAR' },
    tripType: ['roundtrip', 'balanced', 'food'],
    outbound_date: '2026-09-10',
    return_date: '2026-09-14',
    duration_days: 5,
    suggestedQuestions: [],
    ...overrides,
  });
}

function seededPlannerState(summaryContext) {
  return {
    contextRevision: 2,
    placeImageCache: {
      PAR: {
        itemCode: 'PAR',
        imageUrl: 'https://images.example.test/paris.jpg',
      },
    },
    lastPlanSnapshot: {
      ...summaryContext,
      responseMode: 'compact_full',
    },
    lastPlanArtifact: {
      id: 'plan_seed',
      revision: 2,
      responseMode: 'compact_full',
      destination: { ...summaryContext.destination },
      days: [],
      content: 'Existing compact itinerary.',
    },
  };
}

const cases = [
  {
    id: 'pax-short-form',
    userInput: '2 ppl',
    summaryContext: commonSummary(),
    expectedPatch: { pax: 2 },
    verify({ summaryContext }) {
      return summaryContext.pax === 2;
    },
    completedSuggestionPattern: /\b(?:passengers?|travell?ers?|people|pax)\b/i,
  },
  {
    id: 'spouse-party-inference',
    userInput: 'with wife',
    summaryContext: commonSummary(),
    expectedPatch: { pax: 2, tripTypeAdd: 'couple' },
    verify({ summaryContext }) {
      return (
        summaryContext.pax === 2 &&
        summaryContext.tripType.includes('couple')
      );
    },
    completedSuggestionPattern:
      /\b(?:change|make|set)\b.{0,24}\b(?:couple|two travelers|two people)\b/i,
  },
  {
    id: 'vague-date-hint',
    userInput: 'next month',
    summaryContext: commonSummary({
      outbound_date: null,
      return_date: null,
    }),
    expectedPatch: { date_hint: 'next month' },
    verify({ context }) {
      return (
        context.tripPlanner?.dateHint?.toLowerCase() === 'next month' &&
        context.summaryContext.outbound_date === null &&
        context.summaryContext.return_date === null
      );
    },
    completedSuggestionPattern: /\b(?:date|month)\b/i,
  },
  {
    id: 'destination-one-word',
    userInput: 'rome',
    summaryContext: commonSummary({
      destination: { city: null, iata: null },
    }),
    expectedPatch: { destinationCity: 'Rome' },
    seedPlan: false,
    verify({ summaryContext }) {
      return summaryContext.destination.city?.toLowerCase() === 'rome';
    },
    completedSuggestionPattern:
      /\b(?:change|choose|select|pick)\b.{0,24}\b(?:destination|rome)\b/i,
  },
  {
    id: 'relaxed-preference',
    userInput: 'make it chill',
    summaryContext: commonSummary(),
    expectedPatch: { tripTypeAdd: 'relaxed' },
    verify({ summaryContext }) {
      return (
        summaryContext.tripType.includes('relaxed') &&
        !summaryContext.tripType.includes('chill')
      );
    },
    completedSuggestionPattern: /\b(?:relax|chill|lighter|slower)\b/i,
  },
  {
    id: 'budget-preference',
    userInput: 'not costly',
    summaryContext: commonSummary(),
    expectedPatch: { tripTypeAdd: 'budget-conscious' },
    verify({ summaryContext }) {
      return summaryContext.tripType.includes('budget-conscious');
    },
    completedSuggestionPattern: /\b(?:budget|cheap|affordable|cost)\b/i,
  },
];

function expectedPatchMatches(actualPatch, expectedPatch) {
  if (!actualPatch) {
    return false;
  }
  if (
    expectedPatch.pax !== undefined &&
    actualPatch.pax !== expectedPatch.pax
  ) {
    return false;
  }
  if (
    expectedPatch.date_hint &&
    actualPatch.date_hint?.toLowerCase() !==
      expectedPatch.date_hint.toLowerCase()
  ) {
    return false;
  }
  if (
    expectedPatch.destinationCity &&
    actualPatch.destination?.city?.toLowerCase() !==
      expectedPatch.destinationCity.toLowerCase()
  ) {
    return false;
  }
  if (
    expectedPatch.tripTypeAdd &&
    !(actualPatch.tripType?.add || []).some(
      (value) =>
        value.toLowerCase() === expectedPatch.tripTypeAdd.toLowerCase(),
    )
  ) {
    return false;
  }
  return true;
}

function buildMarkdown(report) {
  const lines = [
    '# Trip Planner Agent-Owned Context Live Report',
    '',
    `- Model: \`${report.model}\``,
    `- Passed: ${report.summary.passed}/${report.summary.total}`,
    `- Generated: ${report.generatedAt}`,
    '',
  ];
  for (const result of report.results) {
    lines.push(
      `## ${result.testCaseId}: ${result.pass ? 'PASS' : 'FAIL'}`,
      '',
      `- User: \`${result.userInput}\``,
      `- Tools: ${result.actualToolCalls.map((call) => call.tool).join(' -> ')}`,
      `- Context payload: \`${JSON.stringify(result.contextUpdatePayload)}\``,
      `- Suggestions: ${result.suggestedQuestions.join(' | ') || 'none'}`,
      `- Issues: ${result.issues.join('; ') || 'none'}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

const results = [];
for (const testCase of cases) {
  const sessionId = `trip-planner-agent-owned-${testCase.id}-${Date.now()}`;
  const summaryContext = createTripPlannerSummaryContext(testCase.summaryContext);
  const context = {
    summaryContext,
    tripPlanner:
      testCase.seedPlan === false
        ? { contextRevision: 2 }
        : seededPlannerState(summaryContext),
  };
  const issues = [];
  let run;

  try {
    run = await runTripPlannerAgent({
      input: testCase.userInput,
      context,
      sessionId,
      requestId: `${sessionId}-request`,
    });
  } catch (error) {
    issues.push(`runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  const toolCalls = run?.debug?.toolsCalled || [];
  const contextCalls = toolCalls.filter(
    (call) => call.tool === CONTEXT_TOOL,
  );
  const suggestionCalls = toolCalls.filter(
    (call) => call.tool === SUGGESTIONS_TOOL,
  );
  const successfulSuggestionCalls = suggestionCalls.filter(
    (call) => ['SUCCESS', 'ALREADY_UPDATED'].includes(call.status),
  );
  const contextPayload = contextCalls[0]?.input?.contextPatch || null;
  const finalSummary = createTripPlannerSummaryContext(
    run?.context?.summaryContext,
  );
  const suggestions = finalSummary.suggestedQuestions;

  if (toolCalls[0]?.tool !== CONTEXT_TOOL) {
    issues.push('context updater was not the first tool');
  }
  if (toolCalls.at(-1)?.tool !== SUGGESTIONS_TOOL) {
    issues.push('suggested-question updater was not the final tool');
  }
  if (contextCalls.length !== 1) {
    issues.push(`expected one context update, received ${contextCalls.length}`);
  }
  if (successfulSuggestionCalls.length !== 1 || suggestionCalls.length > 2) {
    issues.push(
      `expected one successful suggestions update with at most one correction, received ${suggestionCalls.length} calls`,
    );
  }
  if (!expectedPatchMatches(contextPayload, testCase.expectedPatch)) {
    issues.push('agent context payload did not match expected structured update');
  }
  if (contextCalls[0]?.input?.userMessage !== undefined) {
    issues.push('context tool received raw user text');
  }
  if (!run || !testCase.verify({ context: run.context, summaryContext: finalSummary })) {
    issues.push('stored context did not match expected state');
  }
  if (!validateTripPlannerSuggestedQuestions(suggestions).ok) {
    issues.push('suggested questions failed structural or scope validation');
  }
  if (
    testCase.completedSuggestionPattern &&
    suggestions.some((suggestion) =>
      testCase.completedSuggestionPattern.test(suggestion),
    )
  ) {
    issues.push('suggested questions repeated the completed action');
  }
  if (!validateTripPlannerScopeText(run?.output || '').ok) {
    issues.push('final response violated Trip Planner scope');
  }
  if (!String(run?.output || '').trim()) {
    issues.push('final response was empty');
  }

  results.push({
    testCaseId: testCase.id,
    userInput: testCase.userInput,
    summaryContextBefore: summaryContext,
    expectedContextPayload: testCase.expectedPatch,
    actualToolCalls: toolCalls,
    contextUpdatePayload: contextPayload,
    agentFinalResponse: run?.output || '',
    summaryContextAfter: finalSummary,
    dateHintAfter: run?.context?.tripPlanner?.dateHint || null,
    suggestedQuestions: suggestions,
    pass: issues.length === 0,
    issues,
  });
  await clearTripPlannerSession(sessionId);
}

const report = {
  generatedAt: new Date().toISOString(),
  model: tripPlannerAgentConfig.model,
  summary: {
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass).length,
  },
  results,
};

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(MARKDOWN_REPORT, buildMarkdown(report));

console.log(JSON.stringify(report.summary, null, 2));
console.log(JSON_REPORT);
console.log(MARKDOWN_REPORT);

if (report.summary.failed > 0) {
  process.exitCode = 1;
}
