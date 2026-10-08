import assert from 'node:assert/strict';
import test from 'node:test';
import { Usage } from '@openai/agents';
import { UsageCollector, instrumentModel, normalizeResponseUsage, observeModelInput, withUsageCollector } from '../../src/shared/observability/model-usage.js';
import { estimateTokenCost } from '../../src/shared/observability/token-cost.js';

const collector = (id = 'test') => new UsageCollector({ requestId: id, traceId: id, sessionId: id });
const rawResponse = (id = 'resp_1') => ({ responseId: id, requestId: 'req_provider', rawUsage: {
  input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 64 }, output_tokens_details: { reasoning_tokens: 10 },
}, output: [] });

test('provider usage wins; absent and reported zero usage differ', () => {
  const actual = normalizeResponseUsage({ ...rawResponse(), usage: { requests: 1, inputTokens: 999 } });
  assert.equal(actual.inputTokens, 100);
  assert.equal(actual.cachedInputTokens, 64);
  assert.equal(actual.reasoningTokens, 10);
  assert.equal(actual.cacheWriteTokens, null);
  assert.equal(normalizeResponseUsage({ usage: new Usage() }).inputTokens, null);
  assert.equal(normalizeResponseUsage({ rawUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }).inputTokens, 0);
});

test('usage deduplicates completed responses and preserves unknown failed attempt cost', () => {
  const usage = collector();
  usage.complete(usage.start('Flight', 'gpt-5.5'), rawResponse(), performance.now());
  usage.complete(usage.start('Flight', 'gpt-5.5'), rawResponse(), performance.now());
  assert.equal(usage.snapshot().totalTokens, 120);
  assert.equal(usage.snapshot().calls.length, 1);
  usage.fail(usage.start('Summary', 'gpt-5.4-mini'), performance.now(), false);
  assert.equal(usage.snapshot().totalTokens, null);
  assert.equal(usage.snapshot().complete, false);
  const snapshot = usage.snapshot();
  snapshot.calls[0].inputTokens = 0;
  assert.equal(usage.calls[0].inputTokens, 100);
});

test('dated cost estimates use cache prices without billing reasoning twice; unknown rates and bands stay unavailable', () => {
  const usage = collector();
  const call = usage.start('Flight', 'gpt-5.5');
  usage.complete(call, rawResponse(), performance.now());
  assert.equal(estimateTokenCost(usage.calls).estimatedTokenCostUsd, (36 * 5 + 64 * 0.5 + 20 * 30) / 1e6);
  assert.equal(estimateTokenCost(usage.calls).totalCostUsd, null);
  call.model = 'unpriced';
  assert.equal(estimateTokenCost(usage.calls).reason, 'unknown_model_rate');
  call.model = 'gpt-5.5'; call.inputTokens = 300000;
  assert.equal(estimateTokenCost(usage.calls).reason, 'pricing_band_requires_session_evidence');
  call.inputTokens = 100; call.cachedInputTokens = null;
  assert.equal(estimateTokenCost(usage.calls).reason, 'missing_usage');
});

test('provider wrapper preserves methods, errors, aborted streams and concurrent attribution', async () => {
  class FakeModel {
    #advice = { suggested: false };
    getRetryAdvice() { return this.#advice; }
    async getResponse(request: any) { await Promise.resolve(); if (request.fail) throw new Error('provider failed'); return rawResponse(request.id); }
    async *getStreamedResponse() { yield { type: 'response_started' as const }; }
  }
  const underlying = new FakeModel();
  const model = instrumentModel(underlying as any, 'gpt-5.5');
  assert.ok(model instanceof FakeModel);
  assert.deepEqual((model as any).getRetryAdvice(), { suggested: false });
  const a = collector('a'), b = collector('b');
  await Promise.all([a, b].map((c) => withUsageCollector(c, async () => {
    observeModelInput({ agent: { name: c.correlation.requestId }, modelData: {} }, 42);
    await model.getResponse({ id: c.correlation.requestId } as any);
  })));
  assert.equal(a.calls[0].agent, 'a');
  assert.equal(a.calls[0].diagnosticCallSequence, 42);
  assert.equal(b.calls[0].agent, 'b');
  await withUsageCollector(a, async () => {
    await assert.rejects(model.getResponse({ fail: true } as any));
    const abort = new AbortController(); abort.abort();
    for await (const _ of model.getStreamedResponse({ signal: abort.signal } as any)) { /* drain */ }
  });
  assert.deepEqual(a.calls.map((c) => c.status), ['completed', 'failed', 'aborted']);
});
