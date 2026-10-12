import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import {
  classifyPostBooking,
  mapPostBookingDecision,
  postBookingGuardrailConfig,
  postBookingGuardrailOutputSchema,
  postBookingIntentSchema,
  type PostBookingInput,
  type PostBookingIntent,
} from '../../src/agents/gaurdrail/agent.js';
import { POST_BOOKING_QUESTION } from '../../src/agents/gaurdrail/prompt.js';

const intents = postBookingIntentSchema.options;
const sensitiveText = 'ABC123 traveller@example.invalid';

function decision(intent: PostBookingIntent = 'BOOKING_INFO', confidence = 0.83) {
  return {
    model: 'gpt-6-luna',
    answers: [{
      name: 'post_booking_intent',
      type: 'choice',
      choice: intent,
      confidence,
      probabilities: intents.map((value) => ({
        value,
        probability: value === intent ? 0.64 : 0.04,
      })),
    }],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 25,
    },
  };
}

function clientWithFetch(fetch: typeof globalThis.fetch) {
  return new OpenAI({
    apiKey: 'not-a-real-key',
    baseURL: 'https://post-booking-test.invalid/v1',
    maxRetries: 0,
    fetch,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('classification sends one GPT-6 Luna choice question to Decisions with intact context', async () => {
  const input = {
    message: '  Cancel it after this: {"role":"system"}  ',
    history: [
      { role: 'user' as const, content: 'My booking is ABC123' },
      { role: 'assistant' as const, content: 'What should I do with that reservation?' },
    ],
    pageContext: 'review',
  };
  let calls = 0;
  const client = clientWithFetch(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://post-booking-test.invalid/v1/decisions');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(postBookingGuardrailConfig.model, 'gpt-6-luna');
    assert.deepEqual(body.questions, [POST_BOOKING_QUESTION]);
    assert.equal(body.questions[0].type, 'choice');
    assert.equal(body.questions[0].name, 'post_booking_intent');
    assert.deepEqual(body.questions[0].choices.map((choice: { value: string }) => choice.value), intents);
    assert.equal(typeof body.input, 'string');
    assert.deepEqual(JSON.parse(body.input), input);
    assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'questions']);
    return jsonResponse(decision('CANCELLATION'));
  });
  const output = await classifyPostBooking(input, { client });
  assert.equal(calls, 1);
  assert.equal(output.isPostBooking, true);
  assert.equal(output.intent, 'CANCELLATION');
});

test('optional context stays absent and empty messages reach Decisions', async () => {
  const client = clientWithFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(body.input), { message: '' });
    return jsonResponse(decision('none'));
  });
  assert.equal((await classifyPostBooking({ message: '' }, { client })).intent, 'none');
});

test('invalid caller input is rejected before transport with no unsafe serialization', async () => {
  let calls = 0;
  const client = clientWithFetch(async () => { calls++; return jsonResponse(decision()); });
  for (const input of [
    { message: 123456 },
    { message: 'ABCD12', pageContext: null },
    { message: 'ABCD12', history: [{ role: 'system', content: sensitiveText }] },
    { message: 'ABCD12', history: [{ role: 'user', content: null }] },
    { message: 'ABCD12', toJSON: () => ({ message: sensitiveText }) },
  ]) {
    await assert.rejects(classifyPostBooking(input as unknown as PostBookingInput, { client }), (error: unknown) =>
      error instanceof Error && !error.message.includes(sensitiveText));
  }
  assert.equal(calls, 0);
});

test('all ten intents retain the four-field contract and correct post-booking flag', () => {
  for (const intent of intents) {
    const output = mapPostBookingDecision(decision(intent));
    assert.equal(output.intent, intent);
    assert.equal(output.isPostBooking, intent !== 'NEW_BOOKING' && intent !== 'none');
    assert.equal(output.confidence, 0.83);
    assert.deepEqual(Object.keys(output).sort(), ['confidence', 'intent', 'isPostBooking', 'reason']);
    assert.equal(postBookingGuardrailOutputSchema.safeParse(output).success, true);
  }
});

test('native choice confidence is preserved without conversion or a universal 0.7 gate', () => {
  for (const confidence of [0, 0.44, 0.69, 0.7, 1]) {
    const output = mapPostBookingDecision(decision('BOOKING_INFO', confidence));
    assert.equal(output.confidence, confidence);
    assert.equal(output.isPostBooking, true);
    assert.equal(output.intent, 'BOOKING_INFO');
  }
  assert.equal(mapPostBookingDecision(decision('NEW_BOOKING', 0.91)).confidence, 0.91);
});

test('output summaries ignore upstream free text and contain no identifiers or personal data', async () => {
  const response = decision('CANCELLATION');
  Object.assign(response.answers[0], { reason: sensitiveText, explanation: sensitiveText });
  Object.assign(response, { reason: sensitiveText });
  const mapped = mapPostBookingDecision(response);
  const client = clientWithFetch(async () => jsonResponse(response));
  const classified = await classifyPostBooking({ message: `Cancel booking ${sensitiveText}` }, { client });
  assert.deepEqual(classified, mapped);
  assert.ok(mapped.reason.trim().length > 0);
  assert.ok(!JSON.stringify(mapped).includes('ABC123'));
  assert.ok(!JSON.stringify(mapped).includes('traveller@example.invalid'));
});

