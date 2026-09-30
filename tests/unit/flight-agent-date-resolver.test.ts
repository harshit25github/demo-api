import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureFlightRuntimeContext,
  getFlightSearchState,
} from '../../src/agents/flight/context/flight-context.js';
import {
  createRequestContext,
  getRequestClock,
  getRequestState,
} from '../../src/shared/runtime/request-context.js';
import { resolveFlightDateIntent } from '../../src/agents/flight/date/resolver.js';
import {
  FLIGHT_SEARCH_WINDOW_DAYS,
  PRICE_PREDICTION_WINDOW_DAYS,
} from '../../src/agents/flight/date/calendar.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import {
  RESOLVE_FLIGHT_DATE_TOOL_NAME,
  ResolveFlightDateTool as ResolveFlightDateToolDefinition,
} from '../../src/agents/flight/tools/resolve-date-tool.js';
import { flightTools } from '../../src/agents/flight/tools/index.js';

const FlightSearchTool: any = FlightSearchToolDefinition;
const ResolveFlightDateTool: any = ResolveFlightDateToolDefinition;

const NOW = new Date('2026-07-31T10:00:00.000Z');
const CLOCK = createRequestClock({ now: NOW, timeZone: 'Asia/Kolkata' });

function intent(overrides = {}): any {
  return {
    kind: 'exact',
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

function resolve(overrides = {}, options = {}) {
  return resolveFlightDateIntent(intent(overrides), {
    clock: CLOCK,
    existingSearch: {},
    ...options,
  });
}

test('turn clock lives only in the explicit request runtime context', () => {
  const context = ensureFlightRuntimeContext({});
  const before = JSON.stringify(context);

  const clock = createRequestClock({
    now: NOW,
    timeZone: 'Asia/Kolkata',
  });
  const requestContext = createRequestContext(context, clock);

  assert.deepEqual(clock, {
    localDate: '2026-07-31',
    localDateTime: '2026-07-31T15:30:00+05:30',
    timeZone: 'Asia/Kolkata',
  });
  assert.deepEqual(getRequestClock(requestContext), clock);
  assert.equal(getRequestState(requestContext), context);
  assert.equal(JSON.stringify(context), before);
  assert.equal(context.flightDate, undefined);
  assert.equal(context.flight.clock, undefined);
});

test('request clocks stay isolated when two turns share durable session state', () => {
  const context = ensureFlightRuntimeContext({});
  const firstClock = createRequestClock({
    now: new Date('2026-07-31T10:00:00.000Z'),
    timeZone: 'Asia/Kolkata',
  });
  const secondClock = createRequestClock({
    now: new Date('2026-08-01T10:00:00.000Z'),
    timeZone: 'America/New_York',
  });

  const firstRequest = createRequestContext(context, firstClock);
  const secondRequest = createRequestContext(context, secondClock);

  assert.equal(getRequestState(firstRequest), context);
  assert.equal(getRequestState(secondRequest), context);
  assert.equal(getRequestClock(firstRequest).localDate, '2026-07-31');
  assert.equal(getRequestClock(firstRequest).timeZone, 'Asia/Kolkata');
  assert.equal(getRequestClock(secondRequest).localDate, '2026-08-01');
  assert.equal(getRequestClock(secondRequest).timeZone, 'America/New_York');
  assert.equal(context.runtime, undefined);
  assert.equal(context.flightDate, undefined);
});

test('resolver requires the request clock instead of creating a hidden clock', () => {
  const result = resolveFlightDateIntent(intent({ kind: 'week', relation: 'next' }));

  assert.deepEqual(result, {
    status: 'INVALID_INTENT',
    range: null,
    searchDate: null,
    returnDate: null,
    assumptionLabel: 'The current local date is invalid.',
    recovery: {
      kind: 'internal',
      retrySafe: false,
      stateChanged: false,
    },
  });
});

test('next week, weekends, and weekdays resolve deterministically', () => {
  assert.deepEqual(resolve({ kind: 'week', relation: 'next' }), {
    status: 'RESOLVED',
    range: { startDate: '2026-08-03', endDate: '2026-08-09' },
    searchDate: '2026-08-03',
    returnDate: null,
    assumptionLabel:
      'next week: 2026-08-03 to 2026-08-09; use 2026-08-03 for flight search.',
  });
  assert.equal(
    resolve({ kind: 'weekend', relation: 'this' }).searchDate,
    '2026-08-01',
  );
  assert.equal(
    resolve({ kind: 'weekend', relation: 'next' }).searchDate,
    '2026-08-08',
  );
  assert.equal(
    resolve({ kind: 'weekday', relation: 'this', weekday: 'friday' }).searchDate,
    '2026-07-31',
  );
  assert.equal(
    resolve({ kind: 'weekday', relation: 'this', weekday: 'thursday' }).searchDate,
    '2026-08-06',
  );
});

test('next month and named months choose the earliest non-past date', () => {
  const nextMonth = resolve({ kind: 'month', relation: 'next' });
  const august = resolve({ kind: 'month', month: 8 });

  assert.deepEqual(nextMonth.range, {
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  });
  assert.equal(nextMonth.searchDate, '2026-08-01');
  assert.deepEqual(august.range, nextMonth.range);
});

test('month resolution handles year boundaries', () => {
  const clock = createRequestClock({
    now: new Date('2026-12-31T12:00:00.000Z'),
    timeZone: 'UTC',
  });
  const result = resolveFlightDateIntent(
    intent({ kind: 'month', relation: 'next' }),
    { clock },
  );

  assert.deepEqual(result.range, {
    startDate: '2027-01-01',
    endDate: '2027-01-31',
  });
});

test('explicit ranges and structured offsets return usable search dates', () => {
  const range = resolve({
    kind: 'range',
    rangeStart: '2026-08-10',
    rangeEnd: '2026-08-25',
  });
  const twoWeeks = resolve({ kind: 'exact', offset: 14 });

  assert.deepEqual(range.range, {
    startDate: '2026-08-10',
    endDate: '2026-08-25',
  });
  assert.equal(range.searchDate, '2026-08-10');
  assert.equal(twoWeeks.searchDate, '2026-08-14');
});

test('round trips return deterministic timing or request only the missing duration', () => {
  const missingDuration = resolve({
    kind: 'month',
    relation: 'next',
    tripType: 'roundtrip',
  });
  const withDuration = resolve({
    kind: 'month',
    relation: 'next',
    tripType: 'roundtrip',
    tripDurationDays: 7,
  });

  assert.equal(missingDuration.status, 'NEEDS_RETURN_TIMING');
  assert.equal(missingDuration.searchDate, '2026-08-01');
  assert.equal(missingDuration.returnDate, null);
  assert.equal(withDuration.status, 'RESOLVED');
  assert.equal(withDuration.returnDate, '2026-08-08');
});

test('round trips may reuse actual dates from durable Flight search state', () => {
  const context = ensureFlightRuntimeContext({
    flight: {
      tripType: 'roundtrip',
      outboundDate: '2026-08-10',
      inboundDate: '2026-08-17',
      segments: [{ date: '2026-08-10', origin: 'DEL', destination: 'BOM' }],
    },
  });
  const result = resolveFlightDateIntent(
    intent({ kind: 'month', relation: 'next', tripType: 'roundtrip' }),
    { clock: CLOCK, existingSearch: getFlightSearchState(context) },
  );

  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.searchDate, '2026-08-01');
  assert.equal(result.returnDate, '2026-08-08');
});

test('search and prediction windows remain separate', () => {
  assert.equal(FLIGHT_SEARCH_WINDOW_DAYS, 359);
  assert.equal(PRICE_PREDICTION_WINDOW_DAYS, 89);

  const insideSearchOnly = resolve({
    kind: 'exact',
    exactDate: '2027-06-01',
  });
  const outsideSearch = resolve({
    kind: 'exact',
    exactDate: '2027-08-01',
  });

  assert.equal(insideSearchOnly.status, 'RESOLVED');
  assert.equal(outsideSearch.status, 'OUTSIDE_SEARCH_WINDOW');
});

test('resolver tool returns feedback without mutating Flight context or tool logs', async () => {
  const context = ensureFlightRuntimeContext({
    requestId: 'turn-1',
    sessionId: 'session-1',
    flight: { uid: 'date-user' },
    toolCallLog: [],
  });
  const requestContext = createRequestContext(
    context,
    createRequestClock({ now: NOW, timeZone: 'Asia/Kolkata' }),
  );
  const before = structuredClone(context);

  const result = await ResolveFlightDateTool.invoke(
    { context: requestContext },
    JSON.stringify(intent({ kind: 'weekend', relation: 'next' })),
    {},
  );

  assert.equal(ResolveFlightDateTool.name, RESOLVE_FLIGHT_DATE_TOOL_NAME);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.searchDate, '2026-08-08');
  assert.deepEqual(context, before);
  assert.equal(context.flightDate, undefined);
  assert.deepEqual(context.toolCallLog, []);
});

