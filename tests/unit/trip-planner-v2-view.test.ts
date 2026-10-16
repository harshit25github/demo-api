/** The app-rendered trip view and its place in the Manager's reply. No model calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTripResult } from '../../src/agents/trip-planner-v2/apply.js';
import { createClientSummary } from '../../src/agents/trip-planner-v2/client-summary.js';
import type { TripResult } from '../../src/agents/trip-planner-v2/schema.js';
import { composeTripTurnReply } from '../../src/agents/trip-planner-v2/view.js';
import { sanitizeNoLinks } from '../../src/shared/text/link-sanitizer.js';

const APPLY = { researched: false, checkedOn: null };

function result(fields: Partial<TripResult>): TripResult {
  return {
    status: 'success', intent: 'inspire', trip: null, dateHint: null, options: null, plan: null, facts: null,
    summary: 'Done.', findings: [], limitations: [], nextStep: null, suggestions: [], ...fields,
  };
}

function optionsTurn(): Record<string, any> {
  const state: Record<string, any> = { summaryContext: createClientSummary({}), tripPlanner: {} };
  applyTripResult(state, result({ options: [
    { code: 'PAR', city: 'Paris', country: 'France', why: 'Art and classic food', bestTime: 'Apr to Jun', cost: '$$$' },
    { code: 'Lisbon', city: 'Lisbon', country: 'Portugal', why: 'Tiled streets and pastries', bestTime: 'Mar to Oct', cost: '$' },
  ] }), APPLY);
  return state;
}

const CARDS = [
  ':::cards',
  '[CARD]', 'title: Paris, France', 'image: https://images.example.test/paris.jpg', 'known_for: Art and classic food',
  'weather: Apr to Jun', 'budget: Splurge', '[/CARD]',
  '[CARD]', 'title: Lisbon, Portugal', 'image: Photo unavailable', 'known_for: Tiled streets and pastries',
  'weather: Mar to Oct', 'budget: Budget-friendly', '[/CARD]',
  ':::cards',
].join('\n');

test("destination options go under the Manager's first paragraph as the client card block", async () => {
  const reply = await composeTripTurnReply(optionsTurn(), 'Here are two picks ☀️\n\nWhich one should I plan?');
  assert.equal(reply.text, `Here are two picks ☀️\n\n${CARDS}\n\nWhich one should I plan?`);
  assert.equal(reply.tripView?.presentation, 'trip_options');
  assert.equal(reply.tripView?.cards[0].imageUrl, 'https://images.example.test/paris.jpg');
});

test('a one-paragraph reply gets the view after it, and so does a reply where Flight also answered', async () => {
  assert.equal((await composeTripTurnReply(optionsTurn(), 'Two picks.')).text, `Two picks.\n\n${CARDS}`);
  const mixed = optionsTurn();
  mixed.flightRanThisTurn = true;
  assert.equal((await composeTripTurnReply(mixed, 'Flights are below.\n\nAnd two trip ideas:')).text,
    `Flights are below.\n\nAnd two trip ideas:\n\n${CARDS}`);
});

test('a changed day renders without cards, with the three time-block labels', async () => {
  const state: Record<string, any> = { summaryContext: createClientSummary({ destination: { city: 'Rome', iata: 'ROM' } }), tripPlanner: {} };
  const days = [1, 2].map((day) => ({ day, title: `Theme ${day}`, morning: 'Forum walk', afternoon: 'Long lunch', evening: 'Trastevere stroll', places: [] }));
  applyTripResult(state, result({ intent: 'plan', plan: { scope: 'full', card: null, days, removeDays: [] } }), APPLY);
  await composeTripTurnReply(state, 'Your Rome plan.');
  applyTripResult(state, result({ intent: 'revise', plan: { scope: 'days', card: null, removeDays: [],
    days: [{ day: 2, title: 'Theme 2, gently', morning: 'Slow breakfast', afternoon: 'Rest', evening: 'Trastevere stroll', places: [] }] } }), APPLY);
  const reply = await composeTripTurnReply(state, 'Day 2 is gentler now.');
  assert.equal(reply.text, [
    'Day 2 is gentler now.', '',
    '**Day 2 — Theme 2, gently**', '🌅 **Morning:** Slow breakfast', '☀️ **Afternoon:** Rest', '🌙 **Evening:** Trastevere stroll',
  ].join('\n'));
});

test('a view goes out with one reply only, and a turn without one leaves the text unchanged', async () => {
  const state = optionsTurn();
  await composeTripTurnReply(state, 'Two picks.');
  assert.deepEqual(await composeTripTurnReply(state, 'Flights only this time.'), { text: 'Flights only this time.', tripView: null });
});

test('approved photos are cached on the trip, and the final link check keeps them', async () => {
  const state = optionsTurn();
  const reply = await composeTripTurnReply(state, 'Two picks.');
  assert.deepEqual(state.tripPlanner.photos, { PAR: 'https://images.example.test/paris.jpg' });
  assert.equal(sanitizeNoLinks(reply.text, { preserveCardImageUrls: true }).text, reply.text);
});
