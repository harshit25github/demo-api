import { z } from 'zod';

const text = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const threeLetters = z.string().regex(/^[A-Z]{3}$/);
const count = z.number().int().nonnegative().nullable();
const amount = z.number().nonnegative().nullable();
const cost = z.enum(['$', '$$', '$$$']);
const status = z.enum(['success', 'partial', 'needs_input', 'failure']);
const intent = z.enum(['inspire', 'plan', 'revise', 'answer', 'research', 'details']);

/**
 * The client's trip summary, in exactly the shape and key order the client requires.
 * A local copy of the Summary Extractor contract (src/agents/summary/schema.ts);
 * tests/unit/trip-planner-v2-summary.test.ts keeps the two in step.
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

const tripDaySchema = z.object({
  day: z.number().int().positive(),
  title: text,
  morning: text,
  afternoon: text,
  evening: text,
  places: z.array(text).max(8),
}).strict();

/**
 * What the Trip model returns: one strict structured output per run.
 * No string length caps: a decoder-enforced maxLength cuts strings mid-word
 * (see src/agents/flight/manager-output.ts); brevity is a prompt rule.
 */
export const tripResultSchema = z.object({
  status,
  intent,
  trip: tripChangesSchema.nullable(),
  dateHint: text.nullable(),
  options: z.array(z.object({ code: text, city: text, country: text, why: text, bestTime: text, cost }).strict()).max(5).nullable(),
  plan: z.object({
    scope: z.enum(['full', 'days']),
    card: z.object({ country: text, knownFor: text, bestTime: text, cost }).strict().nullable(),
    days: z.array(tripDaySchema).max(30),
    removeDays: z.array(z.number().int().positive()).max(30),
  }).strict().nullable(),
  facts: z.array(z.object({ text, source: text, day: z.number().int().positive().nullable() }).strict()).max(5).nullable(),
  summary: text,
  findings: z.array(text).max(4),
  limitations: z.array(text).max(3),
  nextStep: text.nullable(),
  suggestions: z.array(text).max(3),
}).strict();

/** What the Manager receives: Flight's field names, plus what the app shows with the reply. */
export const tripFeedbackSchema = z.object({
  status,
  intent,
  summary: text,
  findings: z.array(text),
  limitations: z.array(text),
  nextStep: text.nullable(),
  presentation: z.enum(['trip_options', 'trip_plan', 'trip_days']).nullable(),
  presentationDays: z.array(z.number().int().positive()),
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
};
export type TripResult = z.infer<typeof tripResultSchema>;
export type TripChanges = NonNullable<TripResult['trip']>;
export type TripOption = NonNullable<TripResult['options']>[number];
export type TripPlanUpdate = NonNullable<TripResult['plan']>;
export type TripDay = TripPlanUpdate['days'][number];
export type TripFact = NonNullable<TripResult['facts']>[number];
export type TripCost = TripOption['cost'];
export type TripFeedback = z.infer<typeof tripFeedbackSchema>;
export type TripPresentation = NonNullable<TripFeedback['presentation']>;

export interface TripClock {
  localDate: string;
  timeZone: string;
}

export interface SavedTripOption extends Omit<TripOption, 'code'> {
  code: string | null;
}

export interface TripPlan {
  destination: ClientSummary['destination'];
  card: TripPlanUpdate['card'];
  days: TripDay[];
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
  photos?: Record<string, string>;
  /** What the app shows with this turn's reply. Shown once and never persisted. */
  turnView?: { presentation: TripPresentation; presentationDays: number[] };
}

export interface TripViewCard {
  code: string | null;
  title: string;
  imageUrl: string | null;
  knownFor: string;
  bestTime: string;
  cost: string;
}

/** What the client shows with the reply, built from saved trip state. */
export interface TripView {
  presentation: TripPresentation;
  cards: TripViewCard[];
  days: TripDay[];
}
