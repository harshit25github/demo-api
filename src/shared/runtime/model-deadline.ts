import { ModelTimeoutError } from '@openai/agents';
import type { Model, ModelProvider, ModelRequest, ModelResponse, ModelRetryAdvice, StreamEvent } from '@openai/agents';
import { getDefaultOpenAIClient, OpenAIProvider } from '@openai/agents-openai';
import OpenAI from 'openai';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../logging/logger.js';
import { isRecord } from '../types/json.js';

export interface ModelDeadlineConfig {
  timeoutsMs: readonly number[];
  initialBackoffMs: number;
  maxBackoffMs: number;
}

export const modelDeadlineConfig = {
  timeoutsMs: [25_000, 50_000, 75_000],
  initialBackoffMs: 500,
  maxBackoffMs: 2_000,
} as const satisfies ModelDeadlineConfig;

/** A request that can search the web often takes 30-45 s; 25 s would cut it off and replay it. */
export const webSearchDeadlineConfig = {
  ...modelDeadlineConfig,
  timeoutsMs: [60_000, 75_000],
} as const satisfies ModelDeadlineConfig;

function isWebSearch(tool: ModelRequest['tools'][number]): boolean {
  return tool.type === 'hosted_tool' && ['web_search', 'web_search_preview'].includes(String(tool.providerData?.type));
}

export class ModelDeadlineExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly reason: 'attempts_exhausted' | 'unsafe_replay' | 'retry_after_exceeds_budget' | 'retry_advice_failed',
    cause: unknown,
  ) {
    super(`Model request recovery stopped after ${attempts} attempt(s): ${reason}.`, { cause });
    this.name = 'ModelDeadlineExhaustedError';
  }
}

/** A hard local deadline, even when the provider ignores its abort signal. */
async function withinDeadline<T>(
  work: (signal: AbortSignal) => Promise<T> | T,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // Reject first: synchronous provider abort handlers cannot win this race.
      reject(parent!.reason);
      controller.abort(parent!.reason);
    };
    parent?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new ModelTimeoutError({ timeoutMs });
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    });
    // Promise.race observes late rejections, but never admits late responses to Runner.
    const result = await Promise.race([operation, interrupted]);
    parent?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) parent?.removeEventListener('abort', onAbort);
  }
}

const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);
const PERMANENT_CODES = new Set([
  'insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active',
  'invalid_api_key', 'account_deactivated', 'permission_denied',
]);

function header(chain: Record<string, unknown>[], name: string): string | undefined {
  for (const value of chain) {
    for (const source of [value.headers, value.responseHeaders, isRecord(value.response) ? value.response.headers : undefined]) {
      if (source instanceof Headers) {
        const found = source.get(name);
        if (found !== null) return found;
      } else if (isRecord(source)) {
        const entry = Object.entries(source).find(([key]) => key.toLowerCase() === name);
        if (entry && typeof entry[1] === 'string') return entry[1];
      }
    }
  }
  return undefined;
}

function isTransient(error: unknown, chain: Record<string, unknown>[], advice?: ModelRetryAdvice): boolean {
  if (advice?.normalized?.isAbort === true
    || PERMANENT_CODES.has(String(advice?.normalized?.errorCode).toLowerCase())) return false;
  if (chain.some((value) => {
    const body = isRecord(value.error) ? value.error : {};
    return [value.code, value.type, body.code, body.type].some((code) =>
      typeof code === 'string' && PERMANENT_CODES.has(code.toLowerCase()));
  })) return false;
  if (chain.some((value) => [
    'AbortError', 'APIUserAbortError', 'ModelRefusalError', 'ModelBehaviorError', 'UserError',
    'InputGuardrailTripwireTriggered', 'OutputGuardrailTripwireTriggered',
    'ToolInputGuardrailTripwireTriggered', 'ToolOutputGuardrailTripwireTriggered',
    'ZodError', 'SyntaxError', 'RangeError', 'ReferenceError',
  ].includes(String(value.name)) || (value.name === 'TypeError' && value.message !== 'fetch failed'))) return false;
  const status = chain.map((value) => value.status ?? value.statusCode).find((value) => typeof value === 'number')
    ?? advice?.normalized?.statusCode;
  if (typeof status === 'number' && !TRANSIENT_STATUSES.has(status)) return false;
  const retryHint = header(chain, 'x-should-retry')?.trim().toLowerCase();
  if (advice?.suggested === false || retryHint === 'false') return false;
  return error instanceof ModelTimeoutError || advice?.suggested === true
    || retryHint === 'true'
    || (typeof status === 'number' && TRANSIENT_STATUSES.has(status))
    || advice?.normalized?.isNetworkError === true
    || chain.some((value) => ['APIConnectionError', 'APIConnectionTimeoutError', 'FetchError'].includes(String(value.name))
      || NETWORK_CODES.has(String(value.code))
      || (value.name === 'TypeError' && value.message === 'fetch failed'));
}

