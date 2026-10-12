import OpenAI from 'openai';
import { getDefaultOpenAIClient } from '@openai/agents-openai';
import { z } from 'zod';
import { POST_BOOKING_QUESTION } from './prompt.js';

export const postBookingGuardrailConfig = {
  model: 'gpt-6-luna',
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

export type PostBookingInput = {
  message: string;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  pageContext?: string;
};

const inputSchema = z.object({
  message: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }).strict()).optional(),
  pageContext: z.string().optional(),
}).strict();

const responseSchema = z.object({ answers: z.array(z.unknown()).length(1) });
const choiceSchema = z.object({
  type: z.literal('choice'),
  name: z.literal(POST_BOOKING_QUESTION.name),
  choice: postBookingIntentSchema,
  confidence: z.number().min(0).max(1),
  probabilities: z.array(z.object({
    value: postBookingIntentSchema,
    probability: z.number().min(0).max(1),
  })).length(postBookingIntentSchema.options.length),
});
const refusalSchema = z.object({ type: z.literal('refusal'), name: z.literal(POST_BOOKING_QUESTION.name) });

const reasons: Record<PostBookingIntent, string> = {
  CANCELLATION: 'Existing-booking cancellation or refund request.',
  FLIGHT_CHANGE: 'Existing-booking flight change request.',
  SEATS_BAGGAGE: 'Existing-booking seat or baggage matter.',
  PAYMENT_BILLING: 'Existing-booking payment or billing matter.',
  BOOKING_INFO: 'Existing-booking information or ticketing request.',
  NEW_BOOKING: 'Pre-booking travel or checkout assistance.',
  TRAVEL_SERVICES: 'Existing-booking travel service request.',
  ACCOUNT_LOYALTY: 'Account or loyalty matter.',
  SUPPORT: 'Existing-booking support request.',
  none: 'Search abandonment or no discernible travel intent.',
};

export function mapPostBookingDecision(response: unknown): PostBookingGuardrailOutput {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) throw new Error('Invalid post-booking decision result.');
  const answer = parsed.data.answers[0];
  if (refusalSchema.safeParse(answer).success) throw new Error('Post-booking decision was refused.');
  const result = choiceSchema.safeParse(answer);
  if (!result.success) throw new Error('Invalid post-booking decision result.');
  const { choice, confidence, probabilities } = result.data;
  const values = new Set(probabilities.map((entry) => entry.value));
  const total = probabilities.reduce((sum, entry) => sum + entry.probability, 0);
  // Allow floating-point summation error, not missing or duplicated categories.
  if (values.size !== postBookingIntentSchema.options.length || Math.abs(total - 1) > 1e-6) {
    throw new Error('Invalid post-booking decision probabilities.');
  }
  return postBookingGuardrailOutputSchema.parse({
    isPostBooking: choice !== 'NEW_BOOKING' && choice !== 'none',
    intent: choice,
    confidence,
    reason: reasons[choice],
  });
}

let defaultClient: OpenAI | undefined;

export async function classifyPostBooking(
  input: PostBookingInput,
  options: { client?: OpenAI; signal?: AbortSignal } = {},
): Promise<PostBookingGuardrailOutput> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid post-booking classification input.');
  const client = options.client ?? getDefaultOpenAIClient() ?? (defaultClient ??= new OpenAI());
  const decision = await client.decisions.create({
    model: postBookingGuardrailConfig.model,
    input: JSON.stringify(parsed.data),
    questions: [POST_BOOKING_QUESTION],
  }, { signal: options.signal });
  return mapPostBookingDecision(decision);
}
