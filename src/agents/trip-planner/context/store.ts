import { createTripPlannerSummaryContext } from './summary-context.js';
import { resolveTripPlannerDestinationIata } from './planning-brief.js';
import type { TripPlannerManagerOutput } from '../manager-output.js';

const MAX_DESCRIPTION_LENGTH = 180;
const MAX_PLAN_LENGTH = 12_000;
type TripPlannerContextRecord = Record<string, any>;
type StoredPlanFacts = Pick<TripPlannerManagerOutput,
  'destinationCards' | 'recommendation' | 'notes' | 'tables' | 'limitations'
> & { legacyContent?: string };

export interface PlanDay {
  day: number;
  title: string;
  content: string;
  morning?: string | null;
  afternoon?: string | null;
  evening?: string | null;
  legacyContent?: string;
}

const TIME_BLOCKS = ['morning', 'afternoon', 'evening'] as const;

const tripPlannerSessionLocks = new Map<string, Promise<void>>();

function compactText(value: unknown, maxLength = MAX_DESCRIPTION_LENGTH): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function extractPlanDays(output = ''): PlanDay[] {
  const lines = String(output || '').split(/\r?\n/);
  const days: PlanDay[] = [];
  let current: PlanDay | null = null;
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:#{2,3}\s*)?\*{0,2}Day\s+(\d+)\s*(?:-|\u2014)\s*(.*?)\*{0,2}\s*$/i,
    );
    if (match) {
      if (current) {
        days.push(current);
      }
      current = {
        day: Number(match[1]),
        title: compactText(match[2], 100),
        content: '',
      };
      continue;
    }
    if (current && line.trim()) {
      current.content = compactText(
        `${current.content} ${line.trim()}`.trim(),
        700,
      );
    }
  }
  if (current) {
    days.push(current);
  }
  return days;
}

function recoverDayBlocks(day: PlanDay): PlanDay {
  if (TIME_BLOCKS.some((block) => Object.hasOwn(day, block))) return { ...day };
  const matches = [...day.content.matchAll(
    /(?:\p{Extended_Pictographic}\uFE0F?\s*)?\*{0,2}(Morning|Afternoon|Evening)\s*:\s*\*{0,2}/giu,
  )];
  const recovered: PlanDay = { ...day };
  for (const [index, match] of matches.entries()) {
    const block = match[1].toLowerCase() as typeof TIME_BLOCKS[number];
    recovered[block] = compactText(
      day.content.slice(match.index! + match[0].length, matches[index + 1]?.index).replace(/\*\*/g, ''),
      700,
    );
  }
  const unstructured = matches.length ? day.content.slice(0, matches[0].index).trim() : day.content;
  if (unstructured) recovered.legacyContent = compactText(unstructured, 700);
  return recovered;
}

function mergePlanDay(
  patch: TripPlannerManagerOutput['itineraryDays'][number],
  previous?: PlanDay,
): PlanDay {
  const day = previous ? recoverDayBlocks(previous) : { day: patch.day, title: '', content: '' };
  day.title = patch.title === null ? day.title : compactText(patch.title, 100);
  for (const block of TIME_BLOCKS) {
    day[block] = patch[block] === null ? day[block] ?? null : compactText(patch[block], 700);
  }
  day.content = compactText(JSON.stringify({
    ...(day.legacyContent ? { previousUnstructuredGuidance: day.legacyContent } : {}),
    morning: day.morning,
    afternoon: day.afternoon,
    evening: day.evening,
  }), 700);
  return day;
}

function sameDestination(before: TripPlannerContextRecord, after: TripPlannerContextRecord): boolean {
  if (before.iata && after.iata && String(before.iata).toUpperCase() !== String(after.iata).toUpperCase()) return false;
  if (before.city && after.city && String(before.city).toLowerCase() !== String(after.city).toLowerCase()) return false;
  return Boolean((before.iata && after.iata) || (before.city && after.city));
}

export function ensureTripPlannerState(
  context: TripPlannerContextRecord = {},
): TripPlannerContextRecord {
  context.summaryContext = createTripPlannerSummaryContext(context.summaryContext);
  context.tripPlanner =
    context.tripPlanner && typeof context.tripPlanner === 'object'
      ? context.tripPlanner
      : {};
  context.tripPlanner.contextRevision = Number.isInteger(
    context.tripPlanner.contextRevision,
  )
    ? context.tripPlanner.contextRevision
    : 0;
  return context.tripPlanner;
}

export function getTripPlannerContextRevision(context: TripPlannerContextRecord = {}) {
  return ensureTripPlannerState(context).contextRevision;
}

