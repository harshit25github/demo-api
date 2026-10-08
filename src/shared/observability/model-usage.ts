import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Model, ModelProvider, ModelRequest } from '@openai/agents';
import { getDefaultOpenAIClient, OpenAIProvider } from '@openai/agents-openai';
import OpenAI from 'openai';
import { estimateTokenCost } from './token-cost.js';

export interface UsageCorrelation {
  requestId: string;
  traceId: string;
  sessionId: string;
}
export interface ModelCallUsage {
  invocationId: string;
  sequence: number;
  diagnosticCallSequence: number | null;
  agent: string;
  model: string;
  serviceTier: string | null;
  endpoint: 'responses.create';
  responseId: string | null;
  providerRequestId: string | null;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  usageSource: 'provider' | 'sdk' | 'missing';
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  latencyMs: number | null;
  functionToolCalls: number;
  hostedToolCalls: number;
  transportAttempts: { status: number | null; requestId: string | null; latencyMs: number; failed: boolean }[];
}
export interface ChatTurnUsage extends UsageCorrelation {
  schemaVersion: 1;
  calls: ModelCallUsage[];
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  complete: boolean;
  firstDeltaMs: number | null;
  latencyMs: number;
  cost: ReturnType<typeof estimateTokenCost>;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' ? value as RecordValue : {};
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function identifier(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function normalizeResponseUsage(response: unknown) {
  const r = record(response);
  const raw = record(r.rawUsage);
  const sdk = record(r.usage);
  const provider = Object.keys(raw).length > 0;
  const usage = provider ? raw : sdk;
  const inputTokens = count(provider ? usage.input_tokens : usage.inputTokens);
  const outputTokens = count(provider ? usage.output_tokens : usage.outputTokens);
  const totalTokens = count(provider ? usage.total_tokens : usage.totalTokens);
  const details = record(provider ? usage.input_tokens_details :
    Array.isArray(usage.inputTokensDetails) ? usage.inputTokensDetails[0] : usage.inputTokensDetails);
  const outputDetails = record(provider ? usage.output_tokens_details :
    Array.isArray(usage.outputTokensDetails) ? usage.outputTokensDetails[0] : usage.outputTokensDetails);
  // Empty normalized Usage defaults are not evidence of a free provider request.
  const reported = provider || (count(sdk.requests) ?? 0) > 0 ||
    (inputTokens ?? 0) > 0 || (outputTokens ?? 0) > 0;
  return {
    usageSource: (reported ? provider ? 'provider' : 'sdk' : 'missing') as ModelCallUsage['usageSource'],
    inputTokens: reported ? inputTokens : null,
    outputTokens: reported ? outputTokens : null,
    totalTokens: reported ? totalTokens : null,
    cachedInputTokens: reported ? count(details.cached_tokens) : null,
    cacheWriteTokens: reported ? count(details.cache_write_tokens) : null,
    reasoningTokens: reported ? count(outputDetails.reasoning_tokens) : null,
  };
}

export class UsageCollector {
  readonly calls: ModelCallUsage[] = [];
  private readonly startedAt = performance.now();
  private firstDeltaMs: number | null = null;
  private readonly responseIds = new Set<string>();
  constructor(readonly correlation: UsageCorrelation) {}

  start(agent: string, model: string, diagnosticCallSequence: number | null = null): ModelCallUsage {
    const call: ModelCallUsage = {
      invocationId: randomUUID(), sequence: this.calls.length + 1, diagnosticCallSequence, agent, model, serviceTier: null,
      endpoint: 'responses.create', responseId: null, providerRequestId: null,
      status: 'running', usageSource: 'missing', inputTokens: null, outputTokens: null,
      totalTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      latencyMs: null, functionToolCalls: 0, hostedToolCalls: 0, transportAttempts: [],
    };
    this.calls.push(call);
    return call;
  }

  complete(call: ModelCallUsage, response: unknown, startedAt: number): void {
    const r = record(response);
    const responseId = identifier(r.responseId ?? r.id);
    if (call.status === 'completed' && call.responseId === responseId) return;
    if (responseId && this.responseIds.has(responseId)) {
      const index = this.calls.indexOf(call);
      if (index >= 0) this.calls.splice(index, 1);
      return;
    }
    if (responseId) this.responseIds.add(responseId);
    const provider = record(r.providerData);
    Object.assign(call, normalizeResponseUsage(r), {
      responseId, providerRequestId: identifier(r.requestId ?? provider._request_id),
      model: identifier(provider.model) ?? call.model, status: 'completed',
      serviceTier: identifier(provider.service_tier),
      latencyMs: performance.now() - startedAt,
      functionToolCalls: Array.isArray(r.output) ? r.output.filter((i) => record(i).type === 'function_call').length : 0,
      hostedToolCalls: Array.isArray(provider.output) ? provider.output.filter((i) => ['web_search_call', 'file_search_call', 'code_interpreter_call'].includes(String(record(i).type))).length : 0,
    });
  }

  fail(call: ModelCallUsage, startedAt: number, aborted: boolean): void {
    if (call.status !== 'running') return;
    call.status = aborted ? 'aborted' : 'failed';
    call.latencyMs = performance.now() - startedAt;
  }

  /**
   * Time from the turn starting to the first user-visible text.
   *
   * The Manager emits its answer as a single delta, so this is time-to-answer
   * rather than time-to-first-token. It becomes the latter if token streaming is
   * added later, without changing the recorded field.
   */
  markFirstDelta(): void {
    this.firstDeltaMs ??= performance.now() - this.startedAt;
  }

  snapshot(): ChatTurnUsage {
    const sum = (key: 'inputTokens' | 'outputTokens' | 'totalTokens') =>
      this.calls.length > 0 && this.calls.every((c) => c[key] !== null && !c.transportAttempts.some((a) => a.failed))
        ? this.calls.reduce((n, c) => n + c[key]!, 0) : null;
    return structuredClone({
      ...this.correlation, schemaVersion: 1 as const, calls: this.calls,
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
      complete: this.calls.length > 0 && this.calls.every((c) => c.status === 'completed' && c.inputTokens !== null && c.outputTokens !== null && c.totalTokens !== null && !c.transportAttempts.some((a) => a.failed)),
      firstDeltaMs: this.firstDeltaMs, latencyMs: performance.now() - this.startedAt,
      cost: estimateTokenCost(this.calls),
    });
  }
}

interface UsageScope { collector: UsageCollector; agent: string; diagnosticCallSequence: number | null }
const usageScope = new AsyncLocalStorage<UsageScope>();
const modelCallScope = new AsyncLocalStorage<ModelCallUsage | undefined>();

// OpenAI's HTTP client can retry inside one Model invocation, even on the first
// SDK-managed attempt. Observe those requests without changing the retry policy.
export function observeOpenAIFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const call = modelCallScope.getStore();
    const startedAt = performance.now();
    try {
      const response = await fetcher(input, init);
      call?.transportAttempts.push({ status: response.status, requestId: response.headers.get('x-request-id'),
        latencyMs: performance.now() - startedAt, failed: !response.ok });
      return response;
    } catch (error) {
      call?.transportAttempts.push({ status: null, requestId: null, latencyMs: performance.now() - startedAt, failed: true });
      throw error;
    }
  };
}

