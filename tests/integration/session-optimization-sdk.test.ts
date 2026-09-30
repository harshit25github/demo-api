import assert from 'node:assert/strict';
import test from 'node:test';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
const { Agent, Runner, handoff } = await import('@openai/agents');
const { OpenAIConversationsSession, OpenAIProvider } = await import('@openai/agents-openai');
const { ObservedModelProvider, UsageCollector, withUsageCollector } = await import('../../src/shared/observability/model-usage.js');
const { createHistoryInputFilter } = await import('../../src/agents/manager-orchestrator/history-policy.js');
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
const marker = (id: string) => ({ id, type: 'compaction', encrypted_content: `opaque_${id}`, created_by: 'server' });
const legacy = { source: 'dummy', message: 'Ready', searchKey: 'search_test', UID: 'user', searchParams: {}, summary: { optionCount: 2 }, flights: [{ option: 1 }, { option: 2 }, { option: 3 }], airlineFilterOptions: [], layoverAirportFilterOptions: [], DepartAirports: [], DepLandAirports: [] };

test('real SDK + Conversations projects replay without duplicate items or rewriting stored legacy output', async () => {
  const mock = mockClient([[message('m1')], [message('m2')]]);
  const session = new OpenAIConversationsSession({ client: mock.client, conversationId: 'conv_fixed' });
  await session.addItems([
    { role: 'user', content: 'search' },
    { type: 'function_call', callId: 'call1', name: 'flight_search', arguments: '{}' },
    { type: 'function_call_result', callId: 'call1', name: 'flight_search', status: 'completed', output: JSON.stringify(legacy) },
  ]);
  const agent = new Agent({ name: 'Flight', model: 'gpt-5.5' });
  const runner = new Runner({ modelProvider: new OpenAIProvider({ openAIClient: mock.client }), tracingDisabled: true, callModelInputFilter: createHistoryInputFilter(undefined, 'enforce') });
  await runner.run(agent, 'option 3', { session });
  await runner.run(agent, 'show all', { session });
  const result = mock.requests[0].input.find((i: any) => i.type === 'function_call_output');
  assert.equal(JSON.parse(result.output).projectionVersion, 1);
  assert.equal(JSON.parse(result.output).summary.optionCount, 3);
  const storedResults = mock.rows.filter((i) => i.type === 'function_call_output');
  assert.equal(storedResults.length, 1);
  assert.deepEqual(JSON.parse(storedResults[0].output), legacy);
  assert.equal(mock.rows.filter((i) => i.role === 'user').length, 3);
  assert.equal(await session.getSessionId(), 'conv_fixed');
});

test('streamed compaction survives two boundaries, both handoff directions, restart and rollback; model settings and usage reconcile', async () => {
  const mock = mockClient([
    [marker('cmp1'), { type: 'function_call', id: 'fc1', call_id: 'handoff1', name: 'to_trip', arguments: '{}' }], [message('trip1')],
    [marker('cmp2'), { type: 'function_call', id: 'fc2', call_id: 'handoff2', name: 'to_flight', arguments: '{}' }], [message('flight1')], [message('final')],
  ]);
  const trip = new Agent({ name: 'Trip Planner', model: 'gpt-5.2', modelSettings: { temperature: 0.4 } });
  const flight = new Agent({ name: 'Flight', model: 'gpt-5.5', modelSettings: { temperature: 0.3 }, handoffs: [handoff(trip, { toolNameOverride: 'to_trip' })] });
  trip.handoffs = [handoff(flight, { toolNameOverride: 'to_flight' })];
  const makeRunner = (enabled: boolean) => new Runner({
    model: 'runner_fallback', modelProvider: new ObservedModelProvider(new OpenAIProvider({ openAIClient: mock.client })),
    modelSettings: { temperature: 0.1, preserveRawUsage: true, ...(enabled ? { contextManagement: [{ type: 'compaction', compactThreshold: 50000 }] } : {}) },
    tracingDisabled: true, callModelInputFilter: createHistoryInputFilter(undefined, enabled ? 'enforce' : 'off'),
  });
  const session = new OpenAIConversationsSession({ client: mock.client, conversationId: 'conv_fixed' });
  await session.addItems([{ role: 'user', content: 'original date evidence' }]);
  const usage = new UsageCollector({ requestId: 'turn', traceId: 'trace', sessionId: 'conv_fixed' });
  await withUsageCollector(usage, async () => {
    for (const [agent, input] of [[flight, 'plan a trip'], [trip, 'return to flight']] as const) {
      const run = await makeRunner(true).run(agent, input, { session, stream: true });
      for await (const _event of run) { /* fully drain and persist */ }
      await run.completed;
    }
    const restarted = new OpenAIConversationsSession({ client: mock.client, conversationId: 'conv_fixed' });
    await makeRunner(false).run(flight, 'option 3', { session: restarted });
  });
  assert.deepEqual(mock.requests.map((r) => r.model), ['gpt-5.5', 'gpt-5.2', 'gpt-5.2', 'gpt-5.5', 'gpt-5.5']);
  assert.deepEqual(mock.requests.slice(0, 4).map((r) => r.context_management), Array(4).fill([{ type: 'compaction', compact_threshold: 50000 }]));
  assert.equal(mock.requests[0].temperature, 0.3);
  assert.equal(mock.requests[1].temperature, 0.4);
  const replay = mock.requests.at(-1);
  assert.equal(replay.context_management, undefined);
  const persistedMarker = mock.rows.find((i) => i.encrypted_content === 'opaque_cmp2');
  assert.deepEqual(replay.input[0], persistedMarker);
  assert.equal(replay.input.some((i: any) => i.encrypted_content === 'opaque_cmp1'), false);
  assert.equal(mock.rows.filter((i) => i.type === 'compaction').length, 2);
  assert.equal(await session.getSessionId(), 'conv_fixed');
  assert.deepEqual(usage.calls.map((c) => c.agent), ['Flight', 'Trip Planner', 'Trip Planner', 'Flight', 'Flight']);
  assert.equal(usage.snapshot().totalTokens, 600);
  assert.equal(usage.calls.reduce((n, c) => n + c.compactionEvents, 0), 2);
});

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
    modelSettings: { preserveRawUsage: true }, callModelInputFilter: createHistoryInputFilter() });
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
    callModelInputFilter: createHistoryInputFilter(undefined, 'enforce') });
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
