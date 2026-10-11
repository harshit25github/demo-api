process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT ||= 'low';
process.env.OPENAI_TRIP_PLANNER_VERBOSITY ||= 'low';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearTripPlannerSession, runTripPlannerAgent } = await import('../../src/agents/trip-planner/runner.js');
const { TRIP_PLANNER_TOOL_NAMES } = await import('../../src/agents/trip-planner/tools/runtime.js');
const { tripPlannerAgentConfig } = await import('../../src/agents/trip-planner/config.js');

const RESULTS_DIR = path.resolve('tests/results');
const REPORT_JSON = path.join(
  RESULTS_DIR,
  'trip-planner-web-search-intelligence-latest.json',
);
const REPORT_MARKDOWN = path.join(
  RESULTS_DIR,
  'trip-planner-web-search-intelligence-latest.md',
);
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.TRIP_PLANNER_WEB_SEARCH_TURN_DELAY_MS || '500', 10) || 0,
);
const CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.TRIP_PLANNER_WEB_SEARCH_CHAT_LIMIT || '5', 10) || 5,
);
const CHAT_IDS = String(process.env.TRIP_PLANNER_WEB_SEARCH_CHAT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const DAY_MS = 24 * 60 * 60 * 1000;
const {
  getPlaceImagesBatch: IMAGE_TOOL,
  webSearch: WEB_TOOL,
  updateSuggestedQuestions: SUGGESTIONS_TOOL,
} = TRIP_PLANNER_TOOL_NAMES;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function startOfUtcDay(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value, days) {
  return new Date(value.getTime() + days * DAY_MS);
}

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

function wordCount(value) {
  return (String(value || '').match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
}

function stripCardBlocks(output) {
  return String(output || '').replace(/^:::cards\r?\n[\s\S]*?^:::cards\s*$/gm, '');
}

function longestMobileLineWords(output) {
  return Math.max(
    0,
    ...stripCardBlocks(output)
      .split(/\r?\n/)
      .map((line) => wordCount(line)),
  );
}

function snapshotContext(context: any = {}) {
  return clone({
    summaryContext: context.summaryContext || null,
    tripPlanner: {
      preferenceSignals: context.tripPlanner?.preferenceSignals || {
        positive: [],
        negative: [],
      },
      webSearchCacheKeys: Object.keys(context.tripPlanner?.webSearchCache || {}).sort(),
    },
  });
}

function formatToolCalls(calls = []) {
  return calls.map((call) => ({
    tool: call.tool,
    input: clone(call.input),
    status: call.status || null,
    output: clone(call.output),
  }));
}

const today = startOfUtcDay();
const dates = {
  paris: [isoDate(addDays(today, 35)), isoDate(addDays(today, 39))],
  singapore: [isoDate(addDays(today, 28)), isoDate(addDays(today, 32))],
  tokyo: [isoDate(addDays(today, 42)), isoDate(addDays(today, 46))],
  rome: [isoDate(addDays(today, 50)), isoDate(addDays(today, 54))],
  barcelona: [isoDate(addDays(today, 56)), isoDate(addDays(today, 60))],
};

function fullContext({ originCode = 'DEL', originCity = 'Delhi', code, city, dateRange }) {
  return {
    pax: 2,
    budget: { total: 2200, amount: 2200, currency: 'USD', per_person: false },
    origin: { city: originCity, iata: originCode },
    destination: { city, iata: code },
    tripType: ['roundtrip', 'couple', 'balanced'],
    outbound_date: dateRange[0],
    return_date: dateRange[1],
    duration_days: 5,
    upcomingEvents: [],
    placesOfInterest: [],
    suggestedQuestions: [],
  };
}

const chats = [
  {
    id: 'trip-web-paris-current-fact-trap',
    title: 'Paris stable plan, current facts, and lexical current trap',
    initialSummaryContext: fullContext({ code: 'PAR', city: 'Paris', dateRange: dates.paris }),
    turns: [
      {
        id: 'paris-stable-plan',
        user: 'Plan relaxed art and local-food days without overpacking them.',
        shouldUseWebSearch: false,
        freshnessCategory: 'stable itinerary planning',
        expectedBehavior: 'Use known Paris context and stable planning knowledge without web search.',
      },
      {
        id: 'paris-current-hours-closures',
        user:
          'Check the latest Louvre and Musee d Orsay opening hours and any temporary closures for our dates.',
        shouldUseWebSearch: true,
        freshnessCategory: 'latest hours and temporary closures',
        expectedBehavior: 'Search once for current operating information, then summarize it without links.',
        groundingRequirement: { unavailableDisclosure: true },
      },
      {
        id: 'paris-current-itinerary-word',
        user: 'Keep the current itinerary, but make day 2 lighter.',
        shouldUseWebSearch: false,
        freshnessCategory: 'preference-only patch containing the word current',
        expectedBehavior: 'Patch day 2 without treating current itinerary as a freshness request.',
      },
    ],
  },
  {
    id: 'trip-web-singapore-events-weather',
    title: 'Singapore stable food, current festivals, and weather-sensitive planning',
    initialSummaryContext: fullContext({
      originCode: 'BOM',
      originCity: 'Mumbai',
      code: 'SIN',
      city: 'Singapore',
      dateRange: dates.singapore,
    }),
    turns: [
      {
        id: 'singapore-stable-food',
        user: 'Add hawker food and family-friendly indoor activities to the plan.',
        shouldUseWebSearch: false,
        freshnessCategory: 'stable food and activity preferences',
        expectedBehavior: 'Use stable local knowledge and preferences without web search.',
      },
      {
        id: 'singapore-festivals-this-month',
        user: 'Which festivals are happening this month, and which one fits our plan?',
        shouldUseWebSearch: true,
        freshnessCategory: 'current-month festivals',
        expectedBehavior: 'Resolve this month from the turn clock, then search current festival information.',
        groundingRequirement: {
          unavailableDisclosure: true,
          forbiddenPatterns: [
            /Singapore National Day season/i,
            /Hungry Ghost Festival/i,
            /Singapore Food Festival/i,
          ],
        },
      },
      {
        id: 'singapore-weather-tomorrow',
        user:
          'Rain may affect our Sentosa day tomorrow. Check the forecast and move outdoor activities if needed.',
        shouldUseWebSearch: true,
        freshnessCategory: 'weather-sensitive activity planning',
        expectedBehavior: 'Search current weather information before changing outdoor activities.',
        groundingRequirement: { unavailableDisclosure: true },
      },
    ],
  },
  {
    id: 'trip-web-tokyo-new-openings',
    title: 'Tokyo stable recommendations, new openings, and latest timings',
    initialSummaryContext: fullContext({ code: 'TYO', city: 'Tokyo', dateRange: dates.tokyo }),
    turns: [
      {
        id: 'tokyo-stable-neighborhoods',
        user: 'Suggest classic neighborhoods, local food, and one landmark per day.',
        shouldUseWebSearch: false,
        freshnessCategory: 'stable destination recommendations',
        expectedBehavior: 'Personalize the plan from context without web search.',
      },
      {
        id: 'tokyo-newly-opened',
        user: 'Any newly opened attractions or restaurants worth adding?',
        shouldUseWebSearch: true,
        freshnessCategory: 'newly opened places',
        expectedBehavior: 'Search current opening information and avoid inventing new venues.',
        groundingRequirement: {
          unavailableDisclosure: true,
          forbiddenPatterns: [
            /teamLab Borderless/i,
            /Kabukicho Tower/i,
            /Azabudai Hills/i,
          ],
        },
      },
      {
        id: 'tokyo-latest-timings',
        user: 'What are the latest timings and reservation requirements for teamLab?',
        shouldUseWebSearch: true,
        freshnessCategory: 'latest timings and reservations',
        expectedBehavior: 'Search once for the latest operating and reservation details.',
        groundingRequirement: {
          unavailableDisclosure: true,
          forbiddenPatterns: [/timed-entry slots/i, /often required/i],
        },
      },
    ],
  },
  {
    id: 'trip-web-rome-advisory-closure',
    title: 'Rome stable planning, visa advisories, and possible maintenance closure',
    initialSummaryContext: fullContext({ code: 'ROM', city: 'Rome', dateRange: dates.rome }),
    turns: [
      {
        id: 'rome-stable-history',
        user: 'Make the trip history-focused with slower afternoons and local food.',
        shouldUseWebSearch: false,
        freshnessCategory: 'stable preference update',
        expectedBehavior: 'Patch preferences without web search.',
      },
      {
        id: 'rome-current-visa-advisory',
        user: 'Check current visa and travel advisories for Indian passport holders.',
        shouldUseWebSearch: true,
        freshnessCategory: 'current visa and travel advisories',
        expectedBehavior: 'Search current advisory information and respond cautiously without links.',
        groundingRequirement: {
          unavailableDisclosure: true,
          forbiddenPatterns: [
            /Schengen short-stay \(Type C\)/i,
            /90 days in a 180-day period/i,
            /application \+ biometrics/i,
          ],
        },
      },
      {
        id: 'rome-possible-maintenance-closure',
        user:
          'I heard the Colosseum may be closed for maintenance during our dates. Verify before keeping it.',
        shouldUseWebSearch: true,
        freshnessCategory: 'possible temporary maintenance closure',
        expectedBehavior: 'Verify the possible closure before retaining the attraction.',
        groundingRequirement: { unavailableDisclosure: true },
      },
    ],
  },
  {
    id: 'trip-web-barcelona-festival-negation',
    title: 'Barcelona stable planning and negated festival-like preference',
    initialSummaryContext: fullContext({ code: 'BCN', city: 'Barcelona', dateRange: dates.barcelona }),
    turns: [
      {
        id: 'barcelona-stable-plan',
        user: 'Plan neighborhoods, tapas, architecture, and one beach break.',
        shouldUseWebSearch: false,
        freshnessCategory: 'stable itinerary planning',
        expectedBehavior: 'Create a stable destination plan without web search.',
      },
      {
        id: 'barcelona-festival-negation',
        user:
          'Give it a festival-like atmosphere, but I am not asking about a specific festival or event.',
        shouldUseWebSearch: false,
        freshnessCategory: 'negated event request used only as a style preference',
        expectedBehavior: 'Treat festival-like as a style preference and skip date validation and web search.',
      },
    ],
  },
];

function containsBlockedLink(output) {
  const body = stripCardBlocks(output);
  return (
    /https?:\/\/|www\./i.test(body) ||
    /\[[^\]]+\]\([^\)]+\)/.test(body) ||
    /<a\s+[^>]*href=/i.test(body)
  );
}

