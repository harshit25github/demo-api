process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'info';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT ||= 'low';
process.env.OPENAI_TRIP_PLANNER_VERBOSITY ||= 'low';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearTripPlannerSession, runTripPlannerAgent } = await import('../../src/agents/trip-planner/runner.js');
const { containsLinkLikeText } = await import('../../src/shared/text/link-sanitizer.js');
const { createTripPlannerSummaryContext } = await import('../../src/agents/trip-planner/context/summary-context.js');
const { TRIP_PLANNER_TOOL_NAMES } = await import('../../src/agents/trip-planner/tools/runtime.js');
const { tripPlannerAgentConfig } = await import('../../src/agents/trip-planner/config.js');

const RESULTS_DIR = path.resolve('tests/results');
const REPORT_JSON = path.join(
  RESULTS_DIR,
  'trip-planner-summary-context-web-search-latest.json',
);
const REPORT_MARKDOWN = path.join(
  RESULTS_DIR,
  'trip-planner-summary-context-web-search-latest.md',
);
const CHAT_IDS = String(process.env.TRIP_PLANNER_CONTEXT_CHAT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function fullContext(destination = { city: 'Paris', iata: 'PAR' }) {
  return {
    pax: 2,
    budget: {
      total: 2400,
      amount: 2400,
      currency: 'USD',
      per_person: false,
    },
    origin: { city: 'Delhi', iata: 'DEL' },
    destination,
    tripType: ['roundtrip', 'balanced', 'food'],
    outbound_date: '2026-09-10',
    return_date: '2026-09-14',
    duration_days: 5,
    upcomingEvents: [],
    placesOfInterest: [],
    suggestedQuestions: [],
  };
}

const chats = [
  {
    id: 'trip-context-empty-progressive',
    title: 'Empty context filled progressively',
    initialSummaryContext: {},
    turns: [
      {
        user: 'Plan my trip to Tokyo.',
        expectedBehavior: 'Store Tokyo and ask only for useful missing details.',
        shouldUseWebSearch: false,
        expectedContext: { destination: { city: 'Tokyo' } },
      },
      {
        user: 'Set my travel date to 2026-09-15 for 5 days.',
        expectedBehavior: 'Keep Tokyo and add the outbound date and duration.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Tokyo' },
          outbound_date: '2026-09-15',
          duration_days: 5,
        },
      },
      {
        user: 'It is for 2 travelers, with food and relaxed sightseeing.',
        expectedBehavior: 'Keep route timing and add travelers and preferences.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Tokyo' },
          outbound_date: '2026-09-15',
          duration_days: 5,
          pax: 2,
          tripTypeIncludes: ['food', 'relaxed'],
        },
      },
    ],
  },
  {
    id: 'trip-context-partial-destination',
    title: 'Partial destination context',
    initialSummaryContext: {
      destination: { city: 'Singapore', iata: 'SIN' },
    },
    turns: [
      {
        user: 'Make it a 4-day relaxed food trip.',
        expectedBehavior: 'Keep Singapore and add duration and preferences.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Singapore', iata: 'SIN' },
          duration_days: 4,
          tripTypeIncludes: ['relaxed', 'food'],
        },
      },
      {
        user: 'Travel date is 2026-09-05 for 3 travelers.',
        expectedBehavior: 'Keep prior details and add date and travelers.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Singapore', iata: 'SIN' },
          outbound_date: '2026-09-05',
          duration_days: 4,
          pax: 3,
          tripTypeIncludes: ['relaxed', 'food'],
        },
      },
    ],
  },
  {
    id: 'trip-context-full-plan',
    title: 'Full context reused without repeated questions',
    initialSummaryContext: fullContext(),
    turns: [
      {
        user: 'Plan my trip.',
        expectedBehavior: 'Use every known field and do not ask for it again.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Paris', iata: 'PAR' },
          outbound_date: '2026-09-10',
          return_date: '2026-09-14',
          duration_days: 5,
          pax: 2,
        },
        forbiddenResponsePatterns: [
          /where (?:are you|would you like) to (?:go|travel)/i,
          /what dates?/i,
          /how many (?:people|travelers)/i,
        ],
      },
    ],
  },
  {
    id: 'trip-context-explicit-changes',
    title: 'Explicit destination, date, and preference changes',
    initialSummaryContext: fullContext(),
    turns: [
      {
        user:
          'Change destination to Rome, change the travel date to 2026-09-11, and make it history-focused. Keep the same budget and 2 travelers.',
        expectedBehavior: 'Override only explicit fields and preserve budget, return date, and pax.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Rome' },
          outbound_date: '2026-09-11',
          return_date: '2026-09-15',
          pax: 2,
          budgetAmount: 2400,
          tripTypeIncludes: ['history'],
        },
      },
      {
        user: 'Make it more relaxed and keep everything else.',
        expectedBehavior: 'Add relaxed pacing without resetting Rome or dates.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Rome' },
          outbound_date: '2026-09-11',
          return_date: '2026-09-15',
          pax: 2,
          budgetAmount: 2400,
          tripTypeIncludes: ['history', 'relaxed'],
        },
      },
    ],
  },
  {
    id: 'trip-context-hosted-web-search',
    title: 'Stable planning followed by current festival research',
    initialSummaryContext: fullContext({ city: 'Tokyo', iata: 'TYO' }),
    turns: [
      {
        user: 'Add classic neighborhoods and local food to the plan.',
        expectedBehavior: 'Use stable planning knowledge without web search.',
        shouldUseWebSearch: false,
        expectedContext: {
          destination: { city: 'Tokyo', iata: 'TYO' },
          tripTypeIncludes: ['food'],
        },
      },
      {
        user:
          'What festivals are happening during our dates? Check current official information.',
        expectedBehavior: 'Use hosted web search and keep the existing trip context.',
        shouldUseWebSearch: true,
        shouldPersistUpcomingEvents: true,
        expectedContext: {
          destination: { city: 'Tokyo', iata: 'TYO' },
          outbound_date: '2026-09-10',
          return_date: '2026-09-14',
          pax: 2,
        },
      },
    ],
  },
];

