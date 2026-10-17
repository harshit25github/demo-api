import { applyTripChanges, createClientSummary } from './client-summary.js';
import {
  clientSummarySchema,
  type SavedTripDay,
  type SavedTripFact,
  type TripCost,
  type TripDay,
  type TripDetailName,
  type TripFeedback,
  type TripPlan,
  type TripPlannerV2State,
  type TripReportDay,
  type TripResult,
} from './schema.js';
import { isOutOfTripScope } from './scope.js';
import { chipsShown, plainText, tripDetailText } from './state.js';

const ASSISTANT_STYLE = /^\s*(?:would\s+you\s+like|do\s+you\s+want|should\s+i|can\s+i)\b/i;
const COST_LABELS: Record<TripCost, TripFeedback['options'][number]['cost']> = { $: 'Budget-friendly', $$: 'Mid-range', $$$: 'Splurge' };
const TEXT_PARTS = ['title', 'morning', 'afternoon', 'evening'] as const;
// Hard ceilings, applied here and never by the decoder: a schema maxLength cuts strings mid-word
// (src/agents/flight/manager-output.ts). The prompt's length targets sit well below them.
const SLOT_WORDS = 60;
const NOTE_WORDS = 25;
const SENTENCE_END = /[.!?](?=\s|$)/g;
const TRIP_DETAILS: TripDetailName[] = ['destination', 'origin', 'dates', 'timing', 'duration', 'travelers', 'budget', 'tripType'];

type DayChange = { day: SavedTripDay; changed: NonNullable<TripReportDay['changed']>; was?: TripReportDay['was'] };

