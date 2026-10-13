import assert from 'node:assert/strict';
import test from 'node:test';
import { setTracingDisabled, Usage, withTrace } from '@openai/agents';
import type { Model, ModelRequest } from '@openai/agents';
import { getDefaultOpenAIClient, setDefaultOpenAIClient } from '@openai/agents-openai';
import OpenAI from 'openai';
import { getModelResponse, getModelStream, modelDeadlineConfig, modelDeadlineProvider, ModelDeadlineExhaustedError } from '../../src/shared/runtime/model-deadline.js';
import type { ModelDeadlineConfig } from '../../src/shared/runtime/model-deadline.js';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.AGENT_LOG_LEVEL = 'error';
setTracingDisabled(true);

const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({
  input: 'Continue the pending model step.', modelSettings: { retry: { maxRetries: 0 } },
  tools: [], outputType: 'text', handoffs: [], tracing: false, ...patch,
});
const response = () => ({ usage: new Usage(), output: [], responseId: 'resp_success' });
function wrap(model: Partial<Model>, options: Partial<ModelDeadlineConfig> = {}): Model {
  const config = { ...modelDeadlineConfig, timeoutsMs: [50, 70, 90], initialBackoffMs: 0, ...options };
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getResponse: (request) => getModelResponse(model as Model, request, config, 'gpt-5.2'),
    getStreamedResponse: (request) => getModelStream(model as Model, request, config, 'gpt-5.2'),
  };
}

test('default progressive budgets are plain 25s/50s/75s configuration, at most three attempts', async () => {
  assert.deepEqual(modelDeadlineConfig, {
    timeoutsMs: [25_000, 50_000, 75_000], initialBackoffMs: 500, maxBackoffMs: 2_000,
  });
  let calls = 0;
  const model: Model = {
    getResponse: async () => { calls++; return response(); },
    async *getStreamedResponse() { throw new Error('Configuration validation must not stream.'); },
  };
  for (const timeoutsMs of [[], [1, 2, 3, 4], [0], [Number.NaN]]) {
    await assert.rejects(getModelResponse(model, request(), { ...modelDeadlineConfig, timeoutsMs }), RangeError);
  }
  await assert.rejects(getModelResponse(model, request(), { ...modelDeadlineConfig, maxBackoffMs: 2001 }), RangeError);
  assert.equal(calls, 0, 'Invalid configuration must fail before sending a model request');
});

test('an in-flight config mutation cannot add a fourth attempt', async () => {
  const timeoutsMs = [50, 70, 90];
  let calls = 0;
  const model: Model = {
    async getResponse() {
      if (++calls === 1) timeoutsMs.push(110);
      throw Object.assign(new Error('temporary'), { status: 503 });
    },
    async *getStreamedResponse() { throw new Error('This request must not stream.'); },
  };
  await assert.rejects(getModelResponse(model, request(), {
    ...modelDeadlineConfig, timeoutsMs, initialBackoffMs: 0,
  }), (error) => error instanceof ModelDeadlineExhaustedError
    && error.reason === 'attempts_exhausted' && error.attempts === 3);
  assert.equal(calls, 3);
});

test('nonretryable credentials, billing, validation, refusals and programming errors are immediate', async () => {
  for (const error of [
    Object.assign(new Error('unauthorized'), { status: 401 }),
    Object.assign(new Error('forbidden'), { status: 403 }),
    Object.assign(new Error('invalid request'), { status: 400 }),
    Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' }),
    Object.assign(new Error('quota'), { status: 429, error: { type: 'billing_not_active' } }),
    Object.assign(new Error('refused'), { name: 'ModelRefusalError' }),
    new TypeError('not a function'),
    Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  ]) {
    let calls = 0;
    const model = await wrap({ getResponse: async () => { calls++; throw error; } });
    await assert.rejects(model.getResponse(request()), (found) => found === error);
    assert.equal(calls, 1);
  }
});

