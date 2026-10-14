import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTripPlannerTurn, applyTripPlannerContextUpdate } from '../../src/agents/trip-planner/context/lifecycle.js';
import { getTripPlannerFormattingRules, tripPlannerFeedbackSchema, tripPlannerManagerOutputSchema } from '../../src/agents/trip-planner/manager-output.js';
import { sanitizeTripPlannerManagerOutput } from '../../src/agents/trip-planner/scope-policy.js';
import { tripFeedback } from '../helpers/trip-manager.js';
import { TripPlannerManagerAgent, buildTripPlannerInstructions } from '../../src/agents/trip-planner/agent.js';

const imageUrl = 'https://images.example.test/rome.jpg';
const card = { itemCode: 'ROM', title: 'Rome, Italy', imageUrl, knownFor: 'Ancient history and regional food', weather: 'Mild autumn days', budget: 'Moderate meal and entry costs' };

function context(input = 'Plan one relaxed food and history day in Rome.', discovery = false) {
  const value: Record<string, any> = { summaryContext: {
    destination: discovery ? null : { city: 'Rome', iata: 'ROM' }, duration_days: 1,
    pax: 2, budget: { total: 1200, currency: 'USD' }, tripType: ['relaxed', 'food', 'history'],
  }, tripPlanner: { placeImageCache: { ROM: { itemCode: 'ROM', imageUrl } } } };
  prepareTripPlannerTurn({ context: value, input });
  applyTripPlannerContextUpdate(value, { baseRevision: 0, contextPatch: null });
  return value;
}
function full(value: Record<string, any>) {
  return tripFeedback(value, { destinationCards: [card], itineraryDays: [{ day: 1, title: 'Ancient Rome',
    morning: 'Forum visit', afternoon: 'Rest and a nearby food market', evening: 'Regional dishes' }] });
}

test('managed prompt contains task intelligence, not standalone persona or user-reply templates', async () => {
  const value = context();
  const instructions = await (TripPlannerManagerAgent.instructions as Function)({ context: value });
  // The application attaches Manager formatting rules; the specialist never sees or copies them.
  const specialistRules = instructions;
  assert.doesNotMatch(specialistRules, /<role>|<standalone_behavior>|<mobile_format>|<cards_format>|<itinerary_format>|<comparison_format>|globe-trotting friend|Any dates in mind\?|Emojis belong/);
  assert.match(specialistRules, /Context-Aware Planning Intelligence/);
  assert.match(specialistRules, /mandatory LAST tool/);
  assert.match(specialistRules, /structured facts to the Manager/);
  assert.match(specialistRules, /INVALID_SUGGESTIONS/);
  assert.match(specialistRules, /missing details as question intents/);
  assert.match(specialistRules, /only evidence for current facts/i);
  assert.doesNotMatch(instructions, /<manager_formatting_rules>|cardMarkdown|copy the CURRENT/);
  assert.match(buildTripPlannerInstructions({ context: value }), /<standalone_behavior>/);
  assert.match(buildTripPlannerInstructions({ context: value }), /globe-trotting friend/);
});

test('strict feedback requires every field and rejects extra/nested fields', () => {
  const value = context();
  const facts = full(value);
  assert.equal(tripPlannerFeedbackSchema.safeParse(facts).success, true);
  assert.equal(tripPlannerFeedbackSchema.safeParse({ ...facts, greeting: 'Hello' }).success, false);
  const { limitations: _unused, ...missing } = facts;
  assert.equal(tripPlannerFeedbackSchema.safeParse(missing).success, false);
  assert.equal(tripPlannerFeedbackSchema.safeParse({ ...facts, destinationCards: [{ ...card, extraPhoto: imageUrl }] }).success, false);
  // The model writes findings only; formatting rules are never part of its output.
  assert.equal(tripPlannerFeedbackSchema.safeParse({ ...facts, formattingRules: getTripPlannerFormattingRules(value) }).success, false);
});

