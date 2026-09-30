process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_PRICE_DATE_MODEL ||
  process.env.OPENAI_FLIGHT_MODEL ||
  'gpt-5.5';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '10';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { getPricePredictionDateLimits } = await import(
  '../../src/agents/flight/tools/price-prediction/tool.js'
);

const PRICE_TOOL = 'price_prediction_tool';
const SEARCH_TOOL = 'flight_search';
const SUGGESTIONS_TOOL = 'update_flight_suggested_questions';
const DAY_MS = 24 * 60 * 60 * 1000;
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.FLIGHT_PRICE_DATE_TURN_DELAY_MS || '20000', 10) || 0,
);
const CASE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.FLIGHT_PRICE_DATE_CASE_LIMIT || '12', 10) || 12,
);
const RESULTS_DIR = path.resolve('tests/results');
const JSON_REPORT = path.join(
  RESULTS_DIR,
  'flight-agent-price-prediction-date-intelligence-latest.json',
);
const MARKDOWN_REPORT = path.join(
  RESULTS_DIR,
  'flight-agent-price-prediction-date-intelligence-latest.md',
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startOfUtcDay(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value, days) {
  return new Date(value.getTime() + days * DAY_MS);
}

function addMonths(value, months) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, value.getUTCDate()),
  );
}

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

function displayDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

function monthName(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    timeZone: 'UTC',
  }).format(value);
}

function monthRange(value) {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function nextWeekday(value, weekday) {
  const offset = ((weekday - value.getUTCDay() + 7) % 7) || 7;
  return addDays(value, offset);
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRange(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return left?.startDate === right?.startDate && left?.endDate === right?.endDate;
}

function dateInRange(value, range) {
  return Boolean(value && range && value >= range.startDate && value <= range.endDate);
}

function matchesAirport(value, expectedCode) {
  const normalized = String(value || '').trim().toUpperCase();
  const aliases = {
    DEL: ['DEL', 'DELHI'],
    BOM: ['BOM', 'MUMBAI'],
  };
  return (aliases[expectedCode] || [expectedCode]).some((candidate) =>
    normalized.includes(candidate),
  );
}

const issueMetadata = {
  routing: {
    rootCause: 'The model selected a tool path that does not match the date-intent routing rules.',
    suggestedFix: 'Tighten exact-date versus flexible-date precedence and add the failing phrase as a prompt example.',
  },
  date_interpretation: {
    rootCause: 'The deterministic date-intent parser did not resolve the user phrase to the expected preference range.',
    suggestedFix: 'Extend pricePredictionDateIntent parsing and add a deterministic unit regression for this phrase.',
  },
  prediction_window: {
    rootCause: 'The prediction call did not use the fixed today-through-today-plus-89-days input window.',
    suggestedFix: 'Keep fixed-window normalization at the runner/tool boundary and ignore narrower model-supplied ranges.',
  },
  prediction_result: {
    rootCause: 'The prediction status or ranked dates did not reflect the requested route/date preference.',
    suggestedFix: 'Review preference intersection and dummy repository output before changing response instructions.',
  },
  grounding: {
    rootCause: 'The final response stated a fare that was not present in the current prediction output.',
    suggestedFix: 'Restrict response fare values to returned prediction records and add a response-grounding guard.',
  },
  fallback: {
    rootCause: 'The unavailable/out-of-window response did not follow the safe non-predicted fallback contract.',
    suggestedFix: 'Require the returned status wording, retain the fallback date in Flight context, and forbid exact fares in fallback responses.',
  },
  response: {
    rootCause: 'The final answer was empty, exposed internals, or omitted the expected conversational next step.',
    suggestedFix: 'Tighten the mobile response pattern for the failing date-intelligence state.',
  },
  state: {
    rootCause: 'Conversation or search context was not carried into the next turn correctly.',
    suggestedFix: 'Fix runner context/session synchronization and add a regression for the failing multi-turn flow.',
  },
  runtime: {
    rootCause: 'The Agents SDK/model run failed before the expected workflow completed.',
    suggestedFix: 'Check model access, rate limits, credentials, and max-turn handling, then rerun the case.',
  },
};

function issue(category, message, turnNumber) {
  return {
    category,
    message,
    rootCause: issueMetadata[category].rootCause,
    suggestedFix: issueMetadata[category].suggestedFix,
    ...(turnNumber ? { turn: turnNumber } : {}),
  };
}

function summarizePrediction(result) {
  if (!result) {
    return null;
  }
  return {
    ok: result.ok ?? null,
    status: result.status || null,
    source: result.source || null,
    route: result.route || null,
    tripType: result.tripType || null,
    searchedDateRange: result.searchedDateRange || null,
    predictionWindow: result.predictionWindow || null,
    predictionCount: result.predictionCount || 0,
    cheapestDates: result.cheapestDates || [],
    cheapestCombinations: result.cheapestCombinations || [],
    priceRangeSummary: result.priceRangeSummary || null,
    recommendation: result.recommendation || null,
    formattedResponse: result.formattedResponse || null,
  };
}

function summarizeCall(call) {
  return {
    tool: call.tool,
    input: call.input || null,
    status: call.status || null,
    searchKey: call.searchKey || null,
    suggestions: call.suggestedQuestions || null,
  };
}

function snapshotContext(context) {
  return {
    searchKey: context.searchKey || context.flight?.searchKey || null,
    flight: {
      searchKey: context.flight?.searchKey || null,
      summary: context.flight?.summary || null,
      suggestedQuestions: context.flight?.suggestedQuestions || [],
      pricePredictionDateIntent: context.flight?.pricePredictionDateIntent || null,
    },
    lastSearch: context.lastSearch || null,
  };
}

function priceValues(result) {
  const values = new Set();
  for (const collection of [
    result?.predictions,
    result?.cheapestDates,
    result?.cheapestCombinations,
  ]) {
    for (const entry of Array.isArray(collection) ? collection : []) {
      if (Number.isFinite(Number(entry?.predictedPrice))) {
        values.add(Number(entry.predictedPrice));
      }
    }
  }
  return values;
}

function responsePriceValues(response) {
  const values = [];
  const pattern = /(?:USD|INR|\$|₹)\s*([\d,]+(?:\.\d+)?)/gi;
  for (const match of String(response || '').matchAll(pattern)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) {
      values.push(value);
    }
  }
  return values;
}

const today = startOfUtcDay();
const limits = getPricePredictionDateLimits(today);
const predictionWindow = {
  startDate: limits.todayString,
  endDate: limits.maxDateString,
};
const nextSaturday = nextWeekday(today, 6);
const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
const nextMonthDates = monthRange(nextMonth);
const currentMonthDates = monthRange(today);
const currentMonthEnd = new Date(`${currentMonthDates.endDate}T00:00:00.000Z`);
const endOfMonthPreference = {
  startDate: isoDate(addDays(currentMonthEnd, -6)),
  endDate: currentMonthDates.endDate,
};
const sixMonthsLater = addMonths(today, 6);
const sixMonthsLaterRange = monthRange(sixMonthsLater);
const exactSearchDate = new Date(
  Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 15),
);
const rangeStart = new Date(
  Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 10),
);
const rangeEnd = new Date(
  Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 25),
);

