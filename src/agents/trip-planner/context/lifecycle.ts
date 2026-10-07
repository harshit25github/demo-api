import {
  createTripPlannerSummaryContext,
  mergeTripPlannerSummaryContext,
} from './summary-context.js';
import {
  buildTripPlannerPlanningBrief,
  mergeTripPlannerAskedQuestionKeys,
  mergeTripPlannerPreferenceSignals,
} from './planning-brief.js';
import {
  classifyTripPlannerScopeRequest,
  isProhibitedTripPlannerPreference,
  validateTripPlannerSuggestedQuestions,
} from '../scope-policy.js';
import {
  bumpTripPlannerContextRevision,
  clearTripPlannerSummaryFields,
  ensureTripPlannerState,
  getTripPlannerContextRevision,
  invalidateTripPlannerKnowledge,
  setTripPlannerLastPlanArtifact,
} from './store.js';
type TripPlannerRecord = Record<string, any>;

const CLEARABLE_CONTEXT_FIELDS = new Set([
  'pax',
  'budget',
  'origin',
  'destination',
  'outbound_date',
  'return_date',
  'duration_days',
  'tripType',
  'date_hint',
]);

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function destinationChanged(before: TripPlannerRecord, after: TripPlannerRecord): boolean {
  return (
    before.destination.city !== after.destination.city ||
    before.destination.iata !== after.destination.iata
  );
}

function datesChanged(before: TripPlannerRecord, after: TripPlannerRecord): boolean {
  return (
    before.outbound_date !== after.outbound_date ||
    before.return_date !== after.return_date
  );
}

function normalizeTripTypeValues(values: unknown): string[] {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ];
}

function sanitizeTripTypeDelta(value: TripPlannerRecord = {}) {
  const rejectedFields: string[] = [];
  const sanitize = (values: unknown, field: string) => {
    const accepted: string[] = [];
    for (const preference of normalizeTripTypeValues(values)) {
      if (isProhibitedTripPlannerPreference(preference)) {
        rejectedFields.push(`tripType.${field}`);
      } else {
        accepted.push(preference);
      }
    }
    return accepted;
  };
  return {
    add: sanitize(value?.add, 'add'),
    remove: sanitize(value?.remove, 'remove'),
    rejectedFields,
  };
}

function applyTripTypeDelta(
  summaryContext: TripPlannerRecord,
  delta: TripPlannerRecord,
) {
  let next = createTripPlannerSummaryContext(summaryContext);
  if (delta.add.length > 0) {
    next = mergeTripPlannerSummaryContext(next, { tripType: delta.add });
  }
  if (delta.remove.length > 0) {
    const removals = new Set<string>(
      delta.remove.map((value: string) => value.toLowerCase()),
    );
    next.tripType = next.tripType.filter(
      (value) => !removals.has(value.toLowerCase()),
    );
  }
  return next;
}

function acceptedContextPatch(input: TripPlannerRecord = {}) {
  const patch: TripPlannerRecord = {};
  const fields = [
    'pax',
    'budget',
    'origin',
    'destination',
    'outbound_date',
    'return_date',
    'duration_days',
  ];
  for (const field of fields) {
    if (input[field] !== null && input[field] !== undefined) {
      patch[field] = input[field];
    }
  }
  return patch;
}

function changedSummaryFields(
  before: TripPlannerRecord,
  after: TripPlannerRecord,
): string[] {
  return [
    'pax',
    'budget',
    'origin',
    'destination',
    'outbound_date',
    'return_date',
    'duration_days',
    'tripType',
  ].filter((field) => !sameJson(before[field], after[field]));
}

export function refreshTripPlannerPlanningBrief(context: TripPlannerRecord = {}) {
  const state = ensureTripPlannerState(context);
  const planningBrief = buildTripPlannerPlanningBrief({
    summaryContext: context.summaryContext,
    latestPatch: state.latestContextPatch || {},
    tripPlannerState: state,
    currentUserMessage: state.currentUserMessage || '',
  });
  state.planningBrief = planningBrief;
  return planningBrief;
}

