process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT ||= 'low';
process.env.OPENAI_TRIP_PLANNER_VERBOSITY ||= 'low';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearTripPlannerSession, runTripPlannerAgent } = await import('../../src/agents/trip-planner/runner.js');
const { createTripPlannerSummaryContext } = await import('../../src/agents/trip-planner/context/summary-context.js');
const { tripPlannerAgentConfig } = await import('../../src/agents/trip-planner/config.js');
const { validateTripPlannerScopeText, validateTripPlannerSuggestedQuestions } = await import('../../src/agents/trip-planner/scope-policy.js');
const {
  createTripPlannerContextJourneyChats,
  TRIP_PLANNER_CONTEXT_JOURNEY_TOOLS,
} = await import('../fixtures/trip-planner-context-journey-chats.js');

const RESULTS_DIR = path.resolve('tests/results');
const REPORT_JSON = path.join(
  RESULTS_DIR,
  'trip-planner-context-journey-multiturn-latest.json',
);
const REPORT_MARKDOWN = path.join(
  RESULTS_DIR,
  'trip-planner-context-journey-multiturn-latest.md',
);
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(
    process.env.TRIP_PLANNER_CONTEXT_TURN_DELAY_MS || '350',
    10,
  ) || 0,
);
const CHAT_IDS = String(process.env.TRIP_PLANNER_CONTEXT_CHAT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(
    process.env.TRIP_PLANNER_CONTEXT_CHAT_LIMIT || '6',
    10,
  ) || 6,
);
const UPDATE_TOOL = TRIP_PLANNER_CONTEXT_JOURNEY_TOOLS.update;

const CONTEXT_DIFF_PATHS = [
  'pax',
  'budget.total',
  'budget.amount',
  'budget.currency',
  'budget.per_person',
  'origin.city',
  'origin.iata',
  'destination.city',
  'destination.iata',
  'tripType',
  'outbound_date',
  'return_date',
  'duration_days',
  'upcomingEvents',
  'placesOfInterest',
  'suggestedQuestions',
];

const ISSUE_GUIDANCE = {
  runtime: {
    rootCause:
      'The live Agents SDK turn did not complete normally.',
    suggestedFix:
      'Inspect model access, timeout, session state, and the recorded trace.',
  },
  tools: {
    rootCause:
      'The model did not follow the deterministic tool strategy or final updater contract.',
    suggestedFix:
      'Tighten the turn tool instruction and add a focused routing regression.',
  },
  context: {
    rootCause:
      'The agent-prepared structured context payload or context merge failed to store a user-grounded field.',
    suggestedFix:
      'Correct the context-capture instruction, schema, or merge rule and retain a focused payload regression.',
  },
  response: {
    rootCause:
      'The model response did not follow the compact response strategy or did not reflect the active trip state.',
    suggestedFix:
      'Tighten only the affected response-mode instruction or assertion contract.',
  },
  suggestions: {
    rootCause:
      'The final suggested-question updater stored stale, malformed, or out-of-scope suggestions.',
    suggestedFix:
      'Correct agent suggestion guidance or structural validation while keeping the updater last.',
  },
  compact_context: {
    rootCause:
      'The dynamic context exceeded the compact-context budget or serialized unnecessary state.',
    suggestedFix:
      'Remove duplicated or historical fields from the dynamic serializer.',
  },
};

const BUGS_FIXED_BEFORE_LIVE_RUN = [
  {
    id: 'short-context-inputs-not-persisted',
    status: 'fixed',
    reproduction: [
      'rome',
      'change to paris',
      'from delhi',
      'sept 10 to 14',
      'with wife',
      '2 ppl',
      'make it chill',
      'not too costly',
    ],
    before:
      'These short forms were previously handled by fragile deterministic parsing.',
    rootCause:
      'Context capture depended on expanding phrase and regex coverage.',
    fix:
      'Moved natural-language interpretation to the agent and kept the context tool structured-only.',
    regression:
      'tests/live/trip-planner-agent-owned-context-live.ts verifies agent-generated payloads for short conversational inputs.',
  },
  {
    id: 'terse-day-ref-regenerated-full-plan',
    status: 'fixed',
    reproduction: ['day 3 easy pls'],
    before:
      'The turn had patch target day_3 but selected compact_full.',
    rootCause:
      'Response-mode detection required a recognized adjustment verb and ignored a direct day reference.',
    fix:
      'A direct day number now selects compact_patch when a previous plan exists.',
    regression:
      'tests/unit/trip-planner-agent.test.ts treats a terse day reference as an itinerary patch.',
  },
];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameContextValue(pathName, left, right) {
  if (
    pathName === 'tripType' &&
    Array.isArray(left) &&
    Array.isArray(right)
  ) {
    return sameValue([...left].sort(), [...right].sort());
  }
  return sameValue(left, right);
}

