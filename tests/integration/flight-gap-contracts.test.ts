import assert from 'node:assert/strict';
import test from 'node:test';
import { FlightSearchTool, validateFlightSearchInput } from '../../src/agents/flight/tools/search-tool.js';
import { ApplyFilterTool } from '../../src/agents/flight/tools/filter/tool.js';
import type { FlightFilter } from '../../src/agents/flight/tools/filter/normalization.js';
import { getFlightSearchRuntime } from '../../src/agents/flight/context/search-runtime-store.js';
import { ensureFlightRuntimeContext, prepareFlightAgentTurnContext } from '../../src/agents/flight/context/flight-context.js';
import { createRequestContext } from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';
import { buildFlightDateDynamicPromptContext } from '../../src/agents/flight/date/prompt-context.js';

function filter(filterType: FlightFilter['filterType'], fields: Partial<FlightFilter> = {}): FlightFilter {
  return {
    filterType, filterCode: null, minDurationMinutes: null, maxDurationMinutes: null,
    minPrice: null, maxPrice: null, airlineNames: null, layoverAirportNames: null,
    departureAirportNames: null, arrivalAirportNames: null, rawUserFilter: null, ...fields,
  };
}

const search = {
  onds: [{ origin: 'DEL', destination: 'DXB', outbound_date: '2026-10-20', return_date: null }],
  trip_type: 'oneway' as const,
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin_class: 'economy' as const,
};

async function invoke(tool: any, context: unknown, input: unknown) {
  const result = await tool.invoke({ context }, JSON.stringify(input), {});
  return typeof result === 'string' ? JSON.parse(result) : result;
}

test('mixed reset and addition clears prior constraints but applies the new ones in the same call', async () => {
  const context = ensureFlightRuntimeContext({ flight: { uid: 'mixed-reset-gap' } });
  await invoke(FlightSearchTool, context, search);
  const searchKey = context.flight.searchKey;
  await invoke(ApplyFilterTool, context, { filters: [
    filter('price', { maxPrice: 800, rawUserFilter: 'under $800' }),
    filter('baggage', { filterCode: '0', rawUserFilter: 'checked baggage' }),
  ] });
  context.currentUserMessage = 'Clear all filters and show nonstop morning flights';
  const result = await invoke(ApplyFilterTool, context, { filters: [
    filter('reset', { rawUserFilter: 'Clear all filters' }),
    filter('stops', { filterCode: '0', rawUserFilter: 'show nonstop' }),
    filter('departureTime', { filterCode: 'MORNING', rawUserFilter: 'morning flights' }),
  ] });
  assert.equal(result.ok, true);
  assert.equal(context.flight.searchKey, searchKey);
  assert.deepEqual(result.filters.map((value: FlightFilter) => value.filterType), ['stops', 'departureTime']);
  assert.deepEqual(result.finalFilterPayload, [
    { filterType: 'reset', Values: [] },
    { filterType: 'stop', Values: ['0'] },
    { filterType: 'departtimeslotfilter', Values: ['MORNING'] },
  ]);
  assert.deepEqual(getFlightSearchRuntime(searchKey)?.appliedFilters, result.filters);
  assert.ok(result.flights.every((flight: any) => flight.stops === 0 && flight.departure_time_window === 'MORNING'));
  assert.equal(context.toolCallLog.filter((entry: any) => entry.tool === 'flight_search').length, 1);
});

test('search and filter changes invalidate old suggestions without requiring the optional tool', async () => {
  const context = ensureFlightRuntimeContext({ flight: { uid: 'suggestion-invalidation-gap' } });
  context.flight.suggestedQuestions = ['Old route', 'Old dates', 'Old options'];
  await invoke(FlightSearchTool, context, search);
  assert.deepEqual(context.flight.suggestedQuestions, []);
  context.flight.suggestedQuestions = ['Show nonstop', 'Show morning', 'Old options'];
  await invoke(ApplyFilterTool, context, { filters: [filter('stops', { filterCode: '0', rawUserFilter: 'nonstop' })] });
  assert.deepEqual(context.flight.suggestedQuestions, []);
  context.flight.suggestedQuestions = ['Stale choice'];
  context.flight.searchKey = '';
  prepareFlightAgentTurnContext(context, { requestId: 'next-gap-turn' });
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('advertised search date bounds match validation across calendar and local-time boundaries', () => {
  for (const now of ['2026-01-31T23:30:00Z', '2026-12-31T23:30:00Z', '2028-02-28T23:30:00Z']) {
    const clock = createRequestClock({ now: new Date(now), timeZone: 'Asia/Kolkata' });
    const instructions = buildFlightDateDynamicPromptContext(clock);
    const bounds = instructions.match(/flight-search booking window: (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})/);
    assert.ok(bounds);
    for (const date of [bounds[1], bounds[2]]) {
      assert.equal(validateFlightSearchInput({ ...search, onds: [{ ...search.onds[0], outbound_date: date }] }, clock.localDate), null);
    }
    assert.equal(validateFlightSearchInput({ ...search, onds: [{ ...search.onds[0], outbound_date: clock.localDate }] }, clock.localDate)?.code, 'INVALID_SEARCH_INPUT');
    assert.ok(instructions.includes(`Current price prediction window: ${clock.localDate}`));
  }
});

test('round-trip validation preserves state until missing return timing is supplied', async () => {
  const state = ensureFlightRuntimeContext({ flight: { uid: 'return-timing-gap' } });
  const context = createRequestContext(state, createRequestClock({ now: new Date('2026-10-01T10:00:00Z'), timeZone: 'UTC' }));
  const result = await invoke(FlightSearchTool, context, { ...search, trip_type: 'roundtrip' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.recovery.fieldIssues.map((issue: any) => issue.path), ['onds.0.return_date']);
  assert.equal(state.flight.searchKey, '');
  const completed = await invoke(FlightSearchTool, context, {
    ...search, trip_type: 'roundtrip', onds: [{ ...search.onds[0], return_date: '2026-10-27' }],
  });
  assert.notEqual(completed.ok, false);
  assert.equal(state.flight.inboundDate, '2026-10-27');
});