function canReplay(request: ModelRequest, chain: Record<string, unknown>[], advice?: ModelRetryAdvice): boolean {
  const extra = request.modelSettings.providerData ?? {};
  // A Session is loaded into input; it is not a server-managed model conversation.
  if (request.conversationId || request.previousResponseId) return false;
  for (const body of [extra, extra.extra_body, extra.extraBody]) {
    if (body === undefined) continue;
    if (!isRecord(body)) return false;
    // Hidden prompt/provider-defined tools may have hosted side effects we cannot classify.
    if (body.conversation || body.conversation_id || body.previous_response_id || body.conversationId
      || body.previousResponseId || body.background || body.tools || body.prompt) return false;
  }
  if (request.prompt && !request.toolsExplicitlyProvided) return false;
  if (advice?.replaySafety === 'unsafe' || chain.some((value) => value.unsafeToReplay === true)) return false;
  return request.tools.every((tool) => tool.type === 'function' || isWebSearch(tool));
}

function assertDeadlineConfig({ timeoutsMs, initialBackoffMs, maxBackoffMs }: ModelDeadlineConfig): void {
  if (!timeoutsMs.length || timeoutsMs.length > 3
    || timeoutsMs.some((ms) => !Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647)
    || !Number.isFinite(initialBackoffMs) || initialBackoffMs < 0
    || !Number.isFinite(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 2_000) {
    throw new RangeError('Model deadlines require one to three positive budgets and backoff bounded to 2000ms.');
  }
}

/** Shared safety/backoff for both SDK model-call signatures, not a second retry owner. */
async function waitForModelRetry(
  model: Model, request: ModelRequest, error: unknown, attempts: number,
  config: ModelDeadlineConfig, modelName: string | undefined, stream: boolean,
): Promise<void> {
  request.signal?.throwIfAborted();
  let advice: ModelRetryAdvice | undefined;
  if (model.getRetryAdvice) {
    try {
      advice = await withinDeadline(() => model.getRetryAdvice!({ request, error, attempt: attempts, stream }),
        2_000, request.signal);
    } catch (adviceError) {
      request.signal?.throwIfAborted();
      throw new ModelDeadlineExhaustedError(attempts, 'retry_advice_failed', adviceError);
    }
  }
  const chain: Record<string, unknown>[] = [];
  for (let value = error; isRecord(value) && !chain.includes(value) && chain.length < 8; value = value.cause) chain.push(value);
  if (!isTransient(error, chain, advice)) throw error;
  if (!canReplay(request, chain, advice) || (stream && advice?.responseStarted === true)) {
    throw new ModelDeadlineExhaustedError(attempts, 'unsafe_replay', error);
  }
  if (attempts === config.timeoutsMs.length) throw new ModelDeadlineExhaustedError(attempts, 'attempts_exhausted', error);
  const delays = [advice?.retryAfterMs, advice?.normalized?.retryAfterMs];
  const milliseconds = header(chain, 'retry-after-ms');
  if (milliseconds !== undefined) delays.push(Number(milliseconds));
  const afterHeader = header(chain, 'retry-after');
  if (afterHeader !== undefined) {
    const seconds = Number(afterHeader);
    delays.push(Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(afterHeader) - Date.now());
  }
  const validDelays = delays.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0);
  const after = validDelays.length ? Math.max(...validDelays) : undefined;
  if (after !== undefined && after > config.maxBackoffMs) {
    throw new ModelDeadlineExhaustedError(attempts, 'retry_after_exceeds_budget', error);
  }
  const backoffMs = after ?? Math.min(config.maxBackoffMs, config.initialBackoffMs * 2 ** (attempts - 1));
  log('warn', 'model_deadline_retry', {
    model: modelName, attempt: attempts, timeoutMs: config.timeoutsMs[attempts - 1],
    nextTimeoutMs: config.timeoutsMs[attempts], backoffMs,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  if (backoffMs > 0) await delay(backoffMs, undefined, { signal: request.signal });
}

/** Retry only this pending model request; never restart Runner or completed tools. */
export async function getModelResponse(
  model: Model, request: ModelRequest, policy: ModelDeadlineConfig = modelDeadlineConfig, modelName?: string,
): Promise<ModelResponse> {
  const config = { ...policy, timeoutsMs: [...policy.timeoutsMs] };
  assertDeadlineConfig(config);
  for (let index = 0; ; index++) {
    request.signal?.throwIfAborted();
    try {
      return await withinDeadline((signal) => model.getResponse({ ...request, signal }), config.timeoutsMs[index], request.signal);
    } catch (error) {
      await waitForModelRetry(model, request, error, index + 1, config, modelName, false);
    }
  }
}

/** One total deadline per streamed attempt, including opening and all event reads. */
export async function* getModelStream(
  model: Model, request: ModelRequest, policy: ModelDeadlineConfig = modelDeadlineConfig, modelName?: string,
): AsyncIterable<StreamEvent> {
  const config = { ...policy, timeoutsMs: [...policy.timeoutsMs] };
  assertDeadlineConfig(config);
  for (let index = 0; ; index++) {
    request.signal?.throwIfAborted();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(request.signal!.reason); controller.abort(request.signal!.reason); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new ModelTimeoutError({ timeoutMs: config.timeoutsMs[index] });
        reject(error);
        controller.abort(error);
      }, config.timeoutsMs[index]);
    });
    // A provider can synchronously abort/throw while creating its iterator.
    void interrupted.catch(() => undefined);
    let iterator: AsyncIterator<StreamEvent> | undefined;
    let emitted = false;
    let completed = false;
    let failure: unknown;
    try {
      // Starting the iterator may throw; its first next() also includes transport opening.
      iterator = model.getStreamedResponse({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return iterator!.next();
        }), interrupted]);
        request.signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        if (next.done) { completed = true; return; }
        emitted = true;
        // response_done is semantic completion. Do not wait on post-terminal cleanup.
        if (next.value.type === 'response_done') { completed = true; clearTimeout(timer); }
        yield next.value;
        if (completed) return;
      }
    } catch (error) {
      controller.abort(error);
      request.signal?.throwIfAborted();
      if (emitted) throw error; // Never repeat events already accepted by Runner.
      failure = error;
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener('abort', onAbort);
      if (!completed) controller.abort();
      // An iterator ignoring cancellation must not hold up recovery or caller close.
      void Promise.resolve().then(() => iterator?.return?.()).catch(() => undefined);
    }
    await waitForModelRetry(model, request, failure, index + 1, config, modelName, true);
  }
}

let openAIProvider: OpenAIProvider | undefined;

// The SDK requires getModel(); this is the only model-boundary wrapper.
export const modelDeadlineProvider: ModelProvider = {
  async getModel(modelName) {
    // Clone the configured client once, preserving its key, endpoint, headers and fetch.
    openAIProvider ??= new OpenAIProvider({
      openAIClient: getDefaultOpenAIClient()?.withOptions({ maxRetries: 0 }) ?? new OpenAI({ maxRetries: 0 }),
      useResponses: true,
      useResponsesWebSocket: false,
    });
    const model = await openAIProvider.getModel(modelName);
    const deadlineFor = (request: ModelRequest) => (request.tools.some(isWebSearch) ? webSearchDeadlineConfig : modelDeadlineConfig);
    return {
      supportsPromptModelSelection: model.supportsPromptModelSelection,
      getResponse: (request) => getModelResponse(model, request, deadlineFor(request), modelName),
      getStreamedResponse: (request) => getModelStream(model, request, deadlineFor(request), modelName),
      // Do not expose another SDK retry owner.
    };
  },
};