const cases = [
  {
    id: 'exact-date-next-saturday',
    expectedBehavior: 'Use normal flight search for one exact relative day and do not predict prices.',
    notes: 'Exact-date precedence case.',
    turns: [
      {
        input: 'Find flights from DEL to BOM next Saturday',
        expectedTools: [SEARCH_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        expectedIntentKind: 'exact',
        expectedSearch: {
          origin: 'DEL',
          destination: 'BOM',
          outboundDate: isoDate(nextSaturday),
        },
        expectedResponse: /found|options|flight/i,
        requirePriceNote: true,
      },
    ],
  },
  {
    id: 'flexible-cheapest-date',
    expectedBehavior: 'Use prediction for a flexible cheapest-date request with a complete route.',
    notes: 'Supported DEL-BOM dummy route.',
    turns: [
      {
        input: "I'm flexible for DEL to BOM, suggest the cheapest date",
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: null,
        expectedRoute: ['DEL', 'BOM'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /cheapest|best|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'month-only-august',
    expectedBehavior: 'Load the full prediction window, then rank only dates in the named month.',
    notes: `Named month resolves to ${nextMonthDates.startDate} through ${nextMonthDates.endDate}.`,
    turns: [
      {
        input: `Find cheapest flights from JFK to LAX in ${monthName(nextMonth)}`,
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: nextMonthDates,
        expectedResultRange: nextMonthDates,
        expectedRoute: ['JFK', 'LAX'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /cheapest|best|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'relative-next-month',
    expectedBehavior: 'Use prediction for a relative-month best-date request.',
    notes: 'Supported NYC-LHR dummy route.',
    turns: [
      {
        input: 'I want to travel next month from NYC to LHR, what date is best?',
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: nextMonthDates,
        expectedResultRange: nextMonthDates,
        expectedRoute: ['NYC', 'LHR'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /best|cheapest|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'explicit-date-range',
    expectedBehavior: 'Use the fixed prediction window and rank only dates inside the explicit range.',
    notes: `Requested range is ${isoDate(rangeStart)} through ${isoDate(rangeEnd)}.`,
    turns: [
      {
        input: `Find best fare dates between ${displayDate(rangeStart)} and ${displayDate(rangeEnd)} from DEL to BOM`,
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: {
          startDate: isoDate(rangeStart),
          endDate: isoDate(rangeEnd),
        },
        expectedResultRange: {
          startDate: isoDate(rangeStart),
          endDate: isoDate(rangeEnd),
        },
        expectedRoute: ['DEL', 'BOM'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /best|cheapest|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'end-of-current-month',
    expectedBehavior: 'Interpret end-of-month as the final seven days and predict within that preference.',
    notes: `Expected end-of-month preference is ${endOfMonthPreference.startDate} through ${endOfMonthPreference.endDate}.`,
    turns: [
      {
        input: "What's the best date near the end of this month for JFK to LAX?",
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: endOfMonthPreference,
        expectedResultRange: endOfMonthPreference,
        expectedRoute: ['JFK', 'LAX'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /best|cheapest|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'missing-origin',
    expectedBehavior: 'Ask only for origin and do not call prediction or search.',
    notes: 'A destination alone must not trigger prediction.',
    turns: [
      {
        input: 'What is the cheapest date to fly to Delhi?',
        expectedTools: [SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        expectedIntentKind: 'flexible',
        forbidSearch: true,
        expectedResponse: /from|origin|departure/i,
      },
    ],
  },
  {
    id: 'missing-destination',
    expectedBehavior: 'Ask only for destination and do not call prediction or search.',
    notes: 'An origin alone must not trigger prediction.',
    turns: [
      {
        input: 'What is the cheapest date from Mumbai?',
        expectedTools: [SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        expectedIntentKind: 'flexible',
        forbidSearch: true,
        expectedResponse: /destination|where.*(?:to|going)|fly to/i,
      },
    ],
  },
  {
    id: 'unsupported-route',
    expectedBehavior: 'Call prediction for the supplied route, then return a non-predicted fallback.',
    notes: 'ABC-XYZ is intentionally absent from dummy data.',
    turns: [
      {
        input: 'Suggest cheapest dates from ABC to XYZ',
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: null,
        expectedRoute: ['ABC', 'XYZ'],
        expectedStatus: 'NO_PREDICTIONS',
        expectedResponse: /unavailable|prediction|midweek|general|search/i,
        requireSearchOffer: true,
        requireSafeFallback: true,
      },
    ],
  },
  {
    id: 'outside-89-day-window',
    expectedBehavior: 'Recognize the six-month preference as outside the window and avoid predicted fares.',
    notes: `Six months later resolves to ${sixMonthsLaterRange.startDate} through ${sixMonthsLaterRange.endDate}.`,
    turns: [
      {
        input: 'Find cheapest date 6 months later from DEL to BOM',
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: sixMonthsLaterRange,
        expectedRangeOutsideWindow: true,
        expectedRoute: ['DEL', 'BOM'],
        expectedStatus: 'DATE_RANGE_EXCEEDED',
        expectedResponse: /89|90|window|outside|through|search/i,
        requireSearchOffer: true,
        requireSafeFallback: true,
      },
    ],
  },
  {
    id: 'multi-turn-route-then-flexible',
    expectedBehavior: 'Collect the missing route endpoint first, then predict only after flexible timing is stated.',
    notes: 'Validates MemorySession carry-forward without a searchKey.',
    turns: [
      {
        input: 'I want to fly to London',
        expectedTools: [SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        forbidSearch: true,
        expectedResponse: /from|origin|departure/i,
      },
      {
        input: 'From NYC',
        expectedTools: [SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        forbidSearch: true,
        expectedResponse: /date|when|travel/i,
      },
      {
        input: "I'm flexible next month",
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: nextMonthDates,
        expectedResultRange: nextMonthDates,
        expectedRoute: ['NYC', 'LHR'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /best|cheapest|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
  {
    id: 'search-then-nearby-cheaper-dates',
    expectedBehavior: 'Search the exact date first, then use its route context for nearby cheaper-date prediction.',
    notes: 'Validates search context to prediction context carry-forward.',
    turns: [
      {
        input: `Search DEL to BOM on ${displayDate(exactSearchDate)}`,
        expectedTools: [SEARCH_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: false,
        expectedIntentKind: 'exact',
        expectedSearch: {
          origin: 'DEL',
          destination: 'BOM',
          outboundDate: isoDate(exactSearchDate),
        },
        expectedResponse: /found|options|flight/i,
        requirePriceNote: true,
      },
      {
        input: 'Any cheaper nearby dates?',
        expectedTools: [PRICE_TOOL, SUGGESTIONS_TOOL],
        shouldCallPrediction: true,
        expectedIntentKind: 'flexible',
        expectedRequestedRange: null,
        expectedRoute: ['DEL', 'BOM'],
        expectedStatus: 'SUCCESS',
        expectedResponse: /cheapest|best|great deal|fair price|search/i,
        requireSearchOffer: true,
      },
    ],
  },
];

function validateResponse({ response, result, predictionResult, turn, turnNumber }) {
  const issues = [];
  if (result.error) {
    issues.push(issue('runtime', `Runner returned an error response: ${compact(response)}`, turnNumber));
    return issues;
  }
  if (!compact(response)) {
    issues.push(issue('response', 'Agent returned an empty response.', turnNumber));
  }
  if (
    /\b(price_prediction_tool|flight_search|update_flight_suggested_questions|searchKey|tool call|JSON payload)\b/i.test(
      response,
    )
  ) {
    issues.push(issue('response', 'Agent exposed internal tool or context terminology.', turnNumber));
  }
  if (response.length > 1200) {
    issues.push(issue('response', `Response is too long for mobile (${response.length} characters).`, turnNumber));
  }
  if (turn.expectedResponse && !turn.expectedResponse.test(response)) {
    issues.push(issue('response', 'Response did not contain the expected helpful guidance.', turnNumber));
  }
  if (turn.requireSearchOffer && !/search/i.test(response)) {
    issues.push(issue('response', 'Response did not offer the expected flight-search next step.', turnNumber));
  }

  const priceNoteCount = (response.match(/Note: Prices shown are per person\./g) || []).length;
  if (turn.requirePriceNote && priceNoteCount !== 1) {
    issues.push(issue('response', `Expected one per-person price note, got ${priceNoteCount}.`, turnNumber));
  }
  if (!turn.requirePriceNote && priceNoteCount > 0) {
    issues.push(issue('response', 'A non-search response included the per-person price note.', turnNumber));
  }

  const responsePrices = responsePriceValues(response);
  if (turn.requireSafeFallback && responsePrices.length > 0) {
    issues.push(issue('fallback', `Fallback response contained exact fare values ${JSON.stringify(responsePrices)}.`, turnNumber));
  } else if (predictionResult?.status === 'SUCCESS') {
    const allowed = priceValues(predictionResult);
    const invented = responsePrices.filter((price) => !allowed.has(price));
    if (invented.length > 0) {
      issues.push(issue('grounding', `Response fares were absent from prediction data: ${JSON.stringify(invented)}.`, turnNumber));
    }
  } else if (!predictionResult && responsePrices.length > 0) {
    issues.push(issue('grounding', `Response stated fares without prediction output: ${JSON.stringify(responsePrices)}.`, turnNumber));
  }
  return issues;
}

function validateTurn({
  turn,
  turnNumber,
  calls,
  result,
  context,
  expectedPredictionWindow,
}) {
  const issues = [];
  const actualTools = calls.map((call) => call.tool);
  const predictionCall = calls.find((call) => call.tool === PRICE_TOOL) || null;
  const searchCall = calls.find((call) => call.tool === SEARCH_TOOL) || null;
  const predictionResult = predictionCall ? context.flight?.lastPricePrediction || null : null;
  const dateIntent = context.flight?.pricePredictionDateIntent || null;
  const response = result.output || '';

  if (!sameArray(actualTools, turn.expectedTools)) {
    issues.push(
      issue(
        'routing',
        `Expected ${turn.expectedTools.join(' -> ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
        turnNumber,
      ),
    );
  }
  if (Boolean(predictionCall) !== turn.shouldCallPrediction) {
    issues.push(
      issue(
        'routing',
        turn.shouldCallPrediction
          ? 'price_prediction_tool was not called.'
          : 'price_prediction_tool was called when it should not have been.',
        turnNumber,
      ),
    );
  }
  if (calls.at(-1)?.tool !== SUGGESTIONS_TOOL) {
    issues.push(issue('routing', 'Suggested-question update was not the final tool call.', turnNumber));
  }
  if (turn.forbidSearch && searchCall) {
    issues.push(issue('routing', 'flight_search ran before mandatory route/date context was ready.', turnNumber));
  }

  if (turn.expectedIntentKind && dateIntent?.kind !== turn.expectedIntentKind) {
    issues.push(
      issue(
        'date_interpretation',
        `Expected date intent ${turn.expectedIntentKind}, got ${dateIntent?.kind || 'none'}.`,
        turnNumber,
      ),
    );
  }
  if (Object.hasOwn(turn, 'expectedRequestedRange')) {
    if (!sameRange(dateIntent?.requestedRange ?? null, turn.expectedRequestedRange)) {
      issues.push(
        issue(
          'date_interpretation',
          `Expected requested range ${JSON.stringify(turn.expectedRequestedRange)}, got ${JSON.stringify(dateIntent?.requestedRange || null)}.`,
          turnNumber,
        ),
      );
    }
  }
  if (
    Object.hasOwn(turn, 'expectedRangeOutsideWindow') &&
    dateIntent?.rangeOutsidePredictionWindow !== turn.expectedRangeOutsideWindow
  ) {
    issues.push(
      issue(
        'date_interpretation',
        `Expected rangeOutsidePredictionWindow=${turn.expectedRangeOutsideWindow}, got ${dateIntent?.rangeOutsidePredictionWindow}.`,
        turnNumber,
      ),
    );
  }

  if (predictionCall) {
    if (
      predictionCall.input?.startDate !== expectedPredictionWindow.startDate ||
      predictionCall.input?.endDate !== expectedPredictionWindow.endDate
    ) {
      issues.push(
        issue(
          'prediction_window',
          `Expected ${expectedPredictionWindow.startDate}..${expectedPredictionWindow.endDate}, got ${predictionCall.input?.startDate || 'none'}..${predictionCall.input?.endDate || 'none'}.`,
          turnNumber,
        ),
      );
    }
    if (turn.expectedRoute) {
      const actualRoute = [
        predictionCall.input?.originCity?.toUpperCase(),
        predictionCall.input?.destinationCity?.toUpperCase(),
      ];
      if (!sameArray(actualRoute, turn.expectedRoute)) {
        issues.push(
          issue(
            'state',
            `Expected prediction route ${turn.expectedRoute.join('-')}, got ${actualRoute.join('-')}.`,
            turnNumber,
          ),
        );
      }
    }
    if (turn.expectedStatus && predictionResult?.status !== turn.expectedStatus) {
      issues.push(
        issue(
          'prediction_result',
          `Expected status ${turn.expectedStatus}, got ${predictionResult?.status || 'none'}.`,
          turnNumber,
        ),
      );
    }
    if (
      turn.requireSafeFallback &&
      !context.flight?.dateIntent?.priceFallbackDate &&
      !context.flight?.pricePredictionDateIntent?.fallbackDate
    ) {
      issues.push(issue('fallback', 'No internal non-predicted fallback date was retained.', turnNumber));
    }
    if (turn.expectedResultRange && predictionResult?.status === 'SUCCESS') {
      const rankedDates = [
        ...(predictionResult.cheapestDates || []).map((entry) => entry.departureDate),
        ...(predictionResult.cheapestCombinations || []).map((entry) => entry.outboundDate),
      ];
      if (rankedDates.length === 0) {
        issues.push(issue('prediction_result', 'No ranked prediction dates were returned.', turnNumber));
      } else if (rankedDates.some((date) => !dateInRange(date, turn.expectedResultRange))) {
        issues.push(
          issue(
            'prediction_result',
            `Ranked dates fell outside ${JSON.stringify(turn.expectedResultRange)}: ${JSON.stringify(rankedDates)}.`,
            turnNumber,
          ),
        );
      }
    }
  }

  if (turn.expectedSearch) {
    const ond = searchCall?.input?.onds?.[0] || {};
    if (!matchesAirport(ond.origin, turn.expectedSearch.origin)) {
      issues.push(issue('state', `Search origin was ${ond.origin || 'missing'}, expected ${turn.expectedSearch.origin}.`, turnNumber));
    }
    if (!matchesAirport(ond.destination, turn.expectedSearch.destination)) {
      issues.push(issue('state', `Search destination was ${ond.destination || 'missing'}, expected ${turn.expectedSearch.destination}.`, turnNumber));
    }
    if (ond.outbound_date !== turn.expectedSearch.outboundDate) {
      issues.push(
        issue(
          'date_interpretation',
          `Search date was ${ond.outbound_date || 'missing'}, expected ${turn.expectedSearch.outboundDate}.`,
          turnNumber,
        ),
      );
    }
  }

  const activeSearchKey = context.flight?.searchKey || context.searchKey || null;
  const suggestions = context.flight?.suggestedQuestions;
  if (activeSearchKey) {
    if (!Array.isArray(suggestions) || suggestions.length !== 3) {
      issues.push(issue('state', 'Expected exactly 3 suggestions with an active searchKey.', turnNumber));
    }
  } else if (!Array.isArray(suggestions) || suggestions.length !== 0) {
    issues.push(issue('state', 'Suggestions were not cleared while searchKey was missing.', turnNumber));
  }

  issues.push(...validateResponse({ response, result, predictionResult, turn, turnNumber }));

  return {
    userInput: turn.input,
    expectedToolCalls: turn.expectedTools,
    actualToolCalls: actualTools,
    actualCalls: calls.map(summarizeCall),
    pricePredictionInput: predictionCall?.input || null,
    pricePredictionOutput: summarizePrediction(predictionResult),
    expectedPredictionWindow,
    dateIntent,
    agentResponse: response,
    searchKey: activeSearchKey,
    suggestedQuestions: suggestions || [],
    didCallPricePrediction: Boolean(predictionCall),
    shouldHaveCalledPricePrediction: turn.shouldCallPrediction,
    pass: issues.length === 0,
    issues,
    latencyMs: result.latencyMs,
  };
}

async function runCase(scenario, caseNumber) {
  const sessionId = `price-date-${scenario.id}-${Date.now()}`;
  const context = {
    UID: sessionId,
    uid: sessionId,
    flight: deepClone(scenario.initialFlight || {}),
    toolCallLog: [],
  };
  const existingContext = snapshotContext(context);
  const turnReports = [];

  try {
    for (const [index, turn] of scenario.turns.entries()) {
      if (TURN_DELAY_MS > 0) {
        await sleep(TURN_DELAY_MS);
      }
      console.log(
        `[price-date-eval] case ${caseNumber}/${Math.min(CASE_LIMIT, cases.length)} ${scenario.id} turn ${index + 1}/${scenario.turns.length}`,
      );
      const turnLimits = getPricePredictionDateLimits();
      const expectedPredictionWindow = {
        startDate: turnLimits.todayString,
        endDate: turnLimits.maxDateString,
      };
      const beforeCalls = context.toolCallLog.length;
      let result;
      try {
        result = await runFlightAgent({
          input: turn.input,
          sessionId,
          requestId: `${sessionId}-turn-${index + 1}`,
          context,
        });
      } catch (error) {
        result = {
          output: '',
          latencyMs: 0,
          context,
          error: true,
          thrownError: error instanceof Error ? error.message : String(error),
        };
      }
      const calls = context.toolCallLog.slice(beforeCalls);
      const turnReport = validateTurn({
        turn,
        turnNumber: index + 1,
        calls,
        result,
        context,
        expectedPredictionWindow,
      });
      if (result.thrownError) {
        turnReport.issues.push(
          issue('runtime', `Runner threw: ${result.thrownError}`, index + 1),
        );
        turnReport.pass = false;
      }
      turnReports.push(turnReport);
      console.log(
        `[price-date-eval] ${scenario.id} turn ${index + 1}: ${turnReport.pass ? 'PASS' : 'FAIL'}`,
      );
    }
  } finally {
    await clearFlightAgentSession(sessionId);
  }

  const allCalls = turnReports.flatMap((turn) => turn.actualToolCalls);
  const predictionTurns = turnReports.filter((turn) => turn.didCallPricePrediction);
  const lastPredictionTurn = predictionTurns.at(-1) || null;
  const issues = turnReports.flatMap((turn) => turn.issues);
  return {
    testCaseId: scenario.id,
    userInput:
      scenario.turns.length === 1
        ? scenario.turns[0].input
        : scenario.turns.map((turn) => turn.input),
    existingContext,
    expectedBehavior: scenario.expectedBehavior,
    expectedToolCall: scenario.turns
      .map((turn, index) => `turn ${index + 1}: ${turn.expectedTools.join(' -> ')}`)
      .join(' | '),
    actualToolCalls: allCalls,
    pricePredictionInput: lastPredictionTurn?.pricePredictionInput || null,
    pricePredictionOutput: lastPredictionTurn?.pricePredictionOutput || null,
    agentFinalResponse: turnReports.at(-1)?.agentResponse || '',
    didCallPricePrediction: predictionTurns.length > 0,
    shouldHaveCalledPricePrediction: scenario.turns.some(
      (turn) => turn.shouldCallPrediction,
    ),
    pass: issues.length === 0,
    issues,
    notes: scenario.notes,
    turns: turnReports,
  };
}

function buildReport(results, startedAt, complete) {
  const passed = results.filter((result) => result.pass).length;
  return {
    summary: {
      generatedAt: new Date().toISOString(),
      model: flightAgentConfig.model,
      predictionWindow,
      turnDelayMs: TURN_DELAY_MS,
      complete,
      totalPlannedCases: Math.min(CASE_LIMIT, cases.length),
      completedCases: results.length,
      passedCases: passed,
      failedCases: results.length - passed,
      successPercentage: Number(((passed / Math.max(results.length, 1)) * 100).toFixed(1)),
      durationMs: Date.now() - startedAt,
      issueCounts: results
        .flatMap((result) => result.issues)
        .reduce((counts, foundIssue) => {
          counts[foundIssue.category] = (counts[foundIssue.category] || 0) + 1;
          return counts;
        }, {}),
    },
    testCases: results,
  };
}

function buildMarkdownReport(report) {
  const lines = [
    '# Flight Agent Price Prediction Date Intelligence',
    '',
    `- Generated: ${report.summary.generatedAt}`,
    `- Model: ${report.summary.model}`,
    `- Prediction window: ${report.summary.predictionWindow.startDate} through ${report.summary.predictionWindow.endDate}`,
    `- Completed: ${report.summary.completedCases}/${report.summary.totalPlannedCases}`,
    `- Passed: ${report.summary.passedCases}`,
    `- Failed: ${report.summary.failedCases}`,
    `- Success: ${report.summary.successPercentage}%`,
    `- Complete: ${report.summary.complete ? 'yes' : 'no'}`,
    '',
  ];

  for (const result of report.testCases) {
    lines.push(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.testCaseId}`);
    lines.push('');
    lines.push(`- Expected: ${result.expectedBehavior}`);
    lines.push(`- Tools: ${result.actualToolCalls.join(' -> ') || '(none)'}`);
    lines.push(
      `- Prediction: expected=${result.shouldHaveCalledPricePrediction}, actual=${result.didCallPricePrediction}, status=${result.pricePredictionOutput?.status || 'none'}`,
    );
    lines.push(`- Final response: ${compact(result.agentFinalResponse)}`);
    for (const foundIssue of result.issues) {
      lines.push(`- Issue [${foundIssue.category}]: ${foundIssue.message}`);
      lines.push(`- Root cause: ${foundIssue.rootCause}`);
      lines.push(`- Suggested fix: ${foundIssue.suggestedFix}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function writeReports(results, startedAt, complete) {
  const report = buildReport(results, startedAt, complete);
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.writeFile(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(MARKDOWN_REPORT, buildMarkdownReport(report));
  return report;
}

const startedAt = Date.now();
const results = [];
const selectedCases = cases.slice(0, CASE_LIMIT);
await writeReports(results, startedAt, false);

for (const [index, scenario] of selectedCases.entries()) {
  const result = await runCase(scenario, index + 1);
  results.push(result);
  await writeReports(results, startedAt, false);
}

const report = await writeReports(results, startedAt, true);
console.log(buildMarkdownReport(report));
console.log(`JSON report: ${JSON_REPORT}`);
console.log(`Markdown report: ${MARKDOWN_REPORT}`);

if (report.summary.failedCases > 0) {
  process.exitCode = 1;
}
