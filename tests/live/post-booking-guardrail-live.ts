import 'dotenv/config';
import { Runner } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PostBookingGuardrailAgent,
  type PostBookingGuardrailOutput,
  type PostBookingIntent,
} from '../../src/agents/gaurdrail/agent.js';

const REPORT_JSON = path.join(process.cwd(), 'tests', 'results', 'post-booking-guardrail-latest.json');
const REPORT_TXT = path.join(process.cwd(), 'tests', 'results', 'post-booking-guardrail-latest.txt');
const CONCURRENCY = Number(process.env.GUARDRAIL_EVAL_CONCURRENCY || 8);
const REPEATS = Number(process.env.GUARDRAIL_EVAL_REPEATS || 3);

type Turn = { role: 'user' | 'assistant'; content: string };

interface GuardrailCase {
  id: string;
  category: string;
  history?: Turn[];
  message: string;
  expectedPostBooking: boolean;
  expectedIntents: PostBookingIntent[];
  note?: string;
}

const cases: GuardrailCase[] = [
  // Existing booking references
  { id: 'ref-my-booking', category: 'existing-booking-reference', message: 'I need help with my booking', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'SUPPORT'] },
  { id: 'ref-already-booked', category: 'existing-booking-reference', message: 'I already booked a flight to Miami and need help with it', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'SUPPORT'] },
  { id: 'ref-reservation-name', category: 'existing-booking-reference', message: 'My reservation has the wrong last name on it', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'SUPPORT', 'FLIGHT_CHANGE'] },
  { id: 'ref-booked-through', category: 'existing-booking-reference', message: 'I booked through CheapOair last week and have a question about my ticket', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'SUPPORT'] },
  { id: 'ref-my-ticket-details', category: 'existing-booking-reference', message: 'Can you pull up my ticket details?', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },

  // PNR / booking / confirmation numbers
  { id: 'id-pnr-labeled', category: 'booking-identifier', message: 'PNR 6E4XYZ', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'id-booking-number', category: 'booking-identifier', message: 'Booking number 12345678', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'id-confirmation-code', category: 'booking-identifier', message: 'My confirmation number is ABC123', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'id-ticket-number', category: 'booking-identifier', message: 'Ticket number 0162345678901 — need help', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'SUPPORT'] },
  { id: 'id-order-id', category: 'booking-identifier', message: 'Order ID CO-9923841', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'id-transaction-id', category: 'booking-identifier', message: 'Can you check transaction ID 88991122 for me?', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO', 'PAYMENT_BILLING'] },

  // Identifier-only messages
  { id: 'idonly-abcd12', category: 'identifier-only', message: 'ABCD12', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'idonly-pnr-style', category: 'identifier-only', message: '6E4XYZ', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'idonly-mixed', category: 'identifier-only', message: 'X7K9P2', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },

  // Bare numeric values (must NOT be treated as booking IDs)
  { id: 'bare-8-digits', category: 'bare-number', message: '12345678', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'], note: 'Six-plus digits standalone reads as a probable booking identifier.' },
  { id: 'bare-6-digits', category: 'bare-number', message: '884512', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'bare-9-digits', category: 'bare-number', message: '981234567', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'bare-small-number', category: 'bare-number', message: '2', expectedPostBooking: false, expectedIntents: ['none', 'NEW_BOOKING'] },
  { id: 'bare-price', category: 'bare-number', message: '450', expectedPostBooking: false, expectedIntents: ['none', 'NEW_BOOKING'] },
  { id: 'bare-year-like', category: 'bare-number', message: '2026', expectedPostBooking: false, expectedIntents: ['none', 'NEW_BOOKING'] },

  // Cancellation
  { id: 'cancel-my-booking', category: 'cancellation', message: 'Cancel my booking', expectedPostBooking: true, expectedIntents: ['CANCELLATION'] },
  { id: 'cancel-refund-ticket', category: 'cancellation', message: 'I want a refund for my ticket', expectedPostBooking: true, expectedIntents: ['CANCELLATION', 'PAYMENT_BILLING'] },
  { id: 'cancel-refund-status', category: 'cancellation', message: 'What is the status of my refund?', expectedPostBooking: true, expectedIntents: ['CANCELLATION', 'PAYMENT_BILLING'] },
  { id: 'cancel-booked-yesterday', category: 'cancellation', message: 'I booked yesterday, please cancel that flight', expectedPostBooking: true, expectedIntents: ['CANCELLATION'] },

  // Flight change / reschedule
  { id: 'change-reschedule-booked', category: 'flight-change', message: 'I need to reschedule my booked flight to next Monday', expectedPostBooking: true, expectedIntents: ['FLIGHT_CHANGE'] },
  { id: 'change-return-date', category: 'flight-change', message: 'Change the return date on my reservation', expectedPostBooking: true, expectedIntents: ['FLIGHT_CHANGE'] },
  { id: 'change-upgrade-booked', category: 'flight-change', message: 'Can I upgrade my booked ticket to business class?', expectedPostBooking: true, expectedIntents: ['FLIGHT_CHANGE'] },

  // Seats / baggage
  { id: 'seat-add-bag-booked', category: 'seats-baggage', message: 'I already booked; add a checked bag', expectedPostBooking: true, expectedIntents: ['SEATS_BAGGAGE'] },
  { id: 'seat-change-on-booking', category: 'seats-baggage', message: 'I want to change my seat on my booking', expectedPostBooking: true, expectedIntents: ['SEATS_BAGGAGE'] },
  { id: 'seat-lost-baggage', category: 'seats-baggage', message: 'My baggage never arrived at the destination airport', expectedPostBooking: true, expectedIntents: ['SEATS_BAGGAGE', 'SUPPORT'] },

  // Payment / duplicate charge
  { id: 'pay-charged-twice', category: 'payment-billing', message: 'My card was charged twice', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING'] },
  { id: 'pay-invoice', category: 'payment-billing', message: 'I need an invoice for my booking', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING', 'BOOKING_INFO'] },
  { id: 'pay-verification', category: 'payment-billing', message: 'My payment is still under verification', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING'] },
  { id: 'pay-charged-no-confirmation', category: 'payment-billing', message: 'I was charged but never got a confirmation', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING', 'BOOKING_INFO'] },

  // Booking confirmation / status
  { id: 'info-resend-confirmation', category: 'booking-info', message: 'Please resend my confirmation email', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'info-no-eticket', category: 'booking-info', message: "I haven't received my e-ticket yet", expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'info-check-in', category: 'booking-info', message: 'How do I check in for my flight and get my boarding pass?', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },
  { id: 'info-booking-status', category: 'booking-info', message: 'What is the status of my booking?', expectedPostBooking: true, expectedIntents: ['BOOKING_INFO'] },

  // Travel services
  { id: 'svc-add-insurance-booked', category: 'travel-services', message: 'I booked already; add travel insurance to it', expectedPostBooking: true, expectedIntents: ['TRAVEL_SERVICES'] },
  { id: 'svc-ktn', category: 'travel-services', message: 'Add my Known Traveler Number to my reservation', expectedPostBooking: true, expectedIntents: ['TRAVEL_SERVICES', 'BOOKING_INFO'] },
  { id: 'svc-support-package', category: 'travel-services', message: 'I want to add the Support Package to my existing booking', expectedPostBooking: true, expectedIntents: ['TRAVEL_SERVICES'] },

  // Account / loyalty
  { id: 'acct-no-access', category: 'account-loyalty', message: 'I cannot access my account', expectedPostBooking: true, expectedIntents: ['ACCOUNT_LOYALTY'] },
  { id: 'acct-credits', category: 'account-loyalty', message: 'How do I use my travel credits from last year?', expectedPostBooking: true, expectedIntents: ['ACCOUNT_LOYALTY'] },
  { id: 'acct-gift-card', category: 'account-loyalty', message: 'My gift card is not working when I log in', expectedPostBooking: true, expectedIntents: ['ACCOUNT_LOYALTY'] },
  { id: 'acct-apply-credit', category: 'account-loyalty', message: 'How do I apply the credit from my cancelled trip?', expectedPostBooking: true, expectedIntents: ['ACCOUNT_LOYALTY', 'CANCELLATION', 'PAYMENT_BILLING'] },
  { id: 'acct-payment-methods', category: 'account-loyalty', message: 'Can I pay with a gift card?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'], note: 'Generic payment-method question, not an existing account asset.' },

  // Pre-purchase commerce questions phrased with possessive booking language
  { id: 'pre-promo-my-booking', category: 'pre-purchase-commerce', message: 'Which promo codes are available for my booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'], note: 'Reported production false positive.' },
  { id: 'pre-coupon-my-booking', category: 'pre-purchase-commerce', message: 'Can I apply a coupon to my booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-discount-my-trip', category: 'pre-purchase-commerce', message: 'Is there any discount available for my trip?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-payment-methods-my-booking', category: 'pre-purchase-commerce', message: 'What payment methods can I use for my booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-installments-my-booking', category: 'pre-purchase-commerce', message: 'Can I pay in installments for my booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-total-cost-my-booking', category: 'pre-purchase-commerce', message: 'How much will my booking cost in total?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-price-drop-my-trip', category: 'pre-purchase-commerce', message: 'Will the price drop for my trip if I wait?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'pre-hold-my-booking', category: 'pre-purchase-commerce', message: 'Can I hold my booking for 24 hours before paying?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },

  // The same topics once a purchase is genuinely complete
  { id: 'post-promo-not-applied', category: 'post-purchase-commerce', message: 'I booked yesterday and my promo code was never applied', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING', 'SUPPORT'] },
  { id: 'post-discount-missing-receipt', category: 'post-purchase-commerce', message: 'The discount on my confirmed booking is missing from the receipt', expectedPostBooking: true, expectedIntents: ['PAYMENT_BILLING', 'SUPPORT'] },
  {
    id: 'post-promo-after-booked-history',
    category: 'post-purchase-commerce',
    history: [
      { role: 'user', content: 'I purchased a ticket to Lisbon last Tuesday, confirmation ABCD99' },
      { role: 'assistant', content: 'Thanks — I have that reservation open.' },
    ],
    message: 'can I still use a promo code on it?',
    expectedPostBooking: true,
    expectedIntents: ['PAYMENT_BILLING', 'SUPPORT', 'TRAVEL_SERVICES'],
  },

  // Missed flight / airline disruption
  { id: 'disrupt-missed-flight', category: 'disruption', message: 'I missed my flight this morning, what are my options?', expectedPostBooking: true, expectedIntents: ['SUPPORT', 'FLIGHT_CHANGE'] },
  { id: 'disrupt-airline-changed', category: 'disruption', message: 'The airline changed the time of my confirmed flight', expectedPostBooking: true, expectedIntents: ['FLIGHT_CHANGE', 'SUPPORT'] },
  { id: 'disrupt-airline-cancelled', category: 'disruption', message: 'My flight was cancelled by the airline, what happens now?', expectedPostBooking: true, expectedIntents: ['CANCELLATION', 'FLIGHT_CHANGE', 'SUPPORT'] },
  { id: 'disrupt-flight-delayed', category: 'disruption', message: 'My flight is delayed and I will miss my connection', expectedPostBooking: true, expectedIntents: ['SUPPORT', 'FLIGHT_CHANGE'] },

  // New flight searches
  { id: 'new-nyc-london', category: 'new-search', message: 'Find flights from NYC to London', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'new-dubai-march', category: 'new-search', message: 'Show me cheap flights to Dubai in March', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'new-paris-2-adults', category: 'new-search', message: 'I want to fly to Paris next weekend for 2 adults', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'new-plan-trip', category: 'new-search', message: 'Help me plan a 5 day trip to Tokyo', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },

  // Search refinement
  { id: 'refine-morning-only', category: 'search-refinement', message: 'Show me only morning flights', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'refine-change-date', category: 'search-refinement', message: 'Change the date to Friday instead', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'refine-remove-filter', category: 'search-refinement', message: 'Remove the Emirates filter', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'refine-cancel-search', category: 'search-refinement', message: 'Never mind, cancel this search', expectedPostBooking: false, expectedIntents: ['none'] },
  { id: 'refine-stop', category: 'search-refinement', message: 'stop', expectedPostBooking: false, expectedIntents: ['none'] },

  // General policy questions
  { id: 'policy-refund', category: 'policy-question', message: 'What is your refund policy?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'policy-baggage-included', category: 'policy-question', message: 'Is baggage included?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'policy-cancellation', category: 'policy-question', message: 'What is your cancellation policy?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'policy-cancel-after-booking', category: 'policy-question', message: 'Can I cancel after booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'policy-insurance-cover', category: 'policy-question', message: 'What does travel insurance cover?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'policy-change-seat-after', category: 'policy-question', message: 'Can I change my seat after booking?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },

  // Selected flight / selected contract
  { id: 'sel-add-bag-this-flight', category: 'selected-option', message: 'Can I add a checked bag to this flight?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'sel-contract-changes', category: 'selected-option', message: 'Does the selected contract allow changes?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'sel-option-2-refundable', category: 'selected-option', message: 'Is option 2 refundable?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },
  { id: 'sel-fare-baggage', category: 'selected-option', message: 'What is the baggage allowance on this fare?', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'] },

  // Ambiguous
  { id: 'amb-change-flight-friday', category: 'ambiguous', message: 'Change my flight to Friday', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING'], note: 'No booking evidence established anywhere.' },
  { id: 'amb-want-to-cancel', category: 'ambiguous', message: 'I want to cancel', expectedPostBooking: false, expectedIntents: ['NEW_BOOKING', 'none'] },
  { id: 'amb-help', category: 'ambiguous', message: 'help', expectedPostBooking: false, expectedIntents: ['none'] },
  { id: 'amb-need-agent', category: 'ambiguous', message: 'I need to talk to a human agent', expectedPostBooking: false, expectedIntents: ['none', 'NEW_BOOKING', 'SUPPORT'], note: 'Either side defensible; tracked for drift only.' },

  // Multi-turn: booking context only in history
  {
    id: 'mt-number-after-booking-ask',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I need help with my booking' },
      { role: 'assistant', content: 'Sure — could you share your booking number so I can pull it up?' },
    ],
    message: '12345678',
    expectedPostBooking: true,
    expectedIntents: ['BOOKING_INFO'],
  },
  {
    id: 'mt-code-after-confirmation-ask',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I have a problem with a flight I purchased' },
      { role: 'assistant', content: 'I can help. What is your confirmation number?' },
    ],
    message: 'ABCD1234',
    expectedPostBooking: true,
    expectedIntents: ['BOOKING_INFO', 'SUPPORT'],
  },
  {
    id: 'mt-cancel-it-after-booking-id',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'My booking is 12345678' },
      { role: 'assistant', content: 'Thanks, I found that reservation. How can I help with it?' },
    ],
    message: 'cancel it',
    expectedPostBooking: true,
    expectedIntents: ['CANCELLATION'],
  },
  {
    id: 'mt-add-bag-after-booked-history',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I booked a JFK to LHR flight last month through CheapOair' },
      { role: 'assistant', content: 'Got it — I see you are asking about a completed reservation.' },
    ],
    message: 'can I add a bag?',
    expectedPostBooking: true,
    expectedIntents: ['SEATS_BAGGAGE'],
  },
  {
    id: 'mt-cancel-it-after-search',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'Find me flights from Delhi to Dubai on the 12th' },
      { role: 'assistant', content: 'Here are 5 options for Delhi to Dubai on the 12th. Option 1 is $320 on Emirates.' },
    ],
    message: 'cancel it',
    expectedPostBooking: false,
    expectedIntents: ['none', 'NEW_BOOKING'],
    note: 'Refers to the active search, not a booking.',
  },
  {
    id: 'mt-option-2-after-results',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'Show me flights to Rome next month' },
      { role: 'assistant', content: 'Here are 4 options. Option 1 $540, Option 2 $610, Option 3 $700.' },
    ],
    message: 'option 2',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
  },
  {
    id: 'mt-number-in-search-context',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I want flights to Goa' },
      { role: 'assistant', content: 'How many passengers are travelling and on which dates?' },
    ],
    message: '2',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
  },
  {
    id: 'mt-long-number-as-budget',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I want to go to Bali with my family' },
      { role: 'assistant', content: 'Great — what is your total budget for the trip?' },
    ],
    message: '150000',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
    note: 'Six digits, but the pending question makes it a budget.',
  },
  {
    id: 'mt-long-number-as-date',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'Looking for flights to Seattle' },
      { role: 'assistant', content: 'What date do you want to depart? You can give it as MMDDYYYY.' },
    ],
    message: '09212026',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
    note: 'Eight digits, but the pending question makes it a date.',
  },
  {
    id: 'mt-bag-question-after-results',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'Flights from Boston to Austin on Sept 4' },
      { role: 'assistant', content: 'Here are the cheapest options. Option 1 is a JetBlue nonstop at $180.' },
    ],
    message: 'does that one include a checked bag?',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
  },
  {
    id: 'mt-refund-after-booked-complaint',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'I bought a ticket yesterday and the airline just cancelled the flight' },
      { role: 'assistant', content: 'I am sorry about that disruption.' },
    ],
    message: 'so what about my money?',
    expectedPostBooking: true,
    expectedIntents: ['PAYMENT_BILLING', 'CANCELLATION', 'SUPPORT'],
  },
  {
    id: 'mt-new-search-after-post-booking',
    category: 'multi-turn',
    history: [
      { role: 'user', content: 'Cancel my booking 88112233' },
      { role: 'assistant', content: 'That cancellation request has been submitted.' },
    ],
    message: 'now find me a new flight to Chicago next Friday',
    expectedPostBooking: false,
    expectedIntents: ['NEW_BOOKING'],
    note: 'History is post-booking but the latest request is a fresh search.',
  },
];