test('transient errors retry, but long Retry-After cannot create an unbounded wait', async () => {
  let calls = 0;
  const model = await wrap({ getResponse: async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('temporary'), { status: 503 });
    return response();
  } });
  await model.getResponse(request());
  assert.equal(calls, 3);
  for (const headers of [new Headers({ 'Retry-After': '1000' }), { 'retry-after-ms': '1000000' }]) {
    calls = 0;
    const slow = await wrap({ getResponse: async () => { calls++; throw Object.assign(new Error('busy'), { status: 429, headers }); } });
    await assert.rejects(slow.getResponse(request()), (error) =>
      error instanceof ModelDeadlineExhaustedError && error.reason === 'retry_after_exceeds_budget');
    assert.equal(calls, 1);
  }
});

test('server-managed state, hidden tools and hosted writes are never blindly replayed', async () => {
  const patches: Partial<ModelRequest>[] = [
    { conversationId: 'conv_stateful' }, { previousResponseId: 'resp_previous' },
    { tools: [{ type: 'hosted_tool', name: 'remote_write', providerData: { type: 'mcp' } }] },
    { prompt: { promptId: 'pmpt_hidden_tools' } },
    ...['conversation', 'previous_response_id', 'tools', 'background', 'prompt'].flatMap((key) =>
      ['extra_body', 'extraBody'].map((alias) => ({ modelSettings: { providerData: { [alias]: { [key]: key === 'tools' ? [] : true } } } }))),
  ];
  for (const patch of patches) {
    let calls = 0;
    const model = await wrap({ getResponse: async () => { calls++; throw Object.assign(new Error('temporary'), { status: 503 }); } });
    await assert.rejects(model.getResponse(request(patch)), (error) =>
      error instanceof ModelDeadlineExhaustedError && error.reason === 'unsafe_replay');
    assert.equal(calls, 1);
  }
});

test('provider replay veto and retry hints are respected; classifier failures are bounded', async () => {
  let calls = 0;
  const unsafe = await wrap({
    getResponse: async () => { calls++; throw Object.assign(new Error('accepted'), { status: 503 }); },
    getRetryAdvice: () => ({ suggested: true, replaySafety: 'unsafe' }),
  });
  await assert.rejects(unsafe.getResponse(request()), (error) =>
    error instanceof ModelDeadlineExhaustedError && error.reason === 'unsafe_replay');
  assert.equal(calls, 1);
  const broken = await wrap({
    getResponse: async () => { throw Object.assign(new Error('temporary'), { status: 503 }); },
    getRetryAdvice: () => { throw new Error('classifier failed'); },
  });
  await assert.rejects(broken.getResponse(request()), (error) =>
    error instanceof ModelDeadlineExhaustedError && error.reason === 'retry_advice_failed');
  const aborted = Object.assign(new Error('cancelled'), { status: 503 });
  const cancelled = await wrap({ getResponse: async () => { throw aborted; },
    getRetryAdvice: () => ({ suggested: true, normalized: { isAbort: true } }) });
  await assert.rejects(cancelled.getResponse(request()), (error) => error === aborted);
  const refusal = Object.assign(new Error('refused'), { name: 'ModelRefusalError' });
  const refused = await wrap({ getResponse: async () => { throw refusal; }, getRetryAdvice: () => ({ suggested: true }) });
  await assert.rejects(refused.getResponse(request()), (error) => error === refusal);
});

