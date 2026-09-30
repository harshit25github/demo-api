import {
  createTripPlannerSummaryContext,
} from './summary-context.js';
import { buildTripPlannerPlanningBrief } from './planning-brief.js';
import { getTripPlannerContextRevision } from './store.js';
type TripPlannerRecord = Record<string, any>;

function endpointLine(name: string, endpoint: TripPlannerRecord): string | null {
  if (!endpoint?.city && !endpoint?.iata) {
    return null;
  }
  return `${name}=${endpoint.iata || '?'}|${endpoint.city || '?'}`;
}

function valueLine(name: string, value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : `${name}=${value}`;
}

function compactBudget(summary: TripPlannerRecord, brief: TripPlannerRecord) {
  const budget = summary.budget;
  if (!budget.amount && !budget.total) {
    return null;
  }
  const amount = budget.total || budget.amount;
  const basis = budget.per_person === true ? 'per_person' : budget.per_person === false ? 'total' : 'unspecified';
  const daily = brief.derivedConstraints.budget.dailyTotalBudget;
  return `budget=${budget.currency || '?'} ${amount}|${basis}${daily ? `|daily_reference:${daily}` : ''}`;
}

function compactToolAction(strategy: TripPlannerRecord, key: string): string {
  const value = strategy?.[key];
  if (!value) {
    return `${key}:not_needed`;
  }
  const details: string[] = [];
  if (value.input?.candidateDate) {
    details.push(`date=${value.input.candidateDate}`);
  }
  if (value.input?.eventKeyword) {
    details.push(`event=${value.input.eventKeyword}`);
  }
  if (value.itemCodes?.length) {
    details.push(`codes=${value.itemCodes.join('+')}`);
  }
  if (value.sections?.length) {
    details.push(`sections=${value.sections.join('+')}`);
  }
  if (value.categories?.length) {
    details.push(`categories=${value.categories.join('+')}`);
  }
  return `${key}:${value.action || 'not_needed'}${
    details.length ? `|${details.join('|')}` : ''
  }`;
}

function completedContextIntents(latestPatch: TripPlannerRecord = {}): string[] {
  const completed = new Set<string>();
  const fieldIntents = {
    pax: 'traveler_count',
    budget: 'budget',
    origin: 'origin',
    destination: 'destination',
    outbound_date: 'dates',
    return_date: 'dates',
    duration_days: 'duration',
    date_hint: 'dates',
  };
  for (const field of Object.keys(latestPatch)) {
    if ((fieldIntents as TripPlannerRecord)[field]) {
      completed.add((fieldIntents as TripPlannerRecord)[field]);
    }
  }
  for (const value of latestPatch.tripType || []) {
    const normalized = String(value).toLowerCase();
    completed.add(normalized);
    if (['relaxed', 'balanced', 'fast-paced'].includes(normalized)) {
      completed.add('pace');
    }
    if (['solo', 'couple', 'family', 'friends', 'business'].includes(normalized)) {
      completed.add('party');
    }
    if (normalized === 'budget-conscious') {
      completed.add('budget');
    }
  }
  return [...completed];
}

