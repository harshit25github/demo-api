import { log } from '../../shared/logging/logger.js';
import { applyTripChanges, validateClientSummary } from './client-summary.js';
import { tripFeedbackSchema, type TripFeedback, type TripPresentation, type TripResult } from './result.js';
import {
  acceptedSuggestions,
  getTripState,
  mergeFacts,
  mergePlan,
  placesOfInterestFromPlan,
  planPhotoCode,
  plainText,
  savedOptions,
  type TripPlannerV2State,
} from './state.js';

export interface ApplyTripResultOptions {
  requestId: string | null;
  /** A hosted web_search completed in this run, so researched facts have evidence. */
  researched: boolean;
  /** The traveler's local date, recorded on researched facts. */
  checkedOn: string | null;
}

export interface AppliedTripResult {
  feedback: TripFeedback;
  /** City codes whose photos the reply may show. */
  photoCodes: string[];
}

/** Typed failure for a result the app cannot use; never SDK error text the Manager would retry. */
export function tripFailureFeedback(): TripFeedback {
  return {
    status: 'failure',
    intent: 'answer',
    summary: 'The trip request could not be completed.',
    findings: [],
    limitations: [],
    nextStep: null,
    presentation: null,
    presentationDays: [],
  };
}

function presentationFor(result: TripResult, trip: TripPlannerV2State): { presentation: TripPresentation | null; presentationDays: number[] } {
  if (result.plan && trip.plan?.days.length) {
    if (result.plan.scope === 'full') return { presentation: 'trip_plan', presentationDays: [] };
    const saved = new Set(trip.plan.days.map((day) => day.day));
    const days = [...new Set(result.plan.days.map((day) => day.day))].filter((day) => saved.has(day)).sort((left, right) => left - right);
    if (days.length) return { presentation: 'trip_days', presentationDays: days };
  }
  if (result.options?.length && trip.options?.length) return { presentation: 'trip_options', presentationDays: [] };
  return { presentation: null, presentationDays: [] };
}

/**
 * Applies one Trip result: update trip context (the client summary and the Trip-owned plan,
 * options and facts), update suggested questions (chips), and the report for the Manager.
 */
export function applyTripResult(
  context: Record<string, any>,
  result: TripResult,
  { requestId, researched, checkedOn }: ApplyTripResultOptions,
): AppliedTripResult {
  const clean = (values: string[]) => values.map(plainText).filter(Boolean);
  if (result.status === 'failure') {
    // A failed run changes nothing that was saved.
    return {
      feedback: tripFeedbackSchema.parse({
        ...tripFailureFeedback(),
        intent: result.intent,
        summary: plainText(result.summary) || tripFailureFeedback().summary,
        limitations: clean(result.limitations),
      }),
      photoCodes: [],
    };
  }

  const trip = getTripState(context);
  const limitations: string[] = [];
  const update = applyTripChanges(context.summaryContext, result.trip);
  limitations.push(...update.limitations);
  const summary = update.summary;
  // Knowledge tied to an old destination or old dates goes before this result's content arrives.
  if (update.destinationChanged) {
    trip.plan = null;
    trip.facts = [];
  } else if (update.datesChanged) {
    trip.facts = [];
  }
  if (result.plan) trip.plan = mergePlan(trip.plan, result.plan, summary.destination);
  if (result.options) trip.options = savedOptions(result.options);

  const factFindings: string[] = [];
  if (result.facts?.length) {
    if (researched) {
      trip.facts = mergeFacts(trip.facts, result.facts, checkedOn);
      factFindings.push(...result.facts.map((fact) => `${plainText(fact.text)} (${plainText(fact.source)})`));
    } else {
      limitations.push('The requested current information could not be verified.');
    }
  }
  if (result.dateHint) trip.dateHint = plainText(result.dateHint);
  else if (update.datesChanged && summary.outbound_date) trip.dateHint = null;

  if (trip.plan) summary.placesOfInterest = placesOfInterestFromPlan(trip.plan);
  else if (update.destinationChanged) summary.placesOfInterest = [];
  const checked = validateClientSummary(summary);
  if (checked.ok) context.summaryContext = summary;
  else log('warn', 'trip_planner_v2.summary_rejected', { requestId, reason: checked.error });

  trip.lastQuestion = result.nextStep ? plainText(result.nextStep) : null;
  trip.suggestions = acceptedSuggestions(result.suggestions, trip.suggestions ?? []);
  const { presentation, presentationDays } = presentationFor(result, trip);
  if (presentation) trip.turnView = { requestId, presentation, presentationDays };
  else if (trip.turnView?.requestId !== requestId) trip.turnView = null;

  const photoCodes = [...(trip.options ?? []).map((option) => option.code), trip.plan ? planPhotoCode(trip.plan) : null]
    .filter((code): code is string => Boolean(code));
  return {
    feedback: tripFeedbackSchema.parse({
      status: result.status,
      intent: result.intent,
      summary: plainText(result.summary) || 'The trip request was handled.',
      findings: [...clean(result.findings), ...factFindings],
      limitations: [...new Set([...clean(result.limitations), ...limitations])],
      nextStep: trip.lastQuestion,
      presentation,
      presentationDays,
    }),
    photoCodes,
  };
}