function evaluateGrounding(output, calls, turn: any = {}) {
  const requirement = turn.groundingRequirement;
  if (!requirement) {
    return { pass: true, issues: [] };
  }

  const issues = [];
  const toolEvidence = JSON.stringify(
    calls.filter((call) => call.tool === WEB_TOOL).map((call) => call.output),
  );
  const hasUnavailableDisclosure =
    /(?:can(?:not|['’]t)|could(?: not|n['’]t)|unable to).*confirm|(?:was|were)n['’]t available|unavailable|not available|double-check|recheck|verify|hours vary|confirm on|check the latest|check.*official/i.test(
      output,
    );

  if (requirement.unavailableDisclosure && !hasUnavailableDisclosure) {
    issues.push('missingUnavailableDisclosure');
  }

  for (const pattern of requirement.forbiddenPatterns || []) {
    if (pattern.test(output) && !pattern.test(toolEvidence)) {
      issues.push(`unsupportedCurrentClaim:${pattern.source}`);
    }
  }

  return { pass: issues.length === 0, issues };
}

function evaluateResponseQuality({ output, calls, planningBrief, result, turn }) {
  const body = stripCardBlocks(output);
  const maxBodyWords = planningBrief?.responseStrategy?.maxBodyWords || 350;
  const suggestedCall = calls.filter((call) => call.tool === SUGGESTIONS_TOOL);
  const lastTool = calls.at(-1)?.tool || null;
  const suggestedQuestions = result.context?.summaryContext?.suggestedQuestions || [];
  const grounding = evaluateGrounding(output, calls, turn);
  const checks = {
    nonEmpty: body.trim().length > 0,
    noRuntimeFallback: !result.error && !/having trouble|could not complete/i.test(body),
    noRawLinks: !containsBlockedLink(output),
    withinWordBudget: wordCount(body) <= maxBodyWords,
    mobileTextLines: longestMobileLineWords(output) <= 80,
    suggestedQuestionsUpdatedLast:
      suggestedCall.length === 1 && lastTool === SUGGESTIONS_TOOL,
    exactlyThreeSuggestions:
      suggestedQuestions.length === 3 && suggestedQuestions.every((value) => value.trim()),
    groundedCurrentClaims: grounding.pass,
  };

  const issues = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
    .concat(grounding.issues);

  return {
    pass: issues.length === 0,
    checks,
    issues,
    metrics: {
      bodyWords: wordCount(body),
      maxBodyWords,
      longestMobileLineWords: longestMobileLineWords(output),
      questionCount: (body.match(/\?/g) || []).length,
    },
    grounding,
  };
}

