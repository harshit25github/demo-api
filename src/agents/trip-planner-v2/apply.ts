import { applyTripChanges, createClientSummary } from './client-summary.js';
import { fetchTripPhotos } from './photos.js';
import {
  clientSummarySchema,
  type ClientSummary,
  type SavedTripDay,
  type SavedTripFact,
  type SavedTripOption,
  type TripCard,
  type TripCost,
  type TripDay,
  type TripFeedback,
  type TripPlan,
  type TripPlannerV2State,
  type TripResult,
  type TripSaved,
} from './schema.js';
import { isOutOfTripScope } from './scope.js';
import { plainText } from './state.js';

const ASSISTANT_STYLE = /^\s*(?:would\s+you\s+like|do\s+you\s+want|should\s+i|can\s+i)\b/i;
const COST_LABELS: Record<TripCost, string> = { $: 'Budget-friendly', $$: 'Mid-range', $$$: 'Splurge' };
const DAY_PARTS = ['title', 'morning', 'afternoon', 'evening'] as const;
// The app supplies every photo, so Trip has nothing to report about them, even when the traveler
// asked for photos; live runs showed Trip saying "I can't attach photos here" despite the prompt.
const PHOTOS = /\b(?:photos?|images?|pictures?)\b/i;
const PHOTO_ABILITY = /\b(?:app|chat|attach\w*|link\w*|can(?:no|'|’)t|cannot|unable)\b/i;

/** The trip details the Manager may say changed, read from the client summary. */
const TRIP_DETAILS: Array<[TripSaved['tripDetails'][number], (summary: ClientSummary) => unknown]> = [
  ['destination', (summary) => summary.destination],
  ['origin', (summary) => summary.origin],
  ['dates', (summary) => [summary.outbound_date, summary.return_date]],
  ['duration', (summary) => summary.duration_days],
  ['travelers', (summary) => summary.passengerData],
  ['budget', (summary) => summary.budget],
  ['tripType', (summary) => summary.tripType],
];

/** Typed failure for a result the app cannot use; never SDK error text the Manager would retry. */
export function tripFailureFeedback(): TripFeedback {
  return {
    status: 'failure',
    intent: 'answer',
    summary: 'The trip request could not be completed.',
    saved: { plan: 'unchanged', days: [], removedDays: [], tripDetails: [] },
    presentation: null,
    cards: [],
    days: [],
    findings: [],
    limitations: [],
    nextStep: null,
  };
}

/** A day from Trip; a null field keeps the saved day's value. */
function savedDay(day: TripDay, kept?: SavedTripDay): SavedTripDay {
  const field = (value: string | null, keptValue: string | undefined, fallback: string) =>
    (value === null ? keptValue : plainText(value) || keptValue) || fallback;
  return {
    day: day.day,
    title: field(day.title, kept?.title, `Day ${day.day}`),
    morning: field(day.morning, kept?.morning, 'Free time'),
    afternoon: field(day.afternoon, kept?.afternoon, 'Free time'),
    evening: field(day.evening, kept?.evening, 'Free time'),
    places: day.places === null ? [...(kept?.places ?? [])] : [...new Set(day.places.map(plainText).filter(Boolean))],
  };
}

/** A full plan replaces the saved one. A days update changes only days already in the plan; other days are skipped. */
function mergePlan(
  existing: TripPlan | null | undefined,
  update: NonNullable<TripResult['plan']>,
  destination: ClientSummary['destination'],
): { plan: TripPlan; skipped: number[] } {
  const days = new Map<number, SavedTripDay>();
  const skipped: number[] = [];
  if (update.scope === 'days') for (const day of existing?.days ?? []) days.set(day.day, day);
  for (const day of update.days) {
    if (update.scope === 'days' && !days.has(day.day)) {
      skipped.push(day.day);
      continue;
    }
    days.set(day.day, savedDay(day, update.scope === 'days' ? days.get(day.day) : undefined));
  }
  for (const day of update.removeDays) days.delete(day);
  const card = update.card
    ? { country: plainText(update.card.country), knownFor: plainText(update.card.knownFor), bestTime: plainText(update.card.bestTime), cost: update.card.cost }
    : existing?.card ?? null;
  return { plan: { destination: { ...destination }, card, days: [...days.values()].sort((left, right) => left.day - right.day) }, skipped };
}

/** What changed in the plan, measured on the saved plan before and after. */
function planChanges(before: TripPlan | null | undefined, after: TripPlan | null | undefined): Omit<TripSaved, 'tripDetails'> {
  const previous = new Map((before?.days ?? []).map((day) => [day.day, day]));
  const kept = new Set((after?.days ?? []).map((day) => day.day));
  const days = (after?.days ?? []).flatMap((day) => {
    const old = previous.get(day.day);
    const changed: TripSaved['days'][number]['changed'] = old ? DAY_PARTS.filter((part) => old[part] !== day[part]) : ['new'];
    return changed.length ? [{ day: day.day, changed }] : [];
  });
  const removedDays = [...previous.keys()].filter((day) => !kept.has(day));
  const plan = !previous.size && kept.size ? 'created'
    : previous.size && !kept.size ? 'cleared'
      : days.length || removedDays.length ? 'updated' : 'unchanged';
  return { plan, days, removedDays };
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
 * The report says what was saved, measured here, and carries the cards and days to show.
 */
export async function applyTripResult(
  context: Record<string, any>,
  result: TripResult,
  { researched, checkedOn }: { researched: boolean; checkedOn: string | null },
): Promise<TripFeedback> {
  const clean = (values: string[]) => values.map(plainText).filter((value) => value && !(PHOTOS.test(value) && PHOTO_ABILITY.test(value)));
  if (result.status === 'failure') {
    // A failed run changes nothing that was saved.
    const failure = tripFailureFeedback();
    return { ...failure, intent: result.intent, summary: plainText(result.summary) || failure.summary, limitations: clean(result.limitations) };
  }

  if (!context.tripPlanner || typeof context.tripPlanner !== 'object') context.tripPlanner = {};
  const trip = context.tripPlanner as TripPlannerV2State;
  const summaryBefore = createClientSummary(context.summaryContext);
  const planBefore = structuredClone(trip.plan ?? null);
  const update = applyTripChanges(context.summaryContext, result.trip);
  const summary = update.summary;
  const limitations = [...update.limitations];
  // What Trip's result describes but the app did not save.
  const unsaved: string[] = [];
  // Knowledge tied to an old destination or old dates goes before this result's content arrives.
  if (update.destinationChanged) {
    trip.plan = null;
    trip.facts = [];
  } else if (update.datesChanged) {
    trip.facts = [];
  }
  let skipped: number[] = [];
  if (result.plan) {
    const merged = mergePlan(trip.plan, result.plan, summary.destination);
    trip.plan = merged.plan;
    skipped = merged.skipped;
  }
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
    unsaved.push('The requested current information could not be verified.');
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
  // The client summary is saved only in its exact shape; otherwise the previous one stays,
  // and the report says so when this result changed trip details.
  const summarySaved = clientSummarySchema.safeParse(summary).success;
  if (summarySaved) context.summaryContext = summary;
  else if (result.trip) unsaved.push('Some trip details could not be saved.');

  trip.lastQuestion = result.nextStep ? plainText(result.nextStep) || null : null;
  trip.suggestions = acceptedSuggestions(result.suggestions, trip.suggestions ?? []);

  // A new destination's plan counts as created, not as every day changed.
  const plan = trip.plan;
  const changes = planChanges(update.destinationChanged && plan?.days.length ? null : planBefore, plan);
  const tripDetails = summarySaved
    ? TRIP_DETAILS.filter(([, read]) => JSON.stringify(read(summaryBefore)) !== JSON.stringify(read(summary))).map(([name]) => name)
    : [];
  if (skipped.length) {
    unsaved.push(skipped.length === 1
      ? `Day ${skipped[0]} is not in the plan, so it was not changed.`
      : `Days ${skipped.join(', ')} are not in the plan, so they were not changed.`);
  } else if (result.intent === 'revise' && changes.plan === 'unchanged' && !tripDetails.length) {
    unsaved.push('The plan was not changed.');
  }
  if (result.intent === 'plan' && !plan?.days.length) unsaved.push('No day-by-day plan was made.');
  // Trip's own success claim stands only when everything it describes was saved.
  const status = unsaved.length && result.status === 'success' ? 'partial' : result.status;

  let presentation: TripFeedback['presentation'] = null;
  let days: SavedTripDay[] = [];
  const cards: TripCard[] = [];
  const card = (title: string, code: string | null, knownFor: string, bestTime: string, cost: TripCost): TripCard => ({
    title, image: (code && trip.photos?.[code]) || 'Photo unavailable', known_for: knownFor, weather: bestTime, budget: COST_LABELS[cost],
  });
  if (plan?.days.length && (changes.plan === 'created' || result.plan?.scope === 'full')) {
    presentation = 'trip_plan';
    days = plan.days;
    const title = [plan.destination.city, plan.card?.country].filter(Boolean).join(', ');
    if (plan.card && title) {
      await fetchTripPhotos(trip, [plan.destination.iata]);
      cards.push(card(title, plan.destination.iata, plan.card.knownFor, plan.card.bestTime, plan.card.cost));
    }
  } else if (plan?.days.length && changes.days.length) {
    presentation = 'trip_days';
    const changed = new Set(changes.days.map((entry) => entry.day));
    days = plan.days.filter((day) => changed.has(day.day));
  } else if (result.options?.length && trip.options?.length) {
    presentation = 'trip_options';
    await fetchTripPhotos(trip, trip.options.map((option) => option.code));
    for (const option of trip.options) cards.push(card(`${option.city}, ${option.country}`, option.code, option.why, option.bestTime, option.cost));
  }

  return {
    status,
    intent: result.intent,
    summary: plainText(result.summary) || 'The trip request was handled.',
    saved: { ...changes, tripDetails },
    presentation,
    cards,
    days: days.map(({ day, title, morning, afternoon, evening }) => ({ day, title, morning, afternoon, evening })),
    findings: [...clean(result.findings), ...factFindings],
    limitations: [...new Set([...clean(result.limitations), ...limitations, ...unsaved])],
    nextStep: trip.lastQuestion,
  };
}