function validateContext(actual, expected = {}) {
  const issues = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'tripTypeIncludes') {
      for (const preference of value as string[]) {
        if (!actual.tripType.includes(preference)) {
          issues.push(`missing tripType value: ${preference}`);
        }
      }
      continue;
    }
    if (key === 'budgetAmount') {
      if (actual.budget.amount !== value) {
        issues.push(`budget.amount expected ${value}, received ${actual.budget.amount}`);
      }
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (actual[key]?.[nestedKey] !== nestedValue) {
          issues.push(
            `${key}.${nestedKey} expected ${nestedValue}, received ${actual[key]?.[nestedKey]}`,
          );
        }
      }
      continue;
    }
    if (actual[key] !== value) {
      issues.push(`${key} expected ${value}, received ${actual[key]}`);
    }
  }
  return issues;
}

async function runChat(chat) {
  await clearTripPlannerSession(chat.id);
  const context: any = {
    summaryContext: createTripPlannerSummaryContext(chat.initialSummaryContext),
    tripPlanner: {},
  };
  const turns = [];

  for (let index = 0; index < chat.turns.length; index += 1) {
    const definition = chat.turns[index];
    const summaryContextBefore = clone(context.summaryContext);
    const result: any = await runTripPlannerAgent({
      input: definition.user,
      context,
      requestId: `${chat.id}-turn-${index + 1}`,
      sessionId: chat.id,
    });
    context.summaryContext = clone(result.context.summaryContext);
    context.tripPlanner = result.context.tripPlanner;
    context.toolCallLog = result.context.toolCallLog;
    const summaryContextAfter = clone(result.context.summaryContext);
    const toolsCalled = clone(result.debug?.toolsCalled || []);
    const webSearchUsed = Boolean(result.debug?.webSearchUsed);
    const issues = validateContext(summaryContextAfter, definition.expectedContext);

    if (webSearchUsed !== definition.shouldUseWebSearch) {
      issues.push(
        `web search expected ${definition.shouldUseWebSearch}, received ${webSearchUsed}`,
      );
    }
    if (
      definition.shouldPersistUpcomingEvents &&
      summaryContextAfter.upcomingEvents.length === 0
    ) {
      issues.push('source-backed current events were not persisted in upcomingEvents');
    }
    if (!result.debug?.extractorOutput || result.debug?.extractorError) {
      issues.push('summary extractor did not complete successfully');
    }
    if (!result.output.trim()) {
      issues.push('agent response was empty');
    }
    if (containsLinkLikeText(result.output, { allowCardImageUrls: true })) {
      issues.push('agent response contained a blocked link');
    }
    for (const pattern of definition.forbiddenResponsePatterns || []) {
      if (pattern.test(result.output)) {
        issues.push(`asked for known context: ${pattern.source}`);
      }
    }

    const suggestionTool = TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions;
    if (toolsCalled.at(-1)?.tool !== suggestionTool) {
      issues.push('suggested-question updater was not the final tool');
    }
    if (summaryContextAfter.suggestedQuestions.length !== 3) {
      issues.push('suggestedQuestions did not contain exactly 3 values');
    }

    turns.push({
      turnNumber: index + 1,
      userMessage: definition.user,
      expectedBehavior: definition.expectedBehavior,
      summaryContextBefore,
      toolsCalled,
      webSearchNeeded: definition.shouldUseWebSearch,
      webSearchUsed,
      agentResponse: result.output,
      extractorInput: result.debug?.extractorInput || null,
      extractorOutput: result.debug?.extractorOutput || null,
      summaryContextAfter,
      pass: issues.length === 0,
      issues,
    });
  }

  await clearTripPlannerSession(chat.id);
  return {
    chatId: chat.id,
    title: chat.title,
    initialSummaryContext: createTripPlannerSummaryContext(
      chat.initialSummaryContext,
    ),
    turns,
    pass: turns.every((turn) => turn.pass),
  };
}

