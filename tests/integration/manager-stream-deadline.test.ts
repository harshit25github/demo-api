/** Offline true-streaming acceptance through the production Manager and native Flight tool. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model, ModelProvider, ModelRequest, StreamEvent } from '@openai/agents';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('Network is disabled for streaming deadline acceptance tests.');
};

const { Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { flightAgentAsTool } = await import('../../src/agents/manager/specialists/flight.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { snapshotFlightSearchRuntime } = await import('../../src/agents/flight/context/search-runtime-store.js');
const { finalizeFlightSuggestedQuestions } = await import('../../src/agents/flight/tools/suggested-questions-tool.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');
const { getModelResponse, getModelStream, modelDeadlineConfig, ModelDeadlineExhaustedError } =
  await import('../../src/shared/runtime/model-deadline.js');

// asTool() streams only when a listener is registered. This changes no production
// source and is isolated to this test process; the SDK has registration but no off().
const childEvents: unknown[] = [];
flightAgentAsTool.on('*', (event) => { childEvents.push(event); });

const TIMEOUTS = [15, 30, 45] as const;
const CONFIG = { ...modelDeadlineConfig, timeoutsMs: TIMEOUTS, initialBackoffMs: 0, maxBackoffMs: 0 };
const MANAGER_MODEL = 'offline-stream-manager';
const FLIGHT_MODEL = 'offline-stream-flight';
const NOW = new Date('2026-10-09T10:00:00Z');
const INPUT = 'Find Delhi to London flights on October 20, only nonstop.';
const SUGGESTIONS = ['Show evening departures', 'Include checked baggage', 'Try nearby dates'];

function answer(text: string) {
  return { usage: new Usage(), responseId: 'resp_stream_answer', output: [{
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
  }] };
}

function flightAnswer() {
  return answer(JSON.stringify({ status: 'success', completedTask: 'Searched the requested flights',
    summary: 'Found matching nonstop flights.', findings: [], limitations: [], missingInformation: [],
    nextStep: null, presentation: 'flight_cards_with_price_note' }));
}

function toolCall(name: string, parameters: unknown, id: string) {
  return { usage: new Usage(), responseId: `resp_${id}`, output: [{
    type: 'function_call', name, arguments: JSON.stringify(parameters), callId: id, status: 'completed',
  }] };
}

function searchPayload(origin = 'Delhi', destination = 'London') {
  return { onds: [{ origin, destination, origin_iata: null, destination_iata: null,
    origin_airport_name: null, destination_airport_name: null,
    outbound_date: '2026-10-20', return_date: null }], trip_type: 'oneway',
  passengers: { adults: 1, children: 0, infants: 0 }, cabin_class: 'economy' };
}

const NONSTOP = { filters: [{ filterType: 'stops', filterCode: '0', minDurationMinutes: null,
  maxDurationMinutes: null, minPrice: null, maxPrice: null, airlineNames: null,
  layoverAirportNames: null, departureAirportNames: null, arrivalAirportNames: null,
  rawUserFilter: 'only nonstop' }] };

function resultsCount(request: ModelRequest): number {
  return Array.isArray(request.input)
    ? request.input.filter((item) => item.type === 'function_call_result').length : 0;
}

function requestSnapshot(request: ModelRequest) {
  const { signal: _signal, ...rest } = request;
  return JSON.stringify(rest);
}

function flightSnapshot(context: any) {
  return structuredClone({ flight: context.flight,
    runtime: snapshotFlightSearchRuntime(context.flight.searchKey), toolCallLog: context.toolCallLog });
}

function done(response: ReturnType<typeof answer> | ReturnType<typeof toolCall>): StreamEvent {
  return { type: 'response_done', response: { id: response.responseId,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output: response.output as any } };
}

async function* complete(response: ReturnType<typeof answer> | ReturnType<typeof toolCall>, text?: string) {
  yield { type: 'response_started' } as StreamEvent;
  if (text) yield { type: 'output_text_delta', delta: text } as StreamEvent;
  yield done(response);
}

function blockedStream(onClose?: () => void): AsyncIterable<StreamEvent> {
  return { [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<StreamEvent>>(() => {}),
    // An uncooperative return() must not turn a hard timeout into another hang.
    return: () => { onClose?.(); return new Promise<IteratorResult<StreamEvent>>(() => {}); },
  }; } };
}

function makeRunner(manager: (request: ModelRequest) => AsyncIterable<StreamEvent>,
  flight: (request: ModelRequest) => AsyncIterable<StreamEvent>) {
  const requests: Array<{ agent: 'manager' | 'flight'; request: ModelRequest }> = [];
  const provider: ModelProvider = { getModel(name) {
    const raw: Model = {
      async getResponse() { throw new Error('Both Manager and native Flight must use true SDK streaming.'); },
      getStreamedResponse(request) {
        assert.ok(name === MANAGER_MODEL || name === FLIGHT_MODEL, `Unexpected model ${name}`);
        const agent = name === MANAGER_MODEL ? 'manager' : 'flight';
        requests.push({ agent, request });
        return agent === 'manager' ? manager(request) : flight(request);
      },
    };
    return { getResponse: (request) => getModelResponse(raw, request, CONFIG, name),
      getStreamedResponse: (request) => getModelStream(raw, request, CONFIG, name) };
  } };
  return { requests, runner: new Runner({ modelProvider: provider, tracingDisabled: true,
    modelSettings: { retry: { maxRetries: 0 } }, toolExecution: { maxFunctionToolConcurrency: 1 } }) };
}

async function withProductionAgents<T>(body: () => Promise<T>): Promise<T> {
  const managerModel = ManagerAgent.model;
  const flightModel = FlightManagerAgent.model;
  ManagerAgent.model = MANAGER_MODEL;
  FlightManagerAgent.model = FLIGHT_MODEL;
  try { return await body(); }
  finally { ManagerAgent.model = managerModel; FlightManagerAgent.model = flightModel; }
}

async function runTurn(runner: InstanceType<typeof Runner>, id: string,
  options: { context?: any; signal?: AbortSignal; session?: any } = {}) {
  const context = buildGatewayContext({ context: options.context || { flight: { uid: id }, toolCallLog: [] },
    input: INPUT, requestId: id, sessionId: `session-${id}` });
  const result = await runner.run(ManagerAgent, INPUT, {
    context: createRequestContext(context, createRequestClock({ now: NOW, timeZone: 'UTC' })),
    stream: true, maxTurns: 8, signal: options.signal, session: options.session,
  });
  void result.completed.catch(() => undefined);
  const events: any[] = [];
  try {
    for await (const event of result) events.push(event);
    await result.completed;
    return { result, context, events };
  } finally {
    finalizeFlightSuggestedQuestions(context);
  }
}

function flightSteps(request: ModelRequest) {
  switch (resultsCount(request)) {
    case 0: return complete(toolCall('flight_search', searchPayload(), 'stream-search'));
    case 1: return complete(toolCall('apply_filter', NONSTOP, 'stream-filter'));
    case 2: return complete(toolCall('update_flight_suggested_questions',
      { suggestedQuestions: SUGGESTIONS }, 'stream-suggestions'));
    case 3: return complete(flightAnswer());
    default: throw new Error('Unexpected extra Flight model step.');
  }
}

function successfulOperations(context: any) {
  assert.deepEqual(context.toolCallLog.map((entry: any) => entry.tool),
    ['flight_search', 'apply_filter', 'update_flight_suggested_questions']);
  assert.ok(context.toolCallLog.every((entry: any) => entry.ok === true));
  assert.equal(context.flight.directFlightOnly, true);
  assert.deepEqual(context.flight.suggestedQuestions, SUGGESTIONS);
}

test('true Manager and native Flight streams complete on first attempts and deliver final deltas once',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    const eventsBefore = childEvents.length;
    const { runner, requests } = makeRunner(() => ++managerCalls === 1
      ? complete(toolCall('flight_agent', { input: INPUT }, 'stream-delegate'))
      : complete(answer('Nonstop flights found.'), 'Nonstop flights found.'), flightSteps);
    const { result, context, events } = await runTurn(runner, 'stream-first-success');
    assert.equal(result.finalOutput, 'Nonstop flights found.');
    assert.equal(requests.filter((entry) => entry.agent === 'manager').length, 2);
    assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 4);
    assert.ok(childEvents.length > eventsBefore, 'Native asTool did not stream its child.');
    assert.deepEqual(events.filter((event) => event.type === 'raw_model_stream_event'
      && event.data.type === 'output_text_delta').map((event) => event.data.delta), ['Nonstop flights found.']);
    successfulOperations(context);
    assert.equal(networkCalls, 0);
  }));

test('production runGatewayAgent stream option drains true SDK streams and preserves final sanitization and lifecycle',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    const { runner, requests } = makeRunner(() => ++managerCalls === 1
      ? complete(toolCall('flight_agent', { input: INPUT }, 'stream-entry-delegate'))
      : complete(answer('Flights found. https://example.invalid/hidden'),
        'Flights found. https://example.invalid/hidden'), flightSteps);
    const result = await runGatewayAgent({ input: INPUT, requestId: 'stream-production-entry',
      sessionId: 'session-stream-production-entry', stream: true, runner,
      now: NOW, timeZone: 'UTC', maxTurns: 8,
      context: { flight: { uid: 'stream-production-entry' }, toolCallLog: [] } });
    assert.match(result.output, /Flights found/);
    assert.doesNotMatch(result.output, /https?:\/\//);
    assert.equal(result.result.cancelled, false);
    assert.equal(requests.filter((entry) => entry.agent === 'manager').length, 2);
    assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 4);
    successfulOperations(result.context);
    assert.equal(networkCalls, 0);
  }));

test('pre-event nested Flight retries use progressive budgets and reject late duplicate tool proposals',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    let attempts = 0;
    const abortBudgets: number[] = [];
    const retryInputs: string[] = [];
    const signals: AbortSignal[] = [];
    const late: Array<Promise<void>> = [];
    const context: any = { flight: { uid: 'stream-flight-retry' }, toolCallLog: [] };
    const saved: unknown[] = [];
    const { runner } = makeRunner(() => ++managerCalls === 1
      ? complete(toolCall('flight_agent', { input: INPUT }, 'stream-retry-delegate'))
      : complete(answer('Completed after recovery.'), 'Completed after recovery.'), (request) => {
      if (resultsCount(request) !== 1) return flightSteps(request);
      attempts += 1;
      retryInputs.push(requestSnapshot(request));
      signals.push(request.signal!);
      saved.push(flightSnapshot(context));
      if (attempts === 3) return flightSteps(request);
      request.signal!.addEventListener('abort', () => abortBudgets.push(request.signal!.reason.timeoutMs), { once: true });
      let release!: () => void;
      late.push(new Promise<void>((resolve) => { release = resolve; }));
      const number = attempts;
      return { [Symbol.asyncIterator]() { return {
        next: () => new Promise<IteratorResult<StreamEvent>>((resolve) => setTimeout(() => {
          resolve({ done: false, value: done(toolCall('flight_search',
            searchPayload('Mumbai', 'New York'), `late-stream-search-${number}`)) });
          release();
        }, 120)),
        return: () => new Promise<IteratorResult<StreamEvent>>(() => {}),
      }; } };
    });
    const result = await runTurn(runner, 'stream-flight-retry', { context });
    await Promise.all(late);
    assert.equal(result.result.finalOutput, 'Completed after recovery.');
    assert.equal(attempts, 3);
    assert.deepEqual(abortBudgets, [15, 30]);
    assert.equal(new Set(signals).size, 3);
    assert.ok(retryInputs.every((input) => input === retryInputs[0]));
    assert.deepEqual(saved[1], saved[0]);
    assert.deepEqual(saved[2], saved[0]);
    assert.equal(managerCalls, 2);
    successfulOperations(result.context);
    assert.equal(result.context.flight.segments[0].origin, 'Delhi');
    assert.equal(networkCalls, 0);
  }));

test('Manager final-stream retries retain completed Flight work and do not rerun the specialist',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let finalAttempts = 0;
    let delegations = 0;
    const snapshots: unknown[] = [];
    const inputs: string[] = [];
    const context: any = { flight: { uid: 'stream-final-retry' }, toolCallLog: [] };
    const { runner, requests } = makeRunner((request) => {
      if (resultsCount(request) === 0) {
        delegations += 1;
        return complete(toolCall('flight_agent', { input: INPUT }, 'stream-final-delegate'));
      }
      finalAttempts += 1;
      snapshots.push(flightSnapshot(context));
      inputs.push(requestSnapshot(request));
      return finalAttempts < 3 ? blockedStream()
        : complete(answer('Your completed results are ready.'), 'Your completed results are ready.');
    }, flightSteps);
    const { result } = await runTurn(runner, 'stream-final-retry', { context });
    assert.equal(result.finalOutput, 'Your completed results are ready.');
    assert.equal(finalAttempts, 3);
    assert.equal(delegations, 1);
    assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 4);
    assert.ok(inputs.every((value) => value === inputs[0]));
    assert.deepEqual(snapshots[1], snapshots[0]);
    assert.deepEqual(snapshots[2], snapshots[0]);
    successfulOperations(context);
    assert.equal(networkCalls, 0);
  }));

test('three never-settling Flight streams return controlled partial feedback with accepted search intact',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let attempts = 0;
    let feedback: any;
    const { runner } = makeRunner((request) => {
      if (resultsCount(request) === 0) return complete(toolCall('flight_agent', { input: INPUT }, 'stream-exhaust-delegate'));
      const output: any = (request.input as any[]).find((item) => item.type === 'function_call_result');
      feedback = flightManagerOutputSchema.parse(JSON.parse(output.output.text));
      return complete(answer('The search is saved, but I could not finish filtering.'), 'The search is saved, but I could not finish filtering.');
    }, (request) => resultsCount(request) === 0
      ? complete(toolCall('flight_search', searchPayload(), 'stream-exhaust-search'))
      : (++attempts, blockedStream()));
    const { result, context } = await runTurn(runner, 'stream-flight-exhaust');
    assert.equal(attempts, 3);
    assert.equal(feedback.status, 'partial');
    assert.equal(feedback.presentation, 'flight_cards_with_price_note');
    assert.deepEqual(feedback.missingInformation, []);
    assert.deepEqual(context.toolCallLog.map((entry: any) => entry.tool), ['flight_search']);
    assert.ok(context.flight.searchKey);
    assert.equal(context.flight.showFlight, true);
    assert.deepEqual(context.flight.suggestedQuestions, []);
    assert.equal(result.finalOutput, 'The search is saved, but I could not finish filtering.');
    assert.equal(networkCalls, 0);
  }));

test('a post-event Flight stall is not replayed and returns grounded partial feedback to Manager',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let failedCalls = 0;
    let feedback: any;
    const { runner } = makeRunner((request) => {
      if (resultsCount(request) === 0) return complete(toolCall('flight_agent', { input: INPUT }, 'stream-post-event-delegate'));
      const output: any = (request.input as any[]).find((item) => item.type === 'function_call_result');
      feedback = flightManagerOutputSchema.parse(JSON.parse(output.output.text));
      return complete(answer('The search was preserved.'), 'The search was preserved.');
    }, (request) => {
      if (resultsCount(request) === 0) return complete(toolCall('flight_search', searchPayload(), 'stream-post-event-search'));
      failedCalls += 1;
      return (async function* () {
        yield { type: 'response_started' } as StreamEvent;
        yield { type: 'output_text_delta', delta: '{"status":"success",' } as StreamEvent;
        await new Promise(() => {});
      })();
    });
    const { result, context } = await runTurn(runner, 'stream-child-post-event');
    assert.equal(failedCalls, 1, 'A partially emitted stream was replayed.');
    assert.equal(feedback.status, 'partial');
    assert.equal(feedback.presentation, 'flight_cards_with_price_note');
    assert.equal(result.finalOutput, 'The search was preserved.');
    assert.deepEqual(context.toolCallLog.map((entry: any) => entry.tool), ['flight_search']);
    assert.equal(networkCalls, 0);
  }));

test('streaming Flight exhaustion blocks same-turn reopening but allows a fresh user turn',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let recovering = false;
    let flightCalls = 0;
    const context: any = { flight: { uid: 'stream-recovery-turn-boundary' }, toolCallLog: [] };
    const { runner } = makeRunner((request) => {
      if (resultsCount(request) < (recovering ? 1 : 2)) {
        return complete(toolCall('flight_agent', { input: INPUT },
          `stream-boundary-delegate-${recovering}-${resultsCount(request)}`));
      }
      return complete(answer(recovering ? 'Recovered on the next turn.' : 'Could not complete this turn.'));
    }, () => {
      flightCalls += 1;
      return recovering ? complete(flightAnswer()) : blockedStream();
    });
    const failed = await runTurn(runner, 'stream-boundary-failed', { context });
    assert.equal(failed.result.finalOutput, 'Could not complete this turn.');
    assert.equal(flightCalls, 3, 'Manager reopened Flight with a fresh budget in the same turn.');
    assert.deepEqual(context.toolCallLog, []);
    recovering = true;
    const recovered = await runTurn(runner, 'stream-boundary-next', { context });
    assert.equal(recovered.result.finalOutput, 'Recovered on the next turn.');
    assert.equal(flightCalls, 4, 'A previous turn permanently disabled Flight.');
    assert.equal(networkCalls, 0);
  }));

test('a post-event Manager stall fails once without repeating visible deltas or successful Flight tools',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let finalCalls = 0;
    const context: any = { flight: { uid: 'stream-manager-post-event' }, toolCallLog: [] };
    const { runner } = makeRunner((request) => {
      if (resultsCount(request) === 0) return complete(toolCall('flight_agent', { input: INPUT }, 'stream-manager-post-event-delegate'));
      finalCalls += 1;
      return (async function* () {
        yield { type: 'response_started' } as StreamEvent;
        yield { type: 'output_text_delta', delta: 'Here are your ' } as StreamEvent;
        await new Promise(() => {});
      })();
    }, flightSteps);
    await assert.rejects(runTurn(runner, 'stream-manager-post-event', { context }));
    assert.equal(finalCalls, 1, 'Manager repeated a stream after output was already exposed.');
    successfulOperations(context);
    assert.equal(networkCalls, 0);
  }));

test('Manager pre-event final exhaustion is bounded to three attempts without replaying completed Flight',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let finalCalls = 0;
    let closed = 0;
    const context: any = { flight: { uid: 'stream-manager-exhaust' }, toolCallLog: [] };
    const { runner, requests } = makeRunner((request) => resultsCount(request) === 0
      ? complete(toolCall('flight_agent', { input: INPUT }, 'stream-manager-exhaust-delegate'))
      : (++finalCalls, blockedStream(() => { closed += 1; })), flightSteps);
    await assert.rejects(runTurn(runner, 'stream-manager-exhaust', { context }), (error: any) =>
      error instanceof ModelDeadlineExhaustedError && error.attempts === 3 && error.reason === 'attempts_exhausted');
    assert.equal(finalCalls, 3);
    assert.equal(closed, 3, 'Each timed-out iterator should receive best-effort close.');
    assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 4);
    successfulOperations(context);
    assert.equal(networkCalls, 0);
  }));

test('parent cancellation hard-stops a native Flight iterator ignoring abort and return without retry',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    const controller = new AbortController();
    let started!: () => void;
    const flightStarted = new Promise<void>((resolve) => { started = resolve; });
    let flightCalls = 0;
    let sawAbort = false;
    let closed = 0;
    const { runner } = makeRunner(() => complete(toolCall('flight_agent', { input: INPUT }, 'stream-client-cancel-delegate')),
      (request) => {
        flightCalls += 1;
        request.signal!.addEventListener('abort', () => { sawAbort = true; }, { once: true });
        started();
        return blockedStream(() => { closed += 1; });
      });
    const pending = runTurn(runner, 'stream-client-cancel', { signal: controller.signal });
    await flightStarted;
    const cancelledAt = performance.now();
    const reason = new DOMException('Client disconnected', 'AbortError');
    controller.abort(reason);
    let rejected = false;
    try {
      const { result } = await pending;
      assert.equal(result.cancelled, true);
    } catch (error: any) {
      rejected = true;
      assert.ok(error === reason || error?.name === 'AbortError');
    }
    assert.ok(rejected || controller.signal.aborted);
    assert.ok(performance.now() - cancelledAt < 1_000, 'Cancellation waited for a stream or close to settle.');
    assert.equal(flightCalls, 1);
    assert.equal(sawAbort, true);
    assert.equal(closed, 1);
    assert.equal(networkCalls, 0);
  }));

test('stream retries preserve Manager session history without forwarding it to Flight or duplicating persistence',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    class CountingSession {
      items: any[] = [{ type: 'message', role: 'user', content: 'MANAGER_STREAM_HISTORY_ONLY' }];
      loads = 0;
      writes = 0;
      async getSessionId() { return 'offline-stream-counting-session'; }
      async getItems() { this.loads += 1; return structuredClone(this.items); }
      async addItems(items: any[]) { this.writes += 1; this.items.push(...structuredClone(items)); }
      async popItem() { return this.items.pop(); }
      async clearSession() { this.items = []; }
    }
    async function scenario(retry: boolean) {
      const session = new CountingSession();
      let attempts = 0;
      let flightCalls = 0;
      const inputs: string[] = [];
      const { runner } = makeRunner((request) => {
        if (resultsCount(request) === 0) {
          attempts += 1;
          inputs.push(requestSnapshot(request));
          if (retry && attempts < 3) return blockedStream();
          return complete(toolCall('flight_agent', { input: INPUT }, 'stream-session-delegate'));
        }
        return complete(answer('STREAM_SESSION_FINAL'), 'STREAM_SESSION_FINAL');
      }, (request) => {
        flightCalls += 1;
        assert.doesNotMatch(JSON.stringify(request.input), /MANAGER_STREAM_HISTORY_ONLY/);
        return complete(flightAnswer());
      });
      const result = await runTurn(runner, `stream-session-${retry}`, { session });
      assert.equal(result.result.finalOutput, 'STREAM_SESSION_FINAL');
      assert.match(inputs[0], /MANAGER_STREAM_HISTORY_ONLY/);
      assert.ok(inputs.every((value) => value === inputs[0]));
      assert.equal(flightCalls, 1);
      assert.equal(session.items.filter((item) => item.role === 'user' && JSON.stringify(item.content).includes(INPUT)).length, 1);
      assert.equal(session.items.filter((item) => item.role === 'assistant'
        && JSON.stringify(item.content).includes('STREAM_SESSION_FINAL')).length, 1);
      return { attempts, loads: session.loads, writes: session.writes };
    }
    const baseline = await scenario(false);
    const retried = await scenario(true);
    assert.equal(baseline.attempts, 1);
    assert.equal(retried.attempts, 3);
    assert.equal(baseline.loads, 1);
    assert.equal(retried.loads, baseline.loads);
    assert.equal(retried.writes, baseline.writes);
    assert.equal(networkCalls, 0);
  }));