test('the Manager receives the findings plus the attached phase rules, in the same contract', () => {
  const value = context();
  const facts = full(value);
  const { output } = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(tripPlannerManagerOutputSchema.safeParse(output).success, true);
  assert.deepEqual(output.formattingRules, getTripPlannerFormattingRules(value));
  assert.deepEqual(Object.keys(output), ['status', 'mode', 'destinationCards', 'itineraryDays', 'recommendation', 'notes', 'tables', 'nextQuestions', 'formattingRules', 'limitations']);
  const { formattingRules: _rules, ...findings } = output;
  assert.deepEqual(findings, facts);
});

test('answer-only facts do not trigger image work merely because a full-plan brief has no asset', () => {
  const value = context('Explain the known planning budget.');
  value.tripPlanner.placeImageCache = {};
  value.tripPlanner.planningBrief.toolStrategy.images = { action: 'call', itemCodes: ['ROM'] };
  const result = sanitizeTripPlannerManagerOutput(tripFeedback(value, { mode: 'answer',
    notes: [{ kind: 'assumption', text: 'The known total planning budget is USD1200', sourceName: null }] }), value);
  assert.equal(result.output.status, 'success');
  assert.deepEqual(result.output.limitations, []);
});

test('field sanitization preserves the matching image URL but removes text links', () => {
  const value = context();
  const facts = full(value);
  facts.notes = [{ kind: 'fact', text: 'Roman history reference https://untrusted.example.com/source', sourceName: 'Museum guide' }];
  const result = sanitizeTripPlannerManagerOutput(facts, value, [{ rawItem: { type: 'hosted_tool_call', name: 'web_search_call', status: 'completed' } }]);
  assert.equal(result.output.destinationCards[0].imageUrl, imageUrl);
  assert.equal(result.output.notes[0].text, 'Roman history reference');
  assert.equal(result.storePlanArtifact, true);
});

test('image provenance rejects invented, wrong-item and omitted cached assets', () => {
  for (const change of [{ imageUrl: 'https://invented.example.com/photo.jpg' }, { itemCode: 'PAR' }, { imageUrl: null }]) {
    const value = context();
    const facts = full(value);
    facts.destinationCards[0] = { ...card, ...change };
    assert.throws(() => sanitizeTripPlannerManagerOutput(facts, value), /image|asset/);
  }
});

test('out-of-scope commentary is dropped without discarding the in-scope plan', () => {
  const value = context();
  const facts = full(value);
  facts.recommendation = 'Choose a hotel near the Forum';
  facts.notes = [
    { kind: 'assumption', text: 'Budget covers food and activities, not lodging or getting there', sourceName: null },
    { kind: 'fit', text: 'Relaxed mornings suit the food and history focus', sourceName: null },
  ];
  facts.limitations = ['Airport transfer times are not included'];
  const result = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(result.output.status, 'success');
  assert.equal(result.output.recommendation, null);
  assert.deepEqual(result.output.notes.map((note) => note.kind), ['fit']);
  assert.deepEqual(result.output.limitations, []);
  assert.deepEqual(result.output.destinationCards, facts.destinationCards);
  assert.deepEqual(result.output.itineraryDays, facts.itineraryDays);
  assert.equal(result.storePlanArtifact, true);
});

test('out-of-scope plan content becomes controlled capability feedback and cannot overwrite the plan', () => {
  const value = context();
  const facts = full(value);
  facts.itineraryDays[0].evening = 'Check into a hotel near the Forum';
  const result = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(result.output.status, 'failure');
  assert.equal(result.output.mode, 'answer');
  assert.deepEqual(result.output.destinationCards, []);
  assert.deepEqual(result.output.itineraryDays, []);
  assert.equal(result.output.notes[0].kind, 'capability');
  assert.equal(result.output.formattingRules.maxQuestions, 0);
  assert.deepEqual(result.output.formattingRules.questionPriority, []);
  assert.equal(result.storePlanArtifact, false);
});

