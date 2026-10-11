import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRIP_PLANNER, TRIP_PLANNER_STANDALONE_PRESENTATION } from '../../src/agents/trip-planner/prompt.js';
import { buildTripPlannerPlanningBrief } from '../../src/agents/trip-planner/context/planning-brief.js';
import { createTripPlannerSummaryContext } from '../../src/agents/trip-planner/context/summary-context.js';
import {
  buildTripPlannerCompactContext,
} from '../../src/agents/trip-planner/context/serializer.js';
import {
  getTripPlannerContextDetails,
} from '../../src/agents/trip-planner/context/store.js';
import {
  classifyTripPlannerScopeRequest,
  sanitizeTripPlannerFinalOutput,
  sanitizeTripPlannerOutput,
  validateTripPlannerScopeText,
  validateTripPlannerSuggestedQuestions,
} from '../../src/agents/trip-planner/scope-policy.js';
import {
  trimTripPlannerSessionItems,
} from '../../src/agents/trip-planner/session.js';
import {
  applyTripPlannerContextUpdate,
  applyTripPlannerSuggestedQuestionsUpdate,
  finalizeTripPlannerTurn,
  prepareTripPlannerTurn,
} from '../../src/agents/trip-planner/context/lifecycle.js';
import { TripPlannerAgent as TripPlannerAgentDefinition } from '../../src/agents/trip-planner/agent.js';
import {
  GetPlaceImagesBatchTool as GetPlaceImagesBatchToolDefinition,
  GetTripPlannerContextDetailsTool as GetTripPlannerContextDetailsToolDefinition,
  UpdateTripPlannerContextTool as UpdateTripPlannerContextToolDefinition,
  UpdateTripPlannerSuggestedQuestionsTool as UpdateTripPlannerSuggestedQuestionsToolDefinition,
} from '../../src/agents/trip-planner/tools/index.js';

const TripPlannerAgent: any = TripPlannerAgentDefinition;
const GetPlaceImagesBatchTool: any = GetPlaceImagesBatchToolDefinition;
const GetTripPlannerContextDetailsTool: any = GetTripPlannerContextDetailsToolDefinition;
const UpdateTripPlannerContextTool: any = UpdateTripPlannerContextToolDefinition;
const UpdateTripPlannerSuggestedQuestionsTool: any =
  UpdateTripPlannerSuggestedQuestionsToolDefinition;

function completeContext(overrides = {}) {
  return createTripPlannerSummaryContext({
    pax: 2,
    budget: {
      total: 2000,
      amount: 2000,
      currency: 'USD',
      per_person: false,
    },
    origin: { city: 'Delhi', iata: 'DEL' },
    destination: { city: 'Paris', iata: 'PAR' },
    tripType: ['roundtrip', 'balanced', 'food'],
    outbound_date: '2026-09-10',
    return_date: '2026-09-14',
    duration_days: 5,
    upcomingEvents: [{ name: 'Saved event', description: 'Saved detail' }],
    placesOfInterest: [
      { placeName: 'Saved place', description: 'Saved place detail' },
    ],
    suggestedQuestions: [
      'Add local food spots',
      'Show budget-friendly activities',
      'Make the itinerary relaxed',
    ],
    ...overrides,
  });
}

function preparedContext(input, summaryContext = completeContext(), requestId = 'request-1'): any {
  const context = {
    requestId,
    sessionId: 'session-1',
    summaryContext,
    tripPlanner: {},
  };
  prepareTripPlannerTurn({
    context,
    input,
    requestId,
    sessionId: context.sessionId,
  });
  return context;
}

function capturePreparedContext(context, contextPatch = null, clearFields = null) {
  return applyTripPlannerContextUpdate(context, {
    baseRevision: context.tripPlanner.turnState.baseRevision,
    contextPatch,
    clearFields,
  });
}