function buildMarkdown(report) {
  const lines = [
    '# Trip Planner Summary Context And Web Search Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Model: ${report.model}`,
    `- Chats passed: ${report.summary.passedChats}/${report.summary.totalChats}`,
    `- Turns passed: ${report.summary.passedTurns}/${report.summary.totalTurns}`,
    `- Hosted web decisions passed: ${report.summary.webDecisionPasses}/${report.summary.totalTurns}`,
    '',
    '| Chat | Turn | Web expected | Web used | Extractor | Result |',
    '|---|---:|---:|---:|---:|---|',
  ];

  for (const chat of report.chats) {
    for (const turn of chat.turns) {
      lines.push(
        `| ${chat.chatId} | ${turn.turnNumber} | ${turn.webSearchNeeded ? 'yes' : 'no'} | ${turn.webSearchUsed ? 'yes' : 'no'} | ${turn.extractorOutput ? 'yes' : 'no'} | ${turn.pass ? 'PASS' : 'FAIL'} |`,
      );
    }
  }

  lines.push('', '## Turn Details', '');
  for (const chat of report.chats) {
    lines.push(`### ${chat.pass ? 'PASS' : 'FAIL'} - ${chat.title}`, '');
    for (const turn of chat.turns) {
      lines.push(
        `#### Turn ${turn.turnNumber}`,
        '',
        `**User:** ${turn.userMessage}`,
        '',
        `**Tools:** ${turn.toolsCalled.map((call) => call.tool).join(' -> ') || 'none'}`,
        '',
        `**Web search:** expected ${turn.webSearchNeeded ? 'yes' : 'no'}, actual ${turn.webSearchUsed ? 'yes' : 'no'}`,
        '',
        `**Result:** ${turn.pass ? 'PASS' : `FAIL - ${turn.issues.join('; ')}`}`,
        '',
        '**Agent response:**',
        '',
        turn.agentResponse,
        '',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const selectedChats =
  CHAT_IDS.length > 0
    ? chats.filter((chat) => CHAT_IDS.includes(chat.id))
    : chats;
const chatResults = [];
for (const chat of selectedChats) {
  process.stdout.write(`\nRunning ${chat.id}\n`);
  const result = await runChat(chat);
  chatResults.push(result);
  for (const turn of result.turns) {
    process.stdout.write(
      `${turn.pass ? 'PASS' : 'FAIL'} turn ${turn.turnNumber}: web expected=${turn.webSearchNeeded}, actual=${turn.webSearchUsed}\n`,
    );
  }
}

const allTurns = chatResults.flatMap((chat) => chat.turns);
const report = {
  generatedAt: new Date().toISOString(),
  model: tripPlannerAgentConfig.model,
  suite: 'trip-planner-summary-context-web-search',
  summary: {
    totalChats: chatResults.length,
    passedChats: chatResults.filter((chat) => chat.pass).length,
    totalTurns: allTurns.length,
    passedTurns: allTurns.filter((turn) => turn.pass).length,
    webDecisionPasses: allTurns.filter(
      (turn) => turn.webSearchNeeded === turn.webSearchUsed,
    ).length,
  },
  chats: chatResults,
};

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await fs.writeFile(REPORT_MARKDOWN, buildMarkdown(report), 'utf8');

process.stdout.write('\nTrip Planner context + web-search summary\n');
process.stdout.write(
  `Chats: ${report.summary.passedChats}/${report.summary.totalChats}\n`,
);
process.stdout.write(
  `Turns: ${report.summary.passedTurns}/${report.summary.totalTurns}\n`,
);
process.stdout.write(`JSON: ${REPORT_JSON}\n`);
process.stdout.write(`Markdown: ${REPORT_MARKDOWN}\n`);

if (report.summary.passedTurns !== report.summary.totalTurns) {
  process.exitCode = 1;
}