test('parent cancellation also interrupts an uncooperative retry classifier', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const classifying = new Promise<void>((resolve) => { started = resolve; });
  const model = await wrap({
    getResponse: async () => { throw Object.assign(new Error('temporary'), { status: 503 }); },
    getRetryAdvice: () => { started(); return new Promise(() => {}); },
  });
  const pending = model.getResponse(request({ signal: controller.signal }));
  await classifying;
  const reason = new DOMException('Client disconnected', 'AbortError');
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test('each new model request starts at the first deadline instead of carrying a larger retry budget', async () => {
  const calls = new Map<string, number>();
  const abortedBudgets: number[] = [];
  const model = wrap({ getResponse: async (request) => {
    const key = String(request.input);
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (count === 1) {
      request.signal!.addEventListener('abort', () => {
        abortedBudgets.push(request.signal!.reason.timeoutMs);
      }, { once: true });
      return new Promise(() => {});
    }
    return response();
  } }, { timeoutsMs: [15, 30, 45] });
  await model.getResponse(request({ input: 'First model step' }));
  await model.getResponse(request({ input: 'Later model step after a successful tool' }));
  assert.deepEqual([...calls.values()], [2, 2]);
  assert.deepEqual(abortedBudgets, [15, 15]);
});

test('client cancellation interrupts retry backoff without sending another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  const model = wrap({ getResponse: async () => {
    calls++;
    throw Object.assign(new Error('busy'), { status: 503, headers: { 'retry-after-ms': '1000' } });
  } });
  const reason = new DOMException('Client disconnected during backoff', 'AbortError');
  const started = performance.now();
  const pending = model.getResponse(request({ signal: controller.signal }));
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(pending, (error: any) => error === reason
      || (error?.name === 'AbortError' && error?.cause === reason));
  } finally {
    clearTimeout(timer);
  }
  assert.ok(performance.now() - started < 500, 'Cancellation must not wait for the one-second backoff');
  assert.equal(calls, 1);
});

test('nested case-insensitive retry headers and network causes keep retry vetoes intact', async () => {
  for (const retry of [false, true]) {
    let calls = 0;
    const error = new Error('wrapped transport error', { cause: Object.assign(new Error('temporary'), {
      responseHeaders: { 'X-Should-Retry': String(retry), 'Retry-After-MS': '1' },
    }) });
    const model = wrap({ getResponse: async () => {
      if (++calls === 1) throw error;
      return response();
    } });
    if (retry) await model.getResponse(request());
    else await assert.rejects(model.getResponse(request()), (found) => found === error);
    assert.equal(calls, retry ? 2 : 1);
  }
  let calls = 0;
  const network = wrap({ getResponse: async () => {
    if (++calls === 1) throw new Error('wrapped', { cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
    return response();
  } });
  await network.getResponse(request());
  assert.equal(calls, 2);
});

test('permanent stream failures are not retried and prompt-model capability is preserved', async () => {
  let calls = 0;
  const model = await wrap({ supportsPromptModelSelection: true, async *getStreamedResponse() {
    calls++;
    throw new Error('stream failed');
  } });
  assert.equal(model.supportsPromptModelSelection, true);
  await assert.rejects(async () => { for await (const _event of model.getStreamedResponse(request())) { /* no output */ } });
  assert.equal(calls, 1);
});

test('HTTP retries are disabled from attempt one while the configured client and transport are preserved', async () => {
  const previous = getDefaultOpenAIClient();
  let fetches = 0;
  const client = new OpenAI({ apiKey: 'not-a-real-key', baseURL: 'https://deadline-test.invalid/v1',
    project: 'retained-project', defaultHeaders: { 'X-Preserved': 'yes' }, maxRetries: 2,
    fetch: async (input, init) => {
      fetches++;
      assert.match(String(input), /^https:\/\/deadline-test\.invalid\/v1\/responses$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('X-Preserved'), 'yes');
      assert.equal(headers.get('OpenAI-Project'), 'retained-project');
      return new Response(JSON.stringify({ error: { message: 'temporary', type: 'server_error' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } });
    },
  });
  setDefaultOpenAIClient(client);
  try {
    const model = await modelDeadlineProvider.getModel('gpt-5.2');
    assert.equal(model.getRetryAdvice, undefined, 'Runner cannot become a second retry owner');
    await assert.rejects(withTrace('offline transport', () => model.getResponse(request())),
      ModelDeadlineExhaustedError);
    assert.equal(fetches, 3, 'one fetch for each attempt; no hidden transport retries');
    assert.equal(client.maxRetries, 2, 'the application client must not be mutated');
  } finally {
    setDefaultOpenAIClient(previous!);
  }
});
