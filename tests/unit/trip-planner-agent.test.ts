import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRIP_PLANNER } from '../../src/agents/trip-planner/prompt.js';
import {
  TripPlannerAgent as TripPlannerAgentDefinition,
  buildTripPlannerDynamicContext,
  buildTripPlannerInstructions,
} from '../../src/agents/trip-planner/agent.js';
import { tripPlannerAgentConfig } from '../../src/agents/trip-planner/config.js';
import {
  buildTripPlannerPlanningBrief,
  mergeTripPlannerAskedQuestionKeys,
  mergeTripPlannerPreferenceSignals,
  resolveTripPlannerDestinationIata,
} from '../../src/agents/trip-planner/context/planning-brief.js';
import {
  createTripPlannerSummaryContext,
  mergeTripPlannerSummaryContext,
} from '../../src/agents/trip-planner/context/summary-context.js';
import {
  GetTripPlannerContextDetailsTool as GetTripPlannerContextDetailsToolDefinition,
  GetPlaceImagesBatchTool as GetPlaceImagesBatchToolDefinition,
  TripPlannerWebSearchTool,
  TRIP_PLANNER_TOOL_NAMES,
  UpdateTripPlannerContextTool as UpdateTripPlannerContextToolDefinition,
  UpdateTripPlannerSuggestedQuestionsTool as UpdateTripPlannerSuggestedQuestionsToolDefinition,
} from '../../src/agents/trip-planner/tools/index.js';
import {
  buildTripPlannerCompactContext,
  estimateTripPlannerContextTokens,
} from '../../src/agents/trip-planner/context/serializer.js';
import {
  applyTripPlannerContextUpdate,
  prepareTripPlannerTurn,
} from '../../src/agents/trip-planner/context/lifecycle.js';
import { createRequestContext } from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';

const TripPlannerAgent: any = TripPlannerAgentDefinition;
const GetTripPlannerContextDetailsTool: any = GetTripPlannerContextDetailsToolDefinition;
const GetPlaceImagesBatchTool: any = GetPlaceImagesBatchToolDefinition;
const UpdateTripPlannerContextTool: any = UpdateTripPlannerContextToolDefinition;
const UpdateTripPlannerSuggestedQuestionsTool: any =
  UpdateTripPlannerSuggestedQuestionsToolDefinition;

const fullContext = {
  pax: 2,
  budget: {
    total: 2400,
    amount: 2400,
    currency: 'USD',
    per_person: false,
  },
  origin: { city: 'Delhi', iata: 'DEL' },
  destination: { city: 'Paris', iata: 'PAR' },
  tripType: ['roundtrip', 'balanced', 'cultural', 'food'],
  outbound_date: '2026-09-10',
  return_date: '2026-09-14',
  duration_days: 5,
  upcomingEvents: [{ name: 'Autumn arts season' }],
  placesOfInterest: [
    { placeName: 'Louvre Museum', description: 'Major art museum' },
  ],
  suggestedQuestions: ['Add local food stops'],
};