// The Trip Planner decides when to research; there is no deterministic search policy.
function classifyRoutingFailure({ shouldUseWebSearch, didUseWebSearch }) {
  if (shouldUseWebSearch === didUseWebSearch) {
    return null;
  }

  if (shouldUseWebSearch) {
    return {
      type: 'MISSED_SEARCH',
      rootCause: 'The agent did not recognize that this request depends on a current, time-sensitive fact.',
      suggestedFix: 'Sharpen the agent-owned web_search criteria in the Trip Planner prompt.',
    };
  }

  return {
    type: 'OVERUSED_SEARCH',
    rootCause: 'The agent searched for stable knowledge the request did not need.',
    suggestedFix: 'Tighten the stable-knowledge exclusions in the Trip Planner web_search rules.',
  };
}

async function runTurn({ chat, turn, turnNumber, context }) {
  const summaryContextBefore = clone(context.summaryContext);
  const contextBefore = snapshotContext(context);
  const startedAt = Date.now();
  const result = await runTripPlannerAgent({
    input: turn.user,
    context,
    requestId: `${chat.id}-turn-${turnNumber}`,
    sessionId: chat.id,
  });
  const calls = formatToolCalls(result.debug?.toolsCalled || []);
  const webCalls = calls.filter((call) => call.tool === WEB_TOOL);
  const didUseWebSearch = webCalls.length > 0;
  const routingFailure = classifyRoutingFailure({
    shouldUseWebSearch: turn.shouldUseWebSearch,
    didUseWebSearch,
  });
  const policyDecisionMatchesExpectation = !routingFailure;
  const responseQuality = evaluateResponseQuality({
    output: result.output,
    calls,
    planningBrief: result.debug?.planningBrief,
    result,
    turn,
  });
  const routingPass = !routingFailure && webCalls.length <= 1;
  const issues = [];
  if (routingFailure) {
    issues.push(`${routingFailure.type}: ${routingFailure.rootCause}`);
  }
  if (webCalls.length > 1) {
    issues.push('MULTIPLE_WEB_SEARCHES: More than one web search was used for one turn.');
  }
  for (const qualityIssue of responseQuality.issues) {
    issues.push(`RESPONSE_QUALITY: ${qualityIssue}`);
  }

  return {
    testCaseId: turn.id,
    chatId: chat.id,
    turnNumber,
    userQuery: turn.user,
    availableSummaryContext: summaryContextBefore,
    contextBefore,
    expectedBehavior: turn.expectedBehavior,
    freshnessCategory: turn.freshnessCategory,
    shouldUseWebSearch: turn.shouldUseWebSearch,
    actualUsedWebSearch: didUseWebSearch,
    policyDecisionMatchesExpectation,
    toolsCalled: calls,
    webSearchInput: clone(webCalls[0]?.input || null),
    webSearchOutput: clone(webCalls[0]?.output || null),
    finalResponse: result.output,
    responseQuality,
    responseQualityRootCause: responseQuality.grounding.pass
      ? null
      : 'The response used current-looking details that were not supported by the dummy web-search output, or did not disclose that exact data was unavailable.',
    responseQualitySuggestedFix: responseQuality.grounding.pass
      ? null
      : 'Return a structured coverage status from web_search and forbid precise current claims unless the matching fact appears in tool evidence.',
    contextAfter: snapshotContext(result.context),
    suggestedQuestions: clone(result.context?.summaryContext?.suggestedQuestions || []),
    routingPass,
    pass: routingPass && responseQuality.pass,
    issues,
    failureType: routingFailure?.type || null,
    rootCause: routingFailure?.rootCause || null,
    suggestedFix: routingFailure?.suggestedFix || null,
    latencyMs: result.latencyMs || Date.now() - startedAt,
  };
}