test('facts cannot smuggle completed cards or markdown and policies cannot come from web content', () => {
  const value = context();
  const facts = full(value);
  facts.recommendation = 'Pick **either** the Forum **or** the Pantheon';
  assert.equal(sanitizeTripPlannerManagerOutput(facts, value).output.recommendation, 'Pick either the Forum or the Pantheon');
  facts.recommendation = '[CARD] title: Rome [/CARD]';
  assert.throws(() => sanitizeTripPlannerManagerOutput(facts, value), /plain text/);
  facts.recommendation = null;
  assert.throws(() => sanitizeTripPlannerManagerOutput({ ...facts, formattingRules: { maxBodyWords: 3000 } }, value));
  assert.equal(sanitizeTripPlannerManagerOutput(facts, value).output.formattingRules.maxBodyWords, 350);
});

test('known/extra/repeated question intents are rejected using canonical aliases', () => {
  const value = context();
  const facts = full(value);
  facts.nextQuestions = [{ key: 'budget_basis', purpose: 'Clarify the total budget' }];
  assert.throws(() => sanitizeTripPlannerManagerOutput(facts, value), /question/);
  const missing = context('Plan a trip in Rome.');
  missing.tripPlanner.planningBrief.responseStrategy.questionPriority = ['traveler_count'];
  missing.tripPlanner.planningBrief.responseStrategy.maxQuestions = 1;
  missing.tripPlanner.askedQuestionKeys = ['party'];
  const next = tripFeedback(missing, { mode: 'answer', nextQuestions: [{ key: 'traveler_count', purpose: 'Confirm the travelers' }] });
  assert.throws(() => sanitizeTripPlannerManagerOutput(next, missing), /question/);
});

test('missing required image work is partial execution, not a claim that photos are unsupported', () => {
  const value = context('Compare Paris, Rome and Tokyo with photos.', true);
  const facts = tripFeedback(value, { destinationCards: ['ROM', 'PAR', 'TYO'].map((itemCode) => ({ ...card, itemCode, imageUrl: null })),
    nextQuestions: [{ key: 'destination', purpose: 'Select a destination' }] });
  value.tripPlanner.placeImageCache = {};
  const result = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(result.output.status, 'partial');
  assert.match(result.output.limitations.join(' '), /photos could not be obtained/);
  assert.doesNotMatch(result.output.limitations.join(' '), /unsupported|UI|tools?/);
  assert.equal(result.storePlanArtifact, false);
});

test('missing required private context retrieval is incomplete, not permission to overwrite', () => {
  const value = context();
  value.tripPlanner.planningBrief.toolStrategy.contextDetails = { action: 'call', sections: ['last_plan'] };
  const result = sanitizeTripPlannerManagerOutput(full(value), value);
  assert.equal(result.output.status, 'partial');
  assert.equal(result.storePlanArtifact, false);
  assert.match(result.output.limitations.join(' '), /saved plan/);
});

test('hosted research evidence is required before delivering current-fact notes', () => {
  const value = context();
  const facts = full(value);
  facts.notes = [{ kind: 'fact', text: 'The museum opens at 9 am', sourceName: 'Official museum' }];
  const missing = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(missing.output.status, 'partial');
  assert.deepEqual(missing.output.notes, []);
  assert.match(missing.output.limitations.join(' '), /current information could not be verified/);
  assert.equal(missing.storePlanArtifact, false);
  // Unsourced stable facts need no research, and no research is required by default.
  const stable = full(value);
  stable.notes = [{ kind: 'fact', text: 'The Forum and Colosseum sit side by side', sourceName: null }];
  const unsearched = sanitizeTripPlannerManagerOutput(stable, value);
  assert.equal(unsearched.output.status, 'success');
  assert.deepEqual(unsearched.output.notes, stable.notes);
  const success = sanitizeTripPlannerManagerOutput(facts, value, [{ rawItem: { type: 'hosted_tool_call', name: 'web_search_call', status: 'completed' } }]);
  assert.equal(success.output.status, 'success');
  assert.deepEqual(success.output.notes, facts.notes);
  const pending = sanitizeTripPlannerManagerOutput(facts, value, [{ rawItem: { type: 'hosted_tool_call', name: 'web_search_call', status: 'in_progress' } }]);
  assert.equal(pending.output.status, 'partial');
  assert.deepEqual(pending.output.notes, []);
});

