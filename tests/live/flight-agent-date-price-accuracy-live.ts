// Historical resolver-era benchmark. The active date-routing regression is
// flight-agent-date-routing-live.ts and is used by the package test script.
process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_DATE_ACCURACY_MODEL ||
  process.env.OPENAI_FLIGHT_MODEL ||
  'gpt-5.5';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '10';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { PROD_FLIGHT_CONTEXT_KEYS, createProdFlightContext, getFlightSearchState, prepareFlightAgentTurnContext } = await import('../../src/agents/flight/context/flight-context.js');
const { buildFlightDateDynamicPromptContext } = await import('../../src/agents/flight/date/prompt-context.js');
const { clearFlightAgentSession, getFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { createRequestContext, getRequestClock } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { clickHouseClient } = await import(
  '../../src/agents/flight/tools/price-prediction/tool.js'
);

const FIXED_NOW = new Date('2026-08-04T10:00:00.000Z');
const TIME_ZONE = 'Asia/Kolkata';
const LOCAL_DATE = '2026-08-04';
const PREDICTION_END = '2026-11-01';
const RESULTS_DIR = path.resolve('tests/results');
const JSON_REPORT = path.join(
  RESULTS_DIR,
  'flight-agent-date-price-accuracy-latest.json',
);
const MARKDOWN_REPORT = path.join(
  RESULTS_DIR,
  'flight-agent-date-price-accuracy-latest.md',
);
const CASE_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.FLIGHT_DATE_PRICE_ACCURACY_CASE_LIMIT || '15', 10) || 15,
);
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.FLIGHT_DATE_PRICE_ACCURACY_TURN_DELAY_MS || '1000', 10) || 0,
);
const CASE_IDS = new Set(
  String(process.env.FLIGHT_DATE_PRICE_ACCURACY_CASE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

const TOOLS = Object.freeze({
  resolve: 'resolve_flight_date',
  prediction: 'price_prediction_tool',
  search: 'flight_search',
  suggestions: 'update_flight_suggested_questions',
});

const VALIDATED_FIXES = Object.freeze([
  {
    issue: '"after 2 weeks" asked for an exact date',
    rootCause: 'The resolver ignored a structured day offset when kind was exact.',
    change: 'Exact intents now resolve nonnegative offsets against the immutable turn clock.',
    expectedAfter: 'Search 2026-08-18 without another date question.',
  },
  {
    issue: 'Adding a round-trip duration collapsed the prior month range',
    rootCause: 'Month resolution ignored an already resolved range replayed through the session.',
    change: 'The stateless resolver preserves a valid structured range before applying trip duration.',
    expectedAfter: 'Keep Sep 1-30 and derive a Sep 22 return for a 21-day trip.',
  },
  {
    issue: 'Flexible timing could be lost while route details were missing',
    rootCause: 'Resolver-first behavior was not mandatory on missing-route turns.',
    change: 'Prompts require resolver feedback before collecting route endpoints.',
    expectedAfter: 'Replay flexible timing through session history, then predict after the route arrives.',
  },
  {
    issue: 'Missing-route response used departure-city/destination-city labels',
    rootCause: 'The prompt allowed an inconsistent user-facing paraphrase.',
    change: 'Missing-route copy now requires departure location and arrival location.',
    expectedAfter: 'Use the required labels without renaming internal route fields.',
  },
]);

const INTERNAL_FAILURE_PATTERN =
  /prediction\s+(?:failed|failure|unavailable)|no predictions|unsupported route|no prediction data|NO_PREDICTIONS|internal error|repository|clickhouse/i;
const INTERNAL_TOOL_PATTERN =
  /price_prediction_tool|resolve_flight_date|flight_search(?:_tool)?|searchKey|tool\s+(?:call|payload)|JSON payload/i;
const LEGACY_ROUTE_LABEL_PATTERN =
  /\b(?:origin|destination|departure city|destination city)\b/i;
const MONEY_PATTERN = /(?:USD|INR|EUR|GBP|AED|\$|€|£|₹)\s*\d[\d,]*(?:\.\d+)?/i;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function makePredictionRow() {
  const predictions = {};
  let date = LOCAL_DATE;
  let index = 0;
  while (date <= PREDICTION_END) {
    predictions[date] = { Rank: 1000 + index };
    date = addDays(date, 1);
    index += 1;
  }
  predictions['2026-08-15'] = { Rank: 2 };
  predictions['2026-08-18'] = { Rank: 3 };
  predictions['2026-09-15'] = { Rank: 1 };
  predictions['2026-09-22'] = { Rank: 4 };
  return {
    SearchDate: '2026-08-03',
    TripPredictions: JSON.stringify(predictions),
  };
}

let predictionMode = 'success';
const originalClickHouseQuery = clickHouseClient.query;
clickHouseClient.query = async () => {
  if (predictionMode === 'error') {
    throw new Error('Controlled repository failure');
  }
  if (predictionMode === 'no_predictions' || predictionMode === 'unsupported') {
    return [];
  }
  if (predictionMode === 'empty') {
    return [{ SearchDate: '2026-08-03', TripPredictions: '{}' }];
  }
  return [makePredictionRow()];
};

const scenarios = [
  {
    id: 'normal-next-week-complete-route',
    category: 'normal_vague_search',
    turns: [
      {
        userMessage: 'Need JFK to Delhi sometime next week',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'week',
          rangeStart: '2026-08-10',
          rangeEnd: '2026-08-16',
          searchDate: '2026-08-10',
        },
        expectedSearch: { origin: 'JFK', destination: 'DEL', outboundDate: '2026-08-10' },
        responseDatePattern: /(?:Aug(?:ust)?\s+10|2026-08-10)/i,
      },
    ],
  },
  {
    id: 'date-first-next-weekend',
    category: 'context_carry_forward',
    turns: [
      {
        userMessage: 'flights next weekend',
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.suggestions]],
        expectedDate: {
          kind: 'weekend',
          rangeStart: '2026-08-15',
          rangeEnd: '2026-08-16',
          searchDate: '2026-08-15',
        },
        responsePattern: /(?:departure location|arrival location|flying from|going)/i,
      },
      {
        userMessage: 'from jfk to delhi',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'weekend',
          rangeStart: '2026-08-15',
          rangeEnd: '2026-08-16',
          searchDate: '2026-08-15',
        },
        expectedSearch: { origin: 'JFK', destination: 'DEL', outboundDate: '2026-08-15' },
        responseDatePattern: /(?:Aug(?:ust)?\s+15|2026-08-15)/i,
      },
    ],
  },
  {
    id: 'normal-next-month-complete-route',
    category: 'normal_vague_search',
    turns: [
      {
        userMessage: 'I want to travel next month from DEL to BOM',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
        },
        expectedSearch: { origin: 'DEL', destination: 'BOM', outboundDate: '2026-09-01' },
        responseDatePattern: /(?:Sep(?:tember)?\s+1|2026-09-01)/i,
      },
    ],
  },
  {
    id: 'date-first-this-friday',
    category: 'context_carry_forward',
    turns: [
      {
        userMessage: 'i want to fly this friday',
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.suggestions]],
        expectedDate: {
          kind: 'weekday',
          rangeStart: '2026-08-07',
          rangeEnd: '2026-08-07',
          searchDate: '2026-08-07',
        },
        responsePattern: /(?:departure location|arrival location|flying from|going)/i,
      },
      {
        userMessage: 'agra to dubai',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'weekday',
          rangeStart: '2026-08-07',
          rangeEnd: '2026-08-07',
          searchDate: '2026-08-07',
        },
        expectedSearch: { origin: 'AGRA', destination: 'DUBAI', outboundDate: '2026-08-07' },
        responseDatePattern: /(?:Aug(?:ust)?\s+7|2026-08-07)/i,
      },
    ],
  },
  {
    id: 'normal-around-august',
    category: 'normal_vague_search',
    turns: [
      {
        userMessage: 'Show NYC to LAX flights around August',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-08-04',
          rangeEnd: '2026-08-31',
          searchDate: '2026-08-04',
        },
        expectedSearch: { origin: 'NYC', destination: 'LAX', outboundDate: '2026-08-04' },
        responseDatePattern: /(?:Aug(?:ust)?\s+4|2026-08-04)/i,
      },
    ],
  },
  {
    id: 'normal-end-of-september',
    category: 'normal_vague_search',
    turns: [
      {
        userMessage: 'DEL to BOM near the end of September',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedSearchDateRange: { startDate: '2026-09-20', endDate: '2026-09-30' },
        expectedSearchRoute: { origin: 'DEL', destination: 'BOM' },
        responseDatePattern: /(?:Sep(?:tember)?\s+(?:20|2[1-9]|30)|2026-09-(?:20|2[1-9]|30))/i,
      },
    ],
  },
  {
    id: 'normal-after-two-weeks',
    category: 'normal_vague_search',
    turns: [
      {
        userMessage: 'need del to bom after 2 weeks',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedSearchDateRange: { startDate: '2026-08-18', endDate: '2026-08-24' },
        expectedSearchRoute: { origin: 'DEL', destination: 'BOM' },
        responseDatePattern: /(?:Aug(?:ust)?\s+(?:1[89]|2[0-4])|2026-08-(?:1[89]|2[0-4]))/i,
      },
    ],
  },
  {
    id: 'prediction-success-then-search-selected',
    category: 'price_prediction',
    turns: [
      {
        userMessage: 'cheapest fare jfk to del next month',
        predictionMode: 'success',
        expectedIntent: 'price_prediction',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.prediction, TOOLS.suggestions]],
        expectedPredictionStatus: 'SUCCESS',
        expectedPredictionRoute: ['JFK', 'DEL'],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
        },
        expectedPredictedDate: '2026-09-15',
        responseDatePattern: /(?:Sep(?:tember)?\s+15|2026-09-15)/i,
        forbidMoney: true,
      },
      {
        userMessage: 'search that one',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.search, TOOLS.suggestions]],
        expectedSearch: { origin: 'JFK', destination: 'DEL', outboundDate: '2026-09-15' },
        responseDatePattern: /(?:Sep(?:tember)?\s+15|2026-09-15)/i,
      },
    ],
  },
  {
    id: 'price-best-fare-september',
    category: 'price_prediction',
    turns: [
      {
        userMessage: 'best date to fly nyc to lax in september',
        predictionMode: 'success',
        expectedIntent: 'price_prediction',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.prediction, TOOLS.suggestions]],
        expectedPredictionStatus: 'SUCCESS',
        expectedPredictionRoute: ['NYC', 'LAX'],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
        },
        expectedPredictedDate: '2026-09-15',
        responseDatePattern: /(?:Sep(?:tember)?\s+15|2026-09-15)/i,
        forbidMoney: true,
      },
    ],
  },
  {
    id: 'price-flexible-complete-route',
    category: 'price_prediction',
    turns: [
      {
        userMessage: 'when should i travel for cheap fares del to bom? flexible dates',
        predictionMode: 'success',
        expectedIntent: 'price_prediction',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.prediction, TOOLS.suggestions]],
        expectedPredictionStatus: 'SUCCESS',
        expectedPredictionRoute: ['DEL', 'BOM'],
        expectedDate: {
          kind: 'flexible',
          rangeStart: '2026-08-04',
          rangeEnd: '2026-11-01',
          searchDate: '2026-08-04',
        },
        expectedPredictedDate: '2026-09-15',
        responsePattern: /(?:strongest|promising|date|search)/i,
        forbidMoney: true,
      },
    ],
  },
  {
    id: 'prediction-no-row-usable-date',
    category: 'prediction_failure',
    turns: [
      {
        userMessage: 'find cheapest abc to xyz next weekend',
        predictionMode: 'no_predictions',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.prediction, TOOLS.search, TOOLS.suggestions]],
        expectedPredictionStatus: 'NO_PREDICTIONS',
        expectedPredictionRoute: ['ABC', 'XYZ'],
        expectedDate: {
          kind: 'weekend',
          rangeStart: '2026-08-15',
          rangeEnd: '2026-08-16',
          searchDate: '2026-08-15',
        },
        expectedSearch: { origin: 'ABC', destination: 'XYZ', outboundDate: '2026-08-15' },
        responseDatePattern: /(?:Aug(?:ust)?\s+15|2026-08-15)/i,
        requirePrivateFailure: true,
      },
    ],
  },
  {
    id: 'prediction-error-without-usable-date',
    category: 'prediction_failure',
    turns: [
      {
        userMessage: 'what is the cheapest date from DEL to BOM?',
        predictionMode: 'error',
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [
          [TOOLS.prediction, TOOLS.suggestions],
          [TOOLS.resolve, TOOLS.prediction, TOOLS.suggestions],
        ],
        expectedPredictionStatus: 'ERROR',
        expectedPredictionRoute: ['DEL', 'BOM'],
        responsePattern: /(?:travel date|what date|when)/i,
        requirePrivateFailure: true,
        forbidSearch: true,
      },
    ],
  },
  {
    id: 'route-first-roundtrip-duration',
    category: 'context_carry_forward',
    turns: [
      {
        userMessage: 'jfk to delhi',
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [[TOOLS.suggestions]],
        responsePattern: /(?:date|when)/i,
      },
      {
        userMessage: 'next month',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
        },
        expectedSearch: { origin: 'JFK', destination: 'DEL', outboundDate: '2026-09-01' },
      },
      {
        userMessage: 'make it round trip',
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [[TOOLS.suggestions]],
        responsePattern: /(?:return|duration|how long)/i,
        preserveSearch: { origin: 'JFK', destination: 'DEL', outboundDate: '2026-09-01' },
      },
      {
        userMessage: '21 days',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
          returnDate: '2026-09-22',
        },
        expectedSearch: {
          origin: 'JFK',
          destination: 'DEL',
          outboundDate: '2026-09-01',
          returnDate: '2026-09-22',
          tripType: 'roundtrip',
        },
      },
    ],
  },
  {
    id: 'change-date-cabin-passengers',
    category: 'context_carry_forward',
    turns: [
      {
        userMessage: 'del to bom next week',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedSearch: { origin: 'DEL', destination: 'BOM', outboundDate: '2026-08-10' },
      },
      {
        userMessage: 'actually next month, business for 2 ppl',
        expectedIntent: 'flight_search',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.search, TOOLS.suggestions]],
        expectedDate: {
          kind: 'month',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
          searchDate: '2026-09-01',
        },
        expectedSearch: {
          origin: 'DEL',
          destination: 'BOM',
          outboundDate: '2026-09-01',
          cabinClass: 'business',
          adults: 2,
        },
        responseDatePattern: /(?:Sep(?:tember)?\s+1|2026-09-01)/i,
      },
    ],
  },
  {
    id: 'flexible-date-before-route',
    category: 'context_carry_forward',
    turns: [
      {
        userMessage: "i'm flexible, show cheapest dates",
        expectedIntent: 'ask_missing_info',
        expectedToolSequences: [[TOOLS.resolve, TOOLS.suggestions]],
        expectedDate: {
          kind: 'flexible',
          rangeStart: '2026-08-04',
          rangeEnd: '2026-11-01',
          searchDate: '2026-08-04',
        },
        responsePattern: /departure location.*arrival location/i,
      },
      {
        userMessage: 'nyc to lax',
        predictionMode: 'success',
        expectedIntent: 'price_prediction',
        expectedToolSequences: [[TOOLS.prediction, TOOLS.suggestions]],
        expectedPredictionStatus: 'SUCCESS',
        expectedPredictionRoute: ['NYC', 'LAX'],
        expectedPredictedDate: '2026-09-15',
        responsePattern: /(?:strongest|promising|date|search)/i,
        forbidMoney: true,
      },
    ],
  },
];

