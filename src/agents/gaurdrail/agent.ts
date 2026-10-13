import OpenAI from 'openai';
import { getDefaultOpenAIClient } from '@openai/agents-openai';
import { z } from 'zod';
import { POST_BOOKING_QUESTION } from './prompt.js';
import {
  postBookingGuardrailOutputSchema,
  postBookingInputSchema,
  postBookingIntentSchema,
  type PostBookingGuardrailOutput,
  type PostBookingInput,
  type PostBookingIntent,
} from './schema.js';

// Post-booking classification on the Decisions API. classifyPostBooking runs these steps in order:
// 1. A bare number or code with no conversation or page is decided by the identifier rule, with no request.
// 2. Otherwise the input is sent as a quoted transcript with the choice question from prompt.ts.
// 3. The chosen intent becomes the output object from schema.ts; isPostBooking and reason are set here.
// 4. On a booking-flow page, a checkout intent earned only by history is re-checked on the latest message.

export const postBookingGuardrailConfig = {
  model: 'gpt-6-luna',
};

// Decisions returns no text, so each intent has a fixed summary that can never carry personal data.
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

const isPostBookingIntent = (intent: PostBookingIntent) => intent !== 'NEW_BOOKING' && intent !== 'none';

// A message that is only a number, or only a code mixing letters and digits.
function bareValue(message: string): { kind: 'number' | 'code'; length: number } | undefined {
  const value = message.trim();
  if (/^\d+$/.test(value)) return { kind: 'number', length: value.length };
  if (/^[a-z\d]+$/i.test(value) && /\d/.test(value) && /[a-z]/i.test(value)) return { kind: 'code', length: value.length };
  return undefined;
}

function ruleDecision(intent: PostBookingIntent): PostBookingGuardrailOutput {
  return { isPostBooking: isPostBookingIntent(intent), intent, confidence: 1, reason: reasons[intent] };
}

// The identifier rule is lexical when no conversation or page can give the value another meaning:
// six or more digits, or a six-character letter-and-digit code, is a booking identifier, and a
// shorter number never is.
function contextFreeValueDecision({ message, history = [], pageContext }: PostBookingInput) {
  if (history.length || pageContext?.trim()) return undefined;
  const value = bareValue(message);
  if (value?.kind === 'number') return ruleDecision(value.length >= 6 ? 'BOOKING_INFO' : 'none');
  if (value?.kind === 'code' && value.length === 6) return ruleDecision('BOOKING_INFO');
  return undefined;
}

// Decisions accepts only user-role input, so the evidence is one labelled transcript: page, then
// the conversation in order, then the latest message. Quoting keeps every turn on one line, so
// user text cannot pose as another turn or label. Digit counts are stated because the model
// reads digits as tokens, not characters.
export function formatDecisionInput({ message, history = [], pageContext }: PostBookingInput): string {
  const lines: string[] = [];
  if (pageContext?.trim()) lines.push(`Current page: ${JSON.stringify(pageContext.trim())}`);
  if (history.length) lines.push('Earlier conversation, oldest first:');
  for (const turn of history) lines.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${JSON.stringify(turn.content)}`);
  lines.push(`Latest user message: ${JSON.stringify(message)}`);
  const value = bareValue(message);
  if (value?.kind === 'number') lines.push(`The latest message is only a number with ${value.length} digit${value.length === 1 ? '' : 's'}.`);
  if (value?.kind === 'code') lines.push(`The latest message is only a ${value.length}-character code of letters and digits.`);
  return lines.join('\n');
}

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
    isPostBooking: isPostBookingIntent(choice),
    intent: choice,
    confidence,
    reason: reasons[choice],
  });
}

// The purchase on these pages is still in progress and unpaid.
const bookingFlowPages = new Set(['listing', 'review', 'passenger details', 'seat selection', 'payment']);
// Checkout topics a booking-flow page keeps in normal flow: seats and bags, fares and passenger
// details, promo codes and payment, and add-ons.
const checkoutIntents = new Set<PostBookingIntent>(['SEATS_BAGGAGE', 'FLIGHT_CHANGE', 'PAYMENT_BILLING', 'TRAVEL_SERVICES']);

function isBookingFlowPage(pageContext: string | undefined): boolean {
  const page = pageContext?.toLowerCase().replace(/[\s_-]+/g, ' ').trim().replace(/ page$/, '');
  return !!page && bookingFlowPages.has(page);
}

let defaultClient: OpenAI | undefined;

export async function classifyPostBooking(
  input: PostBookingInput,
  options: { client?: OpenAI; signal?: AbortSignal } = {},
): Promise<PostBookingGuardrailOutput> {
  const parsed = postBookingInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid post-booking classification input.');
  const ruled = contextFreeValueDecision(parsed.data);
  if (ruled) return ruled;
  const client = options.client ?? getDefaultOpenAIClient() ?? (defaultClient ??= new OpenAI());
  const decide = async (evidence: PostBookingInput) => mapPostBookingDecision(await client.decisions.create({
    model: postBookingGuardrailConfig.model,
    input: formatDecisionInput(evidence),
    questions: [POST_BOOKING_QUESTION],
  }, { signal: options.signal }));
  const decision = await decide(parsed.data);
  // On a booking-flow page only the latest message can show that a checkout topic concerns a
  // different, completed booking; a purchase that appears only in history cannot. Ask again
  // without history and keep the post-booking intent only if the latest message still earns it.
  const { message, history, pageContext } = parsed.data;
  if (decision.isPostBooking && checkoutIntents.has(decision.intent) && history?.length && isBookingFlowPage(pageContext)) {
    const latestOnly = await decide({ message, pageContext });
    if (!latestOnly.isPostBooking) return latestOnly;
  }
  return decision;
}
