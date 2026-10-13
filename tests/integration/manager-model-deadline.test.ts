/** Offline acceptance of per-model deadlines through production Manager -> native asTool. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model, ModelProvider, ModelRequest } from '@openai/agents';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('Network is disabled for model-deadline acceptance tests.');
};

const { Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { FlightAgent, FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { snapshotFlightSearchRuntime } = await import('../../src/agents/flight/context/search-runtime-store.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');
const { getModelResponse, modelDeadlineConfig, ModelDeadlineExhaustedError } = await import('../../src/shared/runtime/model-deadline.js');

const TIMEOUTS = [15, 30, 45] as const;
const MANAGER_MODEL = 'offline-deadline-manager';
const FLIGHT_MODEL = 'offline-deadline-flight';
const NOW = new Date('2026-10-08T10:00:00Z');
const INPUT = 'Find Delhi to London flights on October 20, only nonstop.';
const SUGGESTIONS = ['Show evening departures', 'Include checked baggage', 'Try nearby dates'];

function answer(text: string) {
  return { usage: new Usage(), responseId: 'resp_deadline_answer', output: [{
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
  }] };
}

function flightAnswer(summary = 'Found matching flights.') {
  return answer(JSON.stringify({ status: 'success', completedTask: 'Searched the requested flights',
    summary, findings: [], limitations: [], missingInformation: [], nextStep: null,
    presentation: 'flight_cards_with_price_note' }));
}

function toolCall(name: string, parameters: unknown, id: string) {
  return { usage: new Usage(), responseId: `resp_${id}`, output: [{
    type: 'function_call', name, arguments: JSON.stringify(parameters), callId: id, status: 'completed',
  }] };
}

function searchPayload(origin = 'Delhi', destination = 'London', date = '2026-10-20') {
  return { onds: [{ origin, destination, origin_iata: null, destination_iata: null,
    origin_airport_name: null, destination_airport_name: null,
    outbound_date: date, return_date: null }], trip_type: 'oneway',
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

function snapshot(request: ModelRequest): string {
  // A retry changes only its child signal, never the saved conversation/tools/settings.
  const { signal: _signal, ...rest } = request;
  return JSON.stringify(rest);
}

function neverSettles(): Promise<never> {
  return new Promise(() => {});
}

function makeRunner(manager: (request: ModelRequest) => Promise<any> | any,
  flight: (request: ModelRequest) => Promise<any> | any,
  retryAdvice?: (args: any) => any) {
  const requests: Array<{ agent: string; request: ModelRequest }> = [];
  const provider: ModelProvider = { getModel: (name) => {
    const model: Model = {
      async getResponse(request: ModelRequest) {
        const agent = name === MANAGER_MODEL ? 'manager' : 'flight';
        assert.ok(name === MANAGER_MODEL || name === FLIGHT_MODEL, `Unexpected model: ${name}`);
        requests.push({ agent, request });
        return agent === 'manager' ? manager(request) : flight(request);
      },
      async *getStreamedResponse() { throw new Error('These acceptance runs must remain nonstream.'); },
      getRetryAdvice: retryAdvice,
    };
    return {
      getResponse: (request) => getModelResponse(model, request,
        { ...modelDeadlineConfig, timeoutsMs: TIMEOUTS, initialBackoffMs: 0, maxBackoffMs: 0 }, name),
      getStreamedResponse: model.getStreamedResponse.bind(model),
    };
  } };
  return { requests, runner: new Runner({ modelProvider: provider, tracingDisabled: true,
    modelSettings: { retry: { maxRetries: 0 } },
    toolExecution: { maxFunctionToolConcurrency: 1 } }) };
}

async function withProductionAgents<T>(body: () => Promise<T>): Promise<T> {
  const managerModel = ManagerAgent.model;
  const flightModel = FlightManagerAgent.model;
  // String models exercise provider inheritance; direct Model objects bypass that boundary.
  ManagerAgent.model = MANAGER_MODEL;
  FlightManagerAgent.model = FLIGHT_MODEL;
  try { return await body(); }
  finally { ManagerAgent.model = managerModel; FlightManagerAgent.model = flightModel; }
}

function runTurn(runner: InstanceType<typeof Runner>, id: string, input = INPUT,
  options: { session?: any; signal?: AbortSignal; context?: any } = {}) {
  return runGatewayAgent({ input, requestId: id, sessionId: `session-${id}`, runner,
    now: NOW, timeZone: 'UTC', maxTurns: 8,
    context: options.context || { flight: { uid: id }, toolCallLog: [] },
    session: options.session, signal: options.signal });
}

function exactFlightState(context: any) {
  return structuredClone({ searchKey: context.flight.searchKey, segments: context.flight.segments,
    searchResults: context.flight.searchResults, totalResultsFound: context.flight.totalResultsFound,
    showFlight: context.flight.showFlight, directFlightOnly: context.flight.directFlightOnly,
    suggestedQuestions: context.flight.suggestedQuestions,
    searchRuntime: snapshotFlightSearchRuntime(context.flight.searchKey) });
}

test('managed Flight relinquishes SDK retry/deadline ownership without changing standalone Flight', () => {
  assert.equal(FlightAgent.modelSettings, flightAgentConfig.modelSettings);
  assert.equal(FlightAgent.modelSettings.timeoutMs, flightAgentConfig.modelSettings.timeoutMs);
  assert.ok(Number(FlightAgent.modelSettings.timeoutMs) > 0);
  assert.equal(FlightAgent.modelSettings.retry, flightAgentConfig.modelSettings.retry);
  assert.equal(FlightAgent.modelSettings.retry?.maxRetries, 1);
  assert.equal(FlightManagerAgent.modelSettings.timeoutMs, undefined);
  assert.equal(FlightManagerAgent.modelSettings.retry, undefined);
  const { timeoutMs: _timeout, retry: _retry, ...otherSettings } = FlightAgent.modelSettings;
  assert.deepEqual(FlightManagerAgent.modelSettings, otherSettings);
});

test('first-attempt success uses six model calls and each actual Flight operation once',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    const { runner, requests } = makeRunner(() => ++managerCalls === 1
      ? toolCall('flight_agent', { input: INPUT }, 'first-attempt-delegate') : answer('First-attempt answer.'),
    (request) => {
      switch (resultsCount(request)) {
        case 0: return toolCall('flight_search', searchPayload(), 'first-attempt-search');
        case 1: return toolCall('apply_filter', NONSTOP, 'first-attempt-filter');
        case 2: return toolCall('update_flight_suggested_questions',
          { suggestedQuestions: SUGGESTIONS }, 'first-attempt-suggestions');
        case 3: return flightAnswer();
        default: throw new Error('Unexpected extra model call.');
      }
    });
    const result = await runTurn(runner, 'first-attempt');
    assert.equal(result.output, 'First-attempt answer.');
    assert.equal(requests.filter((entry) => entry.agent === 'manager').length, 2);
    assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 4);
    assert.equal(requests.length, 6);
    assert.deepEqual(result.context.toolCallLog.map((entry: any) => entry.tool),
      ['flight_search', 'apply_filter', 'update_flight_suggested_questions']);
    assert.ok(result.context.toolCallLog.every((entry: any) => entry.ok === true));
    assert.deepEqual(result.context.flight.suggestedQuestions, SUGGESTIONS);
    assert.equal(networkCalls, 0);
  }));

test('progressive retries preserve completed search and run filter/suggestions once through native Flight',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    let failedStepAttempts = 0;
    let lateSettled = 0;
    const aborted: number[] = [];
    const abortedBudgets: number[] = [];
    const retries: string[] = [];
    const retryRequests: ModelRequest[] = [];
    const lateResponses: Promise<unknown>[] = [];
    const { runner, requests } = makeRunner(() => ++managerCalls === 1
      ? toolCall('flight_agent', { input: INPUT }, 'delegate-once') : answer('Here are your nonstop flights.'),
    (request) => {
      const phase = resultsCount(request);
      if (phase === 0) return toolCall('flight_search', searchPayload(), 'search-once');
      if (phase === 1) {
        const attempt = ++failedStepAttempts;
        retries.push(snapshot(request));
        retryRequests.push(request);
        if (attempt < 3) {
          request.signal!.addEventListener('abort', () => {
            aborted.push(attempt);
            abortedBudgets.push(request.signal!.reason.timeoutMs);
          }, { once: true });
          // Ignore abort, then propose a dangerous duplicate search after the deadline.
          const response = new Promise((resolve) => setTimeout(() => {
            lateSettled += 1;
            resolve(toolCall('flight_search', searchPayload('Mumbai', 'New York'), `late-search-${attempt}`));
          }, 120));
          lateResponses.push(response);
          return response;
        }
        return toolCall('apply_filter', NONSTOP, 'filter-once');
      }
      if (phase === 2) return toolCall('update_flight_suggested_questions',
        { suggestedQuestions: SUGGESTIONS }, 'suggestions-once');
      assert.equal(phase, 3);
      return flightAnswer();
    });

    const result = await runTurn(runner, 'progressive-search-filter');
    await Promise.all(lateResponses);
    assert.equal(result.output, 'Here are your nonstop flights.');
    assert.equal(failedStepAttempts, 3);
    assert.deepEqual(aborted, [1, 2]);
    assert.deepEqual(abortedBudgets, [15, 30]);
    assert.equal(new Set(retryRequests.map((request) => request.signal)).size, 3);
    assert.equal(lateSettled, 2);
    assert.ok(retries.every((value) => value === retries[0]));
    assert.ok(retryRequests.every((request) => snapshot(request) === retries[0]),
      'Later accepted responses mutated the saved retry transcript');
    assert.equal(managerCalls, 2);
    assert.equal(requests.filter((call) => call.agent === 'flight').length, 6);
    assert.deepEqual(result.context.toolCallLog.map((entry: any) => entry.tool),
      ['flight_search', 'apply_filter', 'update_flight_suggested_questions']);
    assert.ok(result.context.toolCallLog.every((entry: any) => entry.ok === true));
    assert.equal(result.context.flight.segments[0].origin, 'Delhi');
    assert.equal(result.context.flight.segments[0].destination, 'London');
    assert.equal(result.context.flight.directFlightOnly, true);
    assert.deepEqual(result.context.flight.suggestedQuestions, SUGGESTIONS);
    assert.equal(networkCalls, 0);
  }));

test('post-filter and post-suggestions deadlines preserve exact completed state without replaying tools',
  { timeout: 5_000 }, async (t) => withProductionAgents(async () => {
    for (const scenario of [
      { name: 'recover after filter', phase: 2, exhaust: false },
      { name: 'recover after suggestions', phase: 3, exhaust: false },
      { name: 'exhaust after suggestions', phase: 3, exhaust: true },
    ]) await t.test(scenario.name, async () => {
      const appContext: any = { flight: { uid: scenario.name }, toolCallLog: [] };
      let managerCalls = 0;
      let attempts = 0;
      let savedState: ReturnType<typeof exactFlightState> | undefined;
      let managerFeedback: any;
      const retryInputs: string[] = [];
      const lateResponses: Promise<unknown>[] = [];
      const { runner, requests } = makeRunner((request) => {
        if (++managerCalls === 1) return toolCall('flight_agent', { input: INPUT }, 'post-write-delegate');
        const output: any = Array.isArray(request.input)
          ? request.input.find((item) => item.type === 'function_call_result') : null;
        managerFeedback = flightManagerOutputSchema.parse(JSON.parse(output.output.text));
        return answer('Completed state preserved.');
      }, (request) => {
        const phase = resultsCount(request);
        if (phase === scenario.phase) {
          attempts += 1;
          savedState ||= exactFlightState(appContext);
          retryInputs.push(snapshot(request));
          if (scenario.exhaust) return neverSettles();
          if (attempts < 3) {
            const timedOutAttempt = attempts;
            // Late answers propose removing completed filters; they must never enter the run.
            const reset = { filters: [{ ...NONSTOP.filters[0], filterType: 'reset',
              filterCode: null, rawUserFilter: 'Remove all filters' }] };
            const late = new Promise((resolve) => setTimeout(() =>
              resolve(toolCall('apply_filter', reset, `late-reset-${timedOutAttempt}`)), 120));
            lateResponses.push(late);
            return late;
          }
        }
        if (phase === 0) return toolCall('flight_search', searchPayload(), 'post-write-search');
        if (phase === 1) return toolCall('apply_filter', NONSTOP, 'post-write-filter');
        if (phase === 2) return toolCall('update_flight_suggested_questions',
          { suggestedQuestions: SUGGESTIONS }, 'post-write-suggestions');
        assert.equal(phase, 3);
        return flightAnswer();
      });
      const result = await runTurn(runner, scenario.name, INPUT, { context: appContext });
      await Promise.all(lateResponses);
      assert.equal(attempts, 3);
      assert.ok(retryInputs.every((input) => input === retryInputs[0]));
      assert.equal(requests.filter((entry) => entry.agent === 'manager').length, 2);
      assert.equal(requests.filter((entry) => entry.agent === 'flight').length, 6);
      assert.deepEqual(result.context.toolCallLog.map((entry: any) => entry.tool),
        ['flight_search', 'apply_filter', 'update_flight_suggested_questions']);
      assert.ok(result.context.toolCallLog.every((entry: any) => entry.ok === true));
      assert.deepEqual(exactFlightState(result.context), {
        ...savedState!, suggestedQuestions: SUGGESTIONS,
      });
      assert.equal(managerFeedback.status, scenario.exhaust ? 'partial' : 'success');
      assert.equal(managerFeedback.presentation, 'flight_cards_with_price_note');
      assert.deepEqual(managerFeedback.missingInformation, []);
      assert.equal(result.output, 'Completed state preserved.');
      assert.equal(networkCalls, 0);
    });
  }));

test('three never-settling Flight attempts exhaust without hanging or repeating an accepted search',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    let hungAttempts = 0;
    const { runner } = makeRunner(() => ++managerCalls === 1
      ? toolCall('flight_agent', { input: INPUT }, 'delegate-exhaust')
      : answer('The search results remain available, but I could not finish that request.'),
    (request) => resultsCount(request) === 0
      ? toolCall('flight_search', searchPayload(), 'saved-search')
      : (++hungAttempts, neverSettles()));

    const result = await runTurn(runner, 'never-settling');
    assert.equal(hungAttempts, 3, 'A hidden SDK retry reopened the exhausted model call');
    assert.equal(managerCalls, 2);
    assert.deepEqual(result.context.toolCallLog.map((entry: any) => entry.tool), ['flight_search']);
    assert.ok(result.context.flight.searchKey);
    assert.equal(result.context.flight.showFlight, true);
    assert.deepEqual(result.context.flight.suggestedQuestions, []);
    assert.equal(networkCalls, 0);
  }));

test('client cancellation hard-rejects an uncooperative nested model and never retries',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    const controller = new AbortController();
    let started!: () => void;
    const flightStarted = new Promise<void>((resolve) => { started = resolve; });
    let managerCalls = 0;
    let flightCalls = 0;
    let nestedSawAbort = false;
    const { runner } = makeRunner(() => (++managerCalls,
      toolCall('flight_agent', { input: INPUT }, 'delegate-cancel')), (request) => {
      flightCalls += 1;
      request.signal!.addEventListener('abort', () => { nestedSawAbort = true; }, { once: true });
      started();
      return neverSettles();
    });
    const pending = runTurn(runner, 'client-cancel', INPUT, { signal: controller.signal });
    await flightStarted;
    const reason = new DOMException('Client disconnected', 'AbortError');
    controller.abort(reason);
    await assert.rejects(pending, (error: any) => error === reason || error?.name === 'AbortError');
    assert.equal(nestedSawAbort, true);
    assert.equal(flightCalls, 1);
    assert.equal(managerCalls, 1);
    assert.equal(networkCalls, 0);
  }));

test('client cancellation interrupts an uncooperative async retry classifier after Flight delegation',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    const controller = new AbortController();
    let started!: () => void;
    const classifierStarted = new Promise<void>((resolve) => { started = resolve; });
    let managerCalls = 0;
    let flightCalls = 0;
    let adviceCalls = 0;
    const { runner } = makeRunner(() => {
      if (++managerCalls === 1) return toolCall('flight_agent', { input: INPUT }, 'classifier-delegate');
      throw Object.assign(new Error('Temporary connection failure'), { code: 'ECONNRESET' });
    }, () => (++flightCalls, flightAnswer()), () => {
      adviceCalls += 1;
      started();
      return neverSettles();
    });
    const pending = runTurn(runner, 'classifier-cancel', INPUT, { signal: controller.signal });
    await classifierStarted;
    const cancelledAt = performance.now();
    const reason = new DOMException('Client disconnected during retry classification', 'AbortError');
    controller.abort(reason);
    await assert.rejects(pending, (error: any) => error === reason || error?.name === 'AbortError');
    assert.ok(performance.now() - cancelledAt < 1_000,
      'Cancellation waited for the classifier deadline instead of racing parent abort');
    assert.equal(managerCalls, 2);
    assert.equal(flightCalls, 1);
    assert.equal(adviceCalls, 1);
    assert.equal(networkCalls, 0);
  }));

test('one shared provider keeps concurrent Manager/Flight retry budgets and state isolated',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    const initialAttempts = { A: 0, B: 0 };
    const marker = (request: ModelRequest) => JSON.stringify(request.input).includes('deadline-A') ? 'A' : 'B';
    const { runner } = makeRunner((request) => {
      const key = marker(request);
      return resultsCount(request) === 0
        ? toolCall('flight_agent', { input: `deadline-${key}: ${INPUT}` }, `delegate-${key}`)
        : answer(`Manager ${key}`);
    }, (request) => {
      const key = marker(request);
      const phase = resultsCount(request);
      if (phase === 0) {
        initialAttempts[key] += 1;
        if (initialAttempts[key] < (key === 'A' ? 2 : 3)) return neverSettles();
        return toolCall('flight_search', key === 'A' ? searchPayload()
          : searchPayload('Mumbai', 'New York', '2026-11-05'), `search-${key}`);
      }
      if (phase === 1) return toolCall('update_flight_suggested_questions',
        { suggestedQuestions: SUGGESTIONS }, `suggestions-${key}`);
      return flightAnswer(`Completed ${key}`);
    });
    const results = await Promise.all([
      runTurn(runner, 'concurrent-A', `deadline-A: ${INPUT}`),
      runTurn(runner, 'concurrent-B', `deadline-B: ${INPUT}`),
    ]);
    assert.deepEqual(results.map((result) => result.output), ['Manager A', 'Manager B']);
    assert.deepEqual(initialAttempts, { A: 2, B: 3 });
    assert.equal(results[0].context.flight.segments[0].origin, 'Delhi');
    assert.equal(results[1].context.flight.segments[0].origin, 'Mumbai');
    assert.notEqual(results[0].context.flight.searchKey, results[1].context.flight.searchKey);
    for (const result of results) assert.deepEqual(result.context.toolCallLog.map((entry: any) => entry.tool),
      ['flight_search', 'update_flight_suggested_questions']);
    assert.equal(networkCalls, 0);
  }));

class CountingSession {
  items: any[] = [{ type: 'message', role: 'user', content: 'MANAGER_HISTORY_ONLY' }];
  loads = 0;
  writes = 0;
  async getSessionId() { return 'offline-counting-session'; }
  async getItems() { this.loads += 1; return structuredClone(this.items); }
  async addItems(items: any[]) { this.writes += 1; this.items.push(...structuredClone(items)); }
  async popItem() { return this.items.pop(); }
  async clearSession() { this.items = []; }
}

test('Manager retries neither reload nor duplicate session history and nested Flight stays stateless',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    async function scenario(retry: boolean) {
      const session = new CountingSession();
      let managerAttempts = 0;
      const initialInputs: string[] = [];
      const { runner, requests } = makeRunner((request) => {
        if (resultsCount(request) === 0) {
          managerAttempts += 1;
          initialInputs.push(snapshot(request));
          if (retry && managerAttempts < 3) return neverSettles();
          return toolCall('flight_agent', { input: INPUT }, 'history-delegate');
        }
        return answer('SESSION_FINAL_ANSWER');
      }, (request) => {
        assert.doesNotMatch(JSON.stringify(request.input), /MANAGER_HISTORY_ONLY/);
        return flightAnswer();
      });
      await runTurn(runner, `session-${retry}`, 'SESSION_USER_REQUEST', { session });
      assert.ok(initialInputs.every((input) => input === initialInputs[0]));
      assert.match(initialInputs[0], /MANAGER_HISTORY_ONLY/);
      for (const { request } of requests) {
        assert.equal(request.conversationId, undefined);
        assert.equal(request.previousResponseId, undefined);
      }
      const serialized = JSON.stringify(session.items);
      assert.equal((serialized.match(/SESSION_USER_REQUEST/g) || []).length, 1);
      assert.equal((serialized.match(/SESSION_FINAL_ANSWER/g) || []).length, 1);
      return { loads: session.loads, writes: session.writes, managerAttempts };
    }
    const baseline = await scenario(false);
    const retried = await scenario(true);
    assert.equal(baseline.loads, 1);
    assert.equal(retried.loads, baseline.loads);
    assert.equal(retried.writes, baseline.writes,
      'Model retry added a session write outside native input/final persistence');
    assert.equal(baseline.managerAttempts, 1);
    assert.equal(retried.managerAttempts, 3);
    assert.equal(networkCalls, 0);
  }));

test('stateful Manager requests fail closed on timeout after native Flight delegation',
  { timeout: 5_000 }, async (t) => withProductionAgents(async () => {
    for (const state of [{ conversationId: 'conv_offline' }, { previousResponseId: 'resp_offline' }]) {
      await t.test(Object.keys(state)[0], async () => {
        let managerCalls = 0;
        let flightCalls = 0;
        const { runner } = makeRunner(() => ++managerCalls === 1
          ? toolCall('flight_agent', { input: INPUT }, 'stateful-delegate') : neverSettles(),
        () => (++flightCalls, flightAnswer()));
        const appContext = buildGatewayContext({ context: {}, input: INPUT,
          requestId: 'stateful-deadline', sessionId: 'stateful-session' });
        await assert.rejects(runner.run(ManagerAgent, INPUT, {
          context: createRequestContext(appContext, createRequestClock({ now: NOW, timeZone: 'UTC' })),
          maxTurns: 8, ...state,
        }));
        assert.equal(flightCalls, 1);
        assert.equal(managerCalls, 2, 'An uncertain stateful request was replayed');
      });
    }
    assert.equal(networkCalls, 0);
  }));

test('provider-unsafe accepted errors are never replayed after native Flight delegation',
  { timeout: 5_000 }, async () => withProductionAgents(async () => {
    let managerCalls = 0;
    let flightCalls = 0;
    const unsafe = Object.assign(new Error('The response may already have been accepted'), {
      code: 'ECONNRESET', unsafeToReplay: true, responseStarted: true,
    });
    const { runner } = makeRunner(() => {
      if (++managerCalls === 1) return toolCall('flight_agent', { input: INPUT }, 'unsafe-delegate');
      throw unsafe;
    }, () => (++flightCalls, flightAnswer()));
    await assert.rejects(runTurn(runner, 'unsafe-replay'), (error: any) =>
      error instanceof ModelDeadlineExhaustedError && error.attempts === 1
        && error.reason === 'unsafe_replay' && error.cause === unsafe);
    assert.equal(managerCalls, 2);
    assert.equal(flightCalls, 1);
    assert.equal(networkCalls, 0);
  }));