function contextSnapshot(context: any = {}) {
  const flight = context.flight || createProdFlightContext(context);
  const search = getFlightSearchState({ flight });
  const searchResults = Array.isArray(flight.searchResults)
    ? flight.searchResults.map((result, index) => ({
        option: result.option || index + 1,
        airline: result.airline || null,
        price: result.price || null,
      }))
    : flight.searchResults;
  const lastPricePrediction = flight.lastPricePrediction
    ? {
        ok: flight.lastPricePrediction.ok,
        status: flight.lastPricePrediction.status,
        source: flight.lastPricePrediction.source,
        route: flight.lastPricePrediction.route,
        tripType: flight.lastPricePrediction.tripType,
        searchedDateRange: flight.lastPricePrediction.searchedDateRange,
        predictionWindow: flight.lastPricePrediction.predictionWindow || null,
        predictionCount: flight.lastPricePrediction.predictionCount || 0,
        cheapestDates: flight.lastPricePrediction.cheapestDates || [],
        cheapestCombinations: flight.lastPricePrediction.cheapestCombinations || [],
        recommendation: flight.lastPricePrediction.recommendation || null,
      }
    : null;

  return {
    flightSchemaKeys: Object.keys(flight).sort(),
    flight: {
      ...clone(flight),
      searchResults,
      lastPricePrediction,
    },
    hasDurableFlightDate: Object.hasOwn(context, 'flightDate'),
    searchState: clone(search),
  };
}

