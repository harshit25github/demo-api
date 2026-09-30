import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as tripPlannerTools from '../../src/agents/trip-planner/tools/index.js';
import { buildTripPlannerDynamicContext } from '../../src/agents/trip-planner/agent.js';
import {
  applyTripPlannerContextUpdate,
  prepareTripPlannerTurn,
} from '../../src/agents/trip-planner/context/lifecycle.js';

function createSummaryContext(overrides = {}): any {
  return {
    pax: null,
    budget: {
      total: null,
      amount: null,
      currency: null,
      per_person: null,
    },
    origin: {
      city: null,
      iata: null,
    },
    destination: {
      city: 'Paris',
      iata: 'PAR',
    },
    tripType: [],
    outbound_date: null,
    return_date: null,
    duration_days: null,
    upcomingEvents: [],
    placesOfInterest: [],
    suggestedQuestions: [],
    ...overrides,
  };
}

function createAppContext(summaryContext = createSummaryContext()): any {
  return {
    requestId: 'agent-owned-context-test',
    sessionId: 'agent-owned-context-session',
    summaryContext,
    tripPlanner: {},
    toolCallLog: [],
  };
}

test('context preparation does not interpret raw user language', () => {
  const appContext = createAppContext();

  prepareTripPlannerTurn({
    context: appContext,
    input: '2 ppl',
  });

  assert.equal(appContext.summaryContext.pax, null);
  assert.deepEqual(appContext.summaryContext.tripType, []);
});

test('structured context payload is accepted without deterministic text evidence', async () => {
  const appContext = createAppContext();
  prepareTripPlannerTurn({
    context: appContext,
    input: 'brief user wording not parsed by the tool',
  });

  const baseRevision = appContext.tripPlanner.contextRevision;
  const result = await applyTripPlannerContextUpdate(appContext, {
    baseRevision,
    contextPatch: {
      pax: 2,
      tripType: {
        add: ['couple'],
        remove: [],
      },
    },
    clearFields: [],
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(appContext.summaryContext.pax, 2);
  assert.deepEqual(appContext.summaryContext.tripType, ['couple']);
});

test('context and suggested-question updates are separate tools', () => {
  const contextTool = tripPlannerTools.UpdateTripPlannerContextTool;
  const suggestionsTool = tripPlannerTools.UpdateTripPlannerSuggestedQuestionsTool;

  assert.ok(contextTool);
  assert.ok(suggestionsTool);
  assert.notEqual(contextTool.name, suggestionsTool.name);
  assert.equal(contextTool.name, 'update_trip_planner_context');
  assert.equal(
    suggestionsTool.name,
    'update_trip_planner_suggested_questions',
  );
});

test('runtime context lifecycle does not import deterministic NLP extraction', async () => {
  const lifecycleSource = await readFile(
    new URL('../../src/agents/trip-planner/context/lifecycle.ts', import.meta.url),
    'utf8',
  );
  const toolsSource = await readFile(
    new URL('../../src/agents/trip-planner/tools/context-tools.ts', import.meta.url),
    'utf8',
  );

  for (const source of [lifecycleSource, toolsSource]) {
    assert.doesNotMatch(source, /inferTripPlannerSummaryPatch/);
    assert.doesNotMatch(source, /inferTripPlannerConversationalPatch/);
    assert.doesNotMatch(source, /inferTripPlannerExplicitClearFields/);
  }
});

test('context updater schema receives structured values, not raw user text', () => {
  const source: any = tripPlannerTools.tripPlannerContextUpdateInputSchema;

  assert.ok(source);
  assert.equal(source.shape.userMessage, undefined);
  assert.ok(source.shape.contextPatch);
  assert.ok(source.shape.clearFields);
  assert.equal(source.shape.suggestedQuestions, undefined);
});

test('suggested-question updater accepts only revision and suggestions', () => {
  const source: any = tripPlannerTools.tripPlannerSuggestedQuestionsInputSchema;

  assert.ok(source);
  assert.deepEqual(Object.keys(source.shape).sort(), [
    'baseRevision',
    'suggestedQuestions',
  ]);
});

test('dynamic context refreshes after structured context capture', async () => {
  const appContext = createAppContext();
  prepareTripPlannerTurn({
    context: appContext,
    input: '2 ppl',
  });

  const before = buildTripPlannerDynamicContext({ context: appContext });
  assert.match(before, /phase=context_capture/);
  assert.match(before, /required_first_tool=update_trip_planner_context/);
  assert.doesNotMatch(before, /^pax=2$/m);

  await applyTripPlannerContextUpdate(appContext, {
    baseRevision: appContext.tripPlanner.turnState.baseRevision,
    contextPatch: { pax: 2 },
    clearFields: null,
  });

  const after = buildTripPlannerDynamicContext({ context: appContext });
  assert.match(after, /phase=planning/);
  assert.match(after, /^pax=2$/m);
  assert.match(after, /^changed=pax$/m);
  assert.match(after, /^completed=traveler_count$/m);
});

test('structured preference changes expose completed suggestion categories', async () => {
  const appContext = createAppContext();
  prepareTripPlannerTurn({
    context: appContext,
    input: 'make it chill',
  });
  await applyTripPlannerContextUpdate(appContext, {
    baseRevision: appContext.tripPlanner.turnState.baseRevision,
    contextPatch: {
      tripType: { add: ['relaxed'], remove: [] },
    },
    clearFields: null,
  });

  const dynamicContext = buildTripPlannerDynamicContext({
    context: appContext,
  });
  assert.match(dynamicContext, /^completed=relaxed,pace$/m);
});
