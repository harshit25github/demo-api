/** Applying one Trip v2 result: summary, Trip-owned state, chips and the Manager report. No model calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTripResult } from '../../src/agents/trip-planner-v2/apply.js';
import { createClientSummary } from '../../src/agents/trip-planner-v2/client-summary.js';
import { tripFeedbackSchema, type TripDay, type TripResult } from '../../src/agents/trip-planner-v2/schema.js';
import { describeTripForManager, describeTripForModel } from '../../src/agents/trip-planner-v2/state.js';

const NO_CHANGES = {
  origin: null, destination: null, outbound_date: null, return_date: null, duration_days: null,
  budget: null, tripType: null, passengerData: null, clear: [],
};

function result(fields: Partial<TripResult>): TripResult {
  return {
    status: 'success', intent: 'answer', trip: null, dateHint: null, options: null, plan: null, facts: null,
    summary: 'Done.', findings: [], limitations: [], nextStep: null, suggestions: [], ...fields,
  };
}

function context(): Record<string, any> {
  return { summaryContext: createClientSummary({}), tripPlanner: {}, currentUserMessage: 'hello' };
}

function day(number: number, title: string, places: string[] = []): TripDay {
  return { day: number, title, morning: `${title} morning`, afternoon: 'Rest through the heat', evening: 'Dinner in the old town', places };
}

const OPTIONS = [
  { code: 'SJU', city: 'San Juan', country: 'Puerto Rico', why: 'Beaches and Old San Juan', bestTime: 'Dec to Apr', cost: '$$' as const },
  { code: 'ctg', city: 'Cartagena', country: 'Colombia', why: 'Walled city and Caribbean food', bestTime: 'Dec to Apr', cost: '$' as const },
  { code: 'MID', city: 'Mérida', country: 'Mexico', why: 'Yucatán food and cenotes', bestTime: 'Nov to Mar', cost: '$' as const },
];
const APPLY = { researched: false, checkedOn: '2026-10-16' };

function planCartagena(state: Record<string, any>) {
  return applyTripResult(state, result({
    intent: 'plan',
    trip: { ...NO_CHANGES, destination: { city: 'Cartagena', iata: 'CTG' }, outbound_date: '2026-12-12', return_date: '2026-12-16' },
    plan: {
      scope: 'full',
      card: { country: 'Colombia', knownFor: 'Walled city and Caribbean food', bestTime: 'Dec to Apr', cost: '$' },
      days: [
        day(1, 'Arrival and the Walled City', ['Plaza de Santo Domingo', 'Walls of Cartagena']),
        day(2, 'Getsemaní street art', ['Getsemaní', 'Plaza de la Trinidad']),
        day(3, 'Rosario Islands', ['Rosario Islands']),
        day(4, 'Fortress and views', ['Castillo San Felipe de Barajas', 'Plaza de Santo Domingo']),
        day(5, 'Easy last morning', ['Las Bóvedas']),
      ],
      removeDays: [],
    },
    summary: 'Built a relaxed 5-day Cartagena plan.',
    findings: ['Day 3 is a full day on the Rosario Islands'],
    suggestions: ['Add a cooking class', 'Find a rooftop for sunset', 'Make day 3 shorter'],
  }), APPLY);
}

test('suggesting destinations saves the options, chips and travelers, and reports trip_options', () => {
  const state = context();
  state.tripPlanner.suggestions = ['Compare the food in all three'];
  const feedback = applyTripResult(state, result({
    intent: 'inspire',
    trip: { ...NO_CHANGES, passengerData: { total: 2, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] },
      tripType: { add: ['warm weather', 'budget-conscious'], remove: [] } },
    dateHint: 'December 2026',
    options: OPTIONS,
    summary: 'Suggested three warm, good-value places.',
    findings: ['Cartagena and Mérida stretch a budget furthest'],
    nextStep: 'Which one should I plan?',
    suggestions: ['Compare the food in all three', 'Would you like more ideas?', 'Plan 5 days in Mérida'],
  }), APPLY);

  assert.deepEqual(tripFeedbackSchema.parse(feedback), feedback);
  assert.equal(feedback.presentation, 'trip_options');
  assert.equal(feedback.nextStep, 'Which one should I plan?');
  assert.doesNotMatch(JSON.stringify(feedback), /formattingRules|imageUrl|https?:/);
  assert.equal(state.summaryContext.passengerData.total, 2);
  assert.deepEqual(state.summaryContext.tripType, ['warm weather', 'budget-conscious']);
  assert.equal(state.tripPlanner.dateHint, 'December 2026');
  assert.equal(state.tripPlanner.options[1].code, 'CTG');
  // The repeat of a chip already shown and the assistant-style chip are dropped, not retried.
  assert.deepEqual(state.tripPlanner.suggestions, ['Plan 5 days in Mérida']);
  assert.equal(state.tripPlanner.lastQuestion, 'Which one should I plan?');
});

test('a full plan saves the plan, the client summary and placesOfInterest, and reports trip_plan', () => {
  const state = context();
  state.tripPlanner.dateHint = 'December 2026';
  const feedback = planCartagena(state);
  assert.equal(feedback.presentation, 'trip_plan');
  assert.equal(state.summaryContext.destination.iata, 'CTG');
  assert.equal(state.summaryContext.duration_days, 4);
  assert.equal(state.tripPlanner.dateHint, null);
  assert.equal(state.tripPlanner.plan.days.length, 5);
  assert.deepEqual(state.summaryContext.placesOfInterest.slice(0, 2), [
    { placeName: 'Plaza de Santo Domingo', description: 'Day 1: Arrival and the Walled City' },
    { placeName: 'Walls of Cartagena', description: 'Day 1: Arrival and the Walled City' },
  ]);
  assert.equal(state.summaryContext.placesOfInterest.filter((place: any) => place.placeName === 'Plaza de Santo Domingo').length, 1);
});

test('a day edit replaces only that day, updates placesOfInterest and reports trip_days', () => {
  const state = context();
  planCartagena(state);
  const feedback = applyTripResult(state, result({
    intent: 'revise',
    trip: { ...NO_CHANGES, passengerData: { total: 3, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] },
      tripType: { add: ['minimal walking'], remove: [] } },
    plan: { scope: 'days', card: null, removeDays: [],
      days: [day(4, 'Gold Museum and a slow afternoon', ['Museo del Oro Zenú', 'Plaza de Bolívar'])] },
    summary: 'Made Day 4 low-walking.',
    nextStep: 'Day 2 is a walking tour too. Should I make it easier?',
  }), APPLY);

  assert.equal(feedback.presentation, 'trip_days');
  assert.deepEqual(feedback.presentationDays, [4]);
  assert.equal(state.tripPlanner.plan.days.length, 5);
  assert.equal(state.tripPlanner.plan.days[3].title, 'Gold Museum and a slow afternoon');
  assert.equal(state.tripPlanner.plan.days[0].title, 'Arrival and the Walled City');
  assert.equal(state.tripPlanner.plan.card.country, 'Colombia');
  const places = state.summaryContext.placesOfInterest.map((place: any) => place.placeName);
  assert.ok(places.includes('Museo del Oro Zenú'));
  assert.ok(!places.includes('Castillo San Felipe de Barajas'));
  assert.equal(state.summaryContext.passengerData.total, 3);
});

test('a new destination clears the old plan, facts and places before new content arrives', () => {
  const state = context();
  planCartagena(state);
  state.tripPlanner.facts = [{ text: 'A concert on Dec 14', source: 'City events office', day: 3, checkedOn: '2026-10-16' }];
  const feedback = applyTripResult(state, result({
    intent: 'details', trip: { ...NO_CHANGES, destination: { city: 'Mérida', iata: 'MID' } }, summary: 'Switched to Mérida.',
  }), APPLY);
  assert.equal(state.tripPlanner.plan, null);
  assert.deepEqual(state.tripPlanner.facts, []);
  assert.deepEqual(state.summaryContext.placesOfInterest, []);
  assert.equal(feedback.presentation, null);
});

test('researched facts need a completed search; with one they become sourced findings', () => {
  const unverified = context();
  const missing = applyTripResult(unverified, result({ intent: 'research', facts: [{ text: 'A concert on Dec 14', source: 'City events office', day: 3 }] }), APPLY);
  assert.equal(unverified.tripPlanner.facts, undefined);
  assert.ok(missing.limitations.includes('The requested current information could not be verified.'));

  const verified = context();
  const found = applyTripResult(verified, result({ intent: 'research', facts: [{ text: 'A concert on Dec 14', source: 'City events office', day: 3 }] }),
    { ...APPLY, researched: true });
  assert.deepEqual(found.findings, ['A concert on Dec 14 (City events office)']);
  assert.equal(verified.tripPlanner.facts[0].checkedOn, '2026-10-16');
});

test('a failed result changes nothing that was saved', () => {
  const state = context();
  planCartagena(state);
  const before = structuredClone(state);
  const feedback = applyTripResult(state, result({
    status: 'failure', trip: { ...NO_CHANGES, destination: { city: 'Lima', iata: 'LIM' } }, options: OPTIONS, summary: 'Could not finish.',
  }), APPLY);
  assert.equal(feedback.status, 'failure');
  assert.equal(feedback.presentation, null);
  assert.deepEqual(state, before);
});

test("Trip's input carries the saved trip, today's date and the traveler's own words", () => {
  const state = context();
  planCartagena(state);
  state.currentUserMessage = "my mom is coming too, she can't walk much";
  state.tripPlanner.lastQuestion = 'Want me to add a cooking class?';
  const text = describeTripForModel(state, { localDate: '2026-10-16', timeZone: 'America/New_York' });
  assert.match(text, /^<today>2026-10-16 · America\/New_York<\/today>/);
  assert.match(text, /destination: Cartagena \(CTG\)/);
  assert.match(text, /dates: 2026-12-12 to 2026-12-16 \(plan 5 days\)/);
  assert.match(text, /Day 4 Fortress and views \| Fortress and views morning/);
  assert.match(text, /last question: Want me to add a cooking class\?/);
  assert.match(text, /<traveler_said>my mom is coming too, she can't walk much<\/traveler_said>$/);
});

test("the Manager's trip lines resolve options and days without the plan text", () => {
  const state = context();
  applyTripResult(state, result({ intent: 'inspire', options: OPTIONS, nextStep: 'Which one should I plan?' }), APPLY);
  const lines = describeTripForManager(state);
  assert.equal(lines[1], '- Trip options shown: 1 San Juan, Puerto Rico; 2 Cartagena, Colombia; 3 Mérida, Mexico.');
  assert.equal(lines[2], '- Current trip plan: none.');
  assert.equal(lines[3], '- Last Trip question: "Which one should I plan?".');
  planCartagena(state);
  assert.match(describeTripForManager(state)[2], /^- Current trip plan: 5 days \(D1 Arrival and the Walled City; D2 /);
});