function getPath(value, dottedPath) {
  return dottedPath
    .split('.')
    .reduce((current, key) => current?.[key], value);
}

function setPath(target, dottedPath, value) {
  const keys = dottedPath.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    current[key] ||= {};
    current = current[key];
  }
  current[keys.at(-1)] = clone(value);
}

function isMeaningful(value) {
  if (value === null || value === undefined || value === '') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function contextChanges(before, after) {
  const changes = {
    added: {},
    updated: {},
    preserved: {},
    removed: {},
  };

  for (const pathName of CONTEXT_DIFF_PATHS) {
    const beforeValue = getPath(before, pathName);
    const afterValue = getPath(after, pathName);
    const hadBefore = isMeaningful(beforeValue);
    const hasAfter = isMeaningful(afterValue);

    if (!hadBefore && hasAfter) {
      setPath(changes.added, pathName, afterValue);
    } else if (hadBefore && !hasAfter) {
      setPath(changes.removed, pathName, beforeValue);
    } else if (
      hadBefore &&
      hasAfter &&
      !sameContextValue(pathName, beforeValue, afterValue)
    ) {
      setPath(changes.updated, pathName, {
        before: beforeValue,
        after: afterValue,
      });
    } else if (hadBefore && hasAfter) {
      setPath(changes.preserved, pathName, afterValue);
    }
  }
  return changes;
}

function compactSummary(summaryContext = {}) {
  const summary = createTripPlannerSummaryContext(summaryContext);
  return {
    pax: summary.pax,
    budget: summary.budget,
    origin: summary.origin,
    destination: summary.destination,
    tripType: summary.tripType,
    outbound_date: summary.outbound_date,
    return_date: summary.return_date,
    duration_days: summary.duration_days,
    eventCount: summary.upcomingEvents.length,
    placeCount: summary.placesOfInterest.length,
    suggestedQuestions: summary.suggestedQuestions,
  };
}

function compactText(value, maxLength = 320) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}...`;
}

function logCompact(label, payload) {
  console.log(`${label} ${JSON.stringify(payload)}`);
}

function stripCardBlocks(output) {
  return String(output || '').replace(
    /^:::cards\r?\n[\s\S]*?^:::cards\s*$/gm,
    '',
  );
}

function countCards(output) {
  const blocks = [
    ...String(output || '').matchAll(
      /^:::cards\r?\n([\s\S]*?)^:::cards\s*$/gm,
    ),
  ];
  return blocks.reduce(
    (total, match) =>
      total + (match[1].match(/^\[CARD\]$/gm) || []).length,
    0,
  );
}

function wordCount(value) {
  return (
    String(value || '').match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []
  ).length;
}

function countQuestions(output) {
  return (stripCardBlocks(output).match(/\?/g) || []).length;
}

function countDaySections(output) {
  return (
    String(output || '').match(
      /\bDay\s+\d+(?:\s*\([^)]*\))?\s*(?:-|:|\u2014)/gi,
    ) || []
  ).length;
}

function countTimeBlocks(output, label) {
  return (
    stripCardBlocks(output).match(
      new RegExp(`\\*\\*${label}(?::\\*\\*|\\*\\*:?)`, 'gi'),
    ) || []
  ).length;
}

function issue(category, message) {
  return {
    category,
    message,
    ...ISSUE_GUIDANCE[category],
  };
}

function normalizeToolSequence(calls) {
  return calls
    .filter(
      (call, index) =>
        !(
          call.tool === UPDATE_TOOL &&
          call.status === 'INVALID_SUGGESTIONS' &&
          calls[index + 1]?.tool === UPDATE_TOOL
        ),
    )
    .map((call) => call.tool);
}

function compactToolCalls(calls) {
  return calls.map((call) => ({
    tool: call.tool,
    input: clone(call.input),
    status: call.status || null,
    output: clone(call.output),
  }));
}

function validateToolCalls(calls, turn) {
  const issues = [];
  const actualSequence = normalizeToolSequence(calls);
  if (!sameValue(actualSequence, turn.expectedTools)) {
    issues.push(
      issue(
        'tools',
        `Expected ${turn.expectedTools.join(' -> ')}, got ${actualSequence.join(' -> ') || '(none)'}.`,
      ),
    );
  }

  const updateCalls = calls.filter((call) => call.tool === UPDATE_TOOL);
  const successfulUpdates = updateCalls.filter((call) =>
    ['SUCCESS', 'PARTIAL'].includes(call.status),
  );
  const validCorrection =
    updateCalls.length === 2 &&
    updateCalls[0].status === 'INVALID_SUGGESTIONS' &&
    ['SUCCESS', 'PARTIAL'].includes(updateCalls[1].status);
  if (
    calls.at(-1)?.tool !== UPDATE_TOOL ||
    successfulUpdates.length !== 1 ||
    (updateCalls.length !== 1 && !validCorrection)
  ) {
    issues.push(
      issue(
        'tools',
        'The context updater was not the single successful final function tool call.',
      ),
    );
  }

  if (turn.expectedDetailSections) {
    const detailsCall = calls.find(
      (call) =>
        call.tool ===
        TRIP_PLANNER_CONTEXT_JOURNEY_TOOLS.details,
    );
    if (
      !sameValue(
        [...(detailsCall?.input?.sections || [])].sort(),
        [...turn.expectedDetailSections].sort(),
      )
    ) {
      issues.push(
        issue(
          'tools',
          `Expected detail sections ${JSON.stringify(turn.expectedDetailSections)}, got ${JSON.stringify(detailsCall?.input?.sections || [])}.`,
        ),
      );
    }
  }

  if (
    calls.some(
      (call) =>
        call.tool ===
        TRIP_PLANNER_CONTEXT_JOURNEY_TOOLS.web,
    )
  ) {
    issues.push(
      issue(
        'tools',
        'Web search was used even though no turn requested current information.',
      ),
    );
  }
  return issues;
}

function validateContext(before, after, turn) {
  const issues = [];
  for (const expectation of turn.expectedContext || []) {
    const actual = getPath(after, expectation.path);
    if ('includes' in expectation) {
      if (!Array.isArray(actual) || !actual.includes(expectation.includes)) {
        issues.push(
          issue(
            'context',
            `Expected ${expectation.path} to include ${JSON.stringify(expectation.includes)}, got ${JSON.stringify(actual)}.`,
          ),
        );
      }
    } else if (!sameValue(actual, expectation.value)) {
      issues.push(
        issue(
          'context',
          `Expected ${expectation.path}=${JSON.stringify(expectation.value)}, got ${JSON.stringify(actual)}.`,
        ),
      );
    }
  }

  for (const pathName of turn.preserve || []) {
    const beforeValue = getPath(before, pathName);
    const afterValue = getPath(after, pathName);
    if (!sameContextValue(pathName, beforeValue, afterValue)) {
      issues.push(
        issue(
          'context',
          `Expected ${pathName} to be preserved; before=${JSON.stringify(beforeValue)}, after=${JSON.stringify(afterValue)}.`,
        ),
      );
    }
  }

  for (const forbidden of turn.forbiddenContextValues || []) {
    const actual = getPath(after, forbidden.path);
    if (
      (Array.isArray(actual) && actual.includes(forbidden.value)) ||
      actual === forbidden.value
    ) {
      issues.push(
        issue(
          'context',
          `Forbidden stale value ${JSON.stringify(forbidden.value)} remained in ${forbidden.path}.`,
        ),
      );
    }
  }
  return issues;
}

function knownFieldQuestionIssues(output, summary) {
  const questionText = stripCardBlocks(output)
    .split(/(?<=\?)/)
    .filter((part) => part.includes('?'))
    .join(' ');
  const checks = [];

  if (summary.destination.city || summary.destination.iata) {
    checks.push([
      /where.*(?:go|travel)|which destination|pick a destination/i,
      'destination',
    ]);
  }
  if (
    summary.outbound_date ||
    summary.return_date ||
    summary.duration_days
  ) {
    checks.push([
      /how many days|how long|what.*date|which.*date|when.*travel/i,
      'dates or duration',
    ]);
  }
  if (summary.pax) {
    checks.push([
      /how many.*(?:people|traveler)|who.*travel/i,
      'traveler count',
    ]);
  }
  if (summary.budget.amount || summary.budget.total) {
    checks.push([
      /what.*budget|how much.*spend|per person or total/i,
      'budget',
    ]);
  }
  if (summary.tripType.length > 0) {
    checks.push([
      /what.*interest|which.*interest|what.*vibe.*prioritize/i,
      'interests',
    ]);
  }

  return checks
    .filter(([pattern]) => pattern.test(questionText))
    .map(([, name]) =>
      issue('response', `The response asked again for known ${name}.`),
    );
}

function validateResponse(output, strategy, turn, summaryAfter, debug) {
  const issues = [];
  const body = stripCardBlocks(output);
  const bodyWords = wordCount(body);
  const questions = countQuestions(output);
  const cards = countCards(output);
  const daySections = countDaySections(output);

  if (strategy.renderMode !== turn.expectedRenderMode) {
    issues.push(
      issue(
        'response',
        `Expected ${turn.expectedRenderMode}, got ${strategy.renderMode || 'unknown'}.`,
      ),
    );
  }
  if (
    Number.isFinite(strategy.maxBodyWords) &&
    bodyWords > strategy.maxBodyWords
  ) {
    issues.push(
      issue(
        'response',
        `Response used ${bodyWords} body words; ${strategy.maxBodyWords} were allowed.`,
      ),
    );
  }
  const maxQuestions =
    turn.maxQuestions ?? strategy.maxQuestions ?? 2;
  if (questions > maxQuestions) {
    issues.push(
      issue(
        'response',
        `Response asked ${questions} questions; ${maxQuestions} were allowed.`,
      ),
    );
  }
  if (
    turn.expectedCards !== undefined &&
    cards !== turn.expectedCards
  ) {
    issues.push(
      issue(
        'response',
        `Expected ${turn.expectedCards} cards, got ${cards}.`,
      ),
    );
  }

  if (strategy.renderMode === 'compact_full') {
    const expectedDays =
      debug?.planningBrief?.derivedConstraints?.date
        ?.effectiveDurationDays || 4;
    if (daySections !== expectedDays) {
      issues.push(
        issue(
          'response',
          `Expected ${expectedDays} day sections, got ${daySections}.`,
        ),
      );
    }
    for (const label of ['Morning', 'Afternoon', 'Evening']) {
      const count = countTimeBlocks(output, label);
      if (count !== expectedDays) {
        issues.push(
          issue(
            'response',
            `Expected ${expectedDays} ${label} blocks, got ${count}.`,
          ),
        );
      }
    }
  }

  if (strategy.renderMode === 'compact_patch') {
    const maxDaySections = turn.maxDaySections ?? 2;
    if (daySections > maxDaySections) {
      issues.push(
        issue(
          'response',
          `Patch output rendered ${daySections} day sections; maximum is ${maxDaySections}.`,
        ),
      );
    }
    if (cards > 0) {
      issues.push(
        issue('response', 'Patch output repeated destination cards.'),
      );
    }
  }

  for (const pattern of turn.responsePatterns || []) {
    if (!pattern.test(output)) {
      issues.push(
        issue(
          'response',
          `Response did not satisfy ${String(pattern)}.`,
        ),
      );
    }
  }

  const scope = validateTripPlannerScopeText(output);
  if (!scope.ok) {
    issues.push(
      issue(
        'response',
        `Response violated Trip Planner scope: ${scope.categories.join(', ')}.`,
      ),
    );
  }
  if (/https?:\/\/|www\./i.test(body)) {
    issues.push(
      issue('response', 'Response exposed a URL outside a card block.'),
    );
  }
  issues.push(...knownFieldQuestionIssues(output, summaryAfter));

  return {
    issues,
    metrics: {
      bodyWords,
      questions,
      cards,
      daySections,
      maxBodyWords: strategy.maxBodyWords ?? null,
      dynamicContextEstimatedTokens: debug?.dynamicInstructions
        ? Math.ceil(debug.dynamicInstructions.length / 4)
        : null,
    },
  };
}

function validateSuggestions(before, after) {
  const issues = [];
  const suggestions = after.suggestedQuestions || [];
  const previous = before.suggestedQuestions || [];
  const validation = validateTripPlannerSuggestedQuestions(suggestions, {
    previousSuggestions: previous,
  });

  if (suggestions.length !== 3) {
    issues.push(
      issue(
        'suggestions',
        `Expected exactly 3 suggested questions, got ${suggestions.length}.`,
      ),
    );
  }
  if (!validation.ok) {
    issues.push(
      issue(
        'suggestions',
        `Suggestion policy failed: ${validation.issues.join(', ')}.`,
      ),
    );
  }
  if (
    previous.length === 3 &&
    sameValue(previous, suggestions)
  ) {
    issues.push(
      issue(
        'suggestions',
        'The exact same three suggestions were reused from the prior turn.',
      ),
    );
  }
  return issues;
}

function describeActualBehavior({
  strategy,
  calls,
  changes,
  metrics,
}) {
  const changedGroups = Object.entries(changes)
    .filter(([, value]) => Object.keys(value).length > 0)
    .map(([name]) => name);
  return [
    `render=${strategy.renderMode || 'unknown'}`,
    `tools=${normalizeToolSequence(calls).join(' -> ') || 'none'}`,
    `context=${changedGroups.join(',') || 'unchanged'}`,
    `words=${metrics.bodyWords}`,
    `questions=${metrics.questions}`,
  ].join('; ');
}

async function runTurn({
  chat,
  turn,
  turnNumber,
  context,
}) {
  const summaryBefore = createTripPlannerSummaryContext(
    context.summaryContext,
  );
  const startedAt = Date.now();
  let result;

  logCompact('[TripPlanner][initialSummaryContext]', {
    chatId: chat.id,
    turn: turnNumber,
    summaryContext: compactSummary(summaryBefore),
  });
  logCompact('[TripPlanner][userMessage]', {
    chatId: chat.id,
    turn: turnNumber,
    message: turn.userMessage,
  });

  try {
    result = await runTripPlannerAgent({
      input: turn.userMessage,
      context,
      requestId: `${chat.id}-turn-${turnNumber}`,
      sessionId: chat.id,
    });
  } catch (error) {
    result = {
      output: '',
      context,
      error: true,
      thrownError: error,
      debug: {},
    };
  }

  const activeContext = result.context || context;
  const summaryAfter = createTripPlannerSummaryContext(
    activeContext.summaryContext,
  );
  const calls = result.debug?.toolsCalled || [];
  const output = result.output || '';
  const strategy =
    result.debug?.planningBrief?.responseStrategy || {};
  const changes = contextChanges(summaryBefore, summaryAfter);
  const issues = [];
  const responseValidation = validateResponse(
    output,
    strategy,
    turn,
    summaryAfter,
    result.debug,
  );

  logCompact('[TripPlanner][contextInjected]', {
    chatId: chat.id,
    turn: turnNumber,
    chars: result.debug?.dynamicInstructions?.length || 0,
    estimatedTokens: result.debug?.dynamicInstructions
      ? Math.ceil(result.debug.dynamicInstructions.length / 4)
      : null,
    renderMode: strategy.renderMode || null,
    changed:
      Object.keys(result.debug?.inferredContextPatch || {}),
  });
  logCompact('[TripPlanner][toolsCalled]', {
    chatId: chat.id,
    turn: turnNumber,
    tools: calls.map(({ tool, status }) => ({ tool, status })),
  });
  logCompact('[TripPlanner][agentResponse]', {
    chatId: chat.id,
    turn: turnNumber,
    response: compactText(output),
  });
  logCompact('[TripPlanner][updatedSummaryContext]', {
    chatId: chat.id,
    turn: turnNumber,
    summaryContext: compactSummary(summaryAfter),
  });
  logCompact('[TripPlanner][suggestedQuestions]', {
    chatId: chat.id,
    turn: turnNumber,
    suggestedQuestions: summaryAfter.suggestedQuestions,
  });

  if (result.error || result.thrownError) {
    issues.push(
      issue(
        'runtime',
        result.thrownError?.message ||
          result.debug?.error?.message ||
          output ||
          'Unknown live run failure.',
      ),
    );
  } else {
    issues.push(...validateToolCalls(calls, turn));
    issues.push(
      ...validateContext(summaryBefore, summaryAfter, turn),
    );
    issues.push(...responseValidation.issues);
    issues.push(
      ...validateSuggestions(summaryBefore, summaryAfter),
    );
    if (
      responseValidation.metrics.dynamicContextEstimatedTokens > 800
    ) {
      issues.push(
        issue(
          'compact_context',
          `Dynamic context estimate was ${responseValidation.metrics.dynamicContextEstimatedTokens} tokens; limit is 800.`,
        ),
      );
    }
  }

  const actualBehavior = describeActualBehavior({
    strategy,
    calls,
    changes,
    metrics: responseValidation.metrics,
  });

  return {
    report: {
      chatId: chat.id,
      turn: turnNumber,
      summaryContextBefore: summaryBefore,
      userMessage: turn.userMessage,
      toolsCalled: calls.map((call) => call.tool),
      expectedTools: turn.expectedTools,
      toolPayloads: compactToolCalls(calls),
      agentResponse: output,
      summaryContextAfter: summaryAfter,
      contextChanges: changes,
      suggestedQuestions: summaryAfter.suggestedQuestions,
      expectedBehavior: turn.expectedBehavior,
      actualBehavior,
      pass: issues.length === 0,
      issues,
      notes: turn.notes || '',
      responseStrategy: clone(strategy),
      responseMetrics: responseValidation.metrics,
      inferredContextPatch: clone(
        result.debug?.inferredContextPatch || {},
      ),
      contextInjected: {
        characters:
          result.debug?.dynamicInstructions?.length || 0,
        estimatedTokens:
          responseValidation.metrics
            .dynamicContextEstimatedTokens,
      },
      latencyMs: Date.now() - startedAt,
      tokenUsage: clone(result.debug?.usage || null),
    },
    context: activeContext,
  };
}

async function runChat(chat) {
  await clearTripPlannerSession(chat.id);
  let context = {
    summaryContext: clone(chat.initialSummaryContext),
    tripPlanner: {},
  };
  const turns = [];

  for (const [index, turn] of chat.turns.entries()) {
    if (TURN_DELAY_MS > 0 && index > 0) {
      await sleep(TURN_DELAY_MS);
    }
    const result = await runTurn({
      chat,
      turn,
      turnNumber: index + 1,
      context,
    });
    context = result.context;
    turns.push(result.report);
    console.log(
      `[trip-context] ${chat.id} turn ${index + 1}: ${result.report.pass ? 'PASS' : 'FAIL'}`,
    );
  }

  const finalSummaryContext = createTripPlannerSummaryContext(
    context.summaryContext,
  );
  await clearTripPlannerSession(chat.id);
  return {
    chatId: chat.id,
    title: chat.title,
    initialState: chat.initialState,
    initialSummaryContext: createTripPlannerSummaryContext(
      chat.initialSummaryContext,
    ),
    finalSummaryContext,
    pass: turns.every((turn) => turn.pass),
    passedTurns: turns.filter((turn) => turn.pass).length,
    failedTurns: turns.filter((turn) => !turn.pass).length,
    turns,
  };
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * ratio) - 1,
    )
  ];
}

function buildSummary(
  chats,
  startedAt,
  { totalLatencyMs = null } = {},
) {
  const turns = chats.flatMap((chat) => chat.turns);
  const latencies = turns
    .map((turn) => Number(turn.latencyMs))
    .filter(Number.isFinite);
  const totalTokens = turns
    .map((turn) => Number(turn.tokenUsage?.totalTokens))
    .filter(Number.isFinite);
  const contextTokens = turns
    .map((turn) =>
      Number(turn.contextInjected?.estimatedTokens),
    )
    .filter(Number.isFinite);
  const passedTurns = turns.filter((turn) => turn.pass).length;
  return {
    generatedAt: new Date().toISOString(),
    model: tripPlannerAgentConfig.model,
    totalChats: chats.length,
    passedChats: chats.filter((chat) => chat.pass).length,
    failedChats: chats.filter((chat) => !chat.pass).length,
    totalTurns: turns.length,
    passedTurns,
    failedTurns: turns.length - passedTurns,
    passRate: Number(
      ((passedTurns / Math.max(turns.length, 1)) * 100).toFixed(1),
    ),
    totalLatencyMs:
      totalLatencyMs ?? Date.now() - startedAt,
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
    totalTokensP50: percentile(totalTokens, 0.5),
    totalTokensP95: percentile(totalTokens, 0.95),
    dynamicContextTokensP50: percentile(contextTokens, 0.5),
    dynamicContextTokensP95: percentile(contextTokens, 0.95),
    issueCounts: turns
      .flatMap((turn) => turn.issues)
      .reduce((counts, foundIssue) => {
        counts[foundIssue.category] =
          (counts[foundIssue.category] || 0) + 1;
        return counts;
      }, {}),
  };
}

function durationFromSummary(summary: any = {}) {
  if (summary.duration_days) {
    return summary.duration_days;
  }
  const outbound = Date.parse(
    `${summary.outbound_date || ''}T00:00:00.000Z`,
  );
  const returnDate = Date.parse(
    `${summary.return_date || ''}T00:00:00.000Z`,
  );
  if (
    Number.isFinite(outbound) &&
    Number.isFinite(returnDate) &&
    returnDate >= outbound
  ) {
    return Math.round(
      (returnDate - outbound) / (24 * 60 * 60 * 1000),
    ) + 1;
  }
  return 4;
}

function revalidateStoredTurn(storedTurn, turn) {
  const summaryBefore = createTripPlannerSummaryContext(
    storedTurn.summaryContextBefore,
  );
  const summaryAfter = createTripPlannerSummaryContext(
    storedTurn.summaryContextAfter,
  );
  const calls = storedTurn.toolPayloads || [];
  const strategy = storedTurn.responseStrategy || {};
  const output = storedTurn.agentResponse || '';
  const debug = {
    planningBrief: {
      derivedConstraints: {
        date: {
          effectiveDurationDays: durationFromSummary(summaryAfter),
        },
      },
    },
    dynamicInstructions: 'x'.repeat(
      storedTurn.contextInjected?.characters || 0,
    ),
  };
  const changes = contextChanges(summaryBefore, summaryAfter);
  const responseValidation = validateResponse(
    output,
    strategy,
    turn,
    summaryAfter,
    debug,
  );
  const issues = [
    ...validateToolCalls(calls, turn),
    ...validateContext(summaryBefore, summaryAfter, turn),
    ...responseValidation.issues,
    ...validateSuggestions(summaryBefore, summaryAfter),
  ];
  if (
    responseValidation.metrics.dynamicContextEstimatedTokens > 800
  ) {
    issues.push(
      issue(
        'compact_context',
        `Dynamic context estimate was ${responseValidation.metrics.dynamicContextEstimatedTokens} tokens; limit is 800.`,
      ),
    );
  }

  return {
    ...storedTurn,
    contextChanges: changes,
    actualBehavior: describeActualBehavior({
      strategy,
      calls,
      changes,
      metrics: responseValidation.metrics,
    }),
    responseMetrics: responseValidation.metrics,
    pass: issues.length === 0,
    issues,
  };
}

function revalidateStoredReport(storedReport, scenarioChats) {
  const chats = storedReport.chats.map((storedChat) => {
    const scenario = scenarioChats.find(
      (chat) => chat.id === storedChat.chatId,
    );
    if (!scenario) {
      return storedChat;
    }
    const turns = storedChat.turns.map((storedTurn, index) =>
      revalidateStoredTurn(storedTurn, scenario.turns[index]),
    );
    return {
      ...storedChat,
      pass: turns.every((turn) => turn.pass),
      passedTurns: turns.filter((turn) => turn.pass).length,
      failedTurns: turns.filter((turn) => !turn.pass).length,
      turns,
    };
  });
  return {
    ...storedReport,
    summary: buildSummary(chats, Date.now(), {
      totalLatencyMs: storedReport.summary.totalLatencyMs,
    }),
    chats,
  };
}

function markdownJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildMarkdownReport(report) {
  const lines = [
    '# Trip Planner Context Journey Multi-Turn Report',
    '',
    `- Generated: ${report.summary.generatedAt}`,
    `- Model: ${report.summary.model}`,
    `- Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed`,
    `- Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`,
    `- Pass rate: ${report.summary.passRate}%`,
    `- Latency P50/P95: ${report.summary.latencyP50Ms ?? 'n/a'} / ${report.summary.latencyP95Ms ?? 'n/a'} ms`,
    `- Total tokens P50/P95: ${report.summary.totalTokensP50 ?? 'n/a'} / ${report.summary.totalTokensP95 ?? 'n/a'}`,
    `- Dynamic context P50/P95: ${report.summary.dynamicContextTokensP50 ?? 'n/a'} / ${report.summary.dynamicContextTokensP95 ?? 'n/a'} tokens`,
    '',
    '## Bugs Found And Fixed',
    '',
  ];

  for (const bug of report.bugsFound) {
    lines.push(
      `### ${bug.id}`,
      '',
      `- Status: ${bug.status}`,
      `- Before: ${bug.before}`,
      `- Root cause: ${bug.rootCause}`,
      `- Fix: ${bug.fix}`,
      `- Regression: ${bug.regression}`,
      '',
    );
  }

  lines.push(
    '## Before / After Examples',
    '',
    markdownJson(report.beforeAfterExamples),
    '',
  );

  for (const chat of report.chats) {
    lines.push(
      `## ${chat.pass ? 'PASS' : 'FAIL'} - ${chat.title}`,
      '',
      `**Initial state:** ${chat.initialState}`,
      '',
      '**Initial summary context**',
      markdownJson(chat.initialSummaryContext),
      '',
    );

    for (const turn of chat.turns) {
      lines.push(
        `### Turn ${turn.turn}: ${turn.userMessage}`,
        '',
        `- Result: ${turn.pass ? 'PASS' : 'FAIL'}`,
        `- Expected: ${turn.expectedBehavior}`,
        `- Actual: ${turn.actualBehavior}`,
        `- Tools: ${turn.toolsCalled.join(' -> ') || '(none)'}`,
        `- Suggestions: ${turn.suggestedQuestions.join(' | ') || '(none)'}`,
        '',
        '**Summary context before**',
        markdownJson(turn.summaryContextBefore),
        '',
        '**Summary context after**',
        markdownJson(turn.summaryContextAfter),
        '',
        '**Context changes**',
        markdownJson(turn.contextChanges),
        '',
        '**Tool payloads**',
        markdownJson(turn.toolPayloads),
        '',
        '**Agent response**',
        '```text',
        turn.agentResponse,
        '```',
        '',
      );
      if (turn.issues.length > 0) {
        lines.push('**Issues**', '');
        for (const foundIssue of turn.issues) {
          lines.push(
            `- **${foundIssue.category}:** ${foundIssue.message}`,
            `  Root cause: ${foundIssue.rootCause}`,
            `  Suggested fix: ${foundIssue.suggestedFix}`,
          );
        }
        lines.push('');
      }
      if (turn.notes) {
        lines.push(`**Notes:** ${turn.notes}`, '');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const allChats = createTripPlannerContextJourneyChats();
let report;

if (process.argv.includes('--revalidate')) {
  const storedReport = JSON.parse(
    await fs.readFile(REPORT_JSON, 'utf8'),
  );
  report = revalidateStoredReport(storedReport, allChats);
} else {
  const startedAt = Date.now();
  const selectedChats = (
    CHAT_IDS.length > 0
      ? allChats.filter((chat) => CHAT_IDS.includes(chat.id))
      : allChats
  ).slice(0, CHAT_LIMIT);
  const chatReports = [];

  for (const chat of selectedChats) {
    chatReports.push(await runChat(chat));
  }

  report = {
    summary: buildSummary(chatReports, startedAt),
    bugsFound: BUGS_FIXED_BEFORE_LIVE_RUN,
    beforeAfterExamples: {
      shortDestination: {
        before: { userMessage: 'rome', inferredContextPatch: {} },
        after: {
          userMessage: 'rome',
          inferredContextPatch: {
            destination: { city: 'Rome', iata: null },
          },
        },
      },
      terseDayRefinement: {
        before: {
          userMessage: 'day 3 easy pls',
          renderMode: 'compact_full',
        },
        after: {
          userMessage: 'day 3 easy pls',
          renderMode: 'compact_patch',
          patchTargets: ['day_3'],
        },
      },
    },
    chats: chatReports,
  };
}

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(
  REPORT_JSON,
  `${JSON.stringify(report, null, 2)}\n`,
);
await fs.writeFile(
  REPORT_MARKDOWN,
  buildMarkdownReport(report),
);

console.log('\n# Trip Planner Context Journey Summary');
console.log(`Model: ${report.summary.model}`);
console.log(
  `Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed`,
);
console.log(
  `Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`,
);
console.log(`JSON report: ${REPORT_JSON}`);
console.log(`Markdown report: ${REPORT_MARKDOWN}`);

if (report.summary.failedTurns > 0) {
  process.exitCode = 1;
}
