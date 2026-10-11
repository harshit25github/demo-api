process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT ||= 'low';
process.env.OPENAI_TRIP_PLANNER_VERBOSITY ||= 'low';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearTripPlannerSession, runTripPlannerAgent } = await import('../../src/agents/trip-planner/runner.js');
const { TRIP_PLANNER_TOOL_NAMES } = await import('../../src/agents/trip-planner/tools/runtime.js');
const { tripPlannerAgentConfig } = await import('../../src/agents/trip-planner/config.js');
const { validateTripPlannerScopeText, validateTripPlannerSuggestedQuestions } = await import('../../src/agents/trip-planner/scope-policy.js');

const RESULTS_DIR = path.resolve('tests/results');
const REPORT_JSON = path.join(
  RESULTS_DIR,
  'trip-planner-mobile-multiturn-latest.json',
);
const REPORT_MARKDOWN = path.join(
  RESULTS_DIR,
  'trip-planner-mobile-multiturn-latest.md',
);
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.TRIP_PLANNER_MOBILE_TURN_DELAY_MS || '500', 10) || 0,
);
const CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.TRIP_PLANNER_MOBILE_CHAT_LIMIT || '5', 10) || 5,
);
const CHAT_IDS = String(process.env.TRIP_PLANNER_MOBILE_CHAT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const DAY_MS = 24 * 60 * 60 * 1000;
const {
  getPlaceImagesBatch: IMAGE_TOOL,
  webSearch: WEB_TOOL,
  getContextDetails: DETAILS_TOOL,
  updateContext: SUGGESTIONS_TOOL,
} = TRIP_PLANNER_TOOL_NAMES;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function wordCount(value) {
  return (String(value || '').match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []).length;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function getPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

function stripCardBlocks(output) {
  return String(output || '').replace(/^:::cards\r?\n[\s\S]*?^:::cards\s*$/gm, '');
}

function cardBlocks(output) {
  return [...String(output || '').matchAll(/^:::cards\r?\n([\s\S]*?)^:::cards\s*$/gm)].map(
    (match) => match[1],
  );
}

function countCards(output) {
  return cardBlocks(output).reduce(
    (total, block) => total + (block.match(/^\[CARD\]$/gm) || []).length,
    0,
  );
}

function countDaySections(output) {
  return (String(output || '').match(/\bDay\s+\d+\s*(?:-|\u2014)/gi) || []).length;
}

function countQuestions(output) {
  return (stripCardBlocks(output).match(/\?/g) || []).length;
}

function responseMetrics(output) {
  const body = stripCardBlocks(output);
  const timeBlocks = {};
  for (const label of ['Morning', 'Afternoon', 'Evening']) {
    const matches = [
      ...body.matchAll(
        new RegExp(`\\*\\*${label}(?::\\*\\*|\\*\\*:)[ \\t]*([^\\r\\n]*)`, 'gi'),
      ),
    ];
    timeBlocks[label.toLowerCase()] = matches.map((match) => ({
      text: match[1].trim(),
      words: wordCount(match[1]),
    }));
  }

  return {
    characters: String(output || '').length,
    bodyWords: wordCount(body),
    cardBlocks: cardBlocks(output).length,
    cards: countCards(output),
    daySections: countDaySections(output),
    questions: countQuestions(output),
    timeBlocks,
  };
}

function snapshotContext(context: any = {}) {
  return clone({
    summaryContext: context.summaryContext || null,
    tripPlanner: {
      preferenceSignals: context.tripPlanner?.preferenceSignals || {
        positive: [],
        negative: [],
      },
      askedQuestionKeys: context.tripPlanner?.askedQuestionKeys || [],
      lastPlanSnapshot: context.tripPlanner?.lastPlanSnapshot || null,
      lastPlanArtifact: context.tripPlanner?.lastPlanArtifact || null,
      contextRevision: context.tripPlanner?.contextRevision || 0,
      cachedImageCodes: Object.keys(context.tripPlanner?.placeImageCache || {}).sort(),
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

const issueDetails = {
  routing: {
    rootCause: 'The model did not follow the planning brief tool strategy or final-tool rule.',
    suggestedFix: 'Tighten tool-strategy wording or add a turn-specific tool-routing regression.',
  },
  context: {
    rootCause: 'Trip state was not merged, retained, or interpreted consistently across turns.',
    suggestedFix: 'Fix summary-context inference/merge behavior and add a carry-forward assertion.',
  },
  mobile_format: {
    rootCause: 'The response ignored its render mode, word budget, or compact itinerary structure.',
    suggestedFix: 'Strengthen the relevant render-mode instruction without truncating output at runtime.',
  },
  cards_links: {
    rootCause: 'The response violated the existing card, image, or no-link contract.',
    suggestedFix: 'Keep the card contract explicit and add a hard output-guardrail regression.',
  },
  personalization: {
    rootCause: 'Known destination or preference signals were not reflected in the response.',
    suggestedFix: 'Expose the missing signal in planning_brief and require one grounded fit statement.',
  },
  suggestions: {
    rootCause: 'Suggested questions were stale, malformed, or not persisted by the final tool call.',
    suggestedFix: 'Tighten suggestion constraints and final-call state validation.',
  },
  runtime: {
    rootCause: 'The live Agents SDK run failed before normal validation completed.',
    suggestedFix: 'Check credentials, model access, network health, and max-turn configuration.',
  },
};

function issue(category, message) {
  return { category, message, ...issueDetails[category] };
}

const today = startOfUtcDay();
const parisOutbound = isoDate(addDays(today, 45));
const parisReturn = isoDate(addDays(today, 49));
const baliOutbound = isoDate(addDays(today, 60));
const baliReturn = isoDate(addDays(today, 65));

const chats = [
  {
    id: 'trip-mobile-full-context',
    title: 'Full context and one-day patch',
    initialSummaryContext: {
      pax: 2,
      budget: { total: 2400, amount: 2400, currency: 'USD', per_person: false },
      origin: { city: 'Delhi', iata: 'DEL' },
      destination: { city: 'Paris', iata: 'PAR' },
      tripType: ['roundtrip', 'couple', 'balanced'],
      outbound_date: parisOutbound,
      return_date: parisReturn,
      duration_days: 5,
      upcomingEvents: [],
      placesOfInterest: [],
      suggestedQuestions: [],
    },
    turns: [
      {
        user: 'Plan my trip around art and local food.',
        expectedBehavior:
          'Use all known context, return one compact five-day plan, and ask no missing-detail questions.',
        expectedTools: [IMAGE_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_full',
        expectedImageCodes: ['PAR'],
        requiredResponsePatterns: [/Paris/i, /art|museum|Louvre/i, /food|cuisine|bistro/i],
        expectedContext: [
          { path: 'summaryContext.outbound_date', value: parisOutbound },
          { path: 'summaryContext.return_date', value: parisReturn },
          { path: 'summaryContext.pax', value: 2 },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'museums' },
        ],
      },
      {
        user: 'Make day 3 lighter.',
        expectedBehavior:
          'Patch only day 3, retain every known trip field, and do not repeat the card or full itinerary.',
        expectedTools: [DETAILS_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedDetailSections: ['last_plan'],
        expectedPatchTargets: ['day_3'],
        maxDaySections: 1,
        requiredResponsePatterns: [/day 3/i, /light|relax|rest|slower/i],
        expectedContext: [
          { path: 'summaryContext.destination.iata', value: 'PAR' },
          { path: 'summaryContext.outbound_date', value: parisOutbound },
          { path: 'summaryContext.return_date', value: parisReturn },
          { path: 'summaryContext.budget.amount', value: 2400 },
        ],
      },
    ],
  },
  {
    id: 'trip-mobile-partial-context',
    title: 'Partial context filled incrementally',
    initialSummaryContext: {
      pax: 3,
      origin: { city: 'Delhi', iata: 'DEL' },
      destination: { city: 'Singapore', iata: 'SIN' },
      duration_days: 4,
    },
    turns: [
      {
        user: 'We like street food and easy sightseeing. Give us a practical plan.',
        expectedBehavior:
          'Use destination, duration, and party context; draft a useful compact plan and ask only about budget and pace.',
        expectedTools: [IMAGE_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_full',
        expectedImageCodes: ['SIN'],
        requiredResponsePatterns: [/Singapore/i, /food|hawker|cuisine/i],
        expectedContext: [
          { path: 'summaryContext.duration_days', value: 4 },
          { path: 'summaryContext.pax', value: 3 },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
        ],
      },
      {
        user: 'Budget is $1,800 total, and make it relaxed.',
        expectedBehavior:
          'Persist total budget and relaxed pace, then return only the affected plan and compact allowance update.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['budget', 'pace'],
        maxDaySections: 2,
        blockedSuggestionPatterns: [/set.*budget/i, /change.*budget/i, /make.*relaxed/i],
        requiredResponsePatterns: [/budget|\$1,?800/i, /relax/i],
        expectedContext: [
          { path: 'summaryContext.budget.amount', value: 1800 },
          { path: 'summaryContext.budget.currency', value: 'USD' },
          { path: 'summaryContext.budget.total', value: 1800 },
          { path: 'summaryContext.tripType', includes: 'relaxed' },
        ],
      },
      {
        user: 'Make it a 5-day trip.',
        expectedBehavior:
          'Update duration to five days and show only the newly affected day or pacing changes.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['dates_or_duration'],
        maxDaySections: 2,
        requiredResponsePatterns: [/day 5|5[- ]?day|5 days|five-day/i],
        expectedContext: [
          { path: 'summaryContext.duration_days', value: 5 },
          { path: 'summaryContext.budget.amount', value: 1800 },
          { path: 'summaryContext.tripType', includes: 'relaxed' },
        ],
      },
    ],
  },
  {
    id: 'trip-mobile-destination-only',
    title: 'Destination-only context with focused collection',
    initialSummaryContext: {
      destination: { city: 'Tokyo', iata: 'TYO' },
    },
    turns: [
      {
        user: 'Plan a relaxed Tokyo trip.',
        expectedBehavior:
          'Use Tokyo immediately, provide a compact starter plan, and ask only for duration/dates and interests.',
        expectedTools: [IMAGE_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_full',
        expectedImageCodes: ['TYO'],
        requiredResponsePatterns: [/Tokyo/i, /relax/i, /assum/i],
        expectedContext: [
          { path: 'summaryContext.destination.iata', value: 'TYO' },
          { path: 'summaryContext.tripType', includes: 'relaxed' },
        ],
      },
      {
        user: '4 days, mostly local food and quiet neighborhoods.',
        expectedBehavior:
          'Persist duration and interests, patch the plan without repeating Tokyo details, then ask only still-missing essentials.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['dates_or_duration', 'preferences', 'food', 'places'],
        maxDaySections: 2,
        requiredResponsePatterns: [/food|cuisine|eat/i, /neighborhood|district|local/i],
        expectedContext: [
          { path: 'summaryContext.duration_days', value: 4 },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'local experiences' },
        ],
      },
      {
        user: 'It is for 1 traveler.',
        expectedBehavior:
          'Persist solo traveler count and adjust only party-relevant guidance without repeating known questions.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['party'],
        maxDaySections: 2,
        requiredResponsePatterns: [/solo|1 traveler|one traveler/i],
        expectedContext: [
          { path: 'summaryContext.pax', value: 1 },
          { path: 'summaryContext.duration_days', value: 4 },
          { path: 'summaryContext.destination.iata', value: 'TYO' },
        ],
      },
    ],
  },
  {
    id: 'trip-mobile-preference-evolution',
    title: 'Relaxed to food-focused to budget-conscious',
    initialSummaryContext: {
      pax: 2,
      budget: { total: 1800, amount: 1800, currency: 'USD', per_person: false },
      origin: { city: 'Delhi', iata: 'DEL' },
      destination: { city: 'Bali', iata: 'DPS' },
      tripType: ['roundtrip', 'couple', 'relaxed'],
      outbound_date: baliOutbound,
      return_date: baliReturn,
      duration_days: 6,
      upcomingEvents: [],
      placesOfInterest: [],
      suggestedQuestions: [],
    },
    turns: [
      {
        user: 'Plan this around beaches and nature, with no nightlife.',
        expectedBehavior:
          'Build a relaxed six-day Bali plan using beach/nature preferences while excluding nightlife.',
        expectedTools: [IMAGE_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_full',
        expectedImageCodes: ['DPS'],
        requiredResponsePatterns: [/Bali/i, /beach|coast/i, /nature|scenic|rice/i],
        forbiddenResponsePatterns: [/nightclub|club-hopping/i],
        expectedContext: [
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'beaches' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'nature' },
          { path: 'tripPlanner.preferenceSignals.negative', includes: 'nightlife' },
        ],
      },
      {
        user: 'Actually, make local food the main focus.',
        expectedBehavior:
          'Add food as the main focus, retain the prior no-nightlife preference, and return only plan-wide food changes.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['preferences', 'food'],
        maxDaySections: 2,
        blockedSuggestionPatterns: [/make.*food.*focus/i, /food.*main focus/i],
        requiredResponsePatterns: [/food|cuisine|dish|market/i],
        expectedContext: [
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'beaches' },
          { path: 'tripPlanner.preferenceSignals.negative', includes: 'nightlife' },
        ],
      },
      {
        user: 'Keep the food focus, but make it more budget-friendly.',
        expectedBehavior:
          'Persist budget-conscious intent, preserve food focus, and show only affordable substitutions plus compact allowances.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['preferences', 'food', 'budget'],
        maxDaySections: 2,
        blockedSuggestionPatterns: [
          /make.*(?:plan|itinerary).*budget[- ]friendly/i,
          /make.*(?:plan|itinerary).*cheaper/i,
        ],
        requiredResponsePatterns: [/budget|affordable|free|low-cost/i, /food|cuisine|meal/i],
        expectedContext: [
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'budget-conscious' },
          { path: 'tripPlanner.preferenceSignals.negative', includes: 'nightlife' },
          { path: 'summaryContext.budget.amount', value: 1800 },
        ],
      },
    ],
  },
  {
    id: 'trip-mobile-no-context',
    title: 'No context through destination selection and refinement',
    initialSummaryContext: {},
    turns: [
      {
        user: 'I need a relaxed 4-day break for food and history. Show me Paris, Rome, or Tokyo.',
        expectedBehavior:
          'Show exactly three cards for the stated options and ask one destination-selection question.',
        expectedTools: [IMAGE_TOOL, SUGGESTIONS_TOOL],
        expectedRenderMode: 'discovery_cards',
        expectedImageCodes: ['PAR', 'ROM', 'TYO'],
        requiredResponsePatterns: [/Paris/i, /Rome/i, /Tokyo/i],
        expectedContext: [
          { path: 'summaryContext.destination.city', value: null },
          { path: 'summaryContext.duration_days', value: 4 },
          { path: 'summaryContext.tripType', includes: 'relaxed' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'history' },
        ],
      },
      {
        user: 'Plan my trip to Tokyo for 4 days, 1 traveler.',
        expectedBehavior:
          'Select Tokyo, reuse its cached image, retain prior preferences, and generate one compact full plan.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_full',
        requiredResponsePatterns: [/Tokyo/i, /food|cuisine|market/i, /history|temple|shrine/i],
        expectedContext: [
          { path: 'summaryContext.destination.city', value: 'Tokyo' },
          { path: 'summaryContext.duration_days', value: 4 },
          { path: 'summaryContext.pax', value: 1 },
          { path: 'tripPlanner.preferenceSignals.positive', includes: 'food' },
          { path: 'tripPlanner.cachedImageCodes', includes: 'TYO' },
        ],
      },
      {
        user: 'Skip museums and keep the days easy.',
        expectedBehavior:
          'Persist the museum exclusion and patch only affected activities while retaining relaxed pacing.',
        expectedTools: [SUGGESTIONS_TOOL],
        expectedRenderMode: 'compact_patch',
        expectedPatchTargets: ['preferences', 'activities'],
        maxDaySections: 2,
        requiredResponsePatterns: [
          /museum|gallery/i,
          /skip|replace|instead|swap|no museums|out/i,
        ],
        expectedContext: [
          { path: 'tripPlanner.preferenceSignals.negative', includes: 'museums' },
          { path: 'summaryContext.destination.city', value: 'Tokyo' },
          { path: 'summaryContext.tripType', includes: 'relaxed' },
        ],
      },
    ],
  },
];

function validateToolSequence(actualCalls, expectedTools) {
  const actualTools = actualCalls
    .filter(
      (call, index) =>
        !(
          call.tool === SUGGESTIONS_TOOL &&
          call.status === 'INVALID_SUGGESTIONS' &&
          actualCalls[index + 1]?.tool === SUGGESTIONS_TOOL
        ),
    )
    .map((call) => call.tool);
  return sameArray(actualTools, expectedTools)
    ? []
    : [
        issue(
          'routing',
          `Expected tools ${expectedTools.join(' -> ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
        ),
      ];
}

function validateToolPayloads(calls, turn) {
  const issues = [];
  const byName = (name) => calls.find((call) => call.tool === name);

  if (turn.expectedImageCodes) {
    const actual = byName(IMAGE_TOOL)?.input?.itemCodes || [];
    if (!sameSet(actual, turn.expectedImageCodes)) {
      issues.push(
        issue(
          'routing',
          `Expected image codes ${JSON.stringify(turn.expectedImageCodes)}, got ${JSON.stringify(actual)}.`,
        ),
      );
    }
  }

  if (turn.expectedDetailSections) {
    const actual = byName(DETAILS_TOOL)?.input?.sections || [];
    if (!sameSet(actual, turn.expectedDetailSections)) {
      issues.push(
        issue(
          'routing',
          `Expected detail sections ${JSON.stringify(turn.expectedDetailSections)}, got ${JSON.stringify(actual)}.`,
        ),
      );
    }
  }

  return issues;
}

function validateContext(after, expectedContext = []) {
  const issues = [];
  for (const expectation of expectedContext) {
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
    } else if (actual !== expectation.value) {
      issues.push(
        issue(
          'context',
          `Expected ${expectation.path}=${JSON.stringify(expectation.value)}, got ${JSON.stringify(actual)}.`,
        ),
      );
    }
  }
  return issues;
}

function validateCardAndLinkContract(output, strategy, metrics) {
  const issues = [];
  const blocks = cardBlocks(output);
  const bodyWithoutCards = stripCardBlocks(output);

  if (/^:{1,2}cards\b|^:{4,}cards\b/gm.test(output)) {
    issues.push(issue('cards_links', 'Response used an invalid cards marker.'));
  }
  if (/https?:\/\/|www\./i.test(bodyWithoutCards)) {
    issues.push(issue('cards_links', 'Response exposed a URL outside an exact cards block.'));
  }
  if (/\[[^\]]+\]\(https?:\/\//i.test(output) || /<a\s+href=/i.test(output)) {
    issues.push(issue('cards_links', 'Response included a markdown or HTML link.'));
  }
  const scopeValidation = validateTripPlannerScopeText(output);
  if (!scopeValidation.ok) {
    issues.push(
      issue(
        'personalization',
        `Response violated Trip Planner scope: ${scopeValidation.categories.join(', ')}.`,
      ),
    );
  }

  for (const block of blocks) {
    const cards = [...block.matchAll(/^\[CARD\]\r?\n([\s\S]*?)^\[\/CARD\]$/gm)];
    for (const card of cards) {
      const fields = card[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(':', 1)[0]);
      if (!sameArray(fields, ['title', 'image', 'known_for', 'weather', 'budget'])) {
        issues.push(
          issue(
            'cards_links',
            `Card fields were ${JSON.stringify(fields)} instead of the required five-field order.`,
          ),
        );
      }
    }
  }

  if (strategy.cardPolicy === 'exactly_3_cards' && metrics.cards !== 3) {
    issues.push(issue('cards_links', `Discovery response returned ${metrics.cards} cards instead of 3.`));
  }
  if (strategy.cardPolicy === 'render_once' && metrics.cards !== 1) {
    issues.push(issue('cards_links', `Full response returned ${metrics.cards} destination cards instead of 1.`));
  }
  if (strategy.cardPolicy === 'omit_unless_visuals_requested' && metrics.cards !== 0) {
    issues.push(issue('cards_links', 'Patch response repeated a destination card.'));
  }

  return issues;
}

function validateMobileFormat(output, strategy, metrics, turn) {
  const issues = [];
  const body = stripCardBlocks(output);

  if (metrics.bodyWords > strategy.maxBodyWords) {
    issues.push(
      issue(
        'mobile_format',
        `${strategy.renderMode} response used ${metrics.bodyWords} body words; limit is ${strategy.maxBodyWords}.`,
      ),
    );
  }

  const proseLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^#{2,3}\s/.test(line) &&
        !/^[-*|]/.test(line) &&
        !/\*\*(?:Morning|Afternoon|Evening)/i.test(line),
    );
  if (proseLines.some((line) => (line.match(/[.!?](?:\s|$)/g) || []).length > 2)) {
    issues.push(issue('mobile_format', 'A prose paragraph exceeded two sentences.'));
  }

  if (/\*\*Known for:\*\*|\*\*Perfect for:\*\*|Best Time to Visit/i.test(body)) {
    issues.push(issue('mobile_format', 'Response repeated destination-card or four-season detail in prose.'));
  }

  if (metrics.questions > strategy.maxQuestions) {
    issues.push(
      issue(
        'mobile_format',
        `Response asked ${metrics.questions} questions; this turn allows ${strategy.maxQuestions}.`,
      ),
    );
  }

  if (strategy.renderMode === 'compact_full') {
    const expectedDays = turn.expectedDays || null;
    if (expectedDays !== null && metrics.daySections !== expectedDays) {
      issues.push(
        issue(
          'mobile_format',
          `Expected ${expectedDays} day sections, got ${metrics.daySections}.`,
        ),
      );
    }
    for (const label of ['morning', 'afternoon', 'evening']) {
      if (expectedDays !== null && metrics.timeBlocks[label].length !== expectedDays) {
        issues.push(
          issue(
            'mobile_format',
            `Expected ${expectedDays} ${label} lines, got ${metrics.timeBlocks[label].length}.`,
          ),
        );
      }
      for (const block of metrics.timeBlocks[label]) {
        if (block.words > strategy.maxTimeBlockWords) {
          issues.push(
            issue(
              'mobile_format',
              `${label} block used ${block.words} words; limit is ${strategy.maxTimeBlockWords}.`,
            ),
          );
        }
      }
    }
  }

  if (strategy.renderMode === 'compact_patch') {
    const maxDaySections = turn.maxDaySections ?? 2;
    if (metrics.daySections > maxDaySections) {
      issues.push(
        issue(
          'mobile_format',
          `Patch response rendered ${metrics.daySections} day sections; limit is ${maxDaySections}.`,
        ),
      );
    }
    if (/\b\d+[- ]Day\s+.*Itinerary/i.test(body)) {
      issues.push(issue('mobile_format', 'Patch response regenerated a full itinerary heading.'));
    }
  }

  return issues;
}

function validateKnownFieldQuestions(output, after) {
  const questions = stripCardBlocks(output)
    .split(/(?<=\?)/)
    .filter((part) => part.includes('?'))
    .join(' ');
  const summary = after.summaryContext || {};
  const preferences = after.tripPlanner?.preferenceSignals || {};
  const checks = [];

  if (summary.destination?.city || summary.destination?.iata) {
    checks.push([/where.*(?:go|travel)|which destination|pick a destination/i, 'destination']);
  }
  if (summary.outbound_date || summary.return_date || summary.duration_days) {
    checks.push([/how many days|how long|what.*date|which.*date|when.*travel/i, 'dates or duration']);
  }
  if (summary.pax) {
    checks.push([/how many.*(?:people|traveler)|who.*travel/i, 'traveler count']);
  }
  if (summary.budget?.amount) {
    checks.push([/what.*budget|how much.*spend|per person or total/i, 'budget']);
  }
  if ((preferences.positive?.length || 0) + (preferences.negative?.length || 0) > 0) {
    checks.push([/what.*interest|which.*interest|what.*vibe.*prioritize/i, 'interests']);
  }

  return checks
    .filter(([pattern]) => pattern.test(questions))
    .map(([, field]) => issue('context', `Response asked again for known ${field}.`));
}

function validatePersonalization(output, turn) {
  const issues = [];
  for (const pattern of turn.requiredResponsePatterns || []) {
    if (!pattern.test(output)) {
      issues.push(
        issue('personalization', `Response did not satisfy expected pattern ${String(pattern)}.`),
      );
    }
  }
  for (const pattern of turn.forbiddenResponsePatterns || []) {
    if (pattern.test(output)) {
      issues.push(
        issue('personalization', `Response included forbidden pattern ${String(pattern)}.`),
      );
    }
  }
  return issues;
}

function validateSuggestions(calls, before, after, turn) {
  const issues = [];
  const updateCalls = calls.filter((call) => call.tool === SUGGESTIONS_TOOL);
  const suggestions = after.summaryContext?.suggestedQuestions || [];
  const previous = before.summaryContext?.suggestedQuestions || [];

  const successfulUpdates = updateCalls.filter((call) =>
    ['SUCCESS', 'PARTIAL'].includes(call.status),
  );
  const validCorrectionSequence =
    updateCalls.length === 2 &&
    updateCalls[0].status === 'INVALID_SUGGESTIONS' &&
    ['SUCCESS', 'PARTIAL'].includes(updateCalls[1].status);
  if (
    calls.at(-1)?.tool !== SUGGESTIONS_TOOL ||
    successfulUpdates.length !== 1 ||
    (updateCalls.length !== 1 && !validCorrectionSequence)
  ) {
    issues.push(
      issue(
        'suggestions',
        'Context updater must finish last with one successful update and at most one suggestion correction.',
      ),
    );
  }
  if (suggestions.length !== 3) {
    issues.push(issue('suggestions', `Expected exactly 3 suggestions, got ${suggestions.length}.`));
  }
  const validation = validateTripPlannerSuggestedQuestions(suggestions);
  if (!validation.ok) {
    issues.push(
      issue(
        'suggestions',
        `Stored suggestions failed server policy: ${validation.issues.join(', ')}.`,
      ),
    );
  }
  for (const suggestion of suggestions) {
    const words = wordCount(suggestion);
    if (words < 3 || words > 8) {
      issues.push(
        issue('suggestions', `Suggestion ${JSON.stringify(suggestion)} used ${words} words; expected 3-8.`),
      );
    }
    for (const pattern of turn.blockedSuggestionPatterns || []) {
      if (pattern.test(suggestion)) {
        issues.push(
          issue('suggestions', `Suggestion repeated the completed action: ${JSON.stringify(suggestion)}.`),
        );
      }
    }
  }
  if (previous.length === 3 && sameArray(previous, suggestions)) {
    issues.push(issue('suggestions', 'The exact same three suggestions were reused across turns.'));
  }
  return issues;
}

function validateStrategy(strategy, turn) {
  const issues = [];
  if (strategy.renderMode !== turn.expectedRenderMode) {
    issues.push(
      issue(
        'context',
        `Expected render mode ${turn.expectedRenderMode}, got ${strategy.renderMode}.`,
      ),
    );
  }
  for (const target of turn.expectedPatchTargets || []) {
    if (!strategy.patchTargets.includes(target)) {
      issues.push(
        issue(
          'context',
          `Expected patch target ${target}, got ${JSON.stringify(strategy.patchTargets)}.`,
        ),
      );
    }
  }
  return issues;
}

async function runTurn({ chat, turn, turnNumber, context }) {
  const before = snapshotContext(context);
  const startedAt = Date.now();
  let result;

  try {
    result = await runTripPlannerAgent({
      input: turn.user,
      context,
      requestId: `${chat.id}-turn-${turnNumber}`,
      sessionId: chat.id,
    });
  } catch (error) {
    result = { output: '', error: true, thrownError: error, context };
  }

  const activeContext = result.context || context;
  const after = snapshotContext(activeContext);
  const calls = result.debug?.toolsCalled || [];
  const output = result.output || '';
  const strategy = result.debug?.planningBrief?.responseStrategy || {};
  const expectedDays = result.debug?.planningBrief?.derivedConstraints?.date?.effectiveDurationDays;
  const enrichedTurn = { ...turn, expectedDays };
  const metrics = responseMetrics(output);
  const issues = [];

  if (result.error || result.thrownError) {
    issues.push(
      issue(
        'runtime',
        `Agent run failed: ${result.thrownError?.message || output || 'unknown error'}.`,
      ),
    );
  } else {
    issues.push(...validateToolSequence(calls, turn.expectedTools));
    issues.push(...validateToolPayloads(calls, turn));
    issues.push(...validateStrategy(strategy, turn));
    issues.push(...validateContext(after, turn.expectedContext));
    issues.push(...validateCardAndLinkContract(output, strategy, metrics));
    issues.push(...validateMobileFormat(output, strategy, metrics, enrichedTurn));
    issues.push(...validateKnownFieldQuestions(output, after));
    issues.push(...validatePersonalization(output, turn));
    issues.push(...validateSuggestions(calls, before, after, turn));
    if (calls.some((call) => call.tool === WEB_TOOL)) {
      issues.push(issue('routing', 'A freshness web search was called without a freshness request.'));
    }
  }

  const observations = [
    `${strategy.renderMode || 'unknown'}: ${metrics.bodyWords}/${strategy.maxBodyWords || '?'} body words`,
    `${metrics.cards} card(s), ${metrics.daySections} day section(s), ${metrics.questions} question(s)`,
    `tools: ${calls.map((call) => call.tool).join(' -> ') || '(none)'}`,
    issues.length === 0 ? 'All deterministic quality checks passed.' : `${issues.length} issue(s) found.`,
  ];

  return {
    turn: turnNumber,
    userMessage: turn.user,
    summaryContextBefore: before.summaryContext,
    expectedAgentBehavior: turn.expectedBehavior,
    expectedToolCalls: turn.expectedTools,
    actualToolCalls: calls.map((call) => call.tool),
    expectedPayload: {
      imageCodes: turn.expectedImageCodes || null,
      detailSections: turn.expectedDetailSections || null,
      patchTargets: turn.expectedPatchTargets || [],
    },
    actualPayload: formatToolCalls(calls),
    planningResponseStrategy: clone(strategy),
    agentResponse: output,
    updatedContext: after,
    suggestedQuestions: after.summaryContext.suggestedQuestions,
    responseMetrics: metrics,
    responseQualityObservations: observations,
    pass: issues.length === 0,
    issues,
    latencyMs: Date.now() - startedAt,
    tokenUsage: clone(result.debug?.usage || null),
    dynamicContextEstimatedTokens: result.debug?.dynamicInstructions
      ? Math.ceil(result.debug.dynamicInstructions.length / 4)
      : null,
    context: activeContext,
  };
}

async function runChat(chat) {
  await clearTripPlannerSession(chat.id);
  let context = {
    summaryContext: clone(chat.initialSummaryContext),
    tripPlanner: {},
    toolCallLog: [],
  };
  const turns = [];

  for (const [index, turn] of chat.turns.entries()) {
    if (TURN_DELAY_MS > 0 && index > 0) {
      await sleep(TURN_DELAY_MS);
    }
    console.log(`[trip-mobile] ${chat.id} turn ${index + 1}/${chat.turns.length}`);
    const turnReport = await runTurn({
      chat,
      turn,
      turnNumber: index + 1,
      context,
    });
    context = turnReport.context;
    delete turnReport.context;
    turns.push(turnReport);
    console.log(`[trip-mobile] ${chat.id} turn ${index + 1}: ${turnReport.pass ? 'PASS' : 'FAIL'}`);
  }

  const finalContext = snapshotContext(context);
  await clearTripPlannerSession(chat.id);
  return {
    id: chat.id,
    title: chat.title,
    pass: turns.every((turn) => turn.pass),
    passedTurns: turns.filter((turn) => turn.pass).length,
    failedTurns: turns.filter((turn) => !turn.pass).length,
    finalContext,
    turns,
  };
}

function durationFromSummaryContext(summaryContext: any = {}) {
  if (summaryContext.duration_days) {
    return summaryContext.duration_days;
  }
  const outbound = Date.parse(`${summaryContext.outbound_date || ''}T00:00:00.000Z`);
  const returnDate = Date.parse(`${summaryContext.return_date || ''}T00:00:00.000Z`);
  if (Number.isFinite(outbound) && Number.isFinite(returnDate) && returnDate >= outbound) {
    return Math.round((returnDate - outbound) / DAY_MS) + 1;
  }
  return 4;
}

function alignStoredDynamicDates(turn, storedTurn) {
  const datePaths = new Set([
    'summaryContext.outbound_date',
    'summaryContext.return_date',
  ]);
  return {
    ...turn,
    expectedContext: (turn.expectedContext || []).map((expectation) =>
      datePaths.has(expectation.path) && 'value' in expectation
        ? {
            ...expectation,
            value: getPath(storedTurn.updatedContext, expectation.path),
          }
        : expectation,
    ),
  };
}

function revalidateStoredTurn({ chat, turn, storedTurn, previousSuggestions }) {
  const alignedTurn = alignStoredDynamicDates(turn, storedTurn);
  const before = {
    summaryContext: {
      ...(storedTurn.summaryContextBefore || {}),
      suggestedQuestions: previousSuggestions,
    },
    tripPlanner: {},
  };
  const after = storedTurn.updatedContext;
  const calls = storedTurn.actualPayload || [];
  const output = storedTurn.agentResponse || '';
  const strategy = storedTurn.planningResponseStrategy || {};
  const metrics = responseMetrics(output);
  const enrichedTurn = {
    ...alignedTurn,
    expectedDays: durationFromSummaryContext(after.summaryContext),
  };
  const issues = [
    ...validateToolSequence(calls, alignedTurn.expectedTools),
    ...validateToolPayloads(calls, alignedTurn),
    ...validateStrategy(strategy, alignedTurn),
    ...validateContext(after, alignedTurn.expectedContext),
    ...validateCardAndLinkContract(output, strategy, metrics),
    ...validateMobileFormat(output, strategy, metrics, enrichedTurn),
    ...validateKnownFieldQuestions(output, after),
    ...validatePersonalization(output, alignedTurn),
    ...validateSuggestions(calls, before, after, alignedTurn),
  ];
  if (calls.some((call) => call.tool === WEB_TOOL)) {
    issues.push(issue('routing', 'A freshness web search was called without a freshness request.'));
  }

  return {
    ...storedTurn,
    responseMetrics: metrics,
    responseQualityObservations: [
      `${strategy.renderMode || 'unknown'}: ${metrics.bodyWords}/${strategy.maxBodyWords || '?'} body words`,
      `${metrics.cards} card(s), ${metrics.daySections} day section(s), ${metrics.questions} question(s)`,
      `tools: ${calls.map((call) => call.tool).join(' -> ') || '(none)'}`,
      issues.length === 0 ? 'All deterministic quality checks passed.' : `${issues.length} issue(s) found.`,
    ],
    pass: issues.length === 0,
    issues,
  };
}

function summarizeChatReports(
  chatReports,
  {
    generatedAt,
    totalLatencyMs,
    liveRunGeneratedAt = null,
    turnDelayMs = TURN_DELAY_MS,
  },
) {
  const allTurns = chatReports.flatMap((chat) => chat.turns);
  const passedTurns = allTurns.filter((turn) => turn.pass).length;
  const turnLatencies = allTurns
    .map((turn) => Number(turn.latencyMs))
    .filter(Number.isFinite);
  const totalTokenCounts = allTurns
    .filter((turn) => turn.tokenUsage?.totalTokens !== null && turn.tokenUsage?.totalTokens !== undefined)
    .map((turn) => Number(turn.tokenUsage.totalTokens))
    .filter(Number.isFinite);
  const dynamicContextTokenEstimates = allTurns
    .filter(
      (turn) =>
        turn.dynamicContextEstimatedTokens !== null &&
        turn.dynamicContextEstimatedTokens !== undefined,
    )
    .map((turn) => Number(turn.dynamicContextEstimatedTokens))
    .filter(Number.isFinite);
  return {
    summary: {
      generatedAt,
      ...(liveRunGeneratedAt ? { liveRunGeneratedAt } : {}),
      model: tripPlannerAgentConfig.model,
      totalChats: chatReports.length,
      passedChats: chatReports.filter((chat) => chat.pass).length,
      failedChats: chatReports.filter((chat) => !chat.pass).length,
      totalTurns: allTurns.length,
      passedTurns,
      failedTurns: allTurns.length - passedTurns,
      successPercentage: Number(
        ((passedTurns / Math.max(allTurns.length, 1)) * 100).toFixed(1),
      ),
      turnDelayMs,
      totalLatencyMs,
      latencyP50Ms: percentile(turnLatencies, 0.5),
      latencyP95Ms: percentile(turnLatencies, 0.95),
      totalTokensP50: percentile(totalTokenCounts, 0.5),
      totalTokensP95: percentile(totalTokenCounts, 0.95),
      dynamicContextTokensP50: percentile(dynamicContextTokenEstimates, 0.5),
      dynamicContextTokensP95: percentile(dynamicContextTokenEstimates, 0.95),
      issueCounts: allTurns
        .flatMap((turn) => turn.issues)
        .reduce((counts, foundIssue) => {
          counts[foundIssue.category] = (counts[foundIssue.category] || 0) + 1;
          return counts;
        }, {}),
    },
    chats: chatReports,
  };
}

function revalidateStoredReport(storedReport) {
  const chatReports = storedReport.chats.map((storedChat) => {
    const chat = chats.find((candidate) => candidate.id === storedChat.id);
    if (!chat) {
      return storedChat;
    }
    let previousSuggestions = [];
    const turns = storedChat.turns.map((storedTurn, index) => {
      const revalidated = revalidateStoredTurn({
        chat,
        turn: chat.turns[index],
        storedTurn,
        previousSuggestions,
      });
      previousSuggestions = revalidated.suggestedQuestions || [];
      return revalidated;
    });
    return {
      ...storedChat,
      pass: turns.every((turn) => turn.pass),
      passedTurns: turns.filter((turn) => turn.pass).length,
      failedTurns: turns.filter((turn) => !turn.pass).length,
      turns,
    };
  });

  return summarizeChatReports(chatReports, {
    generatedAt: new Date().toISOString(),
    liveRunGeneratedAt:
      storedReport.summary.liveRunGeneratedAt || storedReport.summary.generatedAt,
    totalLatencyMs: storedReport.summary.totalLatencyMs,
    turnDelayMs:
      process.env.TRIP_PLANNER_MOBILE_TURN_DELAY_MS !== undefined
        ? TURN_DELAY_MS
        : storedReport.summary.turnDelayMs,
  });
}

function markdownJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildMarkdownReport(report) {
  const lines = [
    '# Trip Planner Mobile Multi-Turn Report',
    '',
    `- Generated: ${report.summary.generatedAt}`,
    `- Model: ${report.summary.model}`,
    `- Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed`,
    `- Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`,
    `- Success: ${report.summary.successPercentage}%`,
    `- Total latency: ${report.summary.totalLatencyMs} ms`,
    `- Turn latency P50/P95: ${report.summary.latencyP50Ms ?? 'unavailable'} / ${report.summary.latencyP95Ms ?? 'unavailable'} ms`,
    `- Total tokens P50/P95: ${report.summary.totalTokensP50 ?? 'unavailable'} / ${report.summary.totalTokensP95 ?? 'unavailable'}`,
    `- Dynamic context estimate P50/P95: ${report.summary.dynamicContextTokensP50 ?? 'unavailable'} / ${report.summary.dynamicContextTokensP95 ?? 'unavailable'} tokens`,
    '',
    '## Before / After',
    '',
    '### Full itinerary',
    '',
    '**Before:** The live baseline repeated the destination card as a text profile, added a four-season section, then used multi-sentence Morning/Afternoon/Evening blocks.',
    '',
    '**After:** The first full-context turn below keeps one card, one fit line, compact time-block lines, and one budget table.',
    '',
    '### Preference update',
    '',
    '**Before:** Preference changes had no explicit card, word, or unchanged-section suppression policy.',
    '',
    '**After:** The Bali food and budget follow-ups below use compact_patch and return only affected plan guidance.',
    '',
  ];

  for (const chat of report.chats) {
    lines.push(`## ${chat.pass ? 'PASS' : 'FAIL'} - ${chat.title}`, '');
    for (const turn of chat.turns) {
      lines.push(`### Turn ${turn.turn}: ${turn.userMessage}`, '');
      lines.push(`**Result:** ${turn.pass ? 'PASS' : 'FAIL'}`);
      lines.push(`**Expected behavior:** ${turn.expectedAgentBehavior}`);
      lines.push(`**Expected tools:** ${turn.expectedToolCalls.join(' -> ')}`);
      lines.push(`**Actual tools:** ${turn.actualToolCalls.join(' -> ') || '(none)'}`);
      lines.push(`**Observations:** ${turn.responseQualityObservations.join(' | ')}`, '');
      lines.push('**Summary context before**', markdownJson(turn.summaryContextBefore), '');
      lines.push('**Expected payload**', markdownJson(turn.expectedPayload), '');
      lines.push('**Actual payload**', markdownJson(turn.actualPayload), '');
      lines.push('**Updated context**', markdownJson(turn.updatedContext), '');
      lines.push('**Suggested questions**', markdownJson(turn.suggestedQuestions), '');
      lines.push('**Trip Planner response**', '```text', turn.agentResponse, '```', '');
      if (turn.issues.length > 0) {
        lines.push('**Issues**', '');
        for (const foundIssue of turn.issues) {
          lines.push(`- **${foundIssue.category}:** ${foundIssue.message}`);
          lines.push(`  Root cause: ${foundIssue.rootCause}`);
          lines.push(`  Suggested fix: ${foundIssue.suggestedFix}`);
        }
        lines.push('');
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

let report;
if (process.argv.includes('--revalidate')) {
  const storedReport = JSON.parse(await fs.readFile(REPORT_JSON, 'utf8'));
  report = revalidateStoredReport(storedReport);
} else {
  const suiteStartedAt = Date.now();
  const chatReports = [];
  const selectedChats = (CHAT_IDS.length > 0
    ? chats.filter((chat) => CHAT_IDS.includes(chat.id))
    : chats
  ).slice(0, CHAT_LIMIT);
  for (const chat of selectedChats) {
    chatReports.push(await runChat(chat));
  }
  report = summarizeChatReports(chatReports, {
    generatedAt: new Date().toISOString(),
    totalLatencyMs: Date.now() - suiteStartedAt,
  });
}

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(REPORT_MARKDOWN, buildMarkdownReport(report));

console.log('\n# Trip Planner Mobile Multi-Turn Summary');
console.log(`Model: ${report.summary.model}`);
console.log(`Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed`);
console.log(`Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`);
console.log(`JSON report: ${REPORT_JSON}`);
console.log(`Markdown report: ${REPORT_MARKDOWN}`);

if (report.summary.failedTurns > 0) {
  process.exitCode = 1;
}
