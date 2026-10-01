import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlightAgentInstructions } from '../../src/agents/flight/agent.js';
import { resolveFlightDateIntent as resolveFlightDateIntentDefinition } from '../../src/agents/flight/date/resolver.js';
import { createRequestContext } from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import { MANAGER_PROMPT } from '../../src/agents/manager-orchestrator/manager-prompt.js';
import {
  PRICE_PREDICTION_FAILURE_DATE_REQUEST,
  sanitizePricePredictionFailureResponse,
} from '../../src/agents/flight/tools/price-prediction/failure-response.js';
import {
  PRICE_PREDICTION_TOOL_NAME,
  PRICE_PREDICTION_WINDOW_DAYS,
  PricePredictionTool as PricePredictionToolDefinition,
  classifyPredictedPrice,
  clickHouseClient,
  getPricePrediction as getPricePredictionDefinition,
} from '../../src/agents/flight/tools/price-prediction/tool.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import {
  ClickHousePricePredictionRepository,
  buildPricePredictionQuery,
} from '../../src/agents/flight/tools/price-prediction/repository.js';
import { flightTools } from '../../src/agents/flight/tools/index.js';

const PricePredictionTool: any = PricePredictionToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;
const getPricePrediction: any = getPricePredictionDefinition;
const resolveFlightDateIntent: any = resolveFlightDateIntentDefinition;

const REFERENCE_NOW = new Date('2026-07-16T12:00:00.000Z');
const REFERENCE_CLOCK = createRequestClock({ now: REFERENCE_NOW, timeZone: 'UTC' });
const CONTRACT_NOW = new Date('2026-07-31T00:00:00.000Z');
const CONTRACT_CLOCK = createRequestClock({ now: CONTRACT_NOW, timeZone: 'UTC' });
const DAY_MS = 24 * 60 * 60 * 1000;

function createTestRequestContext(
  state,
  { now = new Date(), timeZone = 'UTC' } = {},
) {
  return createRequestContext(
    state,
    createRequestClock({ now, timeZone }),
  );
}

const ACTUAL_ONE_WAY_INPUT = {
  originCity: 'DEL',
  destinationCity: 'DXB',
  startDate: '2026-07-31',
  endDate: '2026-10-28',
  tripType: 'oneway',
  returnStartDate: null,
  returnEndDate: null,
  tripDuration: null,
  tripDurationFlexibility: null,
};

const ACTUAL_CHEAPEST_DATES = [
  '2026-09-15',
  '2026-09-22',
  '2026-09-14',
  '2026-09-13',
  '2026-09-23',
];

function structuredDateInput(overrides = {}): any {
  return {
    kind: 'flexible',
    relation: null,
    offset: null,
    weekday: null,
    month: null,
    year: null,
    exactDate: null,
    rangeStart: null,
    rangeEnd: null,
    tripDurationDays: null,
    tripType: 'oneway',
    ...overrides,
  };
}

