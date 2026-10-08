import assert from 'node:assert/strict';
import test from 'node:test';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
const { Agent, Runner } = await import('@openai/agents');
const { OpenAIConversationsSession, OpenAIProvider } = await import('@openai/agents-openai');
const { ObservedModelProvider, observeModelInput, UsageCollector, withUsageCollector } = await import('../../src/shared/observability/model-usage.js');
const { publicChat } = await import('../../src/api/chat/server.js');
const { observeOpenAIFetch } = await import('../../src/shared/observability/model-usage.js');

function mockClient(outputs: any[][]) {
  const rows: any[] = [], writes: any[][] = [], requests: any[] = [];
  let number = 0;
  const client: any = {
    conversations: {
      create: async () => ({ id: 'conv_fixed' }),
      delete: async () => { throw new Error('must not delete conversation'); },
      items: {
        list: async function* () { yield* structuredClone(rows); },
        create: async (id: string, body: any) => {
          assert.equal(id, 'conv_fixed');
          writes.push(structuredClone(body.items));
          rows.push(...structuredClone(body.items).map((i: any) => ({ ...i, id: i.id ?? `item_${rows.length}_${++number}` })));
          return { data: [] };
        },
      },
    },
    responses: { create: async (body: any) => {
      requests.push(structuredClone(body));
      const output = outputs.shift();
      assert.ok(output, 'unexpected model request');
      const response = { id: `resp_${++number}`, object: 'response', status: 'completed', model: body.model, output,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } } };
      return body.stream ? (async function* () { yield { type: 'response.completed', response, sequence_number: 0 }; })() : response;
    } },
  };
  return { client, rows, writes, requests };
}
const message = (id: string) => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready', annotations: [] }] });

test('public chat projection hides internal usage while preserving old records and all existing fields', () => {
  const chat: any = { chatId: 'chat', arbitrary: { retained: true }, turns: [{ id: 'old' }, { id: 'new', status: 'completed', usage: { inputTokens: 100 } }] };
  assert.deepEqual(publicChat(chat), { ...chat, turns: [{ id: 'old' }, { id: 'new', status: 'completed' }] });
  assert.equal(chat.turns[1].usage.inputTokens, 100);
});

test('OpenAI client internal retries are observed without changing retry behavior or reporting zero cost for failures', async () => {
  const { default: OpenAI } = await import('openai');
  let attempts = 0;
  const client = new OpenAI({ apiKey: 'synthetic', maxRetries: 1, fetch: observeOpenAIFetch(async () => {
    attempts++;
    if (attempts === 1) return new Response(JSON.stringify({ error: { message: 'busy', type: 'server_error' } }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '1', 'x-request-id': 'req_failed' } });
    return new Response(JSON.stringify({ id: 'resp_retried', output: [message('retried')], model: 'gpt-5.5',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } }),
    { headers: { 'content-type': 'application/json', 'x-request-id': 'req_success' } });
  }) });
  const usage = new UsageCollector({ requestId: 'retry', traceId: 'trace', sessionId: 'test' });
  const runner = new Runner({ tracingDisabled: true, modelProvider: new ObservedModelProvider(new OpenAIProvider({ openAIClient: client })),
    modelSettings: { preserveRawUsage: true }, callModelInputFilter: observeModelInput });
  await withUsageCollector(usage, () => runner.run(new Agent({ name: 'Flight', model: 'gpt-5.5' }), 'hello'));
  assert.equal(attempts, 2);
  assert.equal(usage.calls.length, 1);
  assert.deepEqual(usage.calls[0].transportAttempts.map((a) => a.status), [503, 200]);
  assert.equal(usage.calls[0].inputTokens, 100);
  assert.equal(usage.snapshot().complete, false);
  assert.equal(usage.snapshot().totalTokens, null);
  assert.equal(usage.snapshot().cost.estimatedTokenCostUsd, null);
});

test('context-limit failures preserve existing history and do not trigger pruning or an application replay', async () => {
  const mock = mockClient([]);
  const session = new OpenAIConversationsSession({ client: mock.client, conversationId: 'conv_fixed' });
  await session.addItems([{ role: 'user', content: 'protected original date' }]);
  const original = structuredClone(mock.rows);
  let calls = 0;
  mock.client.responses.create = async () => {
    calls++;
    throw Object.assign(new Error('synthetic context limit'), { status: 400, code: 'context_length_exceeded' });
  };
  const runner = new Runner({ tracingDisabled: true, modelProvider: new ObservedModelProvider(new OpenAIProvider({ openAIClient: mock.client })),
    callModelInputFilter: observeModelInput });
  const usage = new UsageCollector({ requestId: 'limit', traceId: 'trace', sessionId: 'conv_fixed' });
  await withUsageCollector(usage, () => assert.rejects(runner.run(new Agent({ name: 'Flight', model: 'gpt-5.5' }), 'oversized '.repeat(10000), { session })));
  assert.equal(calls, 1);
  assert.deepEqual(mock.rows.slice(0, original.length), original);
  assert.equal(await session.getSessionId(), 'conv_fixed');
  assert.equal(usage.snapshot().complete, false);
});

test('actual Summary runner joins the parent collector and retains its SummaryContext return contract', async () => {
  const { setDefaultOpenAIClient } = await import('@openai/agents-openai');
  const { createEmptySummaryContext } = await import('../../src/api/chat/context-hydration.js');
  const { extractSummaryContext } = await import('../../src/agents/summary/runner.js');
  const summary = createEmptySummaryContext();
  const output = message('summary');
  output.content[0].text = JSON.stringify({ summary });
  const mock = mockClient([[output]]);
  setDefaultOpenAIClient(mock.client);
  const usage = new UsageCollector({ requestId: 'parent', traceId: 'trace_00000000000000000000000000000001', sessionId: 'chat' });
  usage.complete(usage.start('Gateway', 'gpt-5.5'), { responseId: 'gateway', usage: { requests: 1, inputTokens: 10, outputTokens: 2, totalTokens: 12 } }, performance.now());
  let callback: any;
  const returned = await withUsageCollector(usage, () => extractSummaryContext({ previousSummary: summary,
    userMessage: 'hello', agentResponse: 'hello', onUsage: (value) => { callback = value; } }));
  assert.deepEqual(returned, summary);
  assert.equal(callback.requestId, 'parent');
  assert.equal(usage.snapshot().totalTokens, 132);
  assert.deepEqual(usage.calls.map((c) => c.agent), ['Gateway', 'Summary Extractor Agent']);
  assert.equal(usage.calls[1].model, 'gpt-5.4-mini');
});
