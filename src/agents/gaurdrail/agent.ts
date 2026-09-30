import { Agent } from '@openai/agents';
import type { ModelSettings } from '@openai/agents';
import { z } from 'zod';
import { POST_BOOKING_PROMPT } from './prompt.js';

export const postBookingGuardrailConfig = {
  model: 'gpt-5.4-nano',
  modelSettings: {
    reasoning: { effort: 'high' },
    text: { verbosity: 'low' },
  } satisfies ModelSettings,
};

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

export const PostBookingGuardrailAgent = new Agent({
  name: 'Post-Booking Guardrail Agent',
  instructions: POST_BOOKING_PROMPT,
  model: postBookingGuardrailConfig.model,
  modelSettings: postBookingGuardrailConfig.modelSettings,
  outputType: postBookingGuardrailOutputSchema,
  tools: [],
});


