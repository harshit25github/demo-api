import { z } from 'zod';

const text = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const threeLetters = z.string().regex(/^[A-Z]{3}$/);
const count = z.number().int().nonnegative().nullable();
const amount = z.number().nonnegative().nullable();
const cost = z.enum(['$', '$$', '$$$']);
const costLabel = z.enum(['Budget-friendly', 'Mid-range', 'Splurge']);
const status = z.enum(['success', 'partial', 'needs_input', 'failure']);
const intent = z.enum(['inspire', 'plan', 'revise', 'answer', 'research', 'details']);
const dayNumber = z.number().int().positive();

/** The eleven kinds of place Trip tags; the client draws one icon per kind (plan section 12.4). */
export const PLACE_KINDS = ['city', 'area', 'landmark', 'temple', 'museum', 'park', 'nature', 'market', 'food', 'nightlife', 'daytrip'] as const;

/**
 * The client's trip summary, in exactly the shape and key order the client requires.
 * A local copy of the Summary Extractor contract (src/agents/summary/schema.ts) plus the
 * combined chip list as its last key; tests/unit/trip-planner-v2-summary.test.ts keeps the two in step.
 */
export const clientSummarySchema = z.object({
  origin: z.object({ city: text.nullable(), iata: threeLetters.nullable() }).strict(),
  destination: z.object({ city: text.nullable(), iata: threeLetters.nullable() }).strict(),
  outbound_date: isoDate.nullable(),
  return_date: isoDate.nullable(),
  duration_days: z.number().int().positive().nullable(),
  budget: z.object({ amount, currency: threeLetters.nullable(), per_person: z.boolean().nullable(), total: amount }).strict(),
  tripType: z.array(text),
  placesOfInterest: z.array(z.object({ placeName: text, description: text }).strict()),
  passengerData: z.object({
    total: count,
    adults: count,
    seniors: count,
    children: count,
    lapInfants: count,
    seatInfants: count,
    childrenAges: z.array(z.number().int().nonnegative()),
  }).strict().superRefine((passengers, context) => {
    const breakdown = [passengers.adults, passengers.seniors, passengers.children, passengers.lapInfants, passengers.seatInfants];
    if (breakdown.every((value) => value !== null) && passengers.total !== breakdown.reduce((sum: number, value) => sum + (value ?? 0), 0)) {
      context.addIssue({ code: 'custom', path: ['total'], message: 'total must equal the complete passenger breakdown' });
    }
    if (passengers.children !== null && passengers.childrenAges.length > 0 && passengers.childrenAges.length !== passengers.children) {
      context.addIssue({ code: 'custom', path: ['childrenAges'], message: 'childrenAges must match the confirmed children count' });
    }
  }),
  suggestedQuestions: z.array(text),
}).strict();

/** Update trip context: a patch in the client summary's own keys. null means unchanged. */
const tripChangesSchema = z.object({
  origin: z.object({ city: text.nullable(), iata: z.string().nullable() }).strict().nullable(),
  destination: z.object({ city: text.nullable(), iata: z.string().nullable() }).strict().nullable(),
  outbound_date: isoDate.nullable(),
  return_date: isoDate.nullable(),
  duration_days: z.number().int().positive().nullable(),
  budget: z.object({ amount, currency: z.string().nullable(), per_person: z.boolean().nullable() }).strict().nullable(),
  tripType: z.object({ add: z.array(text).max(10), remove: z.array(text).max(10) }).strict().nullable(),
  passengerData: z.object({
    total: count,
    adults: count,
    seniors: count,
    children: count,
    lapInfants: count,
    seatInfants: count,
    childrenAges: z.array(z.number().int().nonnegative()).max(10),
  }).strict().nullable(),
  clear: z.array(z.enum(['origin', 'destination', 'outbound_date', 'return_date', 'duration_days', 'budget', 'tripType', 'passengerData'])).max(8),
}).strict();

/**
 * One day as Trip returns it. Morning, afternoon and evening are how a day is stored, not how it
 * is shown. In a "days" update, null keeps the saved value; a full plan fills every field.
 */
const tripDaySchema = z.object({
  day: dayNumber,
  title: text.nullable(),
  morning: text.nullable(),
  afternoon: text.nullable(),
  evening: text.nullable(),
  notes: z.array(text).max(3).nullable(),
  places: z.array(z.object({ name: text, kind: z.enum(PLACE_KINDS) }).strict()).max(8).nullable(),
}).strict();

/**
 * What the Trip model returns: one strict structured output per run.
 * No string length caps: a decoder-enforced maxLength cuts strings mid-word
 * (see src/agents/flight/manager-output.ts). Length targets are prompt rules, and
 * the hard ceilings are applied by app code (apply.ts). Array caps close cleanly.
 */