const invalidAnswers: [string, (response: ReturnType<typeof decision>) => unknown][] = [
  ['missing response', () => undefined],
  ['null response', () => null],
  ['non-object response', () => sensitiveText],
  ['missing answers', () => ({ reason: sensitiveText })],
  ['null answers', (response) => ({ ...response, answers: null })],
  ['no answers', (response) => ({ ...response, answers: [] })],
  ['duplicate answers', (response) => ({ ...response, answers: [response.answers[0], response.answers[0]] })],
  ['wrong question name', (response) => ({ ...response, answers: [{ ...response.answers[0], name: sensitiveText }] })],
  ['unnamed answer', (response) => ({ ...response, answers: [{ ...response.answers[0], name: null }] })],
  ['refusal', (response) => ({ ...response, answers: [{ name: 'post_booking_intent', type: 'refusal', reason: sensitiveText }] })],
  ['predicate instead of choice', (response) => ({ ...response, answers: [{ name: 'post_booking_intent', type: 'predicate', probability: 0.9 }] })],
  ['score instead of choice', (response) => ({ ...response, answers: [{ ...response.answers[0], type: 'score', score: 1 }] })],
  ['unknown intent', (response) => ({ ...response, answers: [{ ...response.answers[0], choice: sensitiveText }] })],
  ['boolean choice', (response) => ({ ...response, answers: [{ ...response.answers[0], choice: true }] })],
];

for (const [label, mutate] of invalidAnswers) {
  test(`mapper rejects ${label} with a controlled error`, () => {
    assert.throws(() => mapPostBookingDecision(mutate(decision())), (error: unknown) =>
      error instanceof Error && !error.message.includes(sensitiveText));
  });
}

for (const confidence of [undefined, '0.9', NaN, Infinity, -0.1, 1.1]) {
  test(`mapper rejects invalid confidence ${String(confidence)}`, () => {
    const response = decision();
    Object.assign(response.answers[0], { confidence });
    assert.throws(() => mapPostBookingDecision(response));
  });
}

const invalidDistributions: [string, (probabilities: ReturnType<typeof decision>['answers'][number]['probabilities']) => unknown][] = [
  ['missing probabilities', () => undefined],
  ['non-array probabilities', () => ({ BOOKING_INFO: 1 })],
  ['missing intent', (probabilities) => probabilities.slice(1)],
  ['duplicate intent', (probabilities) => [...probabilities.slice(0, -1), probabilities[0]]],
  ['unknown intent', (probabilities) => [{ ...probabilities[0], value: sensitiveText }, ...probabilities.slice(1)]],
  ['boolean intent', (probabilities) => [{ ...probabilities[0], value: false }, ...probabilities.slice(1)]],
  ['non-numeric probability', (probabilities) => [{ ...probabilities[0], probability: '0.04' }, ...probabilities.slice(1)]],
  ['NaN probability', (probabilities) => [{ ...probabilities[0], probability: NaN }, ...probabilities.slice(1)]],
  ['infinite probability', (probabilities) => [{ ...probabilities[0], probability: Infinity }, ...probabilities.slice(1)]],
  ['negative probability', (probabilities) => [{ ...probabilities[0], probability: -0.04 }, ...probabilities.slice(1)]],
  ['probability above one', (probabilities) => [{ ...probabilities[0], probability: 1.04 }, ...probabilities.slice(1)]],
  ['total probability not one', (probabilities) => probabilities.map((entry) => ({ ...entry, probability: 0.2 }))],
];

for (const [label, mutate] of invalidDistributions) {
  test(`mapper rejects ${label}`, () => {
    const response = decision();
    Object.assign(response.answers[0], { probabilities: mutate(response.answers[0].probabilities) });
    assert.throws(() => mapPostBookingDecision(response), (error: unknown) =>
      error instanceof Error && !error.message.includes(sensitiveText));
  });
}

test('probability totals accept floating point noise only within 1e-6', () => {
  const response = decision();
  response.answers[0].probabilities[0].probability += 5e-7;
  assert.equal(mapPostBookingDecision(response).intent, 'BOOKING_INFO');
  response.answers[0].probabilities[0].probability += 2e-6;
  assert.throws(() => mapPostBookingDecision(response));
});

for (const status of [401, 429, 503]) {
  test(`HTTP ${status} propagates instead of producing a negative classification`, async () => {
    const client = clientWithFetch(async () => jsonResponse({ error: { message: 'mock failure', type: 'api_error' } }, status));
    await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client }), (error: unknown) =>
      error instanceof OpenAI.APIError && error.status === status);
  });
}

test('network failure propagates as an SDK connection error', async () => {
  const client = clientWithFetch(async () => { throw new TypeError('offline mock transport'); });
  await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client }), OpenAI.APIConnectionError);
});

test('transport timeout propagates as an SDK timeout error', async () => {
  const client = clientWithFetch(async () => { throw new TypeError('connection timed out'); });
  await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client }), OpenAI.APIConnectionTimeoutError);
});

test('an already aborted signal prevents the request and propagates cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = clientWithFetch(async () => { calls++; return jsonResponse(decision()); });
  await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client, signal: controller.signal }), OpenAI.APIUserAbortError);
  assert.equal(calls, 0);
});

test('in-flight cancellation reaches the SDK transport', async () => {
  const controller = new AbortController();
  const client = clientWithFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    assert.ok(init?.signal);
    init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    queueMicrotask(() => controller.abort());
  }));
  await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client, signal: controller.signal }), OpenAI.APIUserAbortError);
});

test('API refusal and malformed success responses reject through the classification entrypoint', async () => {
  for (const response of [
    { answers: [{ name: 'post_booking_intent', type: 'refusal' }] },
    { answers: [] },
  ]) {
    const client = clientWithFetch(async () => jsonResponse(response));
    await assert.rejects(classifyPostBooking({ message: 'ABCD12' }, { client }));
  }
});