function addDaysIso(days) {
  return new Date(REFERENCE_NOW.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function currentDayIso(days = 0) {
  const current = new Date();
  const utcDay = new Date(
    Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()),
  );
  return new Date(utcDay.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function oneWayInput(overrides = {}): any {
  return {
    originCity: 'JFK',
    destinationCity: 'LAX',
    startDate: addDaysIso(0),
    endDate: addDaysIso(20),
    tripType: 'oneway',
    ...overrides,
  };
}

function roundTripInput(overrides = {}): any {
  return {
    originCity: 'NYC',
    destinationCity: 'LHR',
    startDate: addDaysIso(0),
    endDate: addDaysIso(21),
    tripType: 'roundtrip',
    returnStartDate: addDaysIso(3),
    returnEndDate: addDaysIso(35),
    tripDuration: 7,
    tripDurationFlexibility: 1,
    ...overrides,
  };
}

function startOfUtcDay(value) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function testDateIso(today, days) {
  return new Date(today.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function actualContractPredictionRow() {
  const tripPredictions = {};
  for (let offset = 0; offset < 89; offset += 1) {
    tripPredictions[testDateIso(CONTRACT_NOW, offset)] = 1000 + offset;
  }
  ACTUAL_CHEAPEST_DATES.forEach((date, index) => {
    tripPredictions[date] = index + 1;
  });
  return {
    SearchDate: '2026-07-30',
    Thresholds: JSON.stringify({ LowerLimit: 300, UpperLimit: 420 }),
    TripPredictions: JSON.stringify(tripPredictions),
  };
}

function actualContractSuccessOutput() {
  const predictions = Array.from({ length: 89 }, (_, offset) => ({
    departureDate: testDateIso(CONTRACT_NOW, offset),
  }));
  const cheapestDates = ACTUAL_CHEAPEST_DATES.map((departureDate) => ({
    departureDate,
  }));
  return {
    ok: true,
    status: 'SUCCESS',
    source: 'clickhouse',
    dataAsOf: '2026-07-30',
    route: { originCity: 'DEL', destinationCity: 'DXB' },
    tripType: 'oneway',
    searchedDateRange: {
      startDate: '2026-07-31',
      endDate: '2026-10-28',
      returnStartDate: null,
      returnEndDate: null,
    },
    tripDuration: null,
    tripDurationFlexibility: null,
    predictionCount: 89,
    predictions,
    cheapestDates,
    cheapestCombinations: [],
    priceRangeSummary: null,
    recommendation: 'Best time to book: Sep 15, 2026',
    formattedResponse:
      '### 🏆 Top Cheapest Dates to Book\n\n| Rank | Date |\n|:----:|------|\n| 1 | Sep 15, 2026 |\n| 2 | Sep 22, 2026 |\n| 3 | Sep 14, 2026 |\n| 4 | Sep 13, 2026 |\n| 5 | Sep 23, 2026 |\n\n### 💡 Recommendation\n\n**Book on Sep 15, 2026** for the best predicted fare.',
    message: 'Price predictions returned successfully.',
  };
}

function actualContractNoPredictionsOutput() {
  const message =
    'Price prediction is unavailable for this route and date range. I can still search your preferred dates.';
  return {
    ok: false,
    status: 'NO_PREDICTIONS',
    source: 'clickhouse',
    route: { originCity: 'SAO', destinationCity: 'YTO' },
    tripType: 'oneway',
    searchedDateRange: {
      startDate: '2026-07-31',
      endDate: '2026-10-28',
      returnStartDate: null,
      returnEndDate: null,
    },
    predictionWindow: {
      today: '2026-07-31',
      maxDate: '2026-10-28',
      daysAhead: 89,
    },
    predictions: [],
    cheapestDates: [],
    cheapestCombinations: [],
    priceRangeSummary: null,
    recommendation: message,
    formattedResponse: message,
    message,
    recovery: {
      kind: 'unavailable',
      retrySafe: false,
      stateChanged: false,
    },
  };
}

class TestPricePredictionRepository {
  today: Date;
  source: string;

  constructor({ now = REFERENCE_NOW } = {}) {
    this.today = startOfUtcDay(now);
    this.source = 'test';
  }

  async findCityPrediction({
    searchDate,
    originCity,
    destinationCity,
    isRoundTrip,
  }) {
    const supportedRoutes = new Set(['DEL-BOM', 'JFK-LAX', 'NYC-LHR']);
    if (!supportedRoutes.has(`${originCity}-${destinationCity}`)) {
      return null;
    }

    const tripPredictions = {};
    if (isRoundTrip) {
      for (let outboundOffset = 0; outboundOffset <= 82; outboundOffset += 3) {
        const returnPrices = {};
        for (const duration of [5, 7, 10]) {
          const returnOffset = outboundOffset + duration;
          if (returnOffset <= 89) {
            returnPrices[testDateIso(this.today, returnOffset)] =
              620 + ((outboundOffset * 13 + duration * 7) % 170);
          }
        }
        tripPredictions[testDateIso(this.today, outboundOffset)] = returnPrices;
      }
    } else {
      for (let offset = 0; offset <= 89; offset += 2) {
        tripPredictions[testDateIso(this.today, offset)] = 280 + ((offset * 17) % 150);
      }
    }

    return {
      SearchDate: searchDate,
      SearchDepartureFromCity: originCity,
      SearchDepartureToCity: destinationCity,
      IsRoundTrip: isRoundTrip ? 1 : 0,
      Currency: 'USD',
      Thresholds: JSON.stringify({ LowerLimit: 300, UpperLimit: 420 }),
      TripPredictions: JSON.stringify(tripPredictions),
    };
  }
}

function createTestRepository(now = REFERENCE_NOW) {
  return new TestPricePredictionRepository({ now });
}

async function withTestClickHouseClient(callback) {
  const originalQuery = clickHouseClient.query;
  const repository = createTestRepository(new Date());
  clickHouseClient.query = async ({ query }) => {
    const searchDate =
      query.match(/SearchDate = '(\d{4}-\d{2}-\d{2})'/)?.[1] || currentDayIso(-1);
    const originCity =
      query.match(/SearchDepartureFromCity = '([A-Z]{3})'/)?.[1] || 'DEL';
    const destinationCity =
      query.match(/SearchDepartureToCity = '([A-Z]{3})'/)?.[1] || 'BOM';
    const isRoundTrip = query.match(/IsRoundTrip = ([01])/)?.[1] === '1';
    const row = await repository.findCityPrediction({
      searchDate,
      originCity,
      destinationCity,
      isRoundTrip,
    });
    return { async json() { return row ? [row] : []; } };
  };

  try {
    return await callback();
  } finally {
    clickHouseClient.query = originalQuery;
  }
}

async function withClickHouseRow(row, callback) {
  const originalQuery = clickHouseClient.query;
  clickHouseClient.query = async () => ({
    async json() {
      return row ? [row] : [];
    },
  });
  try {
    return await callback();
  } finally {
    clickHouseClient.query = originalQuery;
  }
}

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function priceFailureContext(status, userMessage = 'Find the cheapest date'): any {
  return {
    requestId: 'price-failure-turn',
    currentUserMessage: userMessage,
    flight: {
      searchKey: '',
      lastPricePrediction: { status },
    },
  };
}

function assertFailureDetailsHidden(output) {
  assert.doesNotMatch(
    output,
    /prediction|unsupported|unavailable|no predictions|internal error|tool error/i,
  );
}

test('price_prediction_tool is registered with the camelCase contract', () => {
  assert.equal(PricePredictionTool.name, PRICE_PREDICTION_TOOL_NAME);
  assert.ok(flightTools.some((registeredTool) => registeredTool.name === PRICE_PREDICTION_TOOL_NAME));
  assert.deepEqual(PricePredictionTool.parameters.required, [
    'originCity',
    'destinationCity',
    'startDate',
    'endDate',
    'tripType',
    'returnStartDate',
    'returnEndDate',
    'tripDuration',
    'tripDurationFlexibility',
  ]);
  assert.match(FLIGHT_PROMPT, /originCity, destinationCity, startDate, endDate/);
  assert.match(MANAGER_PROMPT, /cheapest.*best.*shortest/i);
  assert.match(MANAGER_PROMPT, /flight_agent.*flight search/is);
  assert.match(MANAGER_PROMPT, /route.*date.*passenger.*cabin.*changes/i);
  assert.match(
    FLIGHT_PROMPT,
    /If either route endpoint is missing.*ask only for the missing departure location or arrival location/i,
  );
});

test('tool receives the production one-way payload and returns the production success contract', async () => {
  const context: any = {
    flight: {},
    toolCallLog: [],
  };
  const requestContext = createTestRequestContext(context, { now: CONTRACT_NOW });
  const result = await withClickHouseRow(actualContractPredictionRow(), async () =>
    parseToolResult(
      await PricePredictionTool.invoke(
        { context: requestContext },
        JSON.stringify(ACTUAL_ONE_WAY_INPUT),
        {},
      ),
    ),
  );

  assert.deepEqual(context.toolCallLog, []);
  assert.deepEqual(result, actualContractSuccessOutput());
  assert.deepEqual(context.flight.lastPricePrediction, result);
});

test('NO_PREDICTIONS exactly matches the production failure contract', async () => {
  const input = {
    ...ACTUAL_ONE_WAY_INPUT,
    originCity: 'SAO',
    destinationCity: 'YTO',
  };
  const context: any = {
    flight: {},
    toolCallLog: [],
  };
  const requestContext = createTestRequestContext(context, { now: CONTRACT_NOW });
  const result = await withClickHouseRow(null, async () =>
    parseToolResult(
      await PricePredictionTool.invoke(
        { context: requestContext },
        JSON.stringify(input),
        {},
      ),
    ),
  );

  assert.deepEqual(result, actualContractNoPredictionsOutput());
  assert.deepEqual(context.flight.lastPricePrediction, result);
  assert.equal('dateIntent' in result, false);
  assert.equal('generalFallback' in result, false);
});

test('NO_PREDICTIONS is hidden and asks only for a travel date', () => {
  const processed = sanitizePricePredictionFailureResponse({
    output: 'No predictions are available for this route.',
    context: priceFailureContext('NO_PREDICTIONS'),
  });

  assert.equal(processed.output, PRICE_PREDICTION_FAILURE_DATE_REQUEST);
  assert.equal(processed.guardrail.action, 'request_travel_date');
  assertFailureDetailsHidden(processed.output);
});

test('prediction failure does not ask for a date already in the current search', () => {
  const context = priceFailureContext('NO_PREDICTIONS', 'Any cheaper dates?');
  context.flight.outboundDate = '2026-11-05';
  context.flight.inboundDate = '2026-11-12';
  context.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  const processed = sanitizePricePredictionFailureResponse({
    output: 'No prediction data available.',
    context,
    currentUserMessage: 'Any cheaper dates?',
  });
  assert.equal(processed.guardrail.action, 'price_unverified');
  assert.match(processed.output, /couldn't verify a price recommendation/);
  assert.doesNotMatch(processed.output, /provide your expected travel date/i);
});

test('price prediction ERROR is hidden and asks only for a travel date', () => {
  const processed = sanitizePricePredictionFailureResponse({
    output: 'Price prediction failed because of an internal error.',
    context: priceFailureContext('ERROR'),
  });

  assert.equal(processed.output, PRICE_PREDICTION_FAILURE_DATE_REQUEST);
  assert.equal(processed.guardrail.action, 'request_travel_date');
  assertFailureDetailsHidden(processed.output);
});

test('unsupported route details are hidden from the user', () => {
  const processed = sanitizePricePredictionFailureResponse({
    output: 'This route is unsupported, so prediction data is unavailable.',
    context: priceFailureContext('NO_PREDICTIONS'),
  });

  assert.equal(processed.output, PRICE_PREDICTION_FAILURE_DATE_REQUEST);
  assertFailureDetailsHidden(processed.output);
});

test('cheapest-date failure without usable timing asks for one travel date', () => {
  const context = priceFailureContext(
    'NO_PREDICTIONS',
    'What is the cheapest date from DEL to DXB?',
  );
  const processed = sanitizePricePredictionFailureResponse({
    output: 'I checked predictions but could not find results.',
    context,
  });

  assert.equal(processed.output, PRICE_PREDICTION_FAILURE_DATE_REQUEST);
  assertFailureDetailsHidden(processed.output);
});

test('explicit developer debugging can inspect the original failure response', () => {
  const output = 'Prediction data is unavailable for this route.';
  const processed = sanitizePricePredictionFailureResponse({
    output,
    context: priceFailureContext(
      'NO_PREDICTIONS',
      'Debug why the prediction tool failed',
    ),
  });

  assert.equal(processed.output, output);
  assert.equal(processed.guardrail.applied, false);
});

test('successful prediction and unrelated turns are not rewritten', () => {
  const output = 'Best time to book: Sep 15, 2026';
  const successfulContext = priceFailureContext('SUCCESS');
  const successful = sanitizePricePredictionFailureResponse({
    output,
    context: successfulContext,
  });
  const staleFailureContext = priceFailureContext('NO_PREDICTIONS');
  const previousPricePrediction = staleFailureContext.flight.lastPricePrediction;
  const unrelated = sanitizePricePredictionFailureResponse({
    output,
    context: staleFailureContext,
    previousPricePrediction,
  });

  assert.equal(successful.output, output);
  assert.equal(successful.guardrail.applied, false);
  assert.equal(unrelated.output, output);
  assert.equal(unrelated.guardrail.applied, false);
});

test('usable date continues through flight_search without exposing prediction failure', async () => {
  const resolvedDateIntent = resolveFlightDateIntent(
    structuredDateInput({ kind: 'exact', exactDate: '2026-08-15' }),
    { clock: CONTRACT_CLOCK },
  );
  const context: any = {
    requestId: 'prediction-fallback-turn',
    sessionId: 'prediction-fallback-session',
    flight: {
      uid: 'prediction-fallback-user',
    },
    toolCallLog: [],
  };
  const requestContext = createTestRequestContext(context, { now: CONTRACT_NOW });
  const previousPricePrediction = context.flight.lastPricePrediction || null;
  const previousSearchKey = context.flight.searchKey || null;
  const predictionResult = await withClickHouseRow(null, async () =>
    parseToolResult(
      await PricePredictionTool.invoke(
        { context: requestContext },
        JSON.stringify(ACTUAL_ONE_WAY_INPUT),
        {},
      ),
    ),
  );
  const searchInput = {
    onds: [
      {
        origin: 'DEL',
        destination: 'DXB',
        outbound_date: '2026-08-15',
        return_date: null,
      },
    ],
    trip_type: 'oneway',
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin_class: 'economy',
  };
  const searchResult = parseToolResult(
    await FlightSearchTool.invoke(
      { context: requestContext },
      JSON.stringify(searchInput),
      {},
    ),
  );
  const processed = sanitizePricePredictionFailureResponse({
    output: 'Prediction data was unavailable, so I used a fallback date.',
    context,
    previousPricePrediction,
    previousSearchKey,
  });

  assert.equal(predictionResult.status, 'NO_PREDICTIONS');
  assert.equal(typeof searchResult.searchKey, 'string');
  assert.equal(Array.isArray(searchResult.flights), true);
  assert.deepEqual(
    context.toolCallLog.map(({ tool }) => tool),
    ['price_prediction_tool', 'flight_search'],
  );
  assert.equal(context.flight.outboundDate, '2026-08-15');
  assert.equal(
    processed.output,
    'I found flight options from DEL to DXB for Aug 15, 2026. Note: Prices shown are per person.',
  );
  assert.equal(processed.guardrail.action, 'search_confirmation');
  assertFailureDetailsHidden(processed.output);
  assert.equal(context.flightDate, undefined);
});

test('date resolver accepts structured intent and does not parse raw user text', () => {
  const rawTextResult = resolveFlightDateIntent(
    'Find flights from JFK to LAX next month',
    { clock: REFERENCE_CLOCK },
  );
  const structuredResult = resolveFlightDateIntent(
    structuredDateInput({ kind: 'month', relation: 'next' }),
    { clock: REFERENCE_CLOCK },
  );

  assert.equal(rawTextResult.status, 'INVALID_INTENT');
  assert.equal(structuredResult.status, 'RESOLVED');
  assert.deepEqual(structuredResult.range, {
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  });
});

test('prompt separates normal vague searches from explicit price intelligence', () => {
  assert.match(FLIGHT_PROMPT, /A month, relative date, weekend, or range does not by itself trigger price prediction/i);
  assert.match(FLIGHT_PROMPT, /mention the selected date naturally/i);
  assert.match(FLIGHT_PROMPT, /strongest predicted travel date/i);
  assert.match(FLIGHT_PROMPT, /do not say "best predicted fare," "lowest fare," or "low-fare dates/i);
  assert.match(FLIGHT_PROMPT, /Find flights next month.*normal searches/i);
  assert.match(FLIGHT_PROMPT, /Find the cheapest date next month.*explicit price intelligence/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /resolve_flight_date/i);
  assert.match(
    FLIGHT_PROMPT,
    /Keep prediction failures out of the user-facing answer unless explicitly debugging/i,
  );
  assert.match(
    FLIGHT_PROMPT,
    /After a non-success result.*call `flight_search` once only when the user also requested flight results/is,
  );
  assert.match(
    FLIGHT_PROMPT,
    /If no usable travel date exists.*ask one concise question for the expected travel date/is,
  );
  assert.match(
    FLIGHT_PROMPT,
    /required final step of every Flight turn.*never let its failure discard or downgrade a completed result/is,
  );
  assert.doesNotMatch(FLIGHT_PROMPT, /say prediction is unavailable/i);
  assert.match(FLIGHT_PROMPT, /derive exact range boundaries from the current turn clock/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /durable resolved date intent/i);
});

test('a submitted range beyond 89 days is rejected instead of silently clipped', async () => {
  const result = await getPricePrediction(oneWayInput({ endDate: addDaysIso(92) }), {
    now: REFERENCE_NOW,
    repository: createTestRepository(),
  });

  assert.equal(result.status, 'DATE_RANGE_EXCEEDED');
  assert.deepEqual(result.predictions, []);
});

test('price prediction filters directly to the explicit resolver range', async () => {
  const result = await getPricePrediction(
    oneWayInput({ startDate: '2026-08-01', endDate: '2026-08-31' }),
    { now: REFERENCE_NOW, repository: createTestRepository() },
  );

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.searchedDateRange, {
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    returnStartDate: null,
    returnEndDate: null,
  });
  assert.equal('dateIntent' in result, false);
  assert.equal(
    result.predictions.every(({ departureDate }) => departureDate.startsWith('2026-08-')),
    true,
  );
  assert.equal(
    result.cheapestDates.every(({ departureDate }) => departureDate.startsWith('2026-08-')),
    true,
  );
});

test('round-trip prediction uses only its explicit date payload', async () => {
  const result = await getPricePrediction(roundTripInput(), {
    now: REFERENCE_NOW,
    repository: createTestRepository(),
  });

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.searchedDateRange, {
    startDate: addDaysIso(0),
    endDate: addDaysIso(21),
    returnStartDate: addDaysIso(3),
    returnEndDate: addDaysIso(35),
  });
});

test('unsupported routes return no fabricated date or fare fallback', async () => {
  const result = await getPricePrediction(
    oneWayInput({ originCity: 'DEL', destinationCity: 'DXB' }),
    { now: REFERENCE_NOW, repository: createTestRepository() },
  );

  assert.equal(result.status, 'NO_PREDICTIONS');
  assert.equal('generalFallback' in result, false);
  assert.doesNotMatch(result.formattedResponse, /\$|USD|INR/i);
});

test('a requested month outside the fixed window returns DATE_RANGE_EXCEEDED', async () => {
  const result = await getPricePrediction(oneWayInput({
    startDate: '2026-12-01',
    endDate: '2026-12-31',
  }), {
    now: REFERENCE_NOW,
    repository: createTestRepository(),
  });

  assert.equal(result.status, 'DATE_RANGE_EXCEEDED');
  assert.deepEqual(result.predictions, []);
  assert.equal('generalFallback' in result, false);
  assert.match(result.message, /available only through 2026-10-13/i);
  assert.doesNotMatch(result.formattedResponse, /\$|USD|INR/i);
});

test('one-way prediction returns date-only predictions and five cheapest dates', async () => {
  const result = await getPricePrediction(oneWayInput(), {
    now: REFERENCE_NOW,
    repository: createTestRepository(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.source, 'test');
  assert.deepEqual(result.route, { originCity: 'JFK', destinationCity: 'LAX' });
  assert.equal(result.tripType, 'oneway');
  assert.equal(result.dataAsOf, addDaysIso(-1));
  assert.equal(result.predictions.length > 3, true);
  assert.equal(result.cheapestDates.length, 5);
  assert.deepEqual(result.cheapestCombinations, []);
  assert.deepEqual(Object.keys(result.predictions[0]), ['departureDate']);
  assert.deepEqual(Object.keys(result.cheapestDates[0]), ['departureDate']);
  assert.equal(result.priceRangeSummary, null);
  assert.match(result.recommendation, /Best time to book:/i);
  assert.match(result.formattedResponse, /Top Cheapest Dates to Book/i);
  assert.doesNotMatch(result.formattedResponse, /\$|USD|INR|great deal|fair price/i);
});

test('round-trip prediction ranks combinations and applies duration flexibility', async () => {
  const result = await getPricePrediction(roundTripInput(), {
    now: REFERENCE_NOW,
    repository: createTestRepository(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.tripType, 'roundtrip');
  assert.equal(result.predictions.length > 0, true);
  assert.deepEqual(result.cheapestDates, []);
  assert.equal(result.cheapestCombinations.length, 5);
  assert.equal(
    result.predictions.every(
      (prediction) => prediction.tripDuration >= 6 && prediction.tripDuration <= 8,
    ),
    true,
  );
  assert.equal(
    result.predictions.every(
      (prediction) => prediction.returnDate >= prediction.outboundDate,
    ),
    true,
  );
  assert.deepEqual(Object.keys(result.predictions[0]), [
    'outboundDate',
    'returnDate',
    'tripDuration',
  ]);
  assert.equal(result.priceRangeSummary, null);
  assert.match(result.recommendation, /Best round-trip dates:/i);
  assert.doesNotMatch(result.formattedResponse, /\$|USD|INR|great deal|fair price/i);
});

test('round-trip contract requires return dates while duration fields remain nullable', async () => {
  const missingReturnRange = await getPricePrediction(
    roundTripInput({ returnStartDate: null, returnEndDate: null }),
    { now: REFERENCE_NOW },
  );
  const validWithoutDuration = await getPricePrediction(
    roundTripInput({ tripDuration: null, tripDurationFlexibility: null }),
    { now: REFERENCE_NOW, repository: createTestRepository() },
  );

  assert.equal(missingReturnRange.status, 'INVALID_INPUT');
  assert.deepEqual(missingReturnRange.missingFields, [
    'returnStartDate',
    'returnEndDate',
  ]);
  assert.equal(validWithoutDuration.status, 'SUCCESS');
  assert.equal(validWithoutDuration.tripDuration, null);
  assert.equal(validWithoutDuration.tripDurationFlexibility, null);
  assert.equal(validWithoutDuration.cheapestDates.length, 0);
  assert.equal(validWithoutDuration.cheapestCombinations.length, 5);
});

test('invalid and past dates return INVALID_DATE_RANGE before repository access', async () => {
  let repositoryCalls = 0;
  const repository = {
    async findCityPrediction() {
      repositoryCalls += 1;
      return null;
    },
  };

  const invalidDate = await getPricePrediction(
    oneWayInput({ startDate: '2026-02-30' }),
    { repository, now: REFERENCE_NOW },
  );
  const pastDate = await getPricePrediction(
    oneWayInput({ startDate: addDaysIso(-1) }),
    { repository, now: REFERENCE_NOW },
  );

  assert.equal(invalidDate.status, 'INVALID_DATE_RANGE');
  assert.equal(pastDate.status, 'INVALID_DATE_RANGE');
  assert.equal(repositoryCalls, 0);
});

test('outbound or return dates after today plus 89 days return DATE_RANGE_EXCEEDED', async () => {
  const outboundExceeded = await getPricePrediction(
    oneWayInput({ endDate: addDaysIso(90) }),
    { now: REFERENCE_NOW },
  );
  const returnExceeded = await getPricePrediction(
    roundTripInput({ returnEndDate: addDaysIso(90) }),
    { now: REFERENCE_NOW },
  );

  assert.equal(PRICE_PREDICTION_WINDOW_DAYS, 89);
  assert.equal(outboundExceeded.status, 'DATE_RANGE_EXCEEDED');
  assert.equal(returnExceeded.status, 'DATE_RANGE_EXCEEDED');
  assert.equal(outboundExceeded.predictionWindow.maxDate, addDaysIso(89));
});

test('invalid round-trip ordering returns INVALID_DATE_RANGE', async () => {
  const result = await getPricePrediction(
    roundTripInput({
      returnStartDate: addDaysIso(-1),
      returnEndDate: addDaysIso(12),
    }),
    { now: REFERENCE_NOW },
  );

  assert.equal(result.status, 'INVALID_DATE_RANGE');
  assert.match(result.message, /return date range cannot begin before/i);
});

test('unsupported route and date range without data return NO_PREDICTIONS', async () => {
  const unsupported = await getPricePrediction(
    oneWayInput({ originCity: 'DEL', destinationCity: 'DXB' }),
    { now: REFERENCE_NOW, repository: createTestRepository() },
  );
  const noDates = await getPricePrediction(
    oneWayInput({ startDate: addDaysIso(1), endDate: addDaysIso(1) }),
    { now: REFERENCE_NOW, repository: createTestRepository() },
  );

  assert.equal(unsupported.status, 'NO_PREDICTIONS');
  assert.deepEqual(unsupported.predictions, []);
  assert.equal(noDates.status, 'NO_PREDICTIONS');
  assert.match(noDates.formattedResponse, /still search your preferred dates/i);
});

test('missing required fields return INVALID_INPUT without throwing', async () => {
  const result = await getPricePrediction(
    { originCity: 'JFK', destinationCity: '', startDate: '', endDate: '' },
    { now: REFERENCE_NOW },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'INVALID_INPUT');
  assert.deepEqual(result.missingFields, ['destinationCity', 'startDate', 'endDate']);
  assert.deepEqual(result.predictions, []);
});

test('tool schema failures are converted to structured INVALID_INPUT output', async () => {
  const result = parseToolResult(
    await PricePredictionTool.invoke(
      { context: {} },
      JSON.stringify({ originCity: 'JFK' }),
      {},
    ),
  );

  assert.equal(result.status, 'INVALID_INPUT');
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /zod|schema|stack|exception/i);
});

test('threshold classification uses inclusive lower and upper limits', () => {
  const thresholds = { lowerLimit: 200, upperLimit: 400 };
  assert.deepEqual(classifyPredictedPrice(200, thresholds), {
    priceBucket: 'LOW',
    priceLevel: 'low',
    dealLabel: 'great deal',
  });
  assert.equal(classifyPredictedPrice(201, thresholds).priceBucket, 'MEDIUM');
  assert.equal(classifyPredictedPrice(400, thresholds).priceBucket, 'MEDIUM');
  assert.equal(classifyPredictedPrice(401, thresholds).priceBucket, 'HIGH');
});

test('Thresholds are not required by the date-only public contract', async () => {
  const result = await getPricePrediction(oneWayInput({ endDate: addDaysIso(1) }), {
    now: REFERENCE_NOW,
    repository: {
      source: 'test',
      async findCityPrediction() {
        return {
          SearchDate: addDaysIso(-1),
          Thresholds: '{bad json',
          TripPredictions: JSON.stringify({
            [addDaysIso(0)]: 2,
            [addDaysIso(1)]: 1,
          }),
        };
      },
    },
  });

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.cheapestDates[0], { departureDate: addDaysIso(1) });
  assert.equal(result.priceRangeSummary, null);
});

test('null and non-numeric prediction ranks are ignored without leaking rank values', async () => {
  const result = await getPricePrediction(oneWayInput({ endDate: addDaysIso(2) }), {
    now: REFERENCE_NOW,
    repository: {
      source: 'test',
      async findCityPrediction() {
        return {
          SearchDate: addDaysIso(-1),
          Currency: 'USD',
          Thresholds: JSON.stringify({ LowerLimit: 250, UpperLimit: 400 }),
          TripPredictions: JSON.stringify({
            [addDaysIso(0)]: null,
            [addDaysIso(1)]: 'not-a-price',
            [addDaysIso(2)]: 300,
          }),
        };
      },
    },
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.predictionCount, 1);
  assert.deepEqual(result.predictions[0], { departureDate: addDaysIso(2) });
  assert.equal(result.priceRangeSummary, null);
  assert.doesNotMatch(result.formattedResponse, /300|\$|USD/);
});

test('query builder validates criteria while retaining the configured placeholder SQL', () => {
  const query = buildPricePredictionQuery({
    searchDate: addDaysIso(-1),
    originCity: 'NYC',
    destinationCity: 'LHR',
    isRoundTrip: true,
  });

  assert.equal(query, `SELECT *
  FROM price_predictions
LIMIT 1`);
});

test('ClickHouse repository is replaceable and returns the first JSONEachRow row', async () => {
  const expectedRow = { Thresholds: '{}', TripPredictions: '{}' };
  let queryRequest = null;
  const repository = new ClickHousePricePredictionRepository({
    client: {
      async query(request) {
        queryRequest = request;
        return { async json() { return [expectedRow]; } };
      },
    },
  });

  const row = await repository.findCityPrediction({
    searchDate: addDaysIso(-1),
    originCity: 'JFK',
    destinationCity: 'LAX',
    isRoundTrip: false,
  });

  assert.strictEqual(row, expectedRow);
  assert.equal(queryRequest.format, 'JSONEachRow');
  assert.equal(queryRequest.query, `SELECT *
  FROM price_predictions
LIMIT 1`);
});

test('malformed repository data and repository failures return ERROR without raw details', async () => {
  const malformed = await getPricePrediction(oneWayInput(), {
    now: REFERENCE_NOW,
    repository: {
      source: 'test',
      async findCityPrediction() {
        return { Thresholds: '{}', TripPredictions: '{bad json' };
      },
    },
  });
  const failed = await getPricePrediction(oneWayInput(), {
    now: REFERENCE_NOW,
    repository: {
      source: 'test',
      async findCityPrediction() {
        throw new Error('internal database host and credentials');
      },
    },
  });

  assert.equal(malformed.status, 'ERROR');
  assert.equal(failed.status, 'ERROR');
  assert.doesNotMatch(failed.formattedResponse, /database|credentials|host/i);
});

test('tool invocation stores the latest production prediction result', async () => {
  const context: any = {
    flight: {},
    toolCallLog: [],
  };
  const requestContext = createTestRequestContext(context);
  const result = await withTestClickHouseClient(async () =>
    parseToolResult(
      await PricePredictionTool.invoke(
        { context: requestContext },
        JSON.stringify({
          originCity: 'DEL',
          destinationCity: 'BOM',
          startDate: currentDayIso(0),
          endDate: currentDayIso(20),
          tripType: 'oneway',
          returnStartDate: null,
          returnEndDate: null,
          tripDuration: null,
          tripDurationFlexibility: null,
        }),
        {},
      ),
    ),
  );

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(context.flight.lastPricePrediction, result);
  assert.deepEqual(context.toolCallLog, []);
});

test('tool execution honors its explicit range without date-state logging', async () => {
  const context: any = {
    requestId: 'price-turn',
    flight: {},
    toolCallLog: [],
  };
  const requestContext = createTestRequestContext(context);
  const startDate = currentDayIso(5);
  const endDate = currentDayIso(10);
  const result = await withTestClickHouseClient(async () =>
    parseToolResult(
      await PricePredictionTool.invoke(
        { context: requestContext },
        JSON.stringify({
          originCity: 'DEL',
          destinationCity: 'BOM',
          startDate,
          endDate,
          tripType: 'oneway',
          returnStartDate: null,
          returnEndDate: null,
          tripDuration: null,
          tripDurationFlexibility: null,
        }),
        {},
      ),
    ),
  );

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.searchedDateRange.startDate, startDate);
  assert.equal(result.searchedDateRange.endDate, endDate);
  assert.equal(context.flightDate, undefined);
  assert.deepEqual(context.toolCallLog, []);
});

test('dynamic instructions expose immutable clock and date routing without a resolver tool', () => {
  const context: any = { flight: {} };
  const requestContext = createTestRequestContext(context, { now: REFERENCE_NOW });
  const instructions = buildFlightAgentInstructions({
    context: requestContext,
  });
  const dynamicInstructions = instructions.slice(FLIGHT_PROMPT.length);

  assert.match(dynamicInstructions, /Current price prediction window: \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}/);
  assert.match(dynamicInstructions, /Immutable turn clock: localDate=2026-07-16/i);
  assert.doesNotMatch(dynamicInstructions, /Durable resolved date intent/i);
  assert.doesNotMatch(dynamicInstructions, /priceFallbackDate|fallbackSearchAttempted/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /resolve_flight_date/i);
  assert.match(
    FLIGHT_PROMPT,
    /Classify input failures from recovery feedback; do not treat them as internal failures/i,
  );
  assert.match(
    FLIGHT_PROMPT,
    /After a non-success result.*call `flight_search` once only when the user also requested flight results/is,
  );
  assert.match(
    dynamicInstructions,
    /Normal search intent such as.*uses flight_search/i,
  );
  assert.match(
    dynamicInstructions,
    /For explicit price intelligence with vague timing, derive the requested range from the current turn clock/i,
  );
  assert.match(
    dynamicInstructions,
    /missing the departure location or arrival location.*retain any supplied timing/is,
  );
  assert.doesNotMatch(dynamicInstructions, /Treat every non-success price_prediction_tool result as internal/i);
  assert.match(dynamicInstructions, /Hydrated search key present \(not validated\): no/i);
  assert.match(dynamicInstructions, /Hydrated flight result records present \(not validated\): no/i);
  assert.match(FLIGHT_PROMPT, /A month, relative date, weekend, or range does not by itself trigger price prediction/i);
  assert.match(dynamicInstructions, /choose the earliest valid date in that interval within the booking window/i);
  assert.match(dynamicInstructions, /Never shift an exact user date/i);
  assert.doesNotMatch(dynamicInstructions, /resolve_flight_date/i);
});

test('unconfigured ClickHouse placeholder returns no fabricated predictions', async () => {
  const result = await getPricePrediction(oneWayInput(), { now: REFERENCE_NOW });

  assert.equal(result.status, 'NO_PREDICTIONS');
  assert.equal(result.source, 'clickhouse');
  assert.deepEqual(result.predictions, []);
});