export const tripResultSchema = z.object({
  status,
  intent,
  trip: tripChangesSchema.nullable(),
  dateHint: text.nullable(),
  options: z.array(z.object({
    code: text, city: text, country: text, why: text, highlights: z.array(text).max(3), watchOut: text.nullable(), bestTime: text, cost,
  }).strict()).max(5).nullable(),
  plan: z.object({
    scope: z.enum(['full', 'days']),
    card: z.object({ country: text, knownFor: text, bestTime: text, cost }).strict().nullable(),
    days: z.array(tripDaySchema).max(30),
    removeDays: z.array(dayNumber).max(30),
  }).strict().nullable(),
  relevantDays: z.array(dayNumber).max(30),
  facts: z.array(z.object({ text, source: text, day: dayNumber.nullable() }).strict()).max(5).nullable(),
  findings: z.array(text).max(4),
  limitations: z.array(text).max(3),
  nextStep: text.nullable(),
  suggestions: z.array(text).max(5),
}).strict();

const dayPart = z.enum(['title', 'morning', 'afternoon', 'evening', 'notes']);

/**
 * What the Manager receives. Everything about what changed (plan.change, days[].changed, was,
 * removedDays, tripDetails) is measured by the app on the trip before and after this result,
 * so it lists only what was really saved. Days are copied from the saved trip.
 */
export const tripFeedbackSchema = z.object({
  status,
  intent,
  options: z.array(z.object({
    city: text, country: text, why: text, highlights: z.array(text), watchOut: text.nullable(), bestTime: text, cost: costLabel,
  }).strict()),
  plan: z.object({
    change: z.enum(['created', 'updated', 'cleared', 'unchanged']),
    destination: text,
    overview: z.object({ knownFor: text, bestTime: text, cost: costLabel }).strict().nullable(),
    totalDays: z.number().int().nonnegative(),
    days: z.array(z.object({
      day: dayNumber,
      title: text,
      morning: text,
      afternoon: text,
      evening: text,
      notes: z.array(text),
      // The day's named places, so the Manager writes each name exactly as saved.
      places: z.array(text),
      changed: z.array(z.union([z.literal('new'), dayPart])).optional(),
      was: z.object({
        title: text.optional(), morning: text.optional(), afternoon: text.optional(), evening: text.optional(), notes: z.array(text).optional(),
      }).strict().optional(),
    }).strict()),
    removedDays: z.array(z.object({ day: dayNumber, title: text }).strict()),
  }).strict().nullable(),
  tripDetails: z.array(z.object({
    detail: z.enum(['destination', 'origin', 'dates', 'timing', 'duration', 'travelers', 'budget', 'tripType']),
    was: text,
    now: text,
  }).strict()),
  findings: z.array(text),
  limitations: z.array(text),
  nextStep: text.nullable(),
}).strict();

/** The client summary's shape, written out so it holds in strict and non-strict builds; clientSummarySchema checks it. */
export type ClientSummary = {
  origin: { city: string | null; iata: string | null };
  destination: { city: string | null; iata: string | null };
  outbound_date: string | null;
  return_date: string | null;
  duration_days: number | null;
  budget: { amount: number | null; currency: string | null; per_person: boolean | null; total: number | null };
  tripType: string[];
  placesOfInterest: Array<{ placeName: string; description: string }>;
  passengerData: {
    total: number | null;
    adults: number | null;
    seniors: number | null;
    children: number | null;
    lapInfants: number | null;
    seatInfants: number | null;
    childrenAges: number[];
  };
  suggestedQuestions: string[];
};
export type TripResult = z.infer<typeof tripResultSchema>;
export type TripChanges = NonNullable<TripResult['trip']>;
export type TripOption = NonNullable<TripResult['options']>[number];
export type TripPlanUpdate = NonNullable<TripResult['plan']>;
export type TripDay = TripPlanUpdate['days'][number];
export type TripFact = NonNullable<TripResult['facts']>[number];
export type TripCost = TripOption['cost'];
export type TripFeedback = z.infer<typeof tripFeedbackSchema>;
export type TripReportPlan = NonNullable<TripFeedback['plan']>;
export type TripReportDay = TripReportPlan['days'][number];
export type TripDetailName = TripFeedback['tripDetails'][number]['detail'];

export interface TripClock {
  localDate: string;
  timeZone: string;
}

/** A saved option: what "the second one" needs. Highlights and trade-offs stay in the report of the turn that showed them. */
export interface SavedTripOption {
  code: string | null;
  city: string;
  country: string;
  why: string;
  bestTime: string;
  cost: TripCost;
}

export type PlaceKind = (typeof PLACE_KINDS)[number];

/** A named place in a saved day, with the kind that picks its icon. */
export interface SavedTripPlace {
  name: string;
  kind: PlaceKind;
}

/** A saved day: every field filled. Plans saved before notes existed have none; plans saved before kinds have plain names. */
export interface SavedTripDay {
  day: number;
  title: string;
  morning: string;
  afternoon: string;
  evening: string;
  notes?: string[];
  places: Array<SavedTripPlace | string>;
}

export interface TripPlan {
  destination: { city: string | null; iata: string | null };
  card: TripPlanUpdate['card'];
  days: SavedTripDay[];
}

export interface SavedTripFact extends TripFact {
  checkedOn: string | null;
}

/** Trip-owned state in context.tripPlanner. The trip facts themselves live in the client summary. */
export interface TripPlannerV2State {
  dateHint?: string | null;
  options?: SavedTripOption[];
  plan?: TripPlan | null;
  facts?: SavedTripFact[];
  lastQuestion?: string | null;
  suggestions?: string[];
}