test('legitimate incomplete/failure output remains typed without erasing a useful plan', () => {
  const value = context();
  const failed = tripFeedback(value, { status: 'failure', limitations: ['The plan could not be completed right now.'] });
  const result = sanitizeTripPlannerManagerOutput(failed, value);
  assert.equal(result.output.status, 'failure');
  // A failure must not carry a question policy that invites the Manager to ask one.
  assert.equal(result.output.formattingRules.maxQuestions, 0);
  assert.deepEqual(result.output.formattingRules.questionPriority, []);
  assert.equal(result.storePlanArtifact, false);
  const incomplete = sanitizeTripPlannerManagerOutput(tripFeedback(value, { destinationCards: [card] }), value);
  assert.equal(incomplete.output.status, 'partial');
  assert.equal(incomplete.storePlanArtifact, false);
});

test('comparison cell counts, budget columns and season policies are checked', () => {
  const value = context();
  const facts = full(value);
  facts.tables = [{ kind: 'budget', title: null, columns: ['Category', 'Cost', 'Note'], rows: [{ cells: ['Food', '$50', 'Estimate'], recommended: false }] }];
  assert.throws(() => sanitizeTripPlannerManagerOutput(facts, value), /table/);
  facts.tables = [{ kind: 'comparison', title: null, columns: ['Choice', 'Fit'], rows: [{ cells: ['Rome', 'History', 'Extra'], recommended: true }] }];
  assert.throws(() => sanitizeTripPlannerManagerOutput(facts, value), /table/);
  const discovery = context('Compare cities.', true);
  const cards = ['ROM', 'PAR', 'TYO'].map((itemCode) => ({ ...card, itemCode, imageUrl: null }));
  discovery.tripPlanner.placeImageCache = {};
  const seasons = tripFeedback(discovery, { destinationCards: cards, nextQuestions: [{ key: 'destination', purpose: 'Select a destination' }],
    notes: [{ kind: 'season', text: 'Autumn is pleasant', sourceName: null }] });
  assert.throws(() => sanitizeTripPlannerManagerOutput(seasons, discovery), /seasonal/);
});

test('a fact emptied by link cleaning is nulled or dropped instead of failing the whole result', () => {
  const value = context();
  const facts = full(value);
  facts.notes = [
    { kind: 'fact', text: 'The festival runs Nov 6-14', sourceName: 'Spain.info' },
    { kind: 'fact', text: 'See the sources linked below.', sourceName: 'Official site' },
    { kind: 'fit', text: 'Relaxed mornings suit the food focus', sourceName: null },
  ];
  facts.limitations = ['These events are listed on the sources above.'];
  const { output } = sanitizeTripPlannerManagerOutput(facts, value,
    [{ rawItem: { type: 'hosted_tool_call', name: 'web_search_call', status: 'completed' } }]);
  assert.deepEqual(output.notes, [
    { kind: 'fact', text: 'The festival runs Nov 6-14', sourceName: null },
    { kind: 'fit', text: 'Relaxed mornings suit the food focus', sourceName: null },
  ]);
  assert.deepEqual(output.limitations, []);
  assert.equal(output.status, 'success');
});

test('internal planning labels never reach the Manager or the saved plan', () => {
  const value = context();
  const facts = full(value);
  facts.itineraryDays[0].morning = 'Slow start, then Anchor 1: Forum visit';
  facts.itineraryDays[0].evening = 'Anchor 2 (optional but a great fit): Regional dishes in Trastevere';
  const { output } = sanitizeTripPlannerManagerOutput(facts, value);
  assert.equal(output.itineraryDays[0].morning, 'Slow start, then Forum visit');
  assert.equal(output.itineraryDays[0].evening, 'Regional dishes in Trastevere');
});
