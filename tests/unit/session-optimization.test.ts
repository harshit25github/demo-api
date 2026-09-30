import assert from 'node:assert/strict';
import test from 'node:test';
import { Usage } from '@openai/agents';
import { readSessionOptimizationConfig } from '../../src/shared/config/session-optimization.js';
import { resolveCompactionPolicy } from '../../src/shared/config/compaction-policy.js';
import { UsageCollector, instrumentModel, normalizeResponseUsage, observeModelInput, withUsageCollector } from '../../src/shared/observability/model-usage.js';
import { projectFlightToolOutput, modelFacingToolOutput } from '../../src/agents/flight/tools/model-output.js';
import { projectHistoryInput } from '../../src/agents/manager-orchestrator/history-policy.js';
import { estimateTokenCost } from '../../src/shared/observability/token-cost.js';

export function searchPayload(n = 3) {
  return { source: 'dummy', message: 'Results ready', searchKey: 'search_fixture', UID: 'uid',
    searchParams: { origin: 'DEL', destination: 'BOM', date: '2026-10-15' }, summary: { optionCount: 2 },
    flights: Array.from({ length: n }, (_, i) => ({ option: i + 1, price: 1000 - i, duration: 500 - i, details: 'flight detail '.repeat(40) })),
    airlineFilterOptions: [{ Code: 'AI', Text: 'Air India', IsDisabled: false }], layoverAirportFilterOptions: [], DepartAirports: [], DepLandAirports: [] };
}
const collector = (id = 'test') => new UsageCollector({ requestId: id, traceId: id, sessionId: id });
const rawResponse = (id = 'resp_1') => ({ responseId: id, requestId: 'req_provider', rawUsage: {
  input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 64 }, output_tokens_details: { reasoning_tokens: 10 },
}, output: [] });

test('configuration defaults and invalid values are explicit; compaction fails closed until all models pass', () => {
  const defaults = readSessionOptimizationConfig({});
  assert.deepEqual(defaults, { mode: 'observe', compactionEnabled: false, compactionThresholdTokens: 50000 });
  for (const env of [{ SESSION_OPTIMIZATION_MODE: 'yes' }, { SESSION_COMPACTION_ENABLED: '1' }, { SESSION_COMPACTION_THRESHOLD_TOKENS: '2e4' }, { SESSION_COMPACTION_THRESHOLD_TOKENS: '0' }]) {
    assert.throws(() => readSessionOptimizationConfig(env));
  }
  const config = { ...defaults, compactionEnabled: true };
  assert.equal(resolveCompactionPolicy(config, ['gpt-5.5']).enabled, false);
  const evidence = [{ model: 'gpt-5.5', endpoint: 'responses.create' as const, sdkVersion: '0.17.0', contextWindow: 1050000, outputReserve: 128000, evidence: 'synthetic test only' }];
  assert.equal(resolveCompactionPolicy(config, ['gpt-5.5', 'gpt-5.2'], evidence).enabled, false);
  assert.deepEqual(resolveCompactionPolicy(config, ['gpt-5.5'], evidence).settings, { contextManagement: [{ type: 'compaction', compactThreshold: 50000 }] });
  assert.throws(() => resolveCompactionPolicy({ ...config, compactionThresholdTokens: 1000000 }, ['gpt-5.5'], evidence));
});

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

test('projection keeps catalogs, truth and all candidates in original runtime; mode rollback and idempotence', () => {
  const original = searchPayload(100), before = structuredClone(original);
  const projected: any = projectFlightToolOutput('flight_search', original).output;
  assert.deepEqual(original, before);
  assert.equal(projected.summary.optionCount, 100);
  assert.equal(projected.flights, undefined);
  assert.equal(projected.UID, undefined);
  assert.deepEqual(projected.airlineFilterOptions, original.airlineFilterOptions);
  assert.equal(original.flights.at(-1)?.price, 901);
  assert.equal(projectFlightToolOutput('flight_search', projected).changed, false);
  assert.equal(modelFacingToolOutput('flight_search', original, 'observe'), original);
  assert.equal(modelFacingToolOutput('flight_search', original, 'off'), original);
  assert.deepEqual(modelFacingToolOutput('flight_search', original, 'enforce'), projected);
  const filter = { ok: true, source: 'dummy', message: 'Filtered', searchKey: 'key', filters: [], feedback: { warnings: ['kept'] }, summary: { filteredCount: 0 }, flights: [], UID: 'id', apiPayload: {}, finalFilterPayload: {} };
  const filtered: any = projectFlightToolOutput('apply_filter', filter).output;
  assert.deepEqual(filtered.feedback, filter.feedback);
  assert.equal(filtered.summary.filteredCount, 0);
  assert.equal(filtered.apiPayload, undefined);
  for (const [name, value] of [['flight_search', { ...original, futureField: 'preserve' }], ['flight_search', { ok: false, error: 'invalid date' }], ['getGeneratedContractsContext', original], ['apply_filter', { ...filter, ok: false }]] as const) {
    assert.equal(projectFlightToolOutput(name, value).output, value);
  }
});

test('legacy history only changes paired allowed result bodies, preserving envelope identities and protected evidence', () => {
  const input: any[] = [
    { type: 'message', role: 'user', content: 'next weekend', id: 'user1' },
    { type: 'function_call', callId: 'date1', name: 'resolve_flight_dates', arguments: '{}' },
    { type: 'function_call_result', callId: 'date1', name: 'resolve_flight_dates', status: 'completed', output: JSON.stringify({ range: ['2026-10-17', '2026-10-18'] }) },
    { type: 'function_call', callId: 'search1', name: 'flight_search', arguments: '{}' },
    { type: 'function_call_result', callId: 'search1', name: 'flight_search', status: 'completed', id: 'result1', output: { type: 'text', text: JSON.stringify(searchPayload()), providerData: { retained: true } } },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Ready' }] },
    { type: 'compaction', id: 'cmp', encryptedContent: 'opaque', providerData: { retained: true } },
    { type: 'reasoning', id: 'reason', content: [], encryptedContent: 'reason' },
    { type: 'function_call_result', callId: 'unpaired', name: 'flight_search', status: 'completed', output: JSON.stringify(searchPayload()) },
  ];
  const before = structuredClone(input), identities = [...input], wrapper = input[4].output;
  projectHistoryInput(input, 'observe'); assert.deepEqual(input, before);
  projectHistoryInput(input, 'enforce');
  assert.equal(input.length, before.length);
  identities.forEach((item, i) => assert.equal(input[i], item));
  input.forEach((item, i) => { if (i !== 4) assert.deepEqual(item, before[i]); });
  assert.equal(input[4].output, wrapper);
  assert.deepEqual(wrapper.providerData, { retained: true });
  assert.equal(JSON.parse(wrapper.text).projectionVersion, 1);
  const once = structuredClone(input); projectHistoryInput(input, 'enforce'); projectHistoryInput(input, 'off');
  assert.deepEqual(input, once);
});