test('resolver feedback can feed search explicitly without hidden date state', async () => {
  const context = ensureFlightRuntimeContext({
    requestId: 'turn-2',
    sessionId: 'date-before-route',
    flight: { uid: 'date-user' },
  });
  const requestContext = createRequestContext(
    context,
    createRequestClock({ now: NOW, timeZone: 'Asia/Kolkata' }),
  );
  const resolved = await ResolveFlightDateTool.invoke(
    { context: requestContext },
    JSON.stringify(intent({ kind: 'weekend', relation: 'next' })),
    {},
  );

  const searchResult = await FlightSearchTool.invoke(
    { context: requestContext },
    JSON.stringify({
      onds: [
        {
          origin: 'DEL',
          destination: 'BOM',
          outbound_date: resolved.searchDate,
          return_date: null,
        },
      ],
      trip_type: 'oneway',
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin_class: 'economy',
    }),
    {},
  );

  assert.equal(context.flight.outboundDate, '2026-08-08');
  assert.equal(context.flightDate, undefined);
  assert.ok(searchResult.searchKey);
});

test('resolver is not registered on the Flight Agent tool list', () => {
  assert.deepEqual(
    flightTools.map((registeredTool) => registeredTool.name),
    [
      'flight_search',
      'getGeneratedContractsContext',
      'apply_filter',
      'price_prediction_tool',
      'update_flight_suggested_questions',
    ],
  );
});