export function prepareTripPlannerTurn({
  context = {},
  input = '',
  requestId = null,
  sessionId = null,
}: TripPlannerRecord = {}) {
  const state = ensureTripPlannerState(context);
  const summaryBefore = createTripPlannerSummaryContext(context.summaryContext);
  context.summaryContext = summaryBefore;

  state.currentUserMessage = String(input);
  state.scopeClassification = classifyTripPlannerScopeRequest(input);
  state.latestContextPatch = {};
  state.latestPreferenceSignals = { positive: [], negative: [] };
  state.previousSuggestedQuestions = [...summaryBefore.suggestedQuestions];
  state.currentTurnToolCalls = [];
  state.turnState = {
    requestId,
    sessionId,
    baseRevision: getTripPlannerContextRevision(context),
    contextCaptured: false,
    contextCaptureAttempts: 0,
    suggestionsUpdated: false,
    suggestionAttempts: 0,
  };

  const planningBrief = refreshTripPlannerPlanningBrief(context);
  return {
    context,
    state,
    summaryContextBefore: summaryBefore,
    summaryContextAfterHydration: createTripPlannerSummaryContext(
      context.summaryContext,
    ),
    inferredContextPatch: {},
    explicitClearFields: [],
    scopeClassification: state.scopeClassification,
    planningBrief,
  };
}

export function applyTripPlannerContextUpdate(
  context: TripPlannerRecord = {},
  input: TripPlannerRecord = {},
) {
  const state = ensureTripPlannerState(context);
  state.turnState ||= {
    requestId: context.requestId || null,
    baseRevision: getTripPlannerContextRevision(context),
    contextCaptured: false,
    contextCaptureAttempts: 0,
    suggestionsUpdated: false,
    suggestionAttempts: 0,
  };
  const turnState = state.turnState;
  const requestId = turnState.requestId || context.requestId || null;

  if (
    requestId &&
    state.lastContextUpdateRequestId === requestId &&
    state.lastContextUpdateResult
  ) {
    return {
      ...state.lastContextUpdateResult,
      status: 'ALREADY_UPDATED',
      changedFields: [],
      rejectedFields: [],
    };
  }

  turnState.contextCaptureAttempts += 1;
  if (input.baseRevision !== turnState.baseRevision) {
    return {
      ok: false,
      status: 'REVISION_CONFLICT',
      revision: getTripPlannerContextRevision(context),
      changedFields: [],
      rejectedFields: ['baseRevision'],
      messageForAgent:
        'Use the current revision from trip_state and call this tool once more.',
    };
  }

  const before = createTripPlannerSummaryContext(context.summaryContext);
  const corePatch = acceptedContextPatch(input.contextPatch || {});
  let next = mergeTripPlannerSummaryContext(before, corePatch);
  const tripTypeDelta = sanitizeTripTypeDelta(input.contextPatch?.tripType);
  next = applyTripTypeDelta(next, tripTypeDelta);
  context.summaryContext = next;

  const acceptedClearFields: string[] = (input.clearFields || []).filter((field: string) =>
    CLEARABLE_CONTEXT_FIELDS.has(field),
  );
  const summaryClearFields = acceptedClearFields.filter(
    (field: string) => field !== 'date_hint',
  );
  if (summaryClearFields.length > 0) {
    context.summaryContext = clearTripPlannerSummaryFields(
      context,
      summaryClearFields,
    );
  }

  const previousDateHint = state.dateHint || null;
  if (acceptedClearFields.includes('date_hint')) {
    state.dateHint = null;
  } else if (input.contextPatch?.date_hint) {
    state.dateHint = String(input.contextPatch.date_hint).trim();
  } else if (input.contextPatch?.outbound_date) {
    state.dateHint = null;
  }

  const changedFields = changedSummaryFields(before, context.summaryContext);
  if (previousDateHint !== (state.dateHint || null)) {
    changedFields.push('date_hint');
  }
  invalidateTripPlannerKnowledge(context, {
    destinationChanged: destinationChanged(before, context.summaryContext),
    datesChanged: datesChanged(before, context.summaryContext),
  });

  const structuredPatch: TripPlannerRecord = {
    ...corePatch,
    ...(tripTypeDelta.add.length > 0
      ? { tripType: [...tripTypeDelta.add] }
      : {}),
    ...(input.contextPatch?.date_hint
      ? { date_hint: String(input.contextPatch.date_hint).trim() }
      : {}),
  };
  for (const field of acceptedClearFields) {
    structuredPatch[field] = null;
  }
  state.latestContextPatch = structuredPatch;
  state.latestPreferenceSignals = {
    positive: [...tripTypeDelta.add],
    negative: [...tripTypeDelta.remove],
  };
  state.preferenceSignals = mergeTripPlannerPreferenceSignals(
    state.preferenceSignals,
    state.latestPreferenceSignals,
  );
  turnState.contextCaptured = true;

  const revision =
    changedFields.length > 0
      ? bumpTripPlannerContextRevision(context)
      : getTripPlannerContextRevision(context);
  const planningBrief = refreshTripPlannerPlanningBrief(context);
  const rejectedFields = [...new Set(tripTypeDelta.rejectedFields)];
  const output = {
    ok: true,
    status: rejectedFields.length > 0 ? 'PARTIAL' : 'SUCCESS',
    revision,
    changedFields: [...new Set(changedFields)],
    rejectedFields,
    responseMode: planningBrief.responseStrategy.renderMode,
    messageForAgent:
      'Context capture is complete. Continue the trip-planning task using the refreshed trip_state, then update suggested questions last.',
  };

  if (requestId) {
    state.lastContextUpdateRequestId = requestId;
    state.lastContextUpdateResult = {
      ...output,
      changedFields: [...output.changedFields],
      rejectedFields: [...output.rejectedFields],
    };
  }
  return output;
}

