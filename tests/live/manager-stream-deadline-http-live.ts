/** Paid HTTP/SSE check: real Manager streaming, native Flight and session. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Model, ModelProvider, ModelRequest, StreamEvent } from '@openai/agents';
import type { FlightAppContext } from '../../src/agents/flight/types.js';

if (process.env.RUN_MANAGER_STREAM_HTTP_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
  throw new Error('Set RUN_MANAGER_STREAM_HTTP_LIVE=1 and reuse OPENAI_API_KEY for this paid check.');
}
process.env.AGENT_LOG_LEVEL = 'warn';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const [{ Runner, getGlobalTraceProvider },
  { getDefaultOpenAIClient, setDefaultOpenAIClient, OpenAIProvider, OpenAIConversationsSession },
  { default: OpenAI }, { mainChatRunner, runGatewayAgent }, { FlightManagerAgent },
  { createChatServer }, { streamChatTurn }, { JsonChatStore },
  { modelDeadlineConfig, getModelResponse, getModelStream }, { pinManagerLiveModels }] = await Promise.all([
  import('@openai/agents'), import('@openai/agents-openai'), import('openai'),
  import('../../src/agents/manager-orchestrator/runner.js'), import('../../src/agents/flight/agent.js'),
  import('../../src/api/chat/server.js'),
  import('../../src/api/chat/orchestrator.js'), import('../../src/api/chat/store.js'),
  import('../../src/shared/runtime/model-deadline.js'), import('./manager-live-model-policy.js'),
]);
pinManagerLiveModels();

type HttpCall = {
  payloadHash: string; stream: boolean; model: string; reasoning: string;
  status?: number; headersMs?: number; abortMs?: number; errorName?: string;
};
type Attempt = {
  role: 'Manager' | 'Flight'; mode: 'stream' | 'nonstream'; stepHash: string; attempt: number;
  stateHash: string; startedAt: number; durationMs?: number; timeoutMs?: number; abortMs?: number;
  outcome?: 'success' | 'error'; errorName?: string; events: string[]; http: HttpCall[];
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = new AsyncLocalStorage<Attempt>();
const attempts: Attempt[] = [];
const unmanagedModelHttp: HttpCall[] = [];
const fetchCleanup = new WeakMap<Attempt, (() => void)[]>();
let context: FlightAppContext | undefined;
let flightInvocations = 0;
FlightManagerAgent.on('agent_start', () => { flightInvocations += 1; });

const configuredClient = getDefaultOpenAIClient();
const configuredFetch = configuredClient ? Reflect.get(configuredClient, 'fetch') : undefined;
const originalFetch: typeof fetch = typeof configuredFetch === 'function' ? configuredFetch : globalThis.fetch;
const observedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (!new URL(url).pathname.endsWith('/responses')) return originalFetch(input, init);
  const rawBody = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
  const body = JSON.parse(rawBody);
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.reasoning?.effort, 'low');
  const attempt = scope.getStore();
  const entry: HttpCall = {
    payloadHash: hash(rawBody), stream: body.stream === true,
    model: body.model, reasoning: body.reasoning.effort,
  };
  (attempt?.http ?? unmanagedModelHttp).push(entry);
  const start = performance.now();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const onAbort = () => { entry.abortMs = Math.round(performance.now() - start); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (attempt) fetchCleanup.get(attempt)!.push(() => signal?.removeEventListener('abort', onAbort));
  try {
    const response = await originalFetch(input, init);
    entry.status = response.status;
    entry.headersMs = Math.round(performance.now() - start);
    return response;
  } catch (error) {
    entry.errorName = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    // Managed listeners remain through body consumption, not merely headers.
    if (!attempt) signal?.removeEventListener('abort', onAbort);
  }
};
const client = configuredClient?.withOptions({ maxRetries: 0, fetch: observedFetch })
  ?? new OpenAI({ maxRetries: 0, fetch: observedFetch });
setDefaultOpenAIClient(client); // The real session path reuses this client too.
const base = new OpenAIProvider({ openAIClient: client, useResponses: true, useResponsesWebSocket: false });
const policy = { ...modelDeadlineConfig, timeoutsMs: [2_000, 50_000, 75_000] };

function observeAttempt(request: ModelRequest, mode: Attempt['mode']): [Attempt, () => void] {
  const { signal, ...input } = request;
  const stepHash = hash({ mode, input });
  const attempt: Attempt = {
    role: request.tools.some((tool) => tool.name === 'flight_search') ? 'Flight' : 'Manager',
    mode, stepHash, attempt: attempts.filter((entry) => entry.stepHash === stepHash).length + 1,
    stateHash: hash({ flight: context?.flight, log: context?.toolCallLog }),
    startedAt: performance.now(), events: [], http: [],
  };
  attempts.push(attempt);
  fetchCleanup.set(attempt, []);
  const onAbort = () => {
    attempt.abortMs = Math.round(performance.now() - attempt.startedAt);
    attempt.timeoutMs = signal?.reason?.timeoutMs;
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  return [attempt, () => {
    attempt.durationMs = Math.round(performance.now() - attempt.startedAt);
    signal?.removeEventListener('abort', onAbort);
    for (const cleanup of fetchCleanup.get(attempt)!) cleanup();
  }];
}
const provider: ModelProvider = { async getModel(name) {
  const model = await base.getModel(name);
  const observed: Model = {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getRetryAdvice: model.getRetryAdvice?.bind(model),
    async getResponse(request) {
      const [attempt, finish] = observeAttempt(request, 'nonstream');
      try {
        const result = await scope.run(attempt, () => model.getResponse(request));
        attempt.outcome = 'success';
        return result;
      } catch (error) {
        attempt.outcome = 'error';
        attempt.errorName = error instanceof Error ? error.name : 'UnknownError';
        throw error;
      } finally { finish(); }
    },
    async *getStreamedResponse(request): AsyncIterable<StreamEvent> {
      const [attempt, finish] = observeAttempt(request, 'stream');
      const iterator = scope.run(attempt, () => model.getStreamedResponse(request)[Symbol.asyncIterator]());
      try {
        while (true) {
          const next = await scope.run(attempt, () => iterator.next());
          if (next.done) { attempt.outcome = 'success'; return; }
          attempt.events.push(next.value.type);
          if (next.value.type === 'response_done') attempt.outcome = 'success';
          yield next.value;
        }
      } catch (error) {
        attempt.outcome = 'error';
        attempt.errorName = error instanceof Error ? error.name : 'UnknownError';
        throw error;
      } finally {
        finish();
        void Promise.resolve(scope.run(attempt, () => iterator.return?.())).catch(() => undefined);
      }
    },
  };
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getResponse: (request) => getModelResponse(observed, request, policy, name),
    getStreamedResponse: (request) => getModelStream(observed, request, policy, name),
  };
} };
const runner = new Runner({ ...mainChatRunner.config, modelProvider: provider });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.resolve('artifacts', `manager-stream-deadline-http-live-${stamp}`);
await fs.mkdir(directory, { recursive: true });
const store = await new JsonChatStore({ filePath: path.join(directory, 'chats.json') }).init();
let session: InstanceType<typeof OpenAIConversationsSession> | undefined;
const server = createChatServer({ store, runTurn: (options) => streamChatTurn({
  ...options,
  createConversationSession: (sessionOptions) => {
    session = new OpenAIConversationsSession({ ...sessionOptions, client });
    return session;
  },
  runGateway: async (options) => {
    context = options.context as FlightAppContext;
    return runGatewayAgent({ ...options, input: options.input, runner });
  },
}) });
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address() as import('node:net').AddressInfo;
const message = 'Find one-way flights from Delhi DEL to Dubai DXB on October 20, 2026 for one adult in economy, nonstop only.';
const startedAt = performance.now();
let raw = '';
let sseContentType = '';
let transportFailure: string | null = null;
try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, timeZone: 'Asia/Kolkata', stream: true }),
    signal: AbortSignal.timeout(240_000), // Harness safety ceiling; not a model policy.
  });
  assert.equal(response.status, 200);
  sseContentType = response.headers.get('content-type') ?? '';
  raw = await response.text();
} catch (error) {
  transportFailure = error instanceof Error ? error.name : 'UnknownError';
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const events = raw.split('\n\n').flatMap((block) => {
  const event = block.match(/^event: (.+)$/m)?.[1];
  const data = block.match(/^data: (.+)$/m)?.[1];
  return event && data ? [{ event, data: JSON.parse(data) }] : [];
});
const terminal = events.filter(({ event }) => event === 'done' || event === 'error');
const saved = store.getChat(store.listChats()[0]?.chatId);
const release = saved ? store.acquireTurn(saved.chatId) : null;
release?.();
const history = session ? await session.getItems() : [];
const historyUserCount = history.filter((item) => item.type === 'message' && item.role === 'user').length;
const groups = [...new Set(attempts.map((attempt) => attempt.stepHash))]
  .map((stepHash) => attempts.filter((attempt) => attempt.stepHash === stepHash));
const tools = context?.toolCallLog.filter((entry: any) => entry.ok === true).map((entry: any) => entry.tool) ?? [];
const toolCounts = Object.fromEntries(['flight_search', 'apply_filter', 'update_flight_suggested_questions']
  .map((tool) => [tool, tools.filter((name) => name === tool).length]));
const completed = terminal[0]?.event === 'done' && saved?.turns[0]?.status === 'completed';
const controlledFailure = terminal[0]?.event === 'error' && saved?.turns[0]?.status === 'failed'
  && attempts.some((attempt) => attempt.timeoutMs === 2_000);
const checks = {
  realHttpSse: sseContentType.startsWith('text/event-stream') && transportFailure === null,
  managerModelStreaming: attempts.some((attempt) => attempt.role === 'Manager' && attempt.mode === 'stream'
    && attempt.http.some((call) => call.stream)),
  deadlineActuallyTriggered: attempts.some((attempt) => attempt.timeoutMs === 2_000 && attempt.http.some((call) => call.abortMs !== undefined)),
  terminalEventAndSpinnerRelease: terminal.length === 1 && Boolean(release) && (completed || controlledFailure),
  oneHttpCallPerManagedAttempt: attempts.every((attempt) => attempt.http.length === 1),
  maxThreeAttempts: groups.every((group) => group.length <= 3),
  sameRetryInputAndState: groups.every((group) => group.every((attempt) => attempt.stateHash === group[0].stateHash
    && attempt.http[0]?.payloadHash === group[0].http[0]?.payloadHash)),
  noReplayAfterStreamEvents: groups.every((group) => group.every((attempt, index) =>
    attempt.mode !== 'stream' || attempt.events.length === 0 || index === group.length - 1)),
  successfulOperationsNotDuplicated: Object.values(toolCounts).every((count) => count <= 1),
  historyNotDuplicated: historyUserCount <= 1 && saved?.messages.filter((item) => item.role === 'user').length === 1,
  sessionPersisted: Boolean(saved?.conversationId),
  productionDefaultsUnchanged: JSON.stringify(modelDeadlineConfig.timeoutsMs) === '[25000,50000,75000]',
  extractionSkipped: saved?.turns[0]?.summaryStatus === 'skipped'
    && !events.some(({ event }) => event === 'summary.started') && unmanagedModelHttp.length === 0,
};
const completionChecks = {
  nativeFlightInvokedOnce: flightInvocations === 1,
  allRequiredOperationsCompleted: Object.values(toolCounts).every((count) => count === 1),
  extractionNotRun: terminal[0]?.data.summaryStatus === 'skipped' && unmanagedModelHttp.length === 0,
  sessionHasOneUserMessage: historyUserCount === 1,
};
const report = {
  outcome: completed ? 'completed' : controlledFailure ? 'controlled_failure' : 'unexpected_failure',
  policy, productionPolicy: modelDeadlineConfig, model: 'gpt-5.2', reasoningEffort: 'low',
  latencyMs: Math.round(performance.now() - startedAt), checks, completionChecks,
  transportFailure, traceId: events.find(({ event }) => event === 'turn.started')?.data.traceId,
  chatId: saved?.chatId, conversationId: saved?.conversationId, persistedStatus: saved?.turns[0]?.status,
  eventNames: events.map(({ event }) => event),
  finalText: terminal[0]?.data.finalText ?? null, sseError: terminal[0]?.event === 'error' ? terminal[0].data : null,
  flightInvocations, toolCounts, historyUserCount, unmanagedModelHttp,
  attempts: attempts.map(({ startedAt: _startedAt, ...attempt }) => attempt),
  retryObserved: groups.some((group) => group.length > 1),
  note: 'Real OpenAI streaming/nonstream requests and Conversations session; existing fixture Flight backend. Streaming failures after events are not replayed. No raw prompts or authorization headers retained in this report; aborted remote cost is unknown.',
};
const reportPath = path.join(directory, 'report.json');
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
await getGlobalTraceProvider().forceFlush();
console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (Object.values(checks).some((check) => !check) || (completed && Object.values(completionChecks).some((check) => !check))) {
  process.exitCode = 1;
}
