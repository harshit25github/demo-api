import { z } from 'zod';

const nullableText = z.string().trim().min(1).nullable();
const nullableCount = z.number().int().nonnegative().nullable();
const nullableAmount = z.number().nonnegative().nullable();
const nullableIsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const nullableIata = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullable();
const nullableCurrency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullable();

export const summaryAgentInputSchema = z
  .object({
    oldSummaryContext: z.string().min(1).describe('Previous summary context encoded as TOON.'),
    currentUserMessage: z.string(),
    currentAgentResponse: z.string(),
  })
  .strict();

export const summaryAgentPassengerDataSchema = z
  .object({
    total: nullableCount,
    adults: nullableCount,
    seniors: nullableCount,
    children: nullableCount,
    lapInfants: nullableCount,
    seatInfants: nullableCount,
    childrenAges: z.array(z.number().int().nonnegative()),
  })
  .strict()
  .superRefine((passengers, context) => {
    const breakdown = [
      passengers.adults,
      passengers.seniors,
      passengers.children,
      passengers.lapInfants,
      passengers.seatInfants,
    ];
    if (breakdown.every((count) => count !== null)) {
      const calculatedTotal = breakdown.reduce((sum, count) => sum + count, 0);
      if (passengers.total !== calculatedTotal) {
        context.addIssue({
          code: 'custom',
          path: ['total'],
          message: 'total must equal the complete passenger breakdown',
        });
      }
    }
    if (
      passengers.children !== null &&
      passengers.childrenAges.length > 0 &&
      passengers.childrenAges.length !== passengers.children
    ) {
      context.addIssue({
        code: 'custom',
        path: ['childrenAges'],
        message: 'childrenAges must match the confirmed children count',
      });
    }
  });

export const summaryAgentContextSchema = z
  .object({
    origin: z
      .object({
        city: nullableText.describe('Explicitly supplied city only; never derive it from IATA.'),
        iata: nullableIata,
      })
      .strict(),
    destination: z
      .object({
        city: nullableText.describe('Explicitly supplied city only; never derive it from IATA.'),
        iata: nullableIata,
      })
      .strict(),
    outbound_date: nullableIsoDate.describe(
      'Confirmed exact outbound date, including deterministic relative dates resolved from the supplied clock.',
    ),
    return_date: nullableIsoDate.describe(
      'Confirmed exact return date, including deterministic relative dates resolved from the supplied clock and outbound date.',
    ),
    duration_days: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('Trip duration; preserve it when only flight journey type or return date changes.'),
    budget: z
      .object({
        amount: nullableAmount.describe('Confirmed budget amount only, never a tentative proposal.'),
        currency: nullableCurrency,
        per_person: z
          .boolean()
          .nullable()
          .describe('Budget basis only; flight-card price disclaimers are not budget evidence.'),
        total: nullableAmount,
      })
      .strict(),
    tripType: z
      .array(z.string().trim().min(1))
      .describe(
        'Journey type, party style, pace, and interests. Preserve unrelated values; use oneway and roundtrip as canonical journey-type values.',
      ),
    placesOfInterest: z.array(
      z
        .object({
          placeName: z.string().trim().min(1),
          description: z.string().trim().min(1),
        })
        .strict(),
    ),
    passengerData: summaryAgentPassengerDataSchema,
  })
  .strict();

export const summaryAgentOutputSchema = z
  .object({ summary: summaryAgentContextSchema })
  .strict();

export const SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE = {
  summary: {
    origin: { city: 'New York', iata: 'JFK' },
    destination: { city: 'Delhi', iata: 'DEL' },
    outbound_date: '2026-09-10',
    return_date: '2026-09-15',
    duration_days: 5,
    budget: {
      amount: 1500,
      currency: 'USD',
      per_person: true,
      total: 3000,
    },
    tripType: ['roundtrip', 'food', 'relaxed'],
    placesOfInterest: [
      {
        placeName: 'India Gate',
        description: 'A confirmed stop in the delivered Delhi itinerary.',
      },
      {
        placeName: 'Humayun\'s Tomb',
        description: 'A confirmed heritage stop in the delivered Delhi itinerary.',
      },
    ],
    passengerData: {
      total: 2,
      adults: 2,
      seniors: 0,
      children: 0,
      lapInfants: 0,
      seatInfants: 0,
      childrenAges: [],
    },
  },
};