describe('Trip Planner optimization and scope policy', () => {
  it('classifies prohibited-only and mixed requests without substring false positives', () => {
    const excluded = [
      'Find a hotel in Paris',
      'Where should I stay in Paris?',
      'Book an airport transfer',
      'Arrange a car rental',
      'Show local transport options',
      'Call a taxi for me',
      'Book train tickets',
    ];
    for (const input of excluded) {
      assert.equal(classifyTripPlannerScopeRequest(input).mode, 'excluded', input);
    }

    assert.equal(
      classifyTripPlannerScopeRequest('Plan food activities and find a hotel').mode,
      'mixed',
    );
    assert.equal(classifyTripPlannerScopeRequest('Plan a business trip').mode, 'in_scope');
    assert.equal(classifyTripPlannerScopeRequest('Keep the pace relaxed and stay flexible').mode, 'in_scope');
    assert.equal(classifyTripPlannerScopeRequest('Visit the railway museum').mode, 'in_scope');
  });

  it('replaces prohibited final output while preserving card image URLs during scanning', () => {
    const unsafe = sanitizeTripPlannerFinalOutput(
      'Try a central hotel, then visit the museum.',
    );
    assert.equal(unsafe.changed, true);
    assert.match(unsafe.text, /day-wise itineraries/);

    const card = [
      ':::cards',
      '[CARD]',
      'title: Paris, France',
      'image: https://images.example.test/hotel-view.jpg',
      'known_for: Art and food',
      'weather: Mild in September',
      'budget: Balanced',
      '[/CARD]',
      ':::cards',
    ].join('\n');
    assert.equal(validateTripPlannerScopeText(card).ok, true);
  });

  it('preserves discovery cards with a deterministic scope fallback', () => {
    const context = {
      tripPlanner: {
        planningBrief: {
          responseStrategy: { renderMode: 'discovery_cards' },
        },
        placeImageCache: {
          PAR: { imageUrl: 'https://images.example.test/paris.jpg' },
          ROM: { imageUrl: 'https://images.example.test/rome.jpg' },
          TYO: { imageUrl: 'https://images.example.test/tokyo.jpg' },
        },
      },
    };
    const result = sanitizeTripPlannerFinalOutput(
      'Choose a hotel in one of these cities.',
      { context },
    );

    assert.equal(result.changed, true);
    assert.equal((result.text.match(/\[CARD\]/g) || []).length, 3);
    assert.match(result.text, /Paris, France/);
    assert.match(result.text, /Rome, Italy/);
    assert.match(result.text, /Tokyo, Japan/);
    assert.equal(validateTripPlannerScopeText(result.text).ok, true);
  });

  it('applies scope validation before the existing link guardrail', () => {
    const result = sanitizeTripPlannerOutput('Use a taxi, then see https://example.com/details', {});

    assert.match(result.output, /day-wise itineraries/);
    assert.doesNotMatch(result.output, /https?:\/\//);
    assert.equal(result.scopeGuardrail.changed, true);
    assert.equal(result.scopeGuardrail.violationCount, 1);
  });

  it('accepts only three short fresh scope-safe suggestions', () => {
    const valid = validateTripPlannerSuggestedQuestions([
      'Add local food spots',
      'Improve the second day',
      'Make the itinerary relaxed',
    ]);
    assert.equal(valid.ok, true);
    assert.equal(
      validateTripPlannerSuggestedQuestions([
        'Find the best Paris bakeries',
        'Pick my top three sights',
        'Suggest easy day trips',
      ]).ok,
      true,
    );

    const prohibited = validateTripPlannerSuggestedQuestions([
      'Add local food spots',
      'Suggest central hotels nearby',
      'Make the itinerary relaxed',
    ]);
    assert.equal(prohibited.ok, false);
    assert.equal(prohibited.issues.includes('scope_violation_1'), true);

    const stale = validateTripPlannerSuggestedQuestions(
      [
        'Add local food spots',
        'Improve the second day',
        'Make the itinerary relaxed',
      ],
      { previousSuggestions: ['Add local food spots'] },
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.issues.includes('stale_suggestion_0'), true);
  });

  it('rejects the entire first invalid suggestion update without stale mutation', () => {
    const context = preparedContext('Make this more food-focused');
    const capture = capturePreparedContext(context, {
      tripType: { add: ['food'], remove: [] },
    });
    const before = [...context.summaryContext.suggestedQuestions];
    const result = applyTripPlannerSuggestedQuestionsUpdate(context, {
      baseRevision: capture.revision,
      suggestedQuestions: [
        'Add local food spots',
        'Suggest central hotels nearby',
        'Improve the second day',
      ],
    });

    assert.equal(result.status, 'INVALID_SUGGESTIONS');
    assert.deepEqual(context.summaryContext.suggestedQuestions, before);
    assert.equal(context.tripPlanner.turnState.suggestionsUpdated, false);
  });

  it('does not generate fallback suggestions after invalid agent payloads', () => {
    const context = preparedContext('Make this more food-focused');
    const capture = capturePreparedContext(context, {
      tripType: { add: ['food'], remove: [] },
    });
    const input = {
      baseRevision: capture.revision,
      suggestedQuestions: [
        'Add local food spots',
        'Suggest central hotels nearby',
        'Improve the second day',
      ],
    };

    assert.equal(
      applyTripPlannerSuggestedQuestionsUpdate(context, input).status,
      'INVALID_SUGGESTIONS',
    );
    const second = applyTripPlannerSuggestedQuestionsUpdate(context, input);
    assert.equal(second.status, 'INVALID_SUGGESTIONS');
    finalizeTripPlannerTurn({ context, output: 'Safe response.' });
    assert.deepEqual(context.summaryContext.suggestedQuestions, []);
  });

  it('accepts agent-prepared fields while rejecting prohibited preferences', () => {
    const context = preparedContext('Make it food-focused');
    const result = applyTripPlannerContextUpdate(context, {
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: {
        destination: { city: 'Rome', iata: 'ROM' },
        tripType: { add: ['hotel', 'food'], remove: null },
      },
      clearFields: null,
    });

    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.rejectedFields.includes('tripType.add'), true);
    assert.equal(context.summaryContext.destination.city, 'Rome');
    assert.equal(context.summaryContext.tripType.includes('food'), true);
    assert.equal(context.summaryContext.tripType.includes('hotel'), false);
  });

  it('returns context revision conflicts without changing summary state', () => {
    const context = preparedContext('Plan my trip');
    const before = createTripPlannerSummaryContext(context.summaryContext);
    const result = applyTripPlannerContextUpdate(context, {
      baseRevision: context.tripPlanner.turnState.baseRevision + 1,
      contextPatch: { pax: 4 },
      clearFields: null,
    });

    assert.equal(result.status, 'REVISION_CONFLICT');
    assert.deepEqual(context.summaryContext, before);
  });

  it('makes successful updater requests idempotent by request id', () => {
    const context = preparedContext('Plan my trip');
    const input = {
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: null,
      clearFields: null,
    };
    const first = applyTripPlannerContextUpdate(context, input);
    const revision = first.revision;
    const second = applyTripPlannerContextUpdate(context, input);

    assert.equal(first.status, 'SUCCESS');
    assert.equal(second.status, 'ALREADY_UPDATED');
    assert.equal(second.revision, revision);
  });

  it('preserves unchanged context and invalidates destination-sensitive details', () => {
    const context = {
      requestId: 'destination-change',
      sessionId: 'session-1',
      summaryContext: completeContext(),
      tripPlanner: {
        placeImageCache: {
          PAR: { itemCode: 'PAR', imageUrl: 'https://images.example.test/paris.jpg' },
          ROM: { itemCode: 'ROM', imageUrl: 'https://images.example.test/rome.jpg' },
        },
      },
    };
    prepareTripPlannerTurn({
      context,
      input: 'Change destination to Rome',
      requestId: context.requestId,
      sessionId: context.sessionId,
    });
    capturePreparedContext(context, {
      destination: { city: 'Rome', iata: 'ROM' },
    });

    assert.equal(context.summaryContext.destination.city, 'Rome');
    assert.equal(context.summaryContext.outbound_date, '2026-09-10');
    assert.equal(context.summaryContext.return_date, '2026-09-14');
    assert.equal(context.summaryContext.pax, 2);
    assert.equal(context.summaryContext.budget.total, 2000);
    assert.deepEqual(context.summaryContext.upcomingEvents, []);
    assert.deepEqual(context.summaryContext.placesOfInterest, []);
    assert.deepEqual(Object.keys(context.tripPlanner.placeImageCache), ['ROM']);
  });

  it('keeps large arrays and historic tool results out of compact instructions', () => {
    const summary = completeContext({
      upcomingEvents: Array.from({ length: 30 }, (_, index) => ({
        name: `Large event ${index}`,
        description: 'x'.repeat(200),
      })),
      placesOfInterest: Array.from({ length: 30 }, (_, index) => ({
        placeName: `Large place ${index}`,
        description: 'y'.repeat(200),
      })),
    });
    const compact = buildTripPlannerCompactContext({
      summaryContext: summary,
      currentUserMessage: 'Plan my trip',
      tripPlannerState: {
        contextRevision: 7,
        lastToolOutcomes: [{ output: 'z'.repeat(10_000) }],
      },
    });

    assert.ok(compact.estimatedTokens < 800);
    assert.match(compact.text, /knowledge=places:30,events:30/);
    assert.doesNotMatch(compact.text, /Large event/);
    assert.doesNotMatch(compact.text, /Large place/);
    assert.doesNotMatch(compact.text, /zzzzzz/);
  });

  it('returns only requested compact detail sections for the current revision', () => {
    const context = {
      summaryContext: completeContext(),
      tripPlanner: {
        contextRevision: 4,
        lastPlanArtifact: {
          id: 'plan_4',
          revision: 4,
          responseMode: 'compact_full',
          content: 'A saved compact itinerary.',
        },
      },
    };
    const result = getTripPlannerContextDetails(context, {
      sections: ['places', 'last_plan'],
      limit: 1,
    });

    assert.equal(result.revision, 4);
    assert.equal(result.destination.iata, 'PAR');
    assert.equal(result.details.places.length, 1);
    assert.equal(result.details.lastPlan.id, 'plan_4');
    assert.equal(Object.hasOwn(result.details, 'events'), false);
  });

  it('drops historical tool calls and retains at most four user turns', () => {
    const items: any[] = [];
    for (let index = 1; index <= 6; index += 1) {
      items.push({ role: 'user', content: `User turn ${index}` });
      items.push({
        type: 'function_call',
        name: 'legacy_tool',
        arguments: '{}',
      });
      items.push({ role: 'assistant', type: 'message', content: `Reply ${index}` });
      items.push({
        type: 'function_call_result',
        name: 'legacy_tool',
        output: 'large output',
      });
    }
    const trimmed = trimTripPlannerSessionItems(items);

    assert.equal(trimmed.some((item) => item.type === 'function_call'), false);
    assert.equal(trimmed.some((item) => item.type === 'function_call_result'), false);
    assert.equal(trimmed.filter((item) => (item as any).role === 'user').length, 4);
    assert.match(JSON.stringify(trimmed), /User turn 3/);
    assert.doesNotMatch(JSON.stringify(trimmed), /User turn 2/);
  });

  it('clears stale suggestions when the final updater is missing', () => {
    const context = preparedContext('Plan my trip');
    const finalized = finalizeTripPlannerTurn({
      context,
      output: 'A compact plan.',
      responseMode: 'compact_full',
    });

    assert.deepEqual(finalized.summaryContext.suggestedQuestions, []);
    assert.equal(finalized.suggestionsUpdated, false);
  });

  it('stores a structured last-plan artifact for later day patches', () => {
    const context = preparedContext('Plan my trip');
    const capture = capturePreparedContext(context);
    applyTripPlannerSuggestedQuestionsUpdate(context, {
      baseRevision: capture.revision,
      suggestedQuestions: [
        'Improve the second day',
        'Balance food and sightseeing',
        'Add hidden-gem activities',
      ],
    });
    const finalized = finalizeTripPlannerTurn({
      context,
      output: [
        '**Day 1 - Art focus**',
        '**Morning:** Visit one museum.',
        '**Day 2 - Food focus**',
        '**Evening:** Explore a food market.',
      ].join('\n'),
      responseMode: 'compact_full',
    });

    assert.equal(finalized.lastPlanArtifact.days.length, 2);
    assert.equal(finalized.lastPlanArtifact.days[1].day, 2);
    assert.match(finalized.lastPlanArtifact.days[1].content, /food market/);
  });

  it('uses the same preparation result for direct and Gateway lifecycles', () => {
    const direct = {
      summaryContext: completeContext(),
      tripPlanner: {},
    };
    const gateway = {
      summaryContext: completeContext(),
      tripPlanner: {},
    };
    const input = 'Change destination to Rome and make it relaxed';

    const directPrepared = prepareTripPlannerTurn({
      context: direct,
      input,
      requestId: 'direct',
      sessionId: 'same-session',
    });
    const gatewayPrepared = prepareTripPlannerTurn({
      context: gateway,
      input,
      requestId: 'gateway',
      sessionId: 'same-session',
    });

    assert.deepEqual(
      directPrepared.summaryContextAfterHydration,
      gatewayPrepared.summaryContextAfterHydration,
    );
    assert.deepEqual(
      directPrepared.planningBrief.responseStrategy,
      gatewayPrepared.planningBrief.responseStrategy,
    );
  });

  it('disables local planning tools for excluded requests but leaves updater enabled', async () => {
    const context = preparedContext('Find a hotel in Paris');
    const runContext = { context };

    assert.equal(await GetPlaceImagesBatchTool.isEnabled(runContext, TripPlannerAgent), false);
    assert.equal(
      await GetTripPlannerContextDetailsTool.isEnabled(runContext, TripPlannerAgent),
      false,
    );
    assert.equal(
      await UpdateTripPlannerContextTool.isEnabled(runContext, TripPlannerAgent),
      true,
    );
    assert.equal(
      await UpdateTripPlannerSuggestedQuestionsTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      false,
    );
  });

  it('keeps budget output limited to in-scope planning guidance', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: completeContext(),
      currentUserMessage: 'Plan my trip',
    });
    const budget = brief.derivedConstraints.budget;

    assert.deepEqual(Object.keys(budget.planningGuidance).sort(), [
      'activities',
      'flexibleReserve',
      'food',
    ]);
    assert.equal(Object.hasOwn(budget, 'planningAllowances'), false);
    assert.doesNotMatch(TRIP_PLANNER_STANDALONE_PRESENTATION, /\|\s*(?:Stay|Local transport)\s*\|/i);
    assert.match(TRIP_PLANNER_STANDALONE_PRESENTATION, /\|\s*Planning focus\s*\|\s*Guidance\s*\|/);
    assert.match(TRIP_PLANNER, /Keep food, activities, and flexible reserve guidance tied to known budget basis/);
  });
});
