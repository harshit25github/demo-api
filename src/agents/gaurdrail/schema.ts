import { z } from 'zod';

// What callers send to the post-booking guardrail and get back. The output object is the one the
// earlier Responses API agent returned; agent.ts fills it from the Decisions API.

export const postBookingIntentSchema = z.enum([
  'CANCELLATION',
  'FLIGHT_CHANGE',
  'SEATS_BAGGAGE',
  'PAYMENT_BILLING',
  'BOOKING_INFO',
  'NEW_BOOKING',
  'TRAVEL_SERVICES',
  'ACCOUNT_LOYALTY',
  'SUPPORT',
  'none',
]);

export const postBookingGuardrailOutputSchema = z
  .object({
    isPostBooking: z.boolean(),
    intent: postBookingIntentSchema,
    confidence: z.number().min(0).max(1),
    reason: z
      .string()
      .trim()
      .min(1)
      .describe('Short sanitized classification summary; never include identifiers or personal data.'),
  })
  .strict();

export type PostBookingIntent = z.infer<typeof postBookingIntentSchema>;
export type PostBookingGuardrailOutput = z.infer<typeof postBookingGuardrailOutputSchema>;

export type PostBookingInput = {
  message: string;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  pageContext?: string;
};

export const postBookingInputSchema = z.object({
  message: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()).optional(),
  pageContext: z.string().optional(),
}).strict();