export function bumpTripPlannerContextRevision(context: TripPlannerContextRecord = {}) {
  const state = ensureTripPlannerState(context);
  state.contextRevision += 1;
  return state.contextRevision;
}

export function clearTripPlannerSummaryFields(
  context: TripPlannerContextRecord = {},
  fields: string[] = [],
) {
  ensureTripPlannerState(context);
  const summary = createTripPlannerSummaryContext(context.summaryContext);
  for (const field of fields) {
    if (field === 'budget') {
      summary.budget = {
        total: null,
        amount: null,
        currency: null,
        per_person: null,
      };
    } else if (field === 'origin' || field === 'destination') {
      (summary as TripPlannerContextRecord)[field] = { city: null, iata: null };
    } else if (field === 'tripType') {
      summary.tripType = [];
    } else if (
      ['outbound_date', 'return_date', 'duration_days', 'pax'].includes(field)
    ) {
      (summary as TripPlannerContextRecord)[field] = null;
    }
  }
  context.summaryContext = createTripPlannerSummaryContext(summary);
  return context.summaryContext;
}

export function invalidateTripPlannerKnowledge(context: TripPlannerContextRecord = {}, {
  destinationChanged = false,
  datesChanged = false,
}: { destinationChanged?: boolean; datesChanged?: boolean } = {}) {
  const state = ensureTripPlannerState(context);
  if (destinationChanged) {
    context.summaryContext.upcomingEvents = [];
    context.summaryContext.placesOfInterest = [];
    state.lastPlanArtifact = null;
    const destinationCode = resolveTripPlannerDestinationIata(
      context.summaryContext.destination,
    );
    const matchingImage = destinationCode
      ? state.placeImageCache?.[destinationCode]
      : null;
    state.placeImageCache =
      destinationCode && matchingImage
        ? { [destinationCode]: matchingImage }
        : {};
    return;
  }
  if (datesChanged) {
    context.summaryContext.upcomingEvents = [];
  }
}

export function setTripPlannerLastPlanArtifact(
  context: TripPlannerContextRecord = {},
  { output = '', responseMode = null, feedback }: {
    output?: string;
    responseMode?: string | null;
    feedback?: TripPlannerManagerOutput;
  } = {},
) {
  const state = ensureTripPlannerState(context);
  if (state.scopeClassification?.mode === 'excluded') return null;
  let days = extractPlanDays(output);
  let facts: Partial<StoredPlanFacts> = {};
  if (feedback) {
    if (['failure', 'needs_input'].includes(feedback.status) || feedback.mode === 'answer') return null;
    const previous = feedback.mode === 'compact_patch' && state.lastPlanArtifact &&
      sameDestination(state.lastPlanArtifact.destination || {}, context.summaryContext.destination)
      ? state.lastPlanArtifact
      : null;
    if (!feedback.itineraryDays.length && !feedback.destinationCards.length &&
      !(previous && (feedback.notes.length || feedback.tables.length || feedback.recommendation))) return null;
    const currentDays = new Map<number, PlanDay>(
      (previous?.days || []).map((day: PlanDay) => [day.day, recoverDayBlocks(day)]),
    );
    for (const day of feedback.itineraryDays) currentDays.set(day.day, mergePlanDay(day, currentDays.get(day.day)));
    days = [...currentDays.values()].sort((left, right) => left.day - right.day);
    facts = {
      ...((previous?.legacyContent || (previous && !previous.destinationCards && !previous.days?.length && previous.content)) ? {
        legacyContent: compactText(previous.legacyContent || previous.content, MAX_PLAN_LENGTH),
      } : {}),
      destinationCards: structuredClone(feedback.destinationCards.length ? feedback.destinationCards : previous?.destinationCards || []),
      recommendation: feedback.recommendation ?? previous?.recommendation ?? null,
      notes: structuredClone([
        ...(previous?.notes || []).filter((note: TripPlannerContextRecord) => !feedback.notes.some((next) => next.kind === note.kind)),
        ...feedback.notes,
      ]),
      tables: structuredClone([
        ...(previous?.tables || []).filter((table: TripPlannerContextRecord) => !feedback.tables.some((next) => next.kind === table.kind)),
        ...feedback.tables,
      ]),
      limitations: [...feedback.limitations],
    };
    responseMode = feedback.mode;
  }
  // Private compatibility text reflects merged facts; it is never rendered or parsed as a plan.
  const text = compactText(feedback ? JSON.stringify({ ...facts, days }) : output, MAX_PLAN_LENGTH);
  if (!text) {
    return null;
  }
  const artifact = {
    id: `plan_${state.contextRevision}`,
    revision: state.contextRevision,
    createdAt: new Date().toISOString(),
    destination: { ...context.summaryContext.destination },
    responseMode,
    days,
    content: text,
    ...facts,
  };
  state.lastPlanArtifact = artifact;
  state.lastPlanSnapshot = {
    ...createTripPlannerSummaryContext(context.summaryContext),
    responseMode,
  };
  return artifact;
}

