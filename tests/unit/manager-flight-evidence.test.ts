import assert from 'node:assert/strict';
import test from 'node:test';
import { activeFilterValues, comparableToolSequence, filterValueIssues, fullAirportGroupEvidence, payloadFieldIssues, dateSweepPromiseIssues, failedPredictionCtaIssues, type ObservedFlightToolCall } from '../live/manager-flight-evidence.js';
import { managerFlightComplexConversations } from '../fixtures/manager-flight-complex-conversations.js';
import { expectedFilterValues, expectedPredictionInput } from '../fixtures/manager-flight-complex-state.js';
import { managerFlightNormalizationConversation } from '../fixtures/manager-flight-normalization-conversation.js';

test('search payload evidence catches mixed names, dropped codes, and missing nullable fields', () => {
  const expected = { 'onds.0.origin': 'Delhi', 'onds.0.origin_iata': 'DEL', 'onds.0.origin_airport_name': null };
  assert.equal(payloadFieldIssues({ onds: [{ origin: 'Delhi DEL', origin_iata: null }] }, expected).length, 3);
  assert.deepEqual(payloadFieldIssues({ onds: [{ origin: 'Delhi', origin_iata: 'DEL', origin_airport_name: null }] }, expected), []);
  const city = { 'onds.0.destination': ['New York', 'New York City'] };
  assert.deepEqual(payloadFieldIssues({ onds: [{ destination: 'New York City' }] }, city), []);
  assert.equal(payloadFieldIssues({ onds: [{ destination: 'New York NYC' }] }, city).length, 1);
});

test('date-fallback evidence catches both observed sweep promises, not a bounded follow-up', () => {
  for (const feedback of [
    'Run separate searches for Oct 22-28.',
    'Should I go day-by-day through the whole range?',
    'Or confirm searching each day one at a time.',
    'Run the same search on another specific date to compare manually.',
  ]) assert.equal(dateSweepPromiseIssues(feedback).length, 1);
  assert.deepEqual(dateSweepPromiseIssues('Inspect the October 21 results; no cheapest day was verified.'), []);
});

test('failed-date CTA evidence rejects the observed repeated lookup, not current-option ranking', () => {
  assert.equal(failedPredictionCtaIssues(['Any cheaper dates nearby?']).length, 1);
  assert.deepEqual(failedPredictionCtaIssues(['Which current option is cheapest?', 'Remove the Air China filter', 'Change to business class']), []);
});

const call = (tool: string, output: any = { ok: true }): ObservedFlightToolCall =>
  ({ callId: tool, tool, input: {}, output, completed: true });

test('airport equivalence requires the complete group and verified original-result membership', () => {
  const sources = { departureAirport: [{ Code: 'LAX' }, { Code: 'BUR' }], arrivalAirport: [],
    flights: [{ departure_airport_code: 'LAX' }, { departure_airport_code: 'BUR' }] };
  const complete = fullAirportGroupEvidence({}, { departureAirport: ['BUR', 'LAX'] }, sources);
  assert.deepEqual(filterValueIssues(complete.values, { departureAirport: ['BUR', 'LAX'] }), []);
  assert.equal(complete.acceptableDeviations.length, 1);
  for (const [expected, evidence] of [
    [{ departureAirport: ['BUR'] }, sources],
    [{ departureAirport: ['BUR', 'LAX'] }, { ...sources, departureAirport: [] }],
    [{ departureAirport: ['BUR', 'LAX'] }, { ...sources, flights: [] }],
    [{ departureAirport: ['BUR', 'LAX'] }, { ...sources, flights: [{ departure_airport_code: 'SNA' }] }],
  ] as const) assert.deepEqual(fullAirportGroupEvidence({}, expected, evidence as any).values, {});
});

test('filter evidence detects wrong replacements, omitted alternatives, and changed limits even when categories match', () => {
  const actual = activeFilterValues([
    { filterType: 'departureTime', filterCode: 'MORNING' },
    { filterType: 'airline', filterCode: 'AC' },
    { filterType: 'totalDuration', maxDurationMinutes: 300 },
  ]);
  const issues = filterValueIssues(actual, { departureTime: ['EVENING'], airline: ['AC', 'EK'], totalDuration: [180] });
  assert.equal(issues.length, 3);
  assert.match(issues.join(' '), /MORNING/);
  assert.match(issues.join(' '), /EK/);
  assert.match(issues.join(' '), /300/);
  assert.deepEqual(filterValueIssues({ airline: ['EK', 'AC'] }, { airline: ['AC', 'EK'] }), []);
});

test('observed tool order retains unexpected prediction/filter calls and only collapses a rejected final CTA draft', () => {
  const actual = [call('flight_search'), call('price_prediction_tool'), call('apply_filter'), call('update_flight_suggested_questions')];
  assert.deepEqual(comparableToolSequence(actual), actual.map((entry) => entry.tool));
  const rejected = call('update_flight_suggested_questions', { ok: false, code: 'REPEATED_CTA_INTENT' });
  assert.deepEqual(comparableToolSequence([call('apply_filter'), rejected, call('update_flight_suggested_questions')]),
    ['apply_filter', 'update_flight_suggested_questions']);
  assert.equal(comparableToolSequence([call('update_flight_suggested_questions'), call('update_flight_suggested_questions')]).length, 2);
  assert.equal(comparableToolSequence([rejected, call('update_flight_suggested_questions'), call('flight_search')]).length, 3);
});

test('all five conversation definitions cover every tool and include complete value expectations', () => {
  const tools = ['flight_search', 'apply_filter', 'getGeneratedContractsContext', 'price_prediction_tool', 'update_flight_suggested_questions'];
  assert.equal(managerFlightComplexConversations.length, 5);
  for (const conversation of [...managerFlightComplexConversations, managerFlightNormalizationConversation]) {
    const observed = new Set(conversation.turns.flatMap((turn) => [...turn.expectedTools]));
    assert.deepEqual(tools.filter((tool) => !observed.has(tool as any)), []);
    assert.equal(expectedFilterValues[conversation.id].length, conversation.turns.length);
    for (const [index, turn] of conversation.turns.entries()) {
      assert.deepEqual(Object.keys(expectedFilterValues[conversation.id][index]).sort(), [...turn.expectedFilterTypes].sort());
      if (turn.expectedTools.includes('price_prediction_tool')) assert.ok(expectedPredictionInput[conversation.id][index + 1]);
    }
  }
});