function parseJsonValue(value) {
  const text =
    typeof value === 'string'
      ? value
      : value?.type === 'text'
        ? value.text
        : null;
  if (typeof text !== 'string') {
    return value ?? null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeToolResponse(toolName, output) {
  const parsed = parseJsonValue(output);
  if (!parsed || typeof parsed !== 'object') {
    return parsed;
  }
  if (toolName === TOOLS.prediction) {
    return {
      ok: parsed.ok,
      status: parsed.status,
      source: parsed.source,
      route: parsed.route,
      tripType: parsed.tripType,
      searchedDateRange: parsed.searchedDateRange,
      predictionWindow: parsed.predictionWindow || null,
      predictionCount: parsed.predictionCount || 0,
      cheapestDates: parsed.cheapestDates || [],
      cheapestCombinations: parsed.cheapestCombinations || [],
      recommendation: parsed.recommendation || null,
    };
  }
  if (toolName === TOOLS.search) {
    return {
      ok: parsed.ok,
      status: parsed.status || null,
      searchKey: parsed.searchKey || null,
      UID: parsed.UID || null,
      resultCount: Array.isArray(parsed.flights) ? parsed.flights.length : 0,
    };
  }
  return parsed;
}

function extractSessionToolCalls(items = []) {
  const results = new Map(
    items
      .filter((item) => item.type === 'function_call_result')
      .map((item) => [item.callId, item]),
  );
  return items
    .filter((item) => item.type === 'function_call')
    .map((item) => {
      const resultItem = results.get(item.callId);
      return {
        tool: item.name,
        callId: item.callId,
        input: parseJsonValue(item.arguments),
        status: resultItem?.status || item.status || null,
        output: summarizeToolResponse(item.name, resultItem?.output),
      };
    });
}

function toolPayloadMap(calls) {
  return calls.reduce((payloads, call) => {
    payloads[call.tool] ||= [];
    payloads[call.tool].push(call.input || null);
    return payloads;
  }, {});
}

function toolResponseMap(calls) {
  return calls.reduce((responses, call) => {
    responses[call.tool] ||= [];
    responses[call.tool].push(call.output || null);
    return responses;
  }, {});
}

function previewDynamicDateContext(context, { requestId, sessionId }) {
  const preview = clone(context);
  prepareFlightAgentTurnContext(preview, { requestId, sessionId });
  const clock = createRequestClock({
    now: FIXED_NOW,
    timeZone: TIME_ZONE,
  });
  const requestContext = createRequestContext(preview, clock);
  return {
    rendered: buildFlightDateDynamicPromptContext(clock),
    clock: clone(getRequestClock(requestContext)),
  };
}

function sameSequence(actual, expected) {
  return actual.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}

function matchesAnySequence(actual, expectedSequences) {
  return expectedSequences.some((expected) => sameSequence(actual, expected));
}

function normalizedAirport(value) {
  const text = String(value || '').trim().toUpperCase();
  const aliases = {
    DEL: ['DEL', 'DELHI'],
    BOM: ['BOM', 'MUMBAI'],
    JFK: ['JFK', 'NEW YORK'],
    LAX: ['LAX', 'LOS ANGELES'],
  };
  for (const [code, values] of Object.entries(aliases)) {
    if (values.some((candidate) => text.includes(candidate))) {
      return code;
    }
  }
  return text;
}

function addIssue(issues, category, message, rootCause, suggestedFix) {
  issues.push({ category, message, rootCause, suggestedFix });
}

function validateTurn({ turn, calls, sessionCalls, result, contextBefore, contextAfter }) {
  const issues = [];
  const actualTools = calls.map((call) => call.tool);
  const resolverCall = [...sessionCalls]
    .reverse()
    .find((call) => call.tool === TOOLS.resolve) || null;
  const predictionCall = calls.find((call) => call.tool === TOOLS.prediction) || null;
  const searchCall = calls.find((call) => call.tool === TOOLS.search) || null;
  const output = result.output || '';
  const predictionOutput = contextAfter.flight.lastPricePrediction;
  const searchInput = searchCall?.input || null;

  if (!matchesAnySequence(actualTools, turn.expectedToolSequences)) {
    addIssue(
      issues,
      'routing',
      `Expected ${turn.expectedToolSequences.map((sequence) => sequence.join(' -> ')).join(' OR ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
      'The model selected a tool chain that does not match the current intent precedence rules.',
      'Tighten only the failing intent branch and preserve the existing tool contracts.',
    );
  }

  if (actualTools.at(-1) !== TOOLS.suggestions) {
    addIssue(
      issues,
      'routing',
      'Suggested-question update was not the final tool call.',
      'The model ended the workflow before the required final context update.',
      'Reinforce final-tool ordering in the Flight prompt.',
    );
  }

  if (actualTools.includes('apply_filter')) {
    addIssue(
      issues,
      'routing',
      'apply_filter was called even though this suite contains no filter request.',
      'The model misclassified a date, route, cabin, or passenger update as a result filter.',
      'Correct only the failing intent boundary; keep filter behavior unchanged.',
    );
  }

  if (actualTools.filter((tool) => tool === TOOLS.suggestions).length !== 1) {
    addIssue(
      issues,
      'routing',
      'Suggested-question updater was not called exactly once.',
      'The run repeated or skipped its required final context update.',
      'Keep the updater enabled for one call per request and require it last.',
    );
  }

  if (turn.expectedDate) {
    const expected = turn.expectedDate;
    const resolvedDate = resolverCall?.output || {};
    const actualRange = resolvedDate.range || {};
    const mismatches = [
      resolverCall?.input?.kind !== expected.kind
        ? `kind=${resolverCall?.input?.kind || 'none'}`
        : null,
      actualRange.startDate !== expected.rangeStart
        ? `rangeStart=${actualRange.startDate || 'none'}`
        : null,
      actualRange.endDate !== expected.rangeEnd
        ? `rangeEnd=${actualRange.endDate || 'none'}`
        : null,
      resolvedDate.searchDate !== expected.searchDate
        ? `searchDate=${resolvedDate.searchDate || 'none'}`
        : null,
      Object.hasOwn(expected, 'returnDate') && resolvedDate.returnDate !== expected.returnDate
        ? `returnDate=${resolvedDate.returnDate || 'none'}`
        : null,
    ].filter(Boolean);
    if (mismatches.length > 0) {
      addIssue(
        issues,
        'date_inference',
        `Resolved date mismatch: ${mismatches.join(', ')}.`,
        'The structured date semantics or stateless resolver feedback was incorrect.',
        'Correct the smallest resolver/prompt mapping and add a fixed-clock regression.',
      );
    }
  }

  if (turn.expectedPredictionStatus) {
    if (!predictionCall || predictionOutput?.status !== turn.expectedPredictionStatus) {
      addIssue(
        issues,
        'price_prediction',
        `Expected prediction status ${turn.expectedPredictionStatus}, got ${predictionOutput?.status || 'no prediction call'}.`,
        'The model skipped prediction or the controlled repository outcome was not propagated.',
        'Fix only the affected prediction-routing or result-handling branch.',
      );
    }
    const route = [
      predictionCall?.input?.originCity || null,
      predictionCall?.input?.destinationCity || null,
    ];
    if (
      turn.expectedPredictionRoute &&
      (route[0] !== turn.expectedPredictionRoute[0] || route[1] !== turn.expectedPredictionRoute[1])
    ) {
      addIssue(
        issues,
        'context',
        `Prediction route was ${route.join('-')}, expected ${turn.expectedPredictionRoute.join('-')}.`,
        'Route context was lost or incorrectly overwritten before the prediction call.',
        'Preserve unmodified route fields in dynamic context and payload construction.',
      );
    }
    const expectedPredictionRange = turn.expectedDate
      ? {
          startDate: turn.expectedDate.rangeStart,
          endDate: turn.expectedDate.rangeEnd,
        }
      : { startDate: LOCAL_DATE, endDate: PREDICTION_END };
    if (
      predictionCall &&
      (predictionCall.input?.startDate !== expectedPredictionRange.startDate ||
        predictionCall.input?.endDate !== expectedPredictionRange.endDate)
    ) {
      addIssue(
        issues,
        'price_prediction',
        `Prediction range was ${predictionCall.input?.startDate || 'none'}..${predictionCall.input?.endDate || 'none'}, expected ${expectedPredictionRange.startDate}..${expectedPredictionRange.endDate}.`,
        'The Agent did not transfer the resolver-returned preferred range into prediction.',
        'Populate prediction dates directly from resolver feedback.',
      );
    }
    if (turn.expectedPredictedDate) {
      const predictedOptions = [
        ...(predictionOutput?.cheapestDates || []),
        ...(predictionOutput?.cheapestCombinations || []),
      ];
      const hasExpectedDate = predictedOptions.some(
        (option) =>
          option.departureDate === turn.expectedPredictedDate ||
          option.outboundDate === turn.expectedPredictedDate,
      );
      if (!hasExpectedDate) {
        addIssue(
          issues,
          'price_prediction',
          `Expected predicted date ${turn.expectedPredictedDate} was not returned among the ranked options.`,
          'Date-intent intersection or prediction ranking selected the wrong date range.',
          'Inspect the prediction payload and requested-range intersection before changing prompts.',
        );
      }
    }
  }

  if (turn.expectedSearch) {
    const ond = searchInput?.onds?.[0] || {};
    const expected = turn.expectedSearch;
    const mismatches = [
      normalizedAirport(ond.origin) !== expected.origin
        ? `origin=${ond.origin || 'none'}`
        : null,
      normalizedAirport(ond.destination) !== expected.destination
        ? `destination=${ond.destination || 'none'}`
        : null,
      ond.outbound_date !== expected.outboundDate
        ? `outbound=${ond.outbound_date || 'none'}`
        : null,
      Object.hasOwn(expected, 'returnDate') && ond.return_date !== expected.returnDate
        ? `return=${ond.return_date || 'none'}`
        : null,
      expected.tripType && searchInput?.trip_type !== expected.tripType
        ? `tripType=${searchInput?.trip_type || 'none'}`
        : null,
      expected.cabinClass && searchInput?.cabin_class !== expected.cabinClass
        ? `cabinClass=${searchInput?.cabin_class || 'none'}`
        : null,
      expected.adults && searchInput?.passengers?.adults !== expected.adults
        ? `adults=${searchInput?.passengers?.adults || 'none'}`
        : null,
    ].filter(Boolean);
    if (!searchCall || mismatches.length > 0) {
      addIssue(
        issues,
        'flight_search',
        `Flight search payload mismatch: ${mismatches.join(', ') || 'search tool was not called'}.`,
        'Resolved route/date/trip state was not transferred to flight_search correctly.',
        'Fix payload preparation while leaving the flight_search schema unchanged.',
      );
    }
  }

  if (turn.expectedSearchDateRange) {
    const ond = searchInput?.onds?.[0] || {};
    const actualDate = ond.outbound_date || null;
    const route = turn.expectedSearchRoute || {};
    const dateInRange = Boolean(
      actualDate &&
        actualDate >= turn.expectedSearchDateRange.startDate &&
        actualDate <= turn.expectedSearchDateRange.endDate,
    );
    const routeMatches =
      normalizedAirport(ond.origin) === route.origin &&
      normalizedAirport(ond.destination) === route.destination;
    if (!searchCall || !dateInRange || !routeMatches) {
      addIssue(
        issues,
        'date_inference',
        `Expected ${route.origin}-${route.destination} search between ${turn.expectedSearchDateRange.startDate} and ${turn.expectedSearchDateRange.endDate}; got ${ond.origin || 'none'}-${ond.destination || 'none'} on ${actualDate || 'none'}.`,
        'The model did not preserve the intended relative portion of the requested period.',
        'Refine only the structured date semantics needed for this phrase.',
      );
    }
  }

  if (turn.forbidSearch && searchCall) {
    addIssue(
      issues,
      'routing',
      'flight_search ran even though the request still lacked a usable travel date.',
      'The Agent treated bare price flexibility as a concrete search date.',
      'Clarify that bare flexible price intent does not satisfy outbound_date.',
    );
  }

  if (turn.preserveSearch) {
    const ond = contextAfter.searchState?.onds?.[0] || {};
    const expected = turn.preserveSearch;
    if (
      normalizedAirport(ond.origin) !== expected.origin ||
      normalizedAirport(ond.destination) !== expected.destination ||
      ond.outbound_date !== expected.outboundDate
    ) {
      addIssue(
        issues,
        'context',
        'Existing route/date context was not preserved while collecting return timing.',
        'A partial user update cleared durable search state.',
        'Merge only explicitly supplied fields over the existing search context.',
      );
    }
  }

  if (!compact(output)) {
    addIssue(
      issues,
      'response_quality',
      'Agent returned an empty response.',
      'The run completed without a usable final message.',
      'Inspect final-response generation after the last tool call.',
    );
  }
  if (INTERNAL_TOOL_PATTERN.test(output)) {
    addIssue(
      issues,
      'response_quality',
      'Agent exposed internal tool or context terminology.',
      'The final answer echoed implementation details instead of user-facing language.',
      'Strengthen the existing no-internals response rule.',
    );
  }
  if (LEGACY_ROUTE_LABEL_PATTERN.test(output)) {
    addIssue(
      issues,
      'response_quality',
      'Agent used a legacy user-facing route label.',
      'The response did not follow the required departure-location and arrival-location terminology.',
      'Use departure location and arrival location, or natural route phrasing, without internal field labels.',
    );
  }
  if (turn.requirePrivateFailure && INTERNAL_FAILURE_PATTERN.test(output)) {
    addIssue(
      issues,
      'fallback',
      'Agent exposed prediction failure details.',
      'The private failure branch or final output guard did not run.',
      'Fix only the Flight prediction-failure response handling.',
    );
  }
  if (turn.responsePattern && !turn.responsePattern.test(output)) {
    addIssue(
      issues,
      'response_quality',
      'Response did not ask or answer the expected user-facing next step.',
      'The response copy did not match the completed workflow state.',
      'Adjust only the corresponding response pattern in the Flight prompt.',
    );
  }
  if (turn.responseDatePattern && !turn.responseDatePattern.test(output)) {
    addIssue(
      issues,
      'response_quality',
      'Response did not clearly state the inferred search date.',
      'The Agent searched successfully but omitted the date assumption from its confirmation.',
      'Require the selected date in inferred-date search confirmations.',
    );
  }
  if (turn.forbidMoney && MONEY_PATTERN.test(output)) {
    addIssue(
      issues,
      'grounding',
      'Response invented or exposed an exact fare absent from the date-only prediction contract.',
      'The Agent added a fare value that the tool did not return.',
      'Ground date-intelligence responses only in returned dates and recommendations.',
    );
  }
  if (output.length > 700 || compact(output).split(/\s+/).length > 110) {
    addIssue(
      issues,
      'response_quality',
      'Response is too long for the Flight mobile experience.',
      'The Agent added unnecessary explanation after a simple route/date action.',
      'Keep the response to the existing mobile pattern.',
    );
  }

  const expectedSchemaKeys = [...PROD_FLIGHT_CONTEXT_KEYS].sort();
  if (JSON.stringify(contextAfter.flightSchemaKeys) !== JSON.stringify(expectedSchemaKeys)) {
    addIssue(
      issues,
      'context',
      'Final context.flight keys do not match the prod-compatible schema.',
      'A runtime helper or tool introduced a local-only field into context.flight.',
      'Keep the base Flight schema unchanged and keep the clock request-local.',
    );
  }

  if (contextAfter.hasDurableFlightDate) {
    addIssue(
      issues,
      'context',
      'A durable context.flightDate object was created by the stateless flow.',
      'A runner or tool persisted temporary date reasoning state.',
      'Keep resolver feedback in session history and the turn clock request-local.',
    );
  }

  const hasSearchKey = Boolean(contextAfter.flight.searchKey);
  const suggestions = contextAfter.flight.suggestedQuestions || [];
  if (hasSearchKey && suggestions.length !== 3) {
    addIssue(
      issues,
      'context',
      `Expected 3 suggested questions with searchKey, got ${suggestions.length}.`,
      'The final updater did not read the latest searchKey or rejected its payload.',
      'Keep updater execution last and validate the latest context at execution time.',
    );
  }
  if (!hasSearchKey && suggestions.length !== 0) {
    addIssue(
      issues,
      'context',
      'Suggested questions were retained without an active searchKey.',
      'The updater kept stale questions after a no-search turn.',
      'Clear suggestions when the latest searchKey is absent.',
    );
  }

  const checks = {
    routing: !issues.some((item) => item.category === 'routing'),
    dateInference: !issues.some((item) => item.category === 'date_inference'),
    pricePrediction: !issues.some((item) => item.category === 'price_prediction'),
    flightSearch: !issues.some((item) => item.category === 'flight_search'),
    fallback: !issues.some((item) => item.category === 'fallback'),
    context: !issues.some((item) => item.category === 'context'),
    responseQuality: !issues.some((item) =>
      ['response_quality', 'grounding'].includes(item.category),
    ),
  };

  return {
    actualTools,
    actualToolPayload: toolPayloadMap(calls),
    toolResponses: toolResponseMap(calls),
    toolOutput: {
      prediction: predictionCall?.output || predictionOutput,
      search: searchCall
        ? {
            ...searchCall.output,
            searchState: contextAfter.searchState,
          }
        : null,
    },
    output,
    issues,
    checks,
  };
}

function expectedToolText(turn) {
  return turn.expectedToolSequences
    .map((sequence) => sequence.join(' -> '))
    .join(' OR ');
}

async function runScenario(scenario, scenarioIndex) {
  const sessionId = `date-price-accuracy-${scenario.id}-${Date.now()}`;
  const providedContext = clone(scenario.initialContext || {});
  const context = {
    ...providedContext,
    flight: createProdFlightContext(providedContext),
  };
  context.flight.uid = sessionId;
  const turnReports = [];

  try {
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      if (TURN_DELAY_MS > 0) {
        await sleep(TURN_DELAY_MS);
      }
      predictionMode = turn.predictionMode || 'success';
      const contextBefore = contextSnapshot(context);
      const requestId = `${sessionId}-turn-${turnIndex + 1}`;
      const dynamicPromptDateContext = previewDynamicDateContext(context, {
        requestId,
        sessionId,
      });
      const session = getFlightAgentSession(sessionId);
      const sessionItemsBefore = await session.getItems();
      console.log(
        `[date-price-accuracy] ${scenarioIndex + 1}/${selectedScenarios.length} ${scenario.id} turn ${turnIndex + 1}/${scenario.turns.length}`,
      );

      const result = await runFlightAgent({
        input: turn.userMessage,
        sessionId,
        requestId,
        context,
        now: FIXED_NOW,
        timeZone: TIME_ZONE,
      });
      const sessionItemsAfter = await session.getItems();
      const calls = extractSessionToolCalls(
        sessionItemsAfter.slice(sessionItemsBefore.length),
      );
      const sessionCalls = extractSessionToolCalls(sessionItemsAfter);
      const contextAfter = contextSnapshot(context);
      const validation = validateTurn({
        turn,
        calls,
        sessionCalls,
        result,
        contextBefore,
        contextAfter,
      });
      const blocked = Boolean(result.error);

      const report = {
        testId: scenario.id,
        turn: turnIndex + 1,
        userMessage: turn.userMessage,
        contextBefore,
        dynamicPromptDateContext,
        expectedBehavior: `${turn.expectedIntent}; ${expectedToolText(turn)}`,
        expectedIntent: turn.expectedIntent,
        expectedToolCall: expectedToolText(turn),
        actualToolCalls: validation.actualTools,
        toolPayloads: validation.actualToolPayload,
        toolResponses: validation.toolResponses,
        toolOutput: validation.toolOutput,
        agentResponse: validation.output,
        contextAfter,
        status: blocked ? 'blocked' : validation.issues.length === 0 ? 'passed' : 'failed',
        blocked,
        pass: blocked ? null : validation.issues.length === 0,
        issues: blocked ? [] : validation.issues,
        fixRequired: !blocked && validation.issues.length > 0,
        checks: validation.checks,
        latencyMs: result.latencyMs,
        notes: result.pricePredictionFailureGuardrail?.applied
          ? 'Private price-prediction failure guardrail adjusted the final response.'
          : '',
      };
      if (blocked) {
        report.issues.push({
          category: 'infrastructure',
          message: 'The live OpenAI request did not complete, so this turn was not evaluated.',
          rootCause: 'External API availability, quota, or credentials blocked the model run.',
          suggestedFix: 'Restore API access, then rerun this blocked case without changing agent logic.',
        });
      }
      turnReports.push(report);
      console.log(
        `[date-price-accuracy] ${scenario.id} turn ${turnIndex + 1}: ${report.status.toUpperCase()}`,
      );
    }
  } finally {
    await clearFlightAgentSession(sessionId);
  }

  return {
    chatId: scenario.id,
    category: scenario.category,
    initialContext: contextSnapshot({
      ...providedContext,
      flight: createProdFlightContext(providedContext),
    }),
    status: turnReports.some((turn) => turn.blocked)
      ? 'blocked'
      : turnReports.every((turn) => turn.pass)
        ? 'passed'
        : 'failed',
    pass: turnReports.some((turn) => turn.blocked)
      ? null
      : turnReports.every((turn) => turn.pass),
    turns: turnReports,
  };
}

function accuracyMetric(turns, checkName) {
  const applicable = turns.filter(
    (turn) => !turn.blocked && Object.hasOwn(turn.checks, checkName),
  );
  const passed = applicable.filter((turn) => turn.checks[checkName]).length;
  return {
    passed,
    total: applicable.length,
    percentage: Number(((passed / Math.max(applicable.length, 1)) * 100).toFixed(1)),
  };
}

function buildReport(chats, startedAt, complete) {
  const turns = chats.flatMap((chat) => chat.turns);
  const evaluatedTurns = turns.filter((turn) => !turn.blocked);
  const blockedTurns = turns.filter((turn) => turn.blocked);
  const passedTurns = evaluatedTurns.filter((turn) => turn.pass).length;
  const failures = evaluatedTurns.flatMap((turn) =>
    turn.issues.map((issue) => ({ testId: turn.testId, turn: turn.turn, ...issue })),
  );
  return {
    summary: {
      generatedAt: new Date().toISOString(),
      model: flightAgentConfig.model,
      fixedClock: {
        instant: FIXED_NOW.toISOString(),
        localDate: LOCAL_DATE,
        timeZone: TIME_ZONE,
      },
      completed: complete && blockedTurns.length === 0,
      completionReason:
        blockedTurns.length > 0
          ? 'One or more live OpenAI requests were blocked by external runtime conditions.'
          : null,
      plannedChats: selectedScenarios.length,
      completedChats: chats.length,
      totalTurns: turns.length,
      evaluatedTurns: evaluatedTurns.length,
      blockedTurns: blockedTurns.length,
      passedTurns,
      failedTurns: evaluatedTurns.length - passedTurns,
      passPercentage: Number(
        ((passedTurns / Math.max(evaluatedTurns.length, 1)) * 100).toFixed(1),
      ),
      durationMs: Date.now() - startedAt,
      executionMode: {
        agentModelCalls: 'live OpenAI',
        flightTools: 'local controlled implementations',
        pricePredictionRepository: 'controlled success/no-data/error responses',
      },
      accuracy: {
        routing: accuracyMetric(turns, 'routing'),
        dateInference: accuracyMetric(turns, 'dateInference'),
        pricePrediction: accuracyMetric(turns, 'pricePrediction'),
        flightSearch: accuracyMetric(turns, 'flightSearch'),
        fallbackHandling: accuracyMetric(turns, 'fallback'),
        contextCarryForward: accuracyMetric(turns, 'context'),
        responseQuality: accuracyMetric(turns, 'responseQuality'),
      },
      issueCounts: failures.reduce((counts, issue) => {
        counts[issue.category] = (counts[issue.category] || 0) + 1;
        return counts;
      }, {}),
    },
    chats,
    failures,
    infrastructureBlocks: blockedTurns.map((turn) => ({
      testId: turn.testId,
      turn: turn.turn,
      userMessage: turn.userMessage,
    })),
    validatedFixes: VALIDATED_FIXES,
  };
}

function markdownReport(report) {
  const lines = [
    '# Flight Agent Date and Price Accuracy',
    '',
    `- Generated: ${report.summary.generatedAt}`,
    `- Model: ${report.summary.model}`,
    `- Fixed local clock: ${report.summary.fixedClock.localDate} (${report.summary.fixedClock.timeZone})`,
    `- Chats: ${report.summary.completedChats}/${report.summary.plannedChats}`,
    `- Evaluated turns: ${report.summary.passedTurns}/${report.summary.evaluatedTurns} passed`,
    `- Infrastructure-blocked turns: ${report.summary.blockedTurns}/${report.summary.totalTurns}`,
    `- Evaluated accuracy: ${report.summary.passPercentage}%`,
    '',
    '## Accuracy',
    '',
    `- Routing: ${report.summary.accuracy.routing.percentage}%`,
    `- Date inference: ${report.summary.accuracy.dateInference.percentage}%`,
    `- Price prediction: ${report.summary.accuracy.pricePrediction.percentage}%`,
    `- Flight search: ${report.summary.accuracy.flightSearch.percentage}%`,
    `- Failure fallback: ${report.summary.accuracy.fallbackHandling.percentage}%`,
    `- Context carry-forward: ${report.summary.accuracy.contextCarryForward.percentage}%`,
    `- Response quality: ${report.summary.accuracy.responseQuality.percentage}%`,
    '',
    '## Execution Mode',
    '',
    '- Agent decisions and responses: live OpenAI model calls',
    '- Flight tools: local controlled implementations',
    '- Price prediction outcomes: controlled success, no-data, and error responses',
    '',
    '## Fixes Validated',
    '',
  ];

  for (const fix of report.validatedFixes) {
    lines.push(`- ${fix.issue}: ${fix.change}`);
  }
  lines.push('');

  for (const chat of report.chats) {
    lines.push(`## ${chat.status.toUpperCase()} - ${chat.chatId}`);
    lines.push('');
    for (const turn of chat.turns) {
      lines.push(`### Turn ${turn.turn}: ${turn.status.toUpperCase()}`);
      lines.push('');
      lines.push(`- User: ${turn.userMessage}`);
      lines.push(`- Expected intent: ${turn.expectedIntent}`);
      lines.push(`- Expected tools: ${turn.expectedToolCall}`);
      lines.push(`- Actual tools: ${turn.actualToolCalls.join(' -> ') || '(none)'}`);
      lines.push(`- Response: ${compact(turn.agentResponse)}`);
      for (const issue of turn.issues) {
        lines.push(`- Issue [${issue.category}]: ${issue.message}`);
        lines.push(`- Root cause: ${issue.rootCause}`);
        lines.push(`- Suggested fix: ${issue.suggestedFix}`);
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeReports(chats, startedAt, complete) {
  const report = buildReport(chats, startedAt, complete);
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.writeFile(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(MARKDOWN_REPORT, markdownReport(report));
  return report;
}

const startedAt = Date.now();
const chats = [];
const selectedScenarios = scenarios
  .filter((scenario) => CASE_IDS.size === 0 || CASE_IDS.has(scenario.id))
  .slice(0, CASE_LIMIT);

try {
  await writeReports(chats, startedAt, false);
  for (const [index, scenario] of selectedScenarios.entries()) {
    chats.push(await runScenario(scenario, index));
    await writeReports(chats, startedAt, false);
  }
  const report = await writeReports(chats, startedAt, true);
  console.log(markdownReport(report));
  console.log(`JSON report: ${JSON_REPORT}`);
  console.log(`Markdown report: ${MARKDOWN_REPORT}`);
  if (report.summary.failedTurns > 0) {
    process.exitCode = 1;
  } else if (report.summary.blockedTurns > 0) {
    process.exitCode = 2;
  }
} finally {
  clickHouseClient.query = originalClickHouseQuery;
}