export function withUsageCollector<T>(collector: UsageCollector, fn: () => T): T {
  return usageScope.run({ collector, agent: 'unknown', diagnosticCallSequence: null }, fn);
}
export function currentUsageCollector(): UsageCollector | undefined {
  return usageScope.getStore()?.collector;
}
export function observeModelInput<T extends { agent: { name: string }; modelData: unknown }>(args: T, diagnosticCallSequence: number | null = null): T['modelData'] {
  const scope = usageScope.getStore();
  if (scope) { scope.agent = args.agent.name; scope.diagnosticCallSequence = diagnosticCallSequence; }
  return args.modelData;
}

// The provider boundary includes failed retry attempts; final-result-only accounting misses them.
// Proxy keeps provider capabilities/instance identity and binds private-field methods correctly.
export function instrumentModel(model: Model, modelName: string): Model {
  return new Proxy(model, {
    get(target, property) {
      if (property === 'getResponse') return async (request: ModelRequest) => {
        const scope = usageScope.getStore();
        const startedAt = performance.now();
        const call = scope?.collector.start(scope.agent, modelName, scope.diagnosticCallSequence);
        try {
          const response = await modelCallScope.run(call, () => target.getResponse(request));
          if (call) scope!.collector.complete(call, response, startedAt);
          return response;
        } catch (error) {
          if (call) scope!.collector.fail(call, startedAt, request.signal?.aborted === true);
          throw error;
        }
      };
      if (property === 'getStreamedResponse') return async function* (request: ModelRequest) {
        const scope = usageScope.getStore();
        const startedAt = performance.now();
        const call = scope?.collector.start(scope.agent, modelName, scope.diagnosticCallSequence);
        const iterator = target.getStreamedResponse(request)[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await modelCallScope.run(call, () => iterator.next());
            if (next.done) break;
            const event = next.value;
            if (call && event.type === 'response_done') scope!.collector.complete(call, event.response, startedAt);
            yield event;
          }
        } finally {
          if (call) scope!.collector.fail(call, startedAt, request.signal?.aborted === true);
          await modelCallScope.run(call, () => iterator.return?.());
        }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class ObservedModelProvider implements ModelProvider {
  constructor(private provider?: ModelProvider) {}
  async getModel(modelName?: string): Promise<Model> {
    if (!this.provider) {
      // Respect an explicitly configured application client. Its custom transport remains owned by the caller.
      // The client reads OPENAI_API_KEY from the environment itself.
      const client = getDefaultOpenAIClient() ?? new OpenAI({ fetch: observeOpenAIFetch(globalThis.fetch) });
      this.provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
    }
    return instrumentModel(await this.provider.getModel(modelName), modelName ?? 'unknown');
  }
}