function toInputItems(testCase: GuardrailCase): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const turn of testCase.history || []) {
    if (turn.role === 'assistant') {
      items.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: turn.content }],
      } as AgentInputItem);
    } else {
      items.push({ role: 'user', content: [{ type: 'input_text', text: turn.content }] } as AgentInputItem);
    }
  }
  items.push({ role: 'user', content: [{ type: 'input_text', text: testCase.message }] } as AgentInputItem);
  return items;
}

const runner = new Runner({ workflowName: 'post-booking-guardrail-eval' });

interface Attempt {
  actual: PostBookingGuardrailOutput | null;
  error: string | null;
  postBookingPass: boolean;
  intentPass: boolean;
  latencyMs: number;
}

interface CaseResult extends GuardrailCase {
  attempts: Attempt[];
  actual: PostBookingGuardrailOutput | null;
  error: string | null;
  postBookingPass: boolean;
  intentPass: boolean;
  pass: boolean;
  flaky: boolean;
  postBookingPassCount: number;
  intentPassCount: number;
  failureKind: string | null;
}

async function runAttempt(testCase: GuardrailCase): Promise<Attempt> {
  const startedAt = Date.now();
  let actual: PostBookingGuardrailOutput | null = null;
  let error: string | null = null;
  try {
    const result = await runner.run(PostBookingGuardrailAgent, toInputItems(testCase), { maxTurns: 1 });
    actual = (result.finalOutput as PostBookingGuardrailOutput) ?? null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    actual,
    error,
    postBookingPass: !!actual && actual.isPostBooking === testCase.expectedPostBooking,
    intentPass: !!actual && testCase.expectedIntents.includes(actual.intent),
    latencyMs: Date.now() - startedAt,
  };
}

