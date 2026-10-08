import { createTripPlannerSummaryContext } from './summary-context.js';
import { resolveTripPlannerDestinationIata } from './planning-brief.js';

const MAX_DESCRIPTION_LENGTH = 180;
const MAX_PLAN_LENGTH = 12_000;
type TripPlannerContextRecord = Record<string, any>;

export interface PlanDay {
  day: number;
  title: string;
  content: string;
}

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
    state.dateValidationState = null;
    return;
  }
  if (datesChanged) {
    context.summaryContext.upcomingEvents = [];
    state.dateValidationState = null;
  }
}

export function setTripPlannerLastPlanArtifact(
  context: TripPlannerContextRecord = {},
  { output = '', responseMode = null }: { output?: string; responseMode?: string | null } = {},
) {
  const state = ensureTripPlannerState(context);
  const text = compactText(output, MAX_PLAN_LENGTH);
  if (!text) {
    return null;
  }
  const artifact = {
    id: `plan_${state.contextRevision}`,
    revision: state.contextRevision,
    createdAt: new Date().toISOString(),
    destination: { ...context.summaryContext.destination },
    responseMode,
    days: extractPlanDays(output),
    content: text,
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
            .filter((day: PlanDay) => matchesPlanDay(day, query))
            .slice(0, safeLimit),
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