export function buildTripPlannerCompactContext({
  summaryContext = {},
  latestPatch = {},
  tripPlannerState = {},
  currentUserMessage = '',
}: TripPlannerRecord = {}) {
  const summary = createTripPlannerSummaryContext(summaryContext);
  const brief = buildTripPlannerPlanningBrief({
    summaryContext: summary,
    latestPatch,
    tripPlannerState,
    currentUserMessage,
  });
  const stateLines = [
    endpointLine('origin', summary.origin),
    endpointLine('destination', summary.destination),
    valueLine('outbound_date', summary.outbound_date),
    valueLine('return_date', summary.return_date),
    valueLine('duration_days', summary.duration_days),
    valueLine('pax', summary.pax),
    compactBudget(summary, brief),
    summary.tripType.length > 0 ? `tripType=${summary.tripType.join(',')}` : null,
    valueLine('date_hint', tripPlannerState.dateHint),
    `knowledge=places:${summary.placesOfInterest.length},events:${summary.upcomingEvents.length}`,
    brief.toolState.availableImageAssets?.[0]
      ? `image_asset=${brief.toolState.availableImageAssets[0].itemCode}|${brief.toolState.availableImageAssets[0].imageUrl}`
      : null,
    `last_plan=${tripPlannerState.lastPlanArtifact?.id || 'none'}`,
  ].filter((line): line is string => Boolean(line));

  const hasTurnState = Boolean(tripPlannerState.turnState);
  const contextCaptured = hasTurnState
    ? tripPlannerState.turnState.contextCaptured === true
    : true;
  if (!contextCaptured) {
    const captureLines = [
      'phase=context_capture',
      'required_first_tool=update_trip_planner_context',
      'context_payload=only_explicit_or_clearly_implied_user_changes',
      'unchanged_fields=preserve',
      tripPlannerState.previousSuggestedQuestions?.length
        ? `previous_suggestions=${tripPlannerState.previousSuggestedQuestions
            .slice(0, 3)
            .join(' | ')}`
        : null,
    ].filter((line): line is string => Boolean(line));
    const text = `<trip_state revision=${getTripPlannerContextRevision({
      summaryContext: summary,
      tripPlanner: tripPlannerState,
    })}>\n${stateLines.join('\n')}\n</trip_state>\n\n<turn_plan>\n${captureLines.join('\n')}\n</turn_plan>`;
    return {
      text,
      summaryContext: summary,
      planningBrief: brief,
      phase: 'context_capture',
      estimatedTokens: estimateTripPlannerContextTokens(text),
    };
  }

  const response = brief.responseStrategy;
  const pace = brief.derivedConstraints.pace;
  const dayShape = brief.derivedConstraints.dayShape;
  const scopeMode = tripPlannerState.scopeClassification?.mode || 'in_scope';
  const completedIntents = completedContextIntents(latestPatch);
  const turnLines = [
    'phase=planning',
    `scope=${scopeMode}`,
    `changed=${Object.keys(latestPatch || {}).join(',') || 'none'}`,
    `completed=${completedIntents.join(',') || 'none'}`,
    `render=${response.renderMode}|target_words:${response.targetBodyWords}|max_words:${response.maxBodyWords}`,
    `format=effective_days:${brief.derivedConstraints.date.effectiveDurationDays}|block_words:${response.maxTimeBlockWords || 0}|max_patch_days:${response.maxPatchDaySections || 0}|max_questions:${response.maxQuestions}`,
    `cards=${response.cardPolicy}|season=${response.seasonPolicy}|budget=${response.budgetPolicy}`,
    `pace=${pace.label}|max_anchors:${pace.maxAnchorsPerFullDay}|max_areas:${pace.maxNeighborhoodsPerDay}`,
    `day_shape=first:${dayShape.firstDayLoad}|last:${dayShape.lastDayLoad}`,
    `patch=${response.patchTargets.join(',') || 'none'}`,
    `questions=${response.questionPriority.join(',') || 'none'}`,
    `tools=${[
      compactToolAction(brief.toolStrategy, 'dateValidation'),
      compactToolAction(brief.toolStrategy, 'webSearch'),
      compactToolAction(brief.toolStrategy, 'images'),
      compactToolAction(brief.toolStrategy, 'contextDetails'),
      'suggested_questions:always_last',
    ].join(',')}`,
    tripPlannerState.previousSuggestedQuestions?.length
      ? `previous_suggestions=${tripPlannerState.previousSuggestedQuestions.slice(0, 3).join(' | ')}`
      : null,
  ].filter((line): line is string => Boolean(line));

  const text = `<trip_state revision=${getTripPlannerContextRevision({
    summaryContext: summary,
    tripPlanner: tripPlannerState,
  })}>\n${stateLines.join('\n')}\n</trip_state>\n\n<turn_plan>\n${turnLines.join('\n')}\n</turn_plan>`;
  return {
    text,
    summaryContext: summary,
    planningBrief: brief,
    phase: 'planning',
    estimatedTokens: estimateTripPlannerContextTokens(text),
  };
}

export function estimateTripPlannerContextTokens(value = ''): number {
  return Math.ceil(String(value).length / 4);
}
