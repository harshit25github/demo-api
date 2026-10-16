import { z } from 'zod';

const text = z.string().trim().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative().nullable();
const cost = z.enum(['$', '$$', '$$$']);
const endpoint = z.object({ city: text.nullable(), iata: z.string().nullable() }).strict();

export const TRIP_STATUSES = ['success', 'partial', 'needs_input', 'failure'] as const;
export const TRIP_INTENTS = ['inspire', 'plan', 'revise', 'answer', 'research', 'details'] as const;
export const SUMMARY_CLEAR_FIELDS = [
  'origin', 'destination', 'outbound_date', 'return_date', 'duration_days', 'budget', 'tripType', 'passengerData',
] as const;

/** Update trip context: a patch in the client summary's own keys. null means unchanged. */
export const tripChangesSchema = z.object({
  origin: endpoint.nullable(),
  destination: endpoint.nullable(),
  outbound_date: isoDate.nullable(),
  return_date: isoDate.nullable(),
  duration_days: z.number().int().positive().nullable(),
  budget: z.object({
    amount: z.number().nonnegative().nullable(),
    currency: z.string().nullable(),
    per_person: z.boolean().nullable(),
  }).strict().nullable(),
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
  clear: z.array(z.enum(SUMMARY_CLEAR_FIELDS)).max(SUMMARY_CLEAR_FIELDS.length),
}).strict();

export const tripOptionSchema = z.object({
  code: text,
  city: text,
  country: text,
  why: text,
  bestTime: text,
  cost,
}).strict();

export const tripDaySchema = z.object({
  day: z.number().int().positive(),
  title: text,
  morning: text,
  afternoon: text,
  evening: text,
  places: z.array(text).max(8),
}).strict();

export const tripPlanUpdateSchema = z.object({
  scope: z.enum(['full', 'days']),
  card: z.object({ country: text, knownFor: text, bestTime: text, cost }).strict().nullable(),
  days: z.array(tripDaySchema).max(30),
  removeDays: z.array(z.number().int().positive()).max(30),
}).strict();

export const tripFactSchema = z.object({
  text,
  source: text,
  day: z.number().int().positive().nullable(),
}).strict();

/**
 * What the Trip model returns: one strict structured output per run.
 * No string length caps: a decoder-enforced maxLength cuts strings mid-word
 * (see src/agents/flight/manager-output.ts); brevity is a prompt rule.
 */
export const tripResultSchema = z.object({
  status: z.enum(TRIP_STATUSES),
  intent: z.enum(TRIP_INTENTS),
  trip: tripChangesSchema.nullable(),
  dateHint: text.nullable(),
  options: z.array(tripOptionSchema).max(5).nullable(),
  plan: tripPlanUpdateSchema.nullable(),
  facts: z.array(tripFactSchema).max(5).nullable(),
  summary: text,
  findings: z.array(text).max(4),
  limitations: z.array(text).max(3),
  nextStep: text.nullable(),
  suggestions: z.array(text).max(3),
}).strict();

export const TRIP_PRESENTATIONS = ['trip_options', 'trip_plan', 'trip_days'] as const;

/** What the Manager receives: the same field names as Flight's feedback, plus what the app shows. */
export const tripFeedbackSchema = z.object({
  status: z.enum(TRIP_STATUSES),
  intent: z.enum(TRIP_INTENTS),
  summary: text,
  findings: z.array(text),
  limitations: z.array(text),
  nextStep: text.nullable(),
  presentation: z.enum(TRIP_PRESENTATIONS).nullable(),
  presentationDays: z.array(z.number().int().positive()),
}).strict();

export type TripChanges = z.infer<typeof tripChangesSchema>;
export type TripOption = z.infer<typeof tripOptionSchema>;
export type TripDay = z.infer<typeof tripDaySchema>;
export type TripPlanUpdate = z.infer<typeof tripPlanUpdateSchema>;
export type TripFact = z.infer<typeof tripFactSchema>;
export type TripResult = z.infer<typeof tripResultSchema>;
export type TripFeedback = z.infer<typeof tripFeedbackSchema>;
export type TripPresentation = typeof TRIP_PRESENTATIONS[number];
export type TripCost = z.infer<typeof cost>;