function compactEvent(event: any) {
  if (!event || typeof event !== 'object') {
    return { description: compactText(event) };
  }
  const name = event.name || event.title || event.eventName || null;
  const date = event.date || event.startDate || event.start_date || null;
  const description = event.description || event.summary || null;
  return {
    ...(name ? { name: compactText(name, 100) } : {}),
    ...(date ? { date: compactText(date, 40) } : {}),
    ...(description ? { description: compactText(description) } : {}),
  };
}

function matchesQuery(value: unknown, query: string | null): boolean {
  if (!query) {
    return true;
  }
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

function matchesPlanDay(day: PlanDay, query: string | null): boolean {
  if (!query) {
    return true;
  }
  const requestedDay = String(query).match(/\bday\s*(\d+)\b/i)?.[1];
  if (requestedDay) {
    return day.day === Number(requestedDay);
  }
  return matchesQuery(day, query);
}

export function getTripPlannerContextDetails(
  context: TripPlannerContextRecord = {},
  {
    sections = [],
    query = null,
    limit = 5,
  }: { sections?: string[]; query?: string | null; limit?: number | null } = {},
) {
  const state = ensureTripPlannerState(context);
  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
  const factQuery = /\bday\s*\d+\b/i.test(query || '') ? null : query;
  const requested = new Set(sections);
  const details: TripPlannerContextRecord = {};

  if (requested.has('places')) {
    details.places = context.summaryContext.placesOfInterest
      .map((place: TripPlannerContextRecord) => ({
        placeName: compactText(place.placeName, 100),
        description: compactText(place.description),
      }))
      .filter((place: TripPlannerContextRecord) => matchesQuery(place, query))
      .slice(0, safeLimit);
  }

  if (requested.has('events')) {
    details.events = context.summaryContext.upcomingEvents
      .map(compactEvent)
      .filter((event: TripPlannerContextRecord) => matchesQuery(event, query))
      .slice(0, safeLimit);
  }

  if (requested.has('last_plan')) {
    details.lastPlan = state.lastPlanArtifact
      ? {
          id: state.lastPlanArtifact.id,
          revision: state.lastPlanArtifact.revision,
          responseMode: state.lastPlanArtifact.responseMode,
          days: (state.lastPlanArtifact.days || [])
            .map((day: PlanDay) => recoverDayBlocks(day))
            .filter((day: PlanDay) => matchesPlanDay(day, query))
            .slice(0, safeLimit),
          ...(state.lastPlanArtifact.destinationCards ? {
            destinationCards: state.lastPlanArtifact.destinationCards
              .filter((card: TripPlannerContextRecord) => matchesQuery(card, factQuery))
              .slice(0, safeLimit),
            recommendation: state.lastPlanArtifact.recommendation,
            notes: (state.lastPlanArtifact.notes || []).filter((note: TripPlannerContextRecord) => matchesQuery(note, factQuery)).slice(0, safeLimit),
            tables: (state.lastPlanArtifact.tables || []).filter((table: TripPlannerContextRecord) => matchesQuery(table, factQuery)).slice(0, safeLimit),
            limitations: (state.lastPlanArtifact.limitations || []).filter((limitation: string) => matchesQuery(limitation, factQuery)).slice(0, safeLimit),
            ...(state.lastPlanArtifact.legacyContent ? { legacyContent: compactText(state.lastPlanArtifact.legacyContent, 2_000) } : {}),
          } : {}),
          content: compactText(state.lastPlanArtifact.content, 2_000),
        }
      : null;
  }

  return {
    ok: true,
    status: 'SUCCESS',
    revision: state.contextRevision,
    destination: { ...context.summaryContext.destination },
    details,
  };
}

export async function withTripPlannerSessionLock<T>(
  context: TripPlannerContextRecord = {},
  operation: () => Promise<T> | T,
): Promise<T> {
  if (typeof operation !== 'function') {
    throw new TypeError('Trip Planner lock operation must be a function.');
  }
  const state = ensureTripPlannerState(context);
  const key = String(context.sessionId || state.sessionId || 'trip-planner-default');
  const previous = tripPlannerSessionLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tripPlannerSessionLocks.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tripPlannerSessionLocks.get(key) === tail) {
      tripPlannerSessionLocks.delete(key);
    }
  }
}