export function applyTripPlannerSuggestedQuestionsUpdate(
  context: TripPlannerRecord = {},
  input: TripPlannerRecord = {},
) {
  const state = ensureTripPlannerState(context);
  const turnState = state.turnState;
  if (!turnState?.contextCaptured) {
    return {
      ok: false,
      status: 'CONTEXT_NOT_CAPTURED',
      revision: getTripPlannerContextRevision(context),
      changedFields: [],
      rejectedFields: ['suggestedQuestions'],
      messageForAgent:
        'Capture structured context before updating suggested questions.',
    };
  }

  const requestId = turnState.requestId || context.requestId || null;
  if (
    requestId &&
    state.lastSuggestionsUpdateRequestId === requestId &&
    state.lastSuggestionsUpdateResult
  ) {
    return {
      ...state.lastSuggestionsUpdateResult,
      status: 'ALREADY_UPDATED',
      changedFields: [],
      rejectedFields: [],
    };
  }

  turnState.suggestionAttempts += 1;
  if (input.baseRevision !== getTripPlannerContextRevision(context)) {
    return {
      ok: false,
      status: 'REVISION_CONFLICT',
      revision: getTripPlannerContextRevision(context),
      changedFields: [],
      rejectedFields: ['baseRevision'],
      messageForAgent:
        'Use the current revision from trip_state and retry the suggestions once.',
    };
  }

  const validation = validateTripPlannerSuggestedQuestions(
    input.suggestedQuestions,
    {
      previousSuggestions: state.previousSuggestedQuestions,
    },
  );
  if (!validation.ok) {
    return {
      ok: false,
      status: 'INVALID_SUGGESTIONS',
      revision: getTripPlannerContextRevision(context),
      changedFields: [],
      rejectedFields: ['suggestedQuestions'],
      issues: validation.issues,
      messageForAgent:
        'Generate three new 3-8 word, user-side itinerary suggestions and retry once.',
    };
  }

  const changed = !sameJson(
    context.summaryContext.suggestedQuestions,
    validation.suggestions,
  );
  context.summaryContext.suggestedQuestions = [...validation.suggestions];
  turnState.suggestionsUpdated = true;
  const revision = changed
    ? bumpTripPlannerContextRevision(context)
    : getTripPlannerContextRevision(context);
  const output = {
    ok: true,
    status: 'SUCCESS',
    revision,
    changedFields: changed ? ['suggestedQuestions'] : [],
    rejectedFields: [],
    messageForAgent:
      'Suggested questions are stored. Call no more tools and return the final user response.',
  };
  if (requestId) {
    state.lastSuggestionsUpdateRequestId = requestId;
    state.lastSuggestionsUpdateResult = {
      ...output,
      changedFields: [...output.changedFields],
      rejectedFields: [],
    };
  }
  return output;
}

export function finalizeTripPlannerTurn({
  context = {},
  output = '',
  responseMode = null,
  storePlanArtifact = true,
}: TripPlannerRecord = {}) {
  const state = ensureTripPlannerState(context);
  if (!state.turnState?.suggestionsUpdated) {
    context.summaryContext.suggestedQuestions = [];
  }
  state.askedQuestionKeys = mergeTripPlannerAskedQuestionKeys(
    state.askedQuestionKeys,
    output,
  );
  const artifact =
    !storePlanArtifact || state.scopeClassification?.mode === 'excluded'
      ? null
      : setTripPlannerLastPlanArtifact(context, { output, responseMode });
  if (Array.isArray(context.toolCallLog) && context.toolCallLog.length > 20) {
    context.toolCallLog = context.toolCallLog.slice(-20);
  }
  return {
    summaryContext: createTripPlannerSummaryContext(context.summaryContext),
    revision: getTripPlannerContextRevision(context),
    lastPlanArtifact: artifact,
    contextCaptured: Boolean(state.turnState?.contextCaptured),
    suggestionsUpdated: Boolean(state.turnState?.suggestionsUpdated),
  };
}