async function runCase(testCase: GuardrailCase): Promise<CaseResult> {
  const attempts: Attempt[] = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    attempts.push(await runAttempt(testCase));
  }
  const postBookingPassCount = attempts.filter((attempt) => attempt.postBookingPass).length;
  const intentPassCount = attempts.filter((attempt) => attempt.intentPass).length;
  const postBookingPass = postBookingPassCount === attempts.length;
  const intentPass = intentPassCount === attempts.length;
  const flaky = postBookingPassCount > 0 && postBookingPassCount < attempts.length;
  const firstFailing = attempts.find((attempt) => !attempt.postBookingPass || !attempt.intentPass) || attempts[0];

  let failureKind: string | null = null;
  if (attempts.some((attempt) => attempt.error)) failureKind = 'run-error';
  else if (flaky) failureKind = `unstable isPostBooking (${postBookingPassCount}/${attempts.length} correct)`;
  else if (!postBookingPass) {
    failureKind = testCase.expectedPostBooking ? 'missed-post-booking (false negative)' : 'over-trigger (false positive)';
  } else if (!intentPass) failureKind = `intent-mismatch (${intentPassCount}/${attempts.length} correct)`;

  return {
    ...testCase,
    attempts,
    actual: firstFailing.actual,
    error: firstFailing.error,
    postBookingPass,
    intentPass,
    pass: postBookingPass && intentPass,
    flaky,
    postBookingPassCount,
    intentPassCount,
    failureKind,
  };
}

