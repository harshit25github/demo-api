import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelTimeoutError, setTracingDisabled } from '@openai/agents';
import type { Model, ModelRequest, StreamEvent } from '@openai/agents';
import { getModelStream, modelDeadlineConfig, ModelDeadlineExhaustedError } from '../../src/shared/runtime/model-deadline.js';

setTracingDisabled(true);
process.env.AGENT_LOG_LEVEL = 'error';

const CONFIG = { ...modelDeadlineConfig, timeoutsMs: [25, 50, 75], initialBackoffMs: 0, maxBackoffMs: 0 };
const request = (patch: Partial<ModelRequest> = {}): ModelRequest => ({
  input: 'Continue this one model request.', modelSettings: { retry: { maxRetries: 0 } },
  tools: [], outputType: 'text', handoffs: [], tracing: false, ...patch,
});
const terminal: StreamEvent = { type: 'response_done', response: {
  id: 'resp_terminal', output: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
} };

async function collect(stream: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('stream response_done is completion even when trailing next and iterator cleanup never settle',
  { timeout: 2_000 }, async () => {
    let reads = 0;
    let closed = 0;
    let aborted = false;
    const model: Model = {
      async getResponse() { throw new Error('Must stream'); },
      getStreamedResponse(call) {
        call.signal!.addEventListener('abort', () => { aborted = true; });
        return { [Symbol.asyncIterator]() { return {
          next: async () => ++reads === 1 ? { done: false, value: terminal }
            : new Promise<IteratorResult<StreamEvent>>(() => {}),
          return: () => { closed += 1; return new Promise<IteratorResult<StreamEvent>>(() => {}); },
        }; } };
      },
    };
    assert.deepEqual(await collect(getModelStream(model, request(), CONFIG)), [terminal]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(reads, 1, 'Terminal completion waited for an unnecessary extra event read.');
    assert.equal(closed, 1);
    assert.equal(aborted, false, 'A completed model response was later marked timed out.');
  });

test('stream deadline is total per attempt, not reset by successive chunks',
  { timeout: 2_000 }, async () => {
    let calls = 0;
    let reads = 0;
    const model: Model = {
      async getResponse() { throw new Error('Must stream'); },
      getStreamedResponse() {
        calls += 1;
        return { [Symbol.asyncIterator]() { return {
          next: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            reads += 1;
            return { done: false, value: { type: 'output_text_delta', delta: `${reads}` } as StreamEvent };
          },
        }; } };
      },
    };
    const emitted: StreamEvent[] = [];
    const started = performance.now();
    await assert.rejects((async () => {
      for await (const event of getModelStream(model, request(), CONFIG)) emitted.push(event);
    })(), (error) => error instanceof ModelTimeoutError && error.timeoutMs === 25);
    assert.ok(emitted.length >= 1 && emitted.length <= 3);
    assert.ok(performance.now() - started < 500, 'Chunks kept extending the attempt deadline.');
    assert.equal(calls, 1, 'Partially emitted chunks were replayed.');
  });

test('deadline expiry while a consumer holds a yielded event never starts another raw read',
  { timeout: 2_000 }, async () => {
    let reads = 0;
    let calls = 0;
    let closed = 0;
    const model: Model = {
      async getResponse() { throw new Error('Must stream'); },
      getStreamedResponse() {
        calls += 1;
        return { [Symbol.asyncIterator]() { return {
          next: async () => { reads += 1; return { done: false,
            value: { type: 'output_text_delta', delta: 'Already emitted.' } as StreamEvent }; },
          return: async () => { closed += 1; return { done: true, value: undefined }; },
        }; } };
      },
    };
    const iterator = getModelStream(model, request(), CONFIG)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(iterator.next(), (error) => error instanceof ModelTimeoutError && error.timeoutMs === 25);
    assert.equal(reads, 1);
    assert.equal(calls, 1);
    assert.equal(closed, 1);
  });

test('pre-event streaming provider advice reporting an accepted response fails closed', async () => {
  let calls = 0;
  let adviceCalls = 0;
  const model: Model = {
    async getResponse() { throw new Error('Must stream'); },
    getStreamedResponse() {
      calls += 1;
      throw Object.assign(new Error('Connection reset after server accepted response'), { code: 'ECONNRESET' });
    },
    getRetryAdvice(args) {
      adviceCalls += 1;
      assert.equal(args.stream, true);
      assert.equal(args.attempt, 1);
      return { suggested: true, responseStarted: true };
    },
  };
  await assert.rejects(collect(getModelStream(model, request(), CONFIG)), (error) =>
    error instanceof ModelDeadlineExhaustedError && error.reason === 'unsafe_replay' && error.attempts === 1);
  assert.equal(calls, 1);
  assert.equal(adviceCalls, 1);
});

test('synchronous parent cancellation during stream opening rejects cleanly without retry or unhandled timer promise',
  { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled while opening', 'AbortError');
    let calls = 0;
    const model: Model = {
      async getResponse() { throw new Error('Must stream'); },
      getStreamedResponse() {
        calls += 1;
        controller.abort(reason);
        throw Object.assign(new Error('Open was interrupted'), { code: 'ECONNRESET' });
      },
    };
    await assert.rejects(collect(getModelStream(model, request({ signal: controller.signal }), CONFIG)),
      (error) => error === reason);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
  });

test('a stream cancelled by its iterator factory never starts a transport read', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Cancelled before first read', 'AbortError');
  let reads = 0;
  const model: Model = {
    async getResponse() { throw new Error('Must stream'); },
    getStreamedResponse() {
      controller.abort(reason);
      return { [Symbol.asyncIterator]() { return {
        next: async () => { reads += 1; return { done: false, value: terminal }; },
      }; } };
    },
  };
  await assert.rejects(collect(getModelStream(model, request({ signal: controller.signal }), CONFIG)),
    (error) => error === reason);
  assert.equal(reads, 0, 'Cancellation was checked only after starting another provider read.');
});

test('a stream creation failure retries only the same input and honors at most three attempts', async () => {
  let calls = 0;
  const inputs: string[] = [];
  const model: Model = {
    async getResponse() { throw new Error('Must stream'); },
    getStreamedResponse(call) {
      inputs.push(JSON.stringify({ ...call, signal: undefined }));
      if (++calls < 3) throw Object.assign(new Error('Temporary open failure'), { status: 503 });
      return (async function* () { yield terminal; })();
    },
  };
  assert.deepEqual(await collect(getModelStream(model, request(), CONFIG)), [terminal]);
  assert.equal(calls, 3);
  assert.ok(inputs.every((input) => input === inputs[0]));
});

test('stateful streamed requests cannot be retried before the first event', async (t) => {
  for (const state of [{ conversationId: 'conv_existing' }, { previousResponseId: 'resp_existing' }]) {
    await t.test(Object.keys(state)[0], async () => {
      let calls = 0;
      const model: Model = {
        async getResponse() { throw new Error('Must stream'); },
        getStreamedResponse() {
          calls += 1;
          throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
        },
      };
      await assert.rejects(collect(getModelStream(model, request(state), CONFIG)), (error) =>
        error instanceof ModelDeadlineExhaustedError && error.reason === 'unsafe_replay' && error.attempts === 1);
      assert.equal(calls, 1);
    });
  }
});