async function runChat(chat) {
  await clearTripPlannerSession(chat.id);
  const context = {
    summaryContext: clone(chat.initialSummaryContext),
    tripPlanner: {},
  };
  const turns = [];

  for (let index = 0; index < chat.turns.length; index += 1) {
    const report = await runTurn({
      chat,
      turn: chat.turns[index],
      turnNumber: index + 1,
      context,
    });
    turns.push(report);
    process.stdout.write(
      `${report.pass ? 'PASS' : 'FAIL'} ${report.testCaseId}: expected web=${report.shouldUseWebSearch}, actual=${report.actualUsedWebSearch}\n`,
    );
    if (TURN_DELAY_MS > 0 && index < chat.turns.length - 1) {
      await sleep(TURN_DELAY_MS);
    }
  }

  await clearTripPlannerSession(chat.id);
  return {
    chatId: chat.id,
    title: chat.title,
    initialSummaryContext: clone(chat.initialSummaryContext),
    passed: turns.every((turn) => turn.pass),
    passedTurns: turns.filter((turn) => turn.pass).length,
    totalTurns: turns.length,
    turns,
  };
}

function recommendationsFor(report) {
  const issueIds = new Set(
    report.chats.flatMap((chat) =>
      chat.turns
        .filter((turn) => !turn.pass || !turn.policyDecisionMatchesExpectation)
        .map((turn) => turn.testCaseId),
    ),
  );
  const recommendations = [];

  if (
    issueIds.has('singapore-weather-tomorrow') ||
    issueIds.has('tokyo-newly-opened') ||
    issueIds.has('rome-possible-maintenance-closure')
  ) {
    recommendations.push(
      'Expand freshness intent coverage to weather/forecast, newly opened places, and closed/maintenance/strike/renovation language.',
    );
  }
  if (issueIds.has('singapore-festivals-this-month')) {
    recommendations.push(
      'Preserve both the event noun and date phrase when building date-validation input; plural festivals this month must yield SEARCH_REQUIRED.',
    );
  }
  if (issueIds.has('paris-current-itinerary-word')) {
    recommendations.push(
      'Do not treat the word current as sufficient by itself; require a current fact such as status, hours, price, advisory, or availability.',
    );
  }
  if (issueIds.has('barcelona-festival-negation')) {
    recommendations.push(
      'Add negation and modifier handling so festival-like style requests do not trigger event validation or web search.',
    );
  }
  const groundingFailures = report.chats.flatMap((chat) =>
    chat.turns.filter((turn) => !turn.responseQuality?.grounding?.pass),
  );
  if (groundingFailures.length > 0) {
    recommendations.push(
      'Make the web-search tool return explicit topic coverage (SUPPORTED or CURRENT_DATA_UNAVAILABLE) and require unavailable wording when exact facts are absent.',
    );
    recommendations.push(
      'Block exact current hours, forecasts, opening claims, reservation rules, and visa requirements unless those facts appear in the latest tool output.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Keep the current routing policy and add these scenarios as permanent regressions.');
  }
  return recommendations;
}