async function runPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function formatAttempt(attempt: Attempt): string {
  if (!attempt.actual) return `ERROR: ${attempt.error}`;
  return `${attempt.actual.isPostBooking} / ${attempt.actual.intent} @ ${attempt.actual.confidence}`;
}

function formatRow(result: CaseResult): string {
  const status = result.pass ? 'PASS' : result.flaky ? 'FLAKY' : 'FAIL';
  const historyNote = result.history?.length ? ` [history: ${result.history.length} turns]` : '';
  const reasons = result.attempts
    .map((attempt) => attempt.actual?.reason)
    .filter((reason, index, list): reason is string => !!reason && list.indexOf(reason) === index);
  return [
    `${status}  ${result.id}  (${result.category})`,
    `  message : ${JSON.stringify(result.message)}${historyNote}`,
    `  expected: ${result.expectedPostBooking} / ${result.expectedIntents.join('|')}`,
    `  actual  : ${result.attempts.map(formatAttempt).join('  |  ')}`,
    reasons.length ? `  reason  : ${reasons[0]}` : '',
    result.failureKind ? `  failure : ${result.failureKind}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for this live eval.');
  const startedAt = Date.now();
  const results = await runPool(cases, CONCURRENCY, runCase);

  const failures = results.filter((result) => !result.pass);
  const postBookingFailures = results.filter((result) => !result.postBookingPass);
  const falseNegatives = postBookingFailures.filter((result) => result.expectedPostBooking);
  const falsePositives = postBookingFailures.filter((result) => !result.expectedPostBooking);
  const intentOnlyFailures = results.filter((result) => result.postBookingPass && !result.intentPass);

  const byCategory = new Map<string, { total: number; passed: number }>();
  for (const result of results) {
    const bucket = byCategory.get(result.category) || { total: 0, passed: 0 };
    bucket.total += 1;
    if (result.pass) bucket.passed += 1;
    byCategory.set(result.category, bucket);
  }

  const lines: string[] = [];
  const totalAttempts = results.reduce((sum, result) => sum + result.attempts.length, 0);
  const attemptPostBookingPasses = results.reduce((sum, result) => sum + result.postBookingPassCount, 0);

  lines.push('POST-BOOKING GUARDRAIL LIVE EVAL');
  lines.push(`model: ${PostBookingGuardrailAgent.model}   repeats per case: ${REPEATS}`);
  lines.push(`cases: ${results.length}   passed: ${results.length - failures.length}   failed: ${failures.length}`);
  lines.push(`flaky cases (inconsistent across repeats): ${results.filter((result) => result.flaky).length}`);
  lines.push(`isPostBooking per-case (all repeats correct): ${results.length - postBookingFailures.length}/${results.length}`);
  lines.push(`isPostBooking per-call: ${attemptPostBookingPasses}/${totalAttempts}`);
  lines.push(`false negatives (missed post-booking): ${falseNegatives.length}`);
  lines.push(`false positives (over-trigger): ${falsePositives.length}`);
  lines.push(`intent-only mismatches: ${intentOnlyFailures.length}`);
  lines.push(`duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('BY CATEGORY');
  for (const [category, bucket] of [...byCategory.entries()].sort()) {
    lines.push(`  ${bucket.passed === bucket.total ? 'ok  ' : 'FAIL'} ${category}: ${bucket.passed}/${bucket.total}`);
  }
  lines.push('');
  lines.push('FAILURES');
  lines.push(failures.length ? failures.map(formatRow).join('\n\n') : '  none');
  lines.push('');
  lines.push('ALL CASES');
  lines.push(results.map(formatRow).join('\n\n'));

  const report = lines.join('\n');
  console.log(report);

  await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
  await fs.writeFile(
    REPORT_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: PostBookingGuardrailAgent.model,
        totals: {
          cases: results.length,
          passed: results.length - failures.length,
          failed: failures.length,
          falseNegatives: falseNegatives.length,
          falsePositives: falsePositives.length,
          intentOnlyMismatches: intentOnlyFailures.length,
        },
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(REPORT_TXT, report, 'utf8');

  process.exitCode = failures.length ? 1 : 0;
}

await main();