describe('Dummy Trip Planner Agent setup', () => {
  it('uses gpt-5.2 with hosted web search and four local tools', () => {
    assert.equal(tripPlannerAgentConfig.model, 'gpt-5.2');
    assert.equal(tripPlannerAgentConfig.modelSettings.text.verbosity, 'low');
    const toolNames = TripPlannerAgent.tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      toolNames,
      [...new Set(Object.values(TRIP_PLANNER_TOOL_NAMES))].sort(),
    );
    assert.equal(TripPlannerWebSearchTool.type, 'hosted_tool');
    assert.equal(TripPlannerWebSearchTool.providerData?.type, 'web_search');
  });

  it('keeps the prompt and appends compact summary context dynamically', () => {
    const runContext = {
      context: {
        summaryContext: fullContext,
        tripPlanner: { currentUserMessage: 'Plan my trip' },
      },
    };
    const instructions = buildTripPlannerInstructions(runContext);

    assert.ok(instructions.startsWith(TRIP_PLANNER));
    assert.match(instructions, /<trip_state revision=0>/);
    assert.match(instructions, /destination=PAR\|Paris/);
    assert.match(instructions, /outbound_date=2026-09-10/);
    assert.match(instructions, /knowledge=places:1,events:1/);
    assert.match(instructions, /pax=2/);
    assert.doesNotMatch(instructions, /"placesOfInterest"/);
    assert.doesNotMatch(instructions, /Autumn arts season/);
  });

  it('normalizes missing summary context to the complete null-safe production shape', () => {
    assert.deepEqual(createTripPlannerSummaryContext(), {
      pax: null,
      budget: {
        total: null,
        amount: null,
        currency: null,
        per_person: null,
      },
      origin: { city: null, iata: null },
      destination: { city: null, iata: null },
      tripType: [],
      outbound_date: null,
      return_date: null,
      duration_days: null,
      upcomingEvents: [],
      placesOfInterest: [],
      suggestedQuestions: [],
    });
  });

  it('ignores legacy summary aliases instead of leaking them into production context', () => {
    const normalized = createTripPlannerSummaryContext({
      outboundDate: '2026-10-01',
      returnDate: '2026-10-05',
      durationDays: 5,
      destination: { city: 'Paris', itemCode: 'PAR' },
      budget: { amount: 1000, perPerson: true },
    });

    assert.equal(normalized.outbound_date, null);
    assert.equal(normalized.return_date, null);
    assert.equal(normalized.duration_days, null);
    assert.equal(normalized.destination.iata, null);
    assert.equal(normalized.budget.per_person, null);
    assert.equal(Object.hasOwn(normalized, 'outboundDate'), false);
    assert.equal(Object.hasOwn(normalized.destination, 'itemCode'), false);
  });

  it('preserves existing dates and passengers when destination changes', () => {
    const context: any = {
      requestId: 'destination-change',
      summaryContext: fullContext,
    };
    prepareTripPlannerTurn({
      context,
      input: 'Change destination to Rome and keep the rest the same',
      requestId: context.requestId,
    });
    applyTripPlannerContextUpdate(context, {
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: {
        destination: { city: 'Rome', iata: 'ROM' },
      },
      clearFields: null,
    });

    assert.equal(context.summaryContext.destination.city, 'Rome');
    assert.equal(context.summaryContext.destination.iata, 'ROM');
    assert.equal(context.summaryContext.outbound_date, fullContext.outbound_date);
    assert.equal(context.summaryContext.return_date, fullContext.return_date);
    assert.equal(context.summaryContext.pax, fullContext.pax);
    assert.equal(context.summaryContext.origin.city, fullContext.origin.city);
    assert.deepEqual(context.summaryContext.upcomingEvents, []);
    assert.deepEqual(context.summaryContext.placesOfInterest, []);
  });

  it('stores agent-prepared structured values without parsing raw language', () => {
    const context: any = {
      requestId: 'structured-update',
      summaryContext: {
        destination: { iata: 'TYO', city: 'Tokyo' },
      },
    };
    prepareTripPlannerTurn({
      context,
      input: 'short natural language stays with the agent',
      requestId: context.requestId,
    });
    const result = applyTripPlannerContextUpdate(context, {
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: {
        pax: 1,
        duration_days: 5,
        tripType: {
          add: ['relaxed', 'budget-conscious'],
          remove: [],
        },
      },
      clearFields: null,
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(context.summaryContext.pax, 1);
    assert.equal(context.summaryContext.duration_days, 5);
    assert.equal(context.summaryContext.tripType.includes('relaxed'), true);
    assert.equal(
      context.summaryContext.tripType.includes('budget-conscious'),
      true,
    );
  });

  it('does not erase known values when a partial mapper sends null fields', () => {
    const merged = mergeTripPlannerSummaryContext(fullContext, {
      destination: { iata: null, city: 'Tokyo' },
      outbound_date: null,
      return_date: null,
      pax: null,
    });

    assert.equal(merged.destination.city, 'Tokyo');
    assert.equal(merged.destination.iata, null);
    assert.equal(merged.outbound_date, fullContext.outbound_date);
    assert.equal(merged.return_date, fullContext.return_date);
    assert.equal(merged.pax, fullContext.pax);
  });

  it('shows destination-only and no-context states in dynamic instructions', () => {
    const destinationOnly = buildTripPlannerDynamicContext({
      context: {
        summaryContext: { destination: { iata: 'TYO', city: 'Tokyo' } },
        tripPlanner: { currentUserMessage: 'Plan my trip' },
      },
    });
    const missing = buildTripPlannerDynamicContext({ context: {} });

    assert.match(destinationOnly, /destination=TYO\|Tokyo/);
    assert.doesNotMatch(destinationOnly, /outbound_date=/);
    assert.doesNotMatch(missing, /destination=/);
    assert.ok(estimateTripPlannerContextTokens(destinationOnly) < 800);
  });

  it('derives an actionable full-context planning brief', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      currentUserMessage: 'Plan my trip',
      tripPlannerState: {},
    });

    assert.equal(brief.derivedConstraints.date.effectiveDurationDays, 5);
    assert.equal(brief.derivedConstraints.date.durationSource, 'summary_context');
    assert.equal(brief.derivedConstraints.budget.basis, 'total');
    assert.equal(brief.derivedConstraints.budget.totalBudget, 2400);
    assert.equal(brief.derivedConstraints.budget.perPersonBudget, 1200);
    assert.equal(brief.derivedConstraints.budget.dailyTotalBudget, 480);
    assert.deepEqual(brief.derivedConstraints.budget.planningGuidance, {
      food: 'Use a value, balanced, or flexible tier.',
      activities: 'Use a free, mixed, or paid tier.',
      flexibleReserve: 'Keep part of the budget unallocated.',
    });
    assert.equal(brief.derivedConstraints.pace.maxAnchorsPerFullDay, 3);
    assert.equal(brief.derivedConstraints.party.groupLabel, 'pair');
    assert.equal(brief.derivedConstraints.dayShape.firstDayLoad, 'light');
    assert.equal(brief.derivedConstraints.dayShape.lastDayLoad, 'light');
    assert.equal(brief.derivedConstraints.dayShape.fullPlanningDays, 3);
    assert.deepEqual(
      brief.derivedConstraints.dayShape.anchorBudgetByDay.map(
        ({ day, maxNamedAnchors }) => [day, maxNamedAnchors],
      ),
      [
        [1, 1],
        [2, 3],
        [3, 3],
        [4, 3],
        [5, 1],
      ],
    );
    assert.equal(brief.known.includes('upcoming_events'), true);
    assert.equal(brief.known.includes('places_of_interest'), true);
    assert.equal(brief.preferenceSignals.positive.includes('cultural'), true);
    assert.equal(brief.preferenceSignals.positive.includes('food'), true);
    assert.deepEqual(brief.responseStrategy.questionPriority, []);
    assert.equal(brief.responseStrategy.maxQuestions, 0);
    assert.equal(brief.responseStrategy.renderMode, 'compact_full');
    assert.equal(brief.responseStrategy.maxBodyWords, 350);
    assert.equal(brief.responseStrategy.maxTimeBlockWords, 18);
    assert.equal(brief.responseStrategy.cardPolicy, 'render_once');
    assert.equal(brief.responseStrategy.seasonPolicy, 'one_relevant_trip_season_note');
    assert.equal(brief.responseStrategy.budgetPolicy, 'compact_two_column_table');
    assert.equal(brief.responseStrategy.requiresAllTimeBlocks, true);
    assert.deepEqual(Object.keys(brief.toolStrategy).sort(), [
      'contextCapture',
      'contextDetails',
      'images',
      'suggestedQuestions',
    ]);
    assert.deepEqual(brief.toolStrategy.images, { action: 'call', itemCodes: ['PAR'] });
  });

  it('uses safe labeled assumptions and high-impact questions for partial context', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: {
        destination: { iata: 'TYO', city: 'Tokyo' },
        tripType: ['relaxed'],
      },
      currentUserMessage: 'Plan my trip',
    });

    assert.equal(brief.derivedConstraints.date.effectiveDurationDays, 4);
    assert.equal(brief.derivedConstraints.date.durationSource, 'starter_assumption');
    assert.equal(brief.derivedConstraints.pace.maxAnchorsPerFullDay, 2);
    assert.match(brief.assumptions.join(' '), /4-day starter outline/);
    assert.match(brief.assumptions.join(' '), /do not invent an exact budget/i);
    assert.deepEqual(brief.responseStrategy.questionPriority, [
      'travel_dates_or_duration',
      'interests',
    ]);
    assert.equal(brief.responseStrategy.maxQuestions, 2);
    assert.equal(brief.responseStrategy.renderMode, 'compact_full');
  });

  it('turns user edits into durable preference and pace signals', () => {
    const context: any = {
      requestId: 'durable-preferences',
      summaryContext: fullContext,
    };
    prepareTripPlannerTurn({
      context,
      input:
        'Make it less packed, skip museums, and add local food. Budget is $2,400 total.',
      requestId: context.requestId,
    });
    applyTripPlannerContextUpdate(context, {
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: {
        budget: {
          total: 2400,
          amount: 2400,
          currency: 'USD',
          per_person: false,
        },
        tripType: {
          add: ['relaxed', 'food', 'local experiences'],
          remove: ['museums'],
        },
      },
      clearFields: null,
    });
    const latestSignals = context.tripPlanner.latestPreferenceSignals;
    const mergedSignals = mergeTripPlannerPreferenceSignals(
      { positive: ['museums', 'history'], negative: [] },
      latestSignals,
    );

    assert.equal(context.summaryContext.tripType.includes('relaxed'), true);
    assert.equal(context.summaryContext.tripType.includes('food'), true);
    assert.deepEqual(context.summaryContext.budget, {
      total: 2400,
      amount: 2400,
      currency: 'USD',
      per_person: false,
    });
    assert.equal(mergedSignals.positive.includes('food'), true);
    assert.equal(mergedSignals.positive.includes('local experiences'), true);
    assert.equal(mergedSignals.positive.includes('museums'), false);
    assert.equal(mergedSignals.negative.includes('museums'), true);
  });

  it('keeps budget-conscious intent as a durable preference signal', () => {
    const latestSignals = {
      positive: ['budget-conscious'],
      negative: [],
    };
    const mergedSignals = mergeTripPlannerPreferenceSignals(
      { positive: ['food'], negative: ['nightlife'] },
      latestSignals,
    );

    assert.equal(latestSignals.positive.includes('budget-conscious'), true);
    assert.equal(mergedSignals.positive.includes('food'), true);
    assert.equal(mergedSignals.positive.includes('budget-conscious'), true);
    assert.equal(mergedSignals.negative.includes('nightlife'), true);
  });

  it('personalizes family mountain intent without inventing children or mobility needs', () => {
    const message = 'Make this a relaxed family trip with mountain scenery';
    const updatedContext = mergeTripPlannerSummaryContext(fullContext, {
      tripType: ['relaxed', 'family', 'mountains'],
    });
    const latestPreferenceSignals = {
      positive: ['relaxed', 'family', 'mountains'],
      negative: [],
    };
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: updatedContext,
      latestPatch: { tripType: ['relaxed', 'family', 'mountains'] },
      currentUserMessage: message,
      tripPlannerState: { latestPreferenceSignals },
    });

    assert.equal(brief.derivedConstraints.party.travelerStyle, 'family');
    assert.equal(brief.derivedConstraints.party.childrenKnown, false);
    assert.equal(brief.derivedConstraints.party.mobilityNeedsKnown, false);
    assert.equal(brief.derivedConstraints.pace.maxAnchorsPerFullDay, 2);
    assert.equal(brief.preferenceSignals.positive.includes('mountains'), true);
  });

  it('preserves independent trip styles when journey type changes', () => {
    const merged = mergeTripPlannerSummaryContext(
      { ...fullContext, tripType: ['roundtrip', 'couple'] },
      { tripType: ['oneway'] },
    );

    assert.deepEqual(merged.tripType, ['couple', 'oneway']);
  });

  it('detects date and budget conflicts without discarding the usable context', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: {
        ...fullContext,
        return_date: '2026-09-12',
        duration_days: 7,
        budget: {
          total: null,
          amount: 1000,
          currency: null,
          per_person: null,
        },
      },
      currentUserMessage: 'Plan it',
    });

    assert.equal(brief.derivedConstraints.date.effectiveDurationDays, 7);
    assert.equal(brief.conflicts.includes('duration_does_not_match_date_range'), true);
    assert.equal(brief.conflicts.includes('budget_basis_unspecified'), true);
    assert.equal(brief.conflicts.includes('budget_currency_missing'), true);
    assert.equal(brief.responseStrategy.questionPriority.includes('budget_basis'), true);
    assert.equal(brief.highImpactMissing.includes('budget_basis'), true);
  });

  it('invalidates stale destination assets while preserving reusable current assets', () => {
    const changed = buildTripPlannerPlanningBrief({
      summaryContext: {
        ...fullContext,
        destination: { iata: null, city: 'Rome' },
      },
      latestPatch: { destination: { iata: null, city: 'Rome' } },
      currentUserMessage: 'Change destination to Rome',
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        placeImageCache: {
          PAR: { itemCode: 'PAR', imageUrl: 'https://images.example.test/paris.jpg' },
        },
      },
    });
    const reusable = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      currentUserMessage: 'Make it more relaxed',
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        placeImageCache: {
          PAR: { itemCode: 'PAR', imageUrl: 'https://images.example.test/paris.jpg' },
        },
      },
    });

    assert.equal(resolveTripPlannerDestinationIata(changed.effectiveContext.destination), 'ROM');
    assert.equal(changed.continuity.destinationChanged, true);
    assert.deepEqual(changed.toolState.availableImageAssets, []);
    assert.deepEqual(changed.toolStrategy.images, { action: 'call', itemCodes: ['ROM'] });
    assert.equal(reusable.continuity.destinationChanged, false);
    assert.equal(reusable.continuity.shouldPatchPreviousPlan, true);
    assert.equal(reusable.responseStrategy.renderMode, 'compact_patch');
    assert.equal(reusable.responseStrategy.cardPolicy, 'omit_unless_visuals_requested');
    assert.equal(reusable.toolStrategy.images.action, 'not_needed');
  });

  it('derives strict discovery-card presentation for missing destination context', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: {},
      currentUserMessage: 'I need a relaxed food and history break',
      tripPlannerState: {
        latestPreferenceSignals: {
          positive: ['relaxed', 'food', 'history'],
          negative: [],
        },
      },
    });

    assert.equal(brief.responseStrategy.mode, 'destination_suggestions');
    assert.equal(brief.responseStrategy.renderMode, 'discovery_cards');
    assert.equal(brief.responseStrategy.maxBodyWords, 90);
    assert.equal(brief.responseStrategy.cardPolicy, 'exactly_3_cards');
    assert.equal(brief.responseStrategy.budgetPolicy, 'card_field_only');
    assert.equal(brief.responseStrategy.maxQuestions, 1);
    assert.deepEqual(brief.responseStrategy.questionPriority, ['destination']);
    assert.equal(brief.toolStrategy.images.action, 'call_after_selecting_suggestions');
  });

  it('derives patch-only presentation and targets from a follow-up adjustment', () => {
    const message = 'Make day 3 lighter, add local food, and use quiet neighborhoods';
    const latestPreferenceSignals = {
      positive: ['relaxed', 'food', 'local experiences'],
      negative: [],
    };
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      latestPatch: { tripType: ['relaxed'] },
      currentUserMessage: message,
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        latestPreferenceSignals,
        preferenceSignals: latestPreferenceSignals,
        placeImageCache: {
          PAR: { itemCode: 'PAR', imageUrl: 'https://images.example.test/paris.jpg' },
        },
      },
    });

    assert.equal(brief.responseStrategy.mode, 'patch_existing_itinerary');
    assert.equal(brief.responseStrategy.renderMode, 'compact_patch');
    assert.equal(brief.responseStrategy.maxBodyWords, 160);
    assert.equal(brief.responseStrategy.maxPatchDaySections, 1);
    assert.equal(brief.responseStrategy.includeUnchangedContent, false);
    assert.equal(brief.responseStrategy.budgetPolicy, 'omit_unchanged');
    assert.equal(brief.responseStrategy.patchTargets.includes('pace'), true);
    assert.equal(brief.responseStrategy.patchTargets.includes('preferences'), true);
    assert.equal(brief.responseStrategy.patchTargets.includes('food'), true);
    assert.equal(brief.responseStrategy.patchTargets.includes('places'), true);
    assert.equal(brief.responseStrategy.patchTargets.includes('day_3'), true);
    assert.equal(brief.toolStrategy.images.action, 'not_needed');
  });

  it('treats a terse day reference as an itinerary patch', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      latestPatch: {},
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        lastPlanArtifact: { id: 'plan_1' },
      },
      currentUserMessage: 'day 3 easy pls',
    });

    assert.equal(brief.responseStrategy.renderMode, 'compact_patch');
    assert.equal(brief.responseStrategy.patchTargets.includes('day_3'), true);
    assert.deepEqual(brief.toolStrategy.contextDetails.sections, ['last_plan']);
  });

  it('includes the compact budget table only when a patch changes budget intent', () => {
    const message = 'Keep it food-focused but make it more budget-friendly';
    const latestPreferenceSignals = {
      positive: ['food', 'budget-conscious'],
      negative: [],
    };
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      currentUserMessage: message,
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        latestPreferenceSignals,
        preferenceSignals: { positive: ['food'], negative: [] },
      },
    });

    assert.equal(brief.responseStrategy.renderMode, 'compact_patch');
    assert.equal(brief.responseStrategy.patchTargets.includes('budget'), true);
    assert.equal(brief.responseStrategy.budgetPolicy, 'compact_two_column_table');
    assert.equal(brief.responseStrategy.maxPatchDaySections, 1);
    assert.equal(brief.responseStrategy.targetBodyWords, 130);
    assert.equal(brief.preferenceSignals.positive.includes('food'), true);
    assert.equal(brief.preferenceSignals.positive.includes('budget-conscious'), true);
  });

  it('targets activity content when plural museums are removed', () => {
    const message = 'Skip museums and keep the days easy.';
    const latestPreferenceSignals = {
      positive: ['relaxed'],
      negative: ['museums'],
    };
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      currentUserMessage: message,
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        latestPreferenceSignals,
      },
    });

    assert.equal(brief.responseStrategy.renderMode, 'compact_patch');
    assert.equal(brief.responseStrategy.patchTargets.includes('preferences'), true);
    assert.equal(brief.responseStrategy.patchTargets.includes('activities'), true);
  });

  it('removes already-asked fields from follow-up question priority', () => {
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: {
        destination: { iata: 'TYO', city: 'Tokyo' },
      },
      currentUserMessage: 'Plan my trip',
      tripPlannerState: {
        askedQuestionKeys: ['dates', 'duration', 'interests'],
      },
    });

    assert.deepEqual(brief.responseStrategy.questionPriority, [
      'traveler_count',
      'budget',
    ]);
    assert.equal(brief.responseStrategy.maxQuestions, 2);
  });

  it('uses a fresh compact full response when destination changes', () => {
    const romeContext = {
      ...fullContext,
      destination: { iata: 'ROM', city: 'Rome' },
    };
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: romeContext,
      latestPatch: { destination: { iata: 'ROM', city: 'Rome' } },
      currentUserMessage: 'Change destination to Rome',
      tripPlannerState: {
        lastPlanSnapshot: fullContext,
        placeImageCache: {
          PAR: { itemCode: 'PAR', imageUrl: 'https://images.example.test/paris.jpg' },
        },
      },
    });

    assert.equal(brief.continuity.destinationChanged, true);
    assert.equal(brief.responseStrategy.mode, 'new_destination_itinerary');
    assert.equal(brief.responseStrategy.renderMode, 'compact_full');
    assert.equal(brief.responseStrategy.cardPolicy, 'render_once');
    assert.equal(brief.responseStrategy.includeUnchangedContent, true);
    assert.deepEqual(brief.toolStrategy.images, { action: 'call', itemCodes: ['ROM'] });
  });

  it('treats destination selection after discovery as a fresh full plan', () => {
    const discoverySnapshot = createTripPlannerSummaryContext({
      duration_days: 4,
      tripType: ['relaxed'],
    });
    const brief = buildTripPlannerPlanningBrief({
      summaryContext: {
        ...discoverySnapshot,
        destination: { iata: 'TYO', city: 'Tokyo' },
        pax: 1,
      },
      latestPatch: {
        destination: { iata: 'TYO', city: 'Tokyo' },
        pax: 1,
      },
      currentUserMessage: 'Plan my trip to Tokyo for 4 days, 1 traveler.',
      tripPlannerState: {
        lastPlanSnapshot: discoverySnapshot,
        placeImageCache: {
          TYO: { itemCode: 'TYO', imageUrl: 'https://images.example.test/tokyo.jpg' },
        },
      },
    });

    assert.equal(brief.continuity.destinationChanged, true);
    assert.equal(brief.responseStrategy.mode, 'new_destination_itinerary');
    assert.equal(brief.responseStrategy.renderMode, 'compact_full');
    assert.equal(brief.toolStrategy.images.action, 'reuse');
  });

  it('tracks previously asked high-impact questions', () => {
    const keys = mergeTripPlannerAskedQuestionKeys(
      ['budget'],
      'How many days are you staying? Which interests matter most?',
    );

    assert.deepEqual(keys.sort(), ['budget', 'duration', 'interests']);
  });

  it('includes the derived brief and intelligence rules in dynamic instructions', () => {
    const dynamic = buildTripPlannerDynamicContext({
      context: {
        summaryContext: fullContext,
        tripPlanner: {
          currentUserMessage: 'Make it relaxed',
          latestContextPatch: { tripType: ['relaxed'] },
          askedQuestionKeys: ['interests'],
        },
      },
    });

    assert.match(dynamic, /<trip_state revision=0>/);
    assert.match(dynamic, /pace=relaxed\|max_anchors:2/);
    assert.match(dynamic, /render=compact_full\|target_words:300\|max_words:350/);
    assert.match(dynamic, /questions=none/);
    assert.doesNotMatch(dynamic, /anchorBudgetByDay/);
    assert.ok(estimateTripPlannerContextTokens(dynamic) < 800);
    assert.match(TRIP_PLANNER, /<planning_intelligence>/);
    assert.match(TRIP_PLANNER, /Context-Aware Planning Intelligence/);
    assert.match(TRIP_PLANNER, /Adaptive use of this format/);
    assert.match(TRIP_PLANNER, /discovery_cards/);
    assert.match(TRIP_PLANNER, /compact_patch/);
    assert.match(TRIP_PLANNER, /maximum 18 words/);
    assert.match(TRIP_PLANNER, /Do not repeat it as a second text profile/);
    assert.doesNotMatch(TRIP_PLANNER, /planningAllowances/);
    assert.doesNotMatch(TRIP_PLANNER, /localTransport/);
    assert.match(TRIP_PLANNER, /ONLY evidence for current facts/);
    assert.match(TRIP_PLANNER, /hosted web search/i);
    assert.match(TRIP_PLANNER, /<\/privacy_and_identity_guardrail>/);
  });

  it('hydrates the request clock and leaves the web research decision to the agent', () => {
    const state = {
      summaryContext: fullContext,
      tripPlanner: { currentUserMessage: 'Which festivals are on during our dates?' },
    };
    const clock = createRequestClock({ now: '2026-10-11T10:00:00Z', timeZone: 'Asia/Kolkata' });
    const dynamic = buildTripPlannerDynamicContext({ context: createRequestContext(state, clock) });

    assert.match(dynamic, /<turn_clock>\ntoday=2026-10-11\|time_zone=Asia\/Kolkata\n<\/turn_clock>/);
    assert.match(dynamic, /webSearch:agent_decides/);
    assert.match(dynamic, /web_search is your decision/);
    assert.doesNotMatch(dynamic, /dateValidation|validate_trip_date|webSearch:call/);
    assert.match(buildTripPlannerDynamicContext({ context: state }), /today=unknown/);
    assert.doesNotMatch(TRIP_PLANNER, /validate_trip_date|SEARCH_REQUIRED|candidateDate|eventKeyword/);
    assert.match(TRIP_PLANNER, /You own this decision/);
    assert.match(TRIP_PLANNER, /next occurrence; the current month still counts/);

    const excluded = buildTripPlannerDynamicContext({
      context: {
        summaryContext: fullContext,
        tripPlanner: {
          currentUserMessage: 'Find a hotel in Paris',
          scopeClassification: { mode: 'excluded', categories: ['accommodation'] },
        },
      },
    });
    assert.match(excluded, /webSearch:not_needed/);
  });

  it('configures hosted OpenAI web search for live current information', () => {
    assert.equal(TripPlannerWebSearchTool.type, 'hosted_tool');
    assert.equal(TripPlannerWebSearchTool.name, 'web_search');
    assert.equal(TripPlannerWebSearchTool.providerData.type, 'web_search');
    assert.equal(TripPlannerWebSearchTool.providerData.search_context_size, 'medium');
    assert.equal(TripPlannerWebSearchTool.providerData.external_web_access, true);
  });

  it('runs context first, planning tools next, and suggestions last', async () => {
    const context: any = {
      requestId: 'tools-turn',
      sessionId: 'tools-session',
      summaryContext: fullContext,
    };
    prepareTripPlannerTurn({
      context,
      input: 'Plan my trip',
      requestId: context.requestId,
      sessionId: context.sessionId,
    });
    const runContext = { context };
    const capture = await UpdateTripPlannerContextTool.invoke(
      runContext,
      JSON.stringify({
        baseRevision: context.tripPlanner.turnState.baseRevision,
        contextPatch: null,
        clearFields: null,
      }),
      {},
    );
    const images = await GetPlaceImagesBatchTool.invoke(
      runContext,
      JSON.stringify({ itemCodes: ['PAR', 'ROM'] }),
      {},
    );
    const details = await GetTripPlannerContextDetailsTool.invoke(
      runContext,
      JSON.stringify({ sections: ['places'], query: null, limit: 5 }),
      {},
    );
    const suggestions = await UpdateTripPlannerSuggestedQuestionsTool.invoke(
      runContext,
      JSON.stringify({
        baseRevision: capture.revision,
        suggestedQuestions: [
          'Balance food and sightseeing',
          'Show budget-friendly activities',
          'Improve the second day',
        ],
      }),
      {},
    );

    assert.equal(capture.status, 'SUCCESS');
    assert.equal(images.images.length, 2);
    assert.equal(images.images.every((image) => image.imageUrl.includes('example.test')), true);
    assert.equal(details.details.places.length, 1);
    assert.equal(suggestions.status, 'SUCCESS');
    assert.equal(context.summaryContext.suggestedQuestions.length, 3);
    assert.deepEqual(
      context.toolCallLog.map((entry) => entry.tool),
      [
        TRIP_PLANNER_TOOL_NAMES.updateContext,
        TRIP_PLANNER_TOOL_NAMES.getPlaceImagesBatch,
        TRIP_PLANNER_TOOL_NAMES.getContextDetails,
        TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions,
      ],
    );
  });

  it('reuses local image results without changing tool contracts', async () => {
    const context: any = {};
    const runContext = { context };
    const imageInput = JSON.stringify({ itemCodes: ['PAR'] });
    const firstImages = await GetPlaceImagesBatchTool.invoke(runContext, imageInput, {});
    const secondImages = await GetPlaceImagesBatchTool.invoke(runContext, imageInput, {});

    assert.equal(firstImages.cached, false);
    assert.equal(secondImages.cached, true);

    const brief = buildTripPlannerPlanningBrief({
      summaryContext: fullContext,
      currentUserMessage: 'Plan my trip',
      tripPlannerState: context.tripPlanner,
    });
    assert.equal(brief.toolStrategy.images.action, 'reuse');
  });

  it('serializes compact context without detailed arrays or tool history', () => {
    const compact = buildTripPlannerCompactContext({
      summaryContext: fullContext,
      currentUserMessage: 'Plan my trip',
      tripPlannerState: {
        contextRevision: 3,
        lastToolOutcomes: [{ tool: 'web_search', output: 'large historical result' }],
      },
    });

    assert.match(compact.text, /<trip_state revision=3>/);
    assert.match(compact.text, /knowledge=places:1,events:1/);
    assert.doesNotMatch(compact.text, /Louvre Museum/);
    assert.doesNotMatch(compact.text, /Autumn arts season/);
    assert.doesNotMatch(compact.text, /large historical result/);
    assert.ok(compact.estimatedTokens < 800);
  });

  it('runs context capture first and suggestions last', async () => {
    const context: any = {
      requestId: 'turn-1',
      sessionId: 'session-1',
      summaryContext: fullContext,
    };
    prepareTripPlannerTurn({
      context,
      input: 'Make day 2 lighter',
      requestId: context.requestId,
      sessionId: context.sessionId,
    });
    const runContext = { context };
    const contextInput = JSON.stringify({
      baseRevision: context.tripPlanner.turnState.baseRevision,
      contextPatch: null,
      clearFields: null,
    });
    assert.equal(
      await UpdateTripPlannerContextTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      true,
    );
    assert.equal(
      await UpdateTripPlannerSuggestedQuestionsTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      false,
    );
    const captured = await UpdateTripPlannerContextTool.invoke(
      runContext,
      contextInput,
      {},
    );
    assert.equal(captured.status, 'SUCCESS');
    assert.equal(
      await UpdateTripPlannerContextTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      false,
    );
    assert.equal(
      await UpdateTripPlannerSuggestedQuestionsTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      true,
    );

    const suggestionInput = JSON.stringify({
      baseRevision: captured.revision,
      suggestedQuestions: [
        'Balance food and sightseeing',
        'Show budget-friendly activities',
        'Add hidden-gem activities',
      ],
    });
    const first = await UpdateTripPlannerSuggestedQuestionsTool.invoke(
      runContext,
      suggestionInput,
      {},
    );
    assert.equal(first.status, 'SUCCESS');
    assert.equal(
      await UpdateTripPlannerSuggestedQuestionsTool.isEnabled(
        runContext,
        TripPlannerAgent,
      ),
      false,
    );

    const repeated = await UpdateTripPlannerSuggestedQuestionsTool.invoke(
      runContext,
      suggestionInput,
      {},
    );
    assert.equal(repeated.status, 'ALREADY_UPDATED');
    assert.deepEqual(context.summaryContext.suggestedQuestions, [
      'Balance food and sightseeing',
      'Show budget-friendly activities',
      'Add hidden-gem activities',
    ]);
  });
});