function summarize(chatsResult) {
  const turns = chatsResult.flatMap((chat) => chat.turns);
  const missedSearches = turns.filter((turn) => turn.failureType === 'MISSED_SEARCH');
  const overusedSearches = turns.filter((turn) => turn.failureType === 'OVERUSED_SEARCH');
  const routingPassed = turns.filter((turn) => turn.routingPass).length;
  const responseQualityPassed = turns.filter((turn) => turn.responseQuality.pass).length;
  const policyMismatches = turns.filter(
    (turn) => !turn.policyDecisionMatchesExpectation,
  );
  return {
    totalChats: chatsResult.length,
    passedChats: chatsResult.filter((chat) => chat.passed).length,
    totalTurns: turns.length,
    passedTurns: turns.filter((turn) => turn.pass).length,
    routingPassed,
    responseQualityPassed,
    policyMismatchCount: policyMismatches.length,
    policyMismatchCaseIds: policyMismatches.map((turn) => turn.testCaseId),
    missedSearchCount: missedSearches.length,
    overusedSearchCount: overusedSearches.length,
    missedSearchCaseIds: missedSearches.map((turn) => turn.testCaseId),
    overusedSearchCaseIds: overusedSearches.map((turn) => turn.testCaseId),
    successPercentage: Number(
      ((turns.filter((turn) => turn.pass).length / Math.max(1, turns.length)) * 100).toFixed(1),
    ),
  };
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function buildMarkdown(report) {
  const lines = [
    '# Trip Planner Web-Search Intelligence Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Model: ${report.model}`,
    `- Chats passed: ${report.summary.passedChats}/${report.summary.totalChats}`,
    `- Turns passed: ${report.summary.passedTurns}/${report.summary.totalTurns}`,
    `- Routing decisions passed: ${report.summary.routingPassed}/${report.summary.totalTurns}`,
    `- Response quality passed: ${report.summary.responseQualityPassed}/${report.summary.totalTurns}`,
    `- Agent web-search decision mismatches: ${report.summary.policyMismatchCount}`,
    `- Missed searches: ${report.summary.missedSearchCount}`,
    `- Overused searches: ${report.summary.overusedSearchCount}`,
    '',
    '## Decision Table',
    '',
    '| Case | User query | Expected web | Actual web | Tools | Result | Failure |',
    '|---|---|---:|---:|---|---|---|',
  ];

  for (const chat of report.chats) {
    for (const turn of chat.turns) {
      lines.push(
        `| ${markdownCell(turn.testCaseId)} | ${markdownCell(turn.userQuery)} | ${turn.shouldUseWebSearch ? 'yes' : 'no'} | ${turn.actualUsedWebSearch ? 'yes' : 'no'} | ${markdownCell(turn.toolsCalled.map((call) => call.tool).join(' -> '))} | ${turn.pass ? 'PASS' : 'FAIL'} | ${markdownCell(turn.failureType || turn.issues.join('; '))} |`,
      );
    }
  }

  lines.push('', '## Missed Or Overused Searches', '');
  const routingFailures = report.chats.flatMap((chat) =>
    chat.turns.filter((turn) => turn.failureType),
  );
  if (routingFailures.length === 0) {
    lines.push('No routing failures found.');
  } else {
    for (const turn of routingFailures) {
      lines.push(
        `### ${turn.failureType}: ${turn.testCaseId}`,
        '',
        `- **Query:** ${turn.userQuery}`,
        `- **Root cause:** ${turn.rootCause}`,
        `- **Suggested fix:** ${turn.suggestedFix}`,
        '',
      );
    }
  }

  lines.push('## Current-Information Grounding Risks', '');
  const groundingFailures = report.chats.flatMap((chat) =>
    chat.turns.filter((turn) => !turn.responseQuality?.grounding?.pass),
  );
  if (groundingFailures.length === 0) {
    lines.push('No grounding risks found.', '');
  } else {
    for (const turn of groundingFailures) {
      lines.push(
        `- **${turn.testCaseId}:** ${turn.responseQuality.grounding.issues.join(', ')}.`,
      );
    }
    lines.push('');
  }

  lines.push('## Prompt And Routing Recommendations', '');
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }

  lines.push('', '## Turn Details', '');
  for (const chat of report.chats) {
    lines.push(`### ${chat.passed ? 'PASS' : 'FAIL'} - ${chat.title}`, '');
    for (const turn of chat.turns) {
      lines.push(
        `#### ${turn.pass ? 'PASS' : 'FAIL'} - ${turn.testCaseId}`,
        '',
        `**User:** ${turn.userQuery}`,
        '',
        `**Expected:** ${turn.expectedBehavior}`,
        '',
        `**Web decision:** expected ${turn.shouldUseWebSearch ? 'yes' : 'no'}, actual ${turn.actualUsedWebSearch ? 'yes' : 'no'}`,
        '',
        `**Tools:** ${turn.toolsCalled.map((call) => call.tool).join(' -> ') || 'none'}`,
        '',
        `**Response quality:** ${turn.responseQuality.pass ? 'PASS' : `FAIL - ${turn.responseQuality.issues.join(', ')}`}`,
        '',
        '**Final response:**',
        '',
        turn.finalResponse,
        '',
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function revalidateStoredTurn(storedTurn, turnDefinition) {
  const calls = storedTurn.toolsCalled || [];
  const didUseWebSearch = calls.some((call) => call.tool === WEB_TOOL);
  const routingFailure = classifyRoutingFailure({
    shouldUseWebSearch: storedTurn.shouldUseWebSearch,
    didUseWebSearch,
  });
  const policyDecisionMatchesExpectation = !routingFailure;
  const responseQuality = evaluateResponseQuality({
    output: storedTurn.finalResponse,
    calls,
    planningBrief: {
      responseStrategy: {
        maxBodyWords: storedTurn.responseQuality?.metrics?.maxBodyWords || 350,
      },
    },
    result: {
      context: {
        summaryContext: { suggestedQuestions: storedTurn.suggestedQuestions || [] },
      },
    },
    turn: turnDefinition,
  });
  const routingPass =
    !routingFailure &&
    calls.filter((call) => call.tool === WEB_TOOL).length <= 1;
  const issues = [];
  if (routingFailure) {
    issues.push(`${routingFailure.type}: ${routingFailure.rootCause}`);
  }
  if (calls.filter((call) => call.tool === WEB_TOOL).length > 1) {
    issues.push('MULTIPLE_WEB_SEARCHES: More than one web search was used for one turn.');
  }
  for (const qualityIssue of responseQuality.issues) {
    issues.push(`RESPONSE_QUALITY: ${qualityIssue}`);
  }

  return {
    ...storedTurn,
    actualUsedWebSearch: didUseWebSearch,
    policyDecisionMatchesExpectation,
    responseQuality,
    responseQualityRootCause: responseQuality.grounding.pass
      ? null
      : 'The response used current-looking details that were not supported by the dummy web-search output, or did not disclose that exact data was unavailable.',
    responseQualitySuggestedFix: responseQuality.grounding.pass
      ? null
      : 'Return a structured coverage status from web_search and forbid precise current claims unless the matching fact appears in tool evidence.',
    routingPass,
    pass: routingPass && responseQuality.pass,
    issues,
    failureType: routingFailure?.type || null,
    rootCause: routingFailure?.rootCause || null,
    suggestedFix: routingFailure?.suggestedFix || null,
  };
}

function revalidateStoredChats(storedReport) {
  const turnDefinitions = new Map(
    chats.flatMap((chat) => chat.turns.map((turn) => [turn.id, turn] as const)),
  );
  return storedReport.chats.map((chat) => {
    const turns = chat.turns.map((turn) =>
      revalidateStoredTurn(turn, turnDefinitions.get(turn.testCaseId)),
    );
    return {
      ...chat,
      turns,
      passed: turns.every((turn) => turn.pass),
      passedTurns: turns.filter((turn) => turn.pass).length,
      totalTurns: turns.length,
    };
  });
}

let chatResults;
let liveGeneratedAt = null;
if (process.argv.includes('--revalidate')) {
  const storedReport = JSON.parse(await fs.readFile(REPORT_JSON, 'utf8'));
  liveGeneratedAt = storedReport.liveGeneratedAt || storedReport.generatedAt;
  chatResults = revalidateStoredChats(storedReport);
} else {
  const selectedChats = CHAT_IDS.length > 0
    ? chats.filter((chat) => CHAT_IDS.includes(chat.id))
    : chats.slice(0, CHAT_LIMIT);

  if (selectedChats.length === 0) {
    throw new Error('No Trip Planner web-search chats matched the configured selection.');
  }

  chatResults = [];
  for (const chat of selectedChats) {
    process.stdout.write(`\nRunning ${chat.id}\n`);
    chatResults.push(await runChat(chat));
  }
}

const report: any = {
  generatedAt: new Date().toISOString(),
  liveGeneratedAt: liveGeneratedAt || new Date().toISOString(),
  model: tripPlannerAgentConfig.model,
  suite: 'trip-planner-web-search-intelligence',
  summary: summarize(chatResults),
  chats: chatResults,
};
report.recommendations = recommendationsFor(report);

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT_MARKDOWN, buildMarkdown(report), 'utf8');

process.stdout.write('\n# Trip Planner Web-Search Intelligence Summary\n');
process.stdout.write(`Model: ${report.model}\n`);
process.stdout.write(
  `Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed\n`,
);
process.stdout.write(
  `Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed\n`,
);
process.stdout.write(`Missed searches: ${report.summary.missedSearchCount}\n`);
process.stdout.write(`Overused searches: ${report.summary.overusedSearchCount}\n`);
process.stdout.write(`JSON report: ${REPORT_JSON}\n`);
process.stdout.write(`Markdown report: ${REPORT_MARKDOWN}\n`);
