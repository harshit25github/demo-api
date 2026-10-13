/** One real Manager -> native Flight run with a test-only two-second first attempt. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelProvider, ModelRequest } from '@openai/agents';

if (process.env.RUN_MANAGER_DEADLINE_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
  throw new Error('Set RUN_MANAGER_DEADLINE_LIVE=1 and reuse OPENAI_API_KEY for this paid check.');
}
process.env.ORCHESTRATION_MODE = 'manager';
process.env.AGENT_LOG_LEVEL = 'warn';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const [{ Runner, generateTraceId, getGlobalTraceProvider },
  { getDefaultOpenAIClient, OpenAIProvider }, { default: OpenAI },
  { runGatewayAgent, mainChatRunner }, { FlightManagerAgent },
  { hydrateGatewayContext }, { getModelResponse, modelDeadlineConfig },
  { pinManagerLiveModels }] = await Promise.all([
  import('@openai/agents'), import('@openai/agents-openai'), import('openai'),
  import('../../src/agents/manager-orchestrator/runner.js'),
  import('../../src/agents/flight/agent.js'), import('../../src/api/chat/context-hydration.js'),
  import('../../src/shared/runtime/model-deadline.js'), import('./manager-live-model-policy.js'),
]);
pinManagerLiveModels();

type HttpAttempt = {
  payloadHash: string; durationMs?: number; status?: number; abortMs?: number; errorName?: string;
};
type Attempt = {
  role: 'Manager' | 'Flight'; stepHash: string; attempt: number;
  startedAt: number; durationMs?: number; abortMs?: number; timeoutMs?: number;
  outcome?: 'success' | 'error'; errorName?: string; stateHash: string; http: HttpAttempt[];
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = new AsyncLocalStorage<Attempt>();
const attempts: Attempt[] = [];
const context = hydrateGatewayContext({});
let flightInvocations = 0;
FlightManagerAgent.on('agent_start', () => { flightInvocations += 1; });

const configuredClient = getDefaultOpenAIClient();
// Test instrumentation only: this installed client keeps its transport on the
// runtime instance, although it is not part of the public TypeScript interface.
const configuredFetch = configuredClient ? Reflect.get(configuredClient, 'fetch') : undefined;
const originalFetch: typeof fetch = typeof configuredFetch === 'function' ? configuredFetch : globalThis.fetch;
const observedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (!new URL(url).pathname.endsWith('/responses')) return originalFetch(input, init);
  const rawBody = typeof init?.body === 'string' ? init.body
    : input instanceof Request ? await input.clone().text() : '';
  const body = JSON.parse(rawBody);
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.reasoning?.effort, 'low');
  const attempt = scope.getStore();
  assert.ok(attempt, 'Responses HTTP call was not associated with a model attempt');
  // Hash the real request body; never retain authorization headers or raw prompts.
  const entry: HttpAttempt = { payloadHash: hash(rawBody) };
  attempt.http.push(entry);
  const start = performance.now();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const onAbort = () => { entry.abortMs = Math.round(performance.now() - start); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await originalFetch(input, init);
    entry.status = response.status;
    return response;
  } catch (error) {
    entry.errorName = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    // This duration ends at headers. The model attempt below includes body parsing.
    entry.durationMs = Math.round(performance.now() - start);
    signal?.removeEventListener('abort', onAbort);
  }
};
const client = configuredClient?.withOptions({ maxRetries: 0, fetch: observedFetch })
  ?? new OpenAI({ maxRetries: 0, fetch: observedFetch });
const base = new OpenAIProvider({ openAIClient: client, useResponses: true, useResponsesWebSocket: false });
const testTimeouts = [2_000, 50_000, 75_000];
const observedProvider: ModelProvider = { async getModel(name) {
  const model = await base.getModel(name);
  const observedModel = {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    async getResponse(request: ModelRequest) {
      const { signal, ...saved } = request;
      const stepHash = hash(JSON.stringify(saved));
      const attempt: Attempt = {
        role: request.tools.some((tool) => tool.name === 'flight_search') ? 'Flight' : 'Manager',
        stepHash, attempt: attempts.filter((item) => item.stepHash === stepHash).length + 1,
        startedAt: performance.now(),
        stateHash: hash(JSON.stringify({ flight: context.flight, log: context.toolCallLog })), http: [],
      };
      attempts.push(attempt);
      const onAbort = () => {
        attempt.abortMs = Math.round(performance.now() - attempt.startedAt);
        attempt.timeoutMs = signal?.reason?.timeoutMs;
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await scope.run(attempt, () => model.getResponse(request));
        attempt.outcome = 'success';
        return response;
      } catch (error) {
        attempt.outcome = 'error';
        attempt.errorName = error instanceof Error ? error.name : 'UnknownError';
        throw error;
      } finally {
        attempt.durationMs = Math.round(performance.now() - attempt.startedAt);
        signal?.removeEventListener('abort', onAbort);
      }
    },
    getStreamedResponse: (request) => model.getStreamedResponse(request),
    getRetryAdvice: model.getRetryAdvice?.bind(model),
  };
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getResponse: (request) => getModelResponse(observedModel, request,
      { ...modelDeadlineConfig, timeoutsMs: testTimeouts }, name),
    getStreamedResponse: model.getStreamedResponse.bind(model),
  };
} };

const runner = new Runner({ ...mainChatRunner.config,
  modelProvider: observedProvider,
});
const traceId = generateTraceId();
const startedAt = performance.now();
let output: string | null = null;
let failure: string | null = null;
try {
  const result = await runGatewayAgent({
    input: 'Find one-way flights from Delhi DEL to Dubai DXB on October 20, 2026 for one adult in economy, nonstop only.',
    context, runner, traceId, requestId: 'manager-two-second-deadline-live',
    sessionId: 'manager-two-second-deadline-live', maxTurns: 8,
    now: new Date('2026-10-08T10:00:00Z'), timeZone: 'Asia/Kolkata',
  });
  output = result.output;
} catch (error) {
  failure = error instanceof Error ? error.name : 'UnknownError';
}

const groups = [...new Set(attempts.map((item) => item.stepHash))]
  .map((stepHash) => attempts.filter((item) => item.stepHash === stepHash));
const verifiedRetries = groups.filter((group) => group.length > 1
  && group[0].timeoutMs === 2_000
  && group[0].http.length === 1
  && group.slice(1).some((attempt) => attempt.outcome === 'success' && attempt.http.length === 1
    && attempt.http[0].status === 200 && attempt.http[0].payloadHash === group[0].http[0].payloadHash));
const successfulTools = context.toolCallLog.filter((entry: any) => entry.ok === true);
const checks = {
  managerCompleted: Boolean(output) && failure === null,
  liveFlightRetryObserved: verifiedRetries.some((group) => group[0].role === 'Flight'),
  liveHttpAbortObserved: verifiedRetries.some((group) => group[0].http[0].abortMs !== undefined),
  sameStateAcrossRetries: groups.every((group) => group.every((attempt) => attempt.stateHash === group[0].stateHash)),
  maxThreeAttempts: groups.every((group) => group.length <= 3),
  oneHttpCallPerAttempt: attempts.every((attempt) => attempt.http.length === 1),
  nativeFlightInvokedOnce: flightInvocations === 1,
  searchExecutedOnce: successfulTools.filter((entry: any) => entry.tool === 'flight_search').length === 1,
  filterExecutedOnce: successfulTools.filter((entry: any) => entry.tool === 'apply_filter').length === 1,
  suggestionsWrittenOnce: successfulTools.filter((entry: any) => entry.tool === 'update_flight_suggested_questions').length === 1,
  productionDefaultsUnchanged: JSON.stringify(modelDeadlineConfig.timeoutsMs) === '[25000,50000,75000]',
};
const report = {
  traceId, testTimeouts, productionTimeouts: modelDeadlineConfig.timeoutsMs,
  model: 'gpt-5.2', reasoningEffort: 'low', latencyMs: Math.round(performance.now() - startedAt),
  output, failure, checks, flightInvocations,
  successfulTools: successfulTools.map((entry: any) => entry.tool),
  attempts: attempts.map(({ startedAt: _startedAt, ...attempt }) => attempt),
  note: 'Real OpenAI model requests; existing fixture Flight backend. Aborted remote usage/cost may be unknown.',
};
const reportPath = path.resolve('artifacts', `manager-model-deadline-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
await getGlobalTraceProvider().forceFlush();
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
