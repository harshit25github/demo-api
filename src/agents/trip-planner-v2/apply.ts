import { applyTripChanges } from './client-summary.js';
import {
  clientSummarySchema,
  type ClientSummary,
  type SavedTripFact,
  type SavedTripOption,
  type TripDay,
  type TripFeedback,
  type TripPlan,
  type TripPlannerV2State,
  type TripResult,
} from './schema.js';
import { isOutOfTripScope } from './scope.js';
import { plainText } from './state.js';

const ASSISTANT_STYLE = /^\s*(?:would\s+you\s+like|do\s+you\s+want|should\s+i|can\s+i)\b/i;

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

function cleanDay(day: TripDay): TripDay {
  const block = (value: string) => plainText(value) || 'Free time';
  return {
    day: day.day,
    title: plainText(day.title) || `Day ${day.day}`,
    morning: block(day.morning),
    afternoon: block(day.afternoon),
    evening: block(day.evening),
    places: [...new Set(day.places.map(plainText).filter(Boolean))],
  };
}

/** A full plan replaces the saved one; a days update replaces only those days. */
function mergePlan(existing: TripPlan | null | undefined, update: NonNullable<TripResult['plan']>, destination: ClientSummary['destination']): TripPlan {
  const days = new Map<number, TripDay>();
  if (update.scope === 'days' && existing) for (const day of existing.days) days.set(day.day, day);
  for (const day of update.days) days.set(day.day, cleanDay(day));
  for (const day of update.removeDays) days.delete(day);
  const card = update.card
    ? { country: plainText(update.card.country), knownFor: plainText(update.card.knownFor), bestTime: plainText(update.card.bestTime), cost: update.card.cost }
    : existing?.card ?? null;
  return { destination: { ...destination }, card, days: [...days.values()].sort((left, right) => left.day - right.day) };
}

/** update suggested questions: up to three 3-8 word chips, new and in scope. Invalid ones are dropped, never retried. */
function acceptedSuggestions(values: string[], previous: string[]): string[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const seen = new Set(previous.map(normalize));
  const accepted: string[] = [];
  for (const value of values) {
    const suggestion = plainText(value);
    const words = suggestion.split(' ').filter(Boolean).length;
    const key = normalize(suggestion);
    if (words < 3 || words > 8 || ASSISTANT_STYLE.test(suggestion) || isOutOfTripScope(suggestion) || seen.has(key)) continue;
    seen.add(key);
    accepted.push(suggestion);
  }
  return accepted.slice(0, 3);
}

/**
 * Applies one Trip result: update trip context (the client summary and the Trip-owned plan,
 * options and facts), update suggested questions (chips), and the report for the Manager.
 */
export function applyTripResult(
  context: Record<string, any>,
  result: TripResult,
  { researched, checkedOn }: { researched: boolean; checkedOn: string | null },
): TripFeedback {
  const clean = (values: string[]) => values.map(plainText).filter(Boolean);
  if (result.status === 'failure') {
    // A failed run changes nothing that was saved.
    const failure = tripFailureFeedback();
    return { ...failure, intent: result.intent, summary: plainText(result.summary) || failure.summary, limitations: clean(result.limitations) };
  }

  if (!context.tripPlanner || typeof context.tripPlanner !== 'object') context.tripPlanner = {};
  const trip = context.tripPlanner as TripPlannerV2State;
  const update = applyTripChanges(context.summaryContext, result.trip);
  const summary = update.summary;
  const limitations = [...update.limitations];
  // Knowledge tied to an old destination or old dates goes before this result's content arrives.
  if (update.destinationChanged) {
    trip.plan = null;
    trip.facts = [];
  } else if (update.datesChanged) {
    trip.facts = [];
  }
  if (result.plan) trip.plan = mergePlan(trip.plan, result.plan, summary.destination);
  if (result.options) {
    trip.options = result.options
      .map((option): SavedTripOption => ({
        code: /^[A-Z]{3}$/.test(option.code.trim().toUpperCase()) ? option.code.trim().toUpperCase() : null,
        city: plainText(option.city),
        country: plainText(option.country),
        why: plainText(option.why),
        bestTime: plainText(option.bestTime),
        cost: option.cost,
      }))
      .filter((option, index, all) => option.city
        && all.findIndex((other) => `${other.city}|${other.country}`.toLowerCase() === `${option.city}|${option.country}`.toLowerCase()) === index);
  }

  const factFindings: string[] = [];
  if (result.facts?.length && researched) {
    const facts: SavedTripFact[] = [...(trip.facts ?? [])];
    for (const fact of result.facts) {
      const text = plainText(fact.text);
      const source = plainText(fact.source);
      if (!text || !source || facts.some((saved) => saved.text.toLowerCase() === text.toLowerCase())) continue;
      facts.push({ text, source, day: fact.day, checkedOn });
      factFindings.push(`${text} (${source})`);
    }
    trip.facts = facts.slice(-10);
  } else if (result.facts?.length) {
    // A sourced fact needs a search that completed in this run.
    limitations.push('The requested current information could not be verified.');
  }
  if (result.dateHint) trip.dateHint = plainText(result.dateHint);
  else if (update.datesChanged && summary.outbound_date) trip.dateHint = null;

  // placesOfInterest: every named place in the current plan, once.
  if (trip.plan) {
    summary.placesOfInterest = [];
    for (const day of trip.plan.days) {
      for (const placeName of day.places) {
        if (summary.placesOfInterest.some((place) => place.placeName.toLowerCase() === placeName.toLowerCase())) continue;
        summary.placesOfInterest.push({ placeName, description: `Day ${day.day}: ${day.title}` });
      }
    }
  } else if (update.destinationChanged) {
    summary.placesOfInterest = [];
  }
  // The client summary is saved only in its exact shape; otherwise the previous one stays.
  if (clientSummarySchema.safeParse(summary).success) context.summaryContext = summary;

  trip.lastQuestion = result.nextStep ? plainText(result.nextStep) || null : null;
  trip.suggestions = acceptedSuggestions(result.suggestions, trip.suggestions ?? []);

  let presentation: TripFeedback['presentation'] = null;
  let presentationDays: number[] = [];
  if (result.plan && trip.plan?.days.length) {
    const saved = new Set(trip.plan.days.map((day) => day.day));
    presentationDays = result.plan.scope === 'full'
      ? []
      : [...new Set(result.plan.days.map((day) => day.day))].filter((day) => saved.has(day)).sort((left, right) => left - right);
    presentation = result.plan.scope === 'full' ? 'trip_plan' : presentationDays.length ? 'trip_days' : null;
  }
  if (!presentation && result.options?.length && trip.options?.length) presentation = 'trip_options';
  if (presentation) trip.turnView = { presentation, presentationDays };

  return {
    status: result.status,
    intent: result.intent,
    summary: plainText(result.summary) || 'The trip request was handled.',
    findings: [...clean(result.findings), ...factFindings],
    limitations: [...new Set([...clean(result.limitations), ...limitations])],
    nextStep: trip.lastQuestion,
    presentation,
    presentationDays,
  };
}