/** Typed failure for a result the app cannot use; never SDK error text the Manager would retry. */
export function tripFailureFeedback(): TripFeedback {
  return { status: 'failure', intent: 'answer', options: [], plan: null, tripDetails: [], findings: [], limitations: [], nextStep: null };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** At most maxWords words, cut at the last full sentence that fits, or at a word with an ellipsis. */
function bounded(value: string, maxWords: number): string {
  const words = value.split(' ');
  if (words.length <= maxWords) return value;
  const head = words.slice(0, maxWords).join(' ');
  let end = 0;
  for (const match of head.matchAll(SENTENCE_END)) end = (match.index ?? 0) + 1;
  return end > 0 ? head.slice(0, end) : `${head.replace(/[\s,;:–—-]+$/u, '')}…`;
}

/** A day from Trip; a null field keeps the saved day's value. */
function savedDay(day: TripDay, kept?: SavedTripDay): SavedTripDay {
  const field = (value: string | null, keptValue: string | undefined, fallback: string) =>
    (value === null ? keptValue : bounded(plainText(value), SLOT_WORDS) || keptValue) || fallback;
  return {
    day: day.day,
    title: field(day.title, kept?.title, `Day ${day.day}`),
    morning: field(day.morning, kept?.morning, 'Free time'),
    afternoon: field(day.afternoon, kept?.afternoon, 'Free time'),
    evening: field(day.evening, kept?.evening, 'Free time'),
    notes: day.notes === null ? [...(kept?.notes ?? [])] : unique(day.notes.map((note) => bounded(plainText(note), NOTE_WORDS))).slice(0, 3),
    places: day.places === null ? [...(kept?.places ?? [])] : unique(day.places.map(plainText)),
  };
}

/** A full plan replaces the saved one. A days update changes only days already in the plan; other days are skipped. */
function mergePlan(
  existing: TripPlan | null | undefined,
  update: NonNullable<TripResult['plan']>,
  destination: TripPlan['destination'],
): { plan: TripPlan; skipped: number[] } {
  const days = new Map<number, SavedTripDay>();
  const skipped: number[] = [];
  if (update.scope === 'days') for (const day of existing?.days ?? []) days.set(day.day, { ...day, notes: day.notes ?? [] });
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

/** What changed in the plan, measured on the saved plan before and after, with each changed part's previous value. */
function planChanges(before: TripPlan | null | undefined, after: TripPlan | null | undefined) {
  const previous = new Map((before?.days ?? []).map((day) => [day.day, day]));
  const kept = new Set((after?.days ?? []).map((day) => day.day));
  const days = (after?.days ?? []).flatMap((day): DayChange[] => {
    const old = previous.get(day.day);
    if (!old) return [{ day, changed: ['new'] }];
    const changed: DayChange['changed'] = [];
    const was: NonNullable<TripReportDay['was']> = {};
    for (const part of TEXT_PARTS) {
      if (old[part] !== day[part]) {
        changed.push(part);
        was[part] = old[part];
      }
    }
    if (JSON.stringify(old.notes ?? []) !== JSON.stringify(day.notes ?? [])) {
      changed.push('notes');
      was.notes = [...(old.notes ?? [])];
    }
    return changed.length ? [{ day, changed, was }] : [];
  });
  const removedDays = [...previous.values()].filter((day) => !kept.has(day.day)).map((day) => ({ day: day.day, title: day.title }));
  const change: NonNullable<TripFeedback['plan']>['change'] = !previous.size && kept.size ? 'created'
    : previous.size && !kept.size ? 'cleared'
      : days.length || removedDays.length ? 'updated' : 'unchanged';
  return { change, days, removedDays };
}

function reportDay(day: SavedTripDay, change?: DayChange): TripReportDay {
  const content = { day: day.day, title: day.title, morning: day.morning, afternoon: day.afternoon, evening: day.evening, notes: [...(day.notes ?? [])] };
  if (!change) return content;
  return change.was ? { ...content, changed: change.changed, was: change.was } : { ...content, changed: change.changed };
}

function destinationName(plan: TripPlan): string {
  return [plan.destination.city ?? plan.destination.iata, plan.card?.country].filter(Boolean).join(', ') || 'the destination';
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
 * Everything the report says changed is measured here, and its days come from the saved plan.
 */
export async function applyTripResult(
  context: Record<string, any>,
  result: TripResult,
  { researched, checkedOn }: { researched: boolean; checkedOn: string | null },
): Promise<TripFeedback> {
  const clean = (values: string[]) => values.map(plainText).filter(Boolean);
  if (result.status === 'failure') {
    // A failed run changes nothing that was saved.
    return { ...tripFailureFeedback(), intent: result.intent, limitations: clean(result.limitations) };
  }

  if (!context.tripPlanner || typeof context.tripPlanner !== 'object') context.tripPlanner = {};
  const trip = context.tripPlanner as TripPlannerV2State;
  const summaryBefore = createClientSummary(context.summaryContext);
  const hintBefore = trip.dateHint ?? null;
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

  let options: TripFeedback['options'] = [];
  if (result.options) {
    const seen = new Set<string>();
    const accepted = result.options.flatMap((option) => {
      const shown = { city: plainText(option.city), country: plainText(option.country), why: plainText(option.why), bestTime: plainText(option.bestTime) };
      const key = `${shown.city}|${shown.country}`.toLowerCase();
      if (!shown.city || !shown.why || !shown.bestTime || seen.has(key)) return [];
      seen.add(key);
      return [{ option, shown }];
    });
    trip.options = accepted.map(({ option, shown }) => ({
      code: /^[A-Z]{3}$/.test(option.code.trim().toUpperCase()) ? option.code.trim().toUpperCase() : null,
      ...shown,
      cost: option.cost,
    }));
    options = accepted.map(({ option, shown }) => ({
      city: shown.city,
      country: shown.country,
      why: shown.why,
      highlights: unique(option.highlights.map(plainText)).slice(0, 3),
      watchOut: plainText(option.watchOut ?? '') || null,
      bestTime: shown.bestTime,
      cost: COST_LABELS[option.cost],
    }));
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
  trip.suggestions = acceptedSuggestions(result.suggestions, chipsShown(summaryBefore, trip));

  // A new destination's plan counts as created, not as every day changed.
  const plan = trip.plan;
  const changes = planChanges(update.destinationChanged && plan?.days.length ? null : planBefore, plan);
  const summaryAfter = summarySaved ? summary : summaryBefore;
  const tripDetails = TRIP_DETAILS.flatMap((detail) => {
    const was = tripDetailText(detail, summaryBefore, hintBefore);
    const now = tripDetailText(detail, summaryAfter, trip.dateHint);
    return was === now ? [] : [{ detail, was, now }];
  });
  // Trip meant to change the plan and nothing in it was saved: its findings describe work that didn't happen.
  const planWorkLost = (result.intent === 'revise' && changes.change === 'unchanged' && !tripDetails.length)
    || (result.intent === 'plan' && !plan?.days.length);
  if (skipped.length) {
    unsaved.push(skipped.length === 1
      ? `Day ${skipped[0]} is not in the plan, so it was not changed.`
      : `Days ${skipped.join(', ')} are not in the plan, so they were not changed.`);
  } else if (result.intent === 'revise' && planWorkLost) {
    unsaved.push('The plan was not changed.');
  }
  if (result.intent === 'plan' && planWorkLost) unsaved.push('No day-by-day plan was made.');
  // Trip's own success claim stands only when everything it describes was saved.
  const status = unsaved.length && result.status === 'success' ? 'partial' : result.status;

  // The days the Manager gets: every day of a new plan, every day of a rebuilt one with its changes
  // marked, otherwise the changed days and the ones Trip says this turn is about.
  let reportPlan: TripFeedback['plan'] = null;
  if (changes.change === 'cleared' && planBefore) {
    reportPlan = { change: 'cleared', destination: destinationName(planBefore), overview: null, totalDays: 0, days: [], removedDays: changes.removedDays };
  } else if (plan?.days.length) {
    const byDay = new Map(changes.days.map((entry) => [entry.day.day, entry]));
    const relevant = new Set(result.relevantDays);
    const everyDay = changes.change === 'created' || (changes.change === 'updated' && result.plan?.scope === 'full');
    const days = plan.days
      .filter((day) => everyDay || byDay.has(day.day) || relevant.has(day.day))
      .map((day) => reportDay(day, changes.change === 'created' ? undefined : byDay.get(day.day)));
    if (days.length || changes.removedDays.length) {
      reportPlan = {
        change: changes.change,
        destination: destinationName(plan),
        overview: changes.change === 'created' && plan.card
          ? { knownFor: plan.card.knownFor, bestTime: plan.card.bestTime, cost: COST_LABELS[plan.card.cost] }
          : null,
        totalDays: plan.days.length,
        days,
        removedDays: changes.removedDays,
      };
    }
  }

  return {
    status,
    intent: result.intent,
    options,
    plan: reportPlan,
    tripDetails,
    findings: [...(planWorkLost ? [] : clean(result.findings)), ...factFindings],
    limitations: [...new Set([...clean(result.limitations), ...limitations, ...unsaved])],
    nextStep: trip.lastQuestion,
  };
}
