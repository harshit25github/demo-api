/** The app-rendered trip view and its place in the Manager's reply. No model calls. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTripResult } from '../../src/agents/trip-planner-v2/apply.js';
import { createClientSummary } from '../../src/agents/trip-planner-v2/client-summary.js';
import { startTripPhotoLookup } from '../../src/agents/trip-planner-v2/photos.js';
import type { TripResult } from '../../src/agents/trip-planner-v2/result.js';
import { buildTripView, composeTripReply, composeTripTurnReply, renderTripMarkdown } from '../../src/agents/trip-planner-v2/view.js';
import { sanitizeNoLinks } from '../../src/shared/text/link-sanitizer.js';

function result(fields: Partial<TripResult>): TripResult {
  return {
    status: 'success', intent: 'inspire', trip: null, dateHint: null, options: null, plan: null, facts: null,
    summary: 'Done.', findings: [], limitations: [], nextStep: null, suggestions: [], ...fields,
  };
}

function optionsTurn(requestId = 'req-1') {
  const state: Record<string, any> = { requestId, summaryContext: createClientSummary({}), tripPlanner: {} };
  applyTripResult(state, result({ options: [
    { code: 'PAR', city: 'Paris', country: 'France', why: 'Art and classic food', bestTime: 'Apr to Jun', cost: '$$$' },
    { code: 'LIS', city: 'Lisbon', country: 'Portugal', why: 'Tiled streets and pastries', bestTime: 'Mar to Oct', cost: '$' },
  ] }), { requestId, researched: false, checkedOn: null });
  return state;
}

test('destination options render as the client card block with the five fields in order', () => {
  const state = optionsTurn();
  state.tripPlanner.photos = { PAR: 'https://images.example.test/paris.jpg' };
  const view = buildTripView(state);
  assert.ok(view);
  assert.equal(renderTripMarkdown(view), [
    ':::cards',
    '[CARD]', 'title: Paris, France', 'image: https://images.example.test/paris.jpg', 'known_for: Art and classic food',
    'weather: Apr to Jun', 'budget: Splurge', '[/CARD]',
    '[CARD]', 'title: Lisbon, Portugal', 'image: Photo unavailable', 'known_for: Tiled streets and pastries',
    'weather: Mar to Oct', 'budget: Budget-friendly', '[/CARD]',
    ':::cards',
  ].join('\n'));
});

test('a changed day renders without cards and with the three time-block labels', () => {
  const state: Record<string, any> = { requestId: 'req-1', summaryContext: createClientSummary({ destination: { city: 'Rome', iata: 'ROM' } }), tripPlanner: {} };
  const days = [1, 2].map((day) => ({ day, title: `Theme ${day}`, morning: 'Forum walk', afternoon: 'Long lunch', evening: 'Trastevere stroll', places: [] }));
  applyTripResult(state, result({ intent: 'plan', plan: { scope: 'full', card: null, days, removeDays: [] } }), { requestId: 'req-1', researched: false, checkedOn: null });
  state.requestId = 'req-2';
  applyTripResult(state, result({ intent: 'revise', plan: { scope: 'days', card: null, removeDays: [],
    days: [{ day: 2, title: 'Theme 2, gently', morning: 'Slow breakfast', afternoon: 'Rest', evening: 'Trastevere stroll', places: [] }] } }),
  { requestId: 'req-2', researched: false, checkedOn: null });
  assert.equal(renderTripMarkdown(buildTripView(state)!), [
    '**Day 2 — Theme 2, gently**', '🌅 **Morning:** Slow breakfast', '☀️ **Afternoon:** Rest', '🌙 **Evening:** Trastevere stroll',
  ].join('\n'));
});

test("a view from another request is never shown", () => {
  const state = optionsTurn('req-1');
  state.requestId = 'req-2';
  assert.equal(buildTripView(state), null);
});

test("the view goes under the Manager's first paragraph, or after the reply when Flight also answered", () => {
  const view = ':::cards\n[CARD]\n[/CARD]\n:::cards';
  assert.equal(composeTripReply('Here are three picks ☀️\n\nWhich one should I plan?', view),
    `Here are three picks ☀️\n\n${view}\n\nWhich one should I plan?`);
  assert.equal(composeTripReply('Here are three picks.', view), `Here are three picks.\n\n${view}`);
  assert.equal(composeTripReply('Flights below.\n\nAnd your trip:', view, { afterReply: true }), `Flights below.\n\nAnd your trip:\n\n${view}`);
  assert.equal(composeTripReply('No trip content.', ''), 'No trip content.');
});

test('the reply waits for approved photos, and the final link check keeps them', async () => {
  const state = optionsTurn();
  startTripPhotoLookup(state, ['PAR', 'LIS']);
  const reply = await composeTripTurnReply(state, 'Two easy picks.\n\nWhich one should I plan?');
  assert.ok(reply.tripView);
  assert.match(reply.text, /image: https:\/\/images\.example\.test\/paris\.jpg/);
  assert.match(reply.text, /image: https:\/\/images\.example\.test\/fallback-lis\.jpg/);
  const sanitized = sanitizeNoLinks(reply.text, { preserveCardImageUrls: true });
  assert.equal(sanitized.text, reply.text);
});
