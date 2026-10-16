/** Minimal Manager acceptance: native SDK delegation, shared state, persistence, and existing runner errors. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { MaxTurnsExceededError, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { TripPlannerV2Agent } = await import('../../src/agents/trip-planner-v2/agent.js');
const { ApplyFilterTool: ApplyFilterToolDefinition } = await import('../../src/agents/flight/tools/filter/tool.js');
const { createProdFlightContext } = await import('../../src/agents/flight/context/flight-context.js');
const { snapshotGatewayContext, hydrateGatewayContext } = await import('../../src/api/chat/context-hydration.js');
const { getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { tripFeedbackSchema } = await import('../../src/agents/trip-planner-v2/schema.js');

const ApplyFilterTool: any = ApplyFilterToolDefinition;
function makeContext(input: string, seed: Record<string, unknown> = {}) {
  return buildGatewayContext({ context: seed, input, requestId: 'acceptance-request', sessionId: 'acceptance-session' });
}
function modelAnswer(text: string) {
  return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }], responseId: 'resp_acceptance' };
}
function flightAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({ status: 'success', completedTask: 'Searched flights', summary: 'Found options.',
    findings: [], limitations: [], missingInformation: [], nextStep: null, presentation: null, ...fields }));
}
function toolCall(name: string, input: string, callId: string) {
  return { usage: new Usage(), output: [{ type: 'function_call', callId, name,
    arguments: JSON.stringify({ input }), status: 'completed' }], responseId: `resp_${callId}` };
}
async function runManagerTurn({ input, seed = {}, script, flight, trip }: {
  input: string; seed?: Record<string, unknown>; script: (call: number, request: any) => any;
  flight?: (appContext: any) => unknown; trip?: (request: any) => unknown;
}) {
  const appContext = makeContext(input, seed);
  const originalManager = ManagerAgent.model;
  const originalFlight = FlightManagerAgent.model;
  const originalTrip = TripPlannerV2Agent.model;
  const inputs: any[][] = [];
  const order: string[] = [];
  const scopes: Record<string, { toolInput: unknown; state: unknown }> = {};
  const flightStarted = (context: any) => { scopes.flight = { toolInput: context.toolInput, state: getRequestState(context.context) }; };
  const tripStarted = (context: any) => { scopes.trip = { toolInput: context.toolInput, state: getRequestState(context.context) }; };
  FlightManagerAgent.on('agent_start', flightStarted);
  TripPlannerV2Agent.on('agent_start', tripStarted);
  try {
    if (flight) FlightManagerAgent.model = { async getResponse() { order.push('flight_agent'); return flight(appContext); } } as any;
    if (trip) TripPlannerV2Agent.model = { async getResponse(request: any) { order.push('trip_planner_agent'); return trip(request); } } as any;
    ManagerAgent.model = { async getResponse(request: any) { inputs.push(request.input); return script(inputs.length, request); } } as any;
    // Exercise the production Runner and its local concurrency setting.
    const result = await runGatewayAgent({ input, context: appContext, maxTurns: 8,
      requestId: 'acceptance-request', sessionId: 'acceptance-session',
      now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' });
    // Inspect the final Manager model input once, rather than duplicating accumulating tool results.
    const toolResults = inputs.at(-1)!.filter((item: any) => item.type === 'function_call_result')
      .map((item: any) => String(item.output.text));
    return { appContext: result.context, inputs, order, scopes, toolResults, output: result.output };
  } finally {
    FlightManagerAgent.off('agent_start', flightStarted);
    TripPlannerV2Agent.off('agent_start', tripStarted);
    ManagerAgent.model = originalManager; FlightManagerAgent.model = originalFlight; TripPlannerV2Agent.model = originalTrip;
  }
}

const DUBAI_PLAN = {
  status: 'success', intent: 'plan', trip: null, dateHint: null, options: null, facts: null,
  plan: { scope: 'full', removeDays: [], card: { country: 'United Arab Emirates', knownFor: 'Museums and food', bestTime: 'Nov to Mar', cost: '$$' },
    days: [{ day: 1, title: 'Historic Dubai', morning: 'Dubai Creek and local food', afternoon: 'Free time', evening: 'Regional food', places: ['Dubai Creek'] },
      { day: 2, title: 'Culture', morning: 'Museums', afternoon: 'Beaches', evening: 'Regional food', places: [] }] },
  summary: 'Built a 2-day Dubai plan for a 20 October arrival.', findings: [], limitations: [], nextStep: null, suggestions: [],
};

/** Both models must enter before either can finish; the timer only bounds a broken serial configuration. */
function overlapBarrier() {
  let entered = 0;
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  const timer = setTimeout(() => reject(new Error('Both specialists did not start concurrently.')), 2_000);
  return {
    async run<T>(action: () => T | Promise<T>): Promise<T> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered += 1;
      if (entered === 2) { clearTimeout(timer); release(); }
      try { await ready; return await action(); }
      finally { active -= 1; }
    },
    get maxActive() { return maxActive; },
    close() { clearTimeout(timer); release(); },
  };
}

function flightAndTripCalls() {
  const flight = toolCall('flight_agent', 'Find Delhi to Dubai flights on 20 October for 2 adults', 'parallel-flight');
  const trip = toolCall('trip_planner_agent', 'Plan 2 relaxed Dubai days from 20 October for 2 adults within USD 800 total', 'parallel-trip');
  return { ...flight, output: [...flight.output, ...trip.output] };
}

const MIXED_INPUT = 'Find Delhi to Dubai flights on 20 October for 2 adults and plan 2 relaxed days there within USD 800 total.';
const MIXED_SEED = { summaryContext: { destination: { city: 'Dubai', iata: 'DXB' },
  budget: { amount: 800, currency: 'USD', per_person: false }, tripType: ['relaxed'], passengerData: { total: 2, adults: 2 } } };
const PARALLEL_TRIP = { ...DUBAI_PLAN, trip: { origin: null, destination: null,
  outbound_date: '2026-10-20', return_date: null, duration_days: 2, budget: null,
  tripType: null, passengerData: null, clear: [] } };

test('independent Flight and Trip calls overlap through production adapters and retain scoped input and both states', async () => {
  const barrier = overlapBarrier();
  try {
    const result = await runManagerTurn({ input: MIXED_INPUT, seed: MIXED_SEED,
      script: (call) => call === 1 ? flightAndTripCalls() : modelAnswer('Your flights and relaxed Dubai plan are ready.'),
      flight: (state) => barrier.run(() => {
        state.flight.searchKey = 'parallel-search';
        state.flight.searchResults = [{ id: 'parallel-flight-result', display: true }];
        state.flight.totalResultsFound = 1;
        state.flight.showFlight = true;
        state.flight.outboundDate = '2026-10-20';
        return flightAnswer({ presentation: 'flight_cards_with_price_note' });
      }),
      trip: () => barrier.run(() => modelAnswer(JSON.stringify(PARALLEL_TRIP))),
    });
    assert.equal(barrier.maxActive, 2, 'Both actual specialist runs must be active together.');
    assert.deepEqual([...result.order].sort(), ['flight_agent', 'trip_planner_agent']);
    assert.deepEqual(result.scopes.flight.toolInput, { input: 'Find Delhi to Dubai flights on 20 October for 2 adults' });
    assert.deepEqual(result.scopes.trip.toolInput, { input: 'Plan 2 relaxed Dubai days from 20 October for 2 adults within USD 800 total' });
    assert.equal(result.scopes.flight.state, result.appContext);
    assert.equal(result.scopes.trip.state, result.appContext);
    assert.equal(result.appContext.currentUserMessage, MIXED_INPUT);
    assert.equal(result.inputs.length, 2, 'One Manager decision must dispatch both specialists.');
    assert.equal(result.toolResults.length, 2);
    assert.equal(flightManagerOutputSchema.parse(JSON.parse(result.toolResults[0])).status, 'success');
    assert.equal(tripFeedbackSchema.parse(JSON.parse(result.toolResults[1])).saved.plan, 'created');

    const restored = hydrateGatewayContext(snapshotGatewayContext(result.appContext));
    assert.equal(restored.flight.searchKey, 'parallel-search');
    assert.deepEqual(restored.flight.searchResults, [{ id: 'parallel-flight-result', display: true }]);
    assert.equal(restored.flight.showFlight, true);
    assert.equal(restored.flight.outboundDate, '2026-10-20');
    assert.equal((restored.tripPlanner as any).plan.days[0].morning, 'Dubai Creek and local food');
    assert.equal((restored.summaryContext as any).outbound_date, '2026-10-20');
    assert.equal((restored.summaryContext as any).budget.amount, 800);
    assert.deepEqual((restored.summaryContext as any).tripType, ['relaxed']);
    assert.equal((restored.summaryContext as any).passengerData.total, 2);
  } finally { barrier.close(); }
});

test('one parallel specialist failure still lets the independent Trip finish and save its result', async () => {
  const barrier = overlapBarrier();
  try {
    const result = await runManagerTurn({ input: MIXED_INPUT, seed: MIXED_SEED,
      script: (call) => call === 1 ? flightAndTripCalls() : modelAnswer("Your Dubai plan is ready, but I couldn't finish the flight search."),
      flight: () => barrier.run(() => { throw new Error('PRIVATE_FLIGHT_FAILURE'); }),
      trip: () => barrier.run(() => modelAnswer(JSON.stringify(PARALLEL_TRIP))),
    });
    assert.equal(barrier.maxActive, 2);
    assert.equal(result.inputs.length, 2, 'The failed Flight task must not reopen.');
    assert.equal(result.toolResults.length, 2);
    assert.equal(flightManagerOutputSchema.parse(JSON.parse(result.toolResults[0])).status, 'failure');
    assert.equal(tripFeedbackSchema.parse(JSON.parse(result.toolResults[1])).status, 'success');
    assert.equal((result.appContext.tripPlanner as any).plan.days.length, 2);
    assert.equal((result.appContext.summaryContext as any).outbound_date, '2026-10-20');
    assert.equal(result.appContext.currentUserMessage, MIXED_INPUT);
    assert.doesNotMatch(result.toolResults.join('\n') + result.output, /PRIVATE_FLIGHT_FAILURE/);
  } finally { barrier.close(); }
});

test('dependent Flight then Trip delegation is ordered and Trip gets the confirmed flight date in its request', async () => {
  const answer = 'Found two Dubai flights for 20 October. Note: Prices shown are per person.\n\nYour two Dubai days are below.';
  let flightFinished = false;
  const result = await runManagerTurn({ input: 'Find flights to Dubai on 20 October, then plan what to do there',
    seed: { summaryContext: { destination: { city: 'Dubai', iata: 'DXB' }, duration_days: 2 } },
    script: (call, request) => {
      if (call === 1) return toolCall('flight_agent', 'Find flights to Dubai on 20 October', 'c1');
      if (call === 2) {
        assert.equal(flightFinished, true, 'Trip can only be delegated after the prerequisite finishes.');
        const feedback = JSON.parse(request.input.find((item: any) => item.type === 'function_call_result').output.text);
        assert.deepEqual(feedback.findings, ['Outbound date: 2026-10-20']);
        return toolCall('trip_planner_agent', 'Plan Dubai activities for a 20 October arrival', 'c2');
      }
      return modelAnswer(answer);
    },
    flight: (state) => {
      state.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      state.flight.totalResultsFound = 2;
      state.flight.showFlight = true;
      state.flight.outboundDate = '2026-10-20';
      flightFinished = true;
      return flightAnswer({ findings: ['Outbound date: 2026-10-20'], presentation: 'flight_cards_with_price_note' });
    }, trip: (request) => {
      assert.equal(flightFinished, true);
      assert.match(JSON.stringify(request.input), /Plan Dubai activities for a 20 October arrival/);
      return modelAnswer(JSON.stringify(DUBAI_PLAN));
    } });
  assert.deepEqual(result.order, ['flight_agent', 'trip_planner_agent']);
  assert.deepEqual(JSON.parse(result.toolResults[0]).findings, ['Outbound date: 2026-10-20']);
  assert.equal(JSON.parse(result.toolResults[1]).status, 'success');
  assert.equal(JSON.parse(result.toolResults[1]).presentation, 'trip_plan');
  assert.equal((result.appContext.tripPlanner as any).plan.days[0].morning, 'Dubai Creek and local food');
  assert.equal(result.output, answer);
  assert.equal(result.appContext.flight.showFlight, true);
  assert.doesNotMatch(result.output, /\[\[render:|renderRef/);
});

test('filter clearing uses the scoped subtask rather than the whole mixed turn', async () => {
  let sequence = 0;
  const filterContext = () => ({ requestId: 'acceptance-request', sessionId: 'acceptance-session', toolCallLog: [],
    currentUserMessage: 'Remove all filters and plan my Dubai trip',
    flight: createProdFlightContext({ flight: { uid: 'acceptance-user', searchKey: `search-acceptance-${++sequence}`,
      searchResults: [] } }) });
  const suppliedFilter = { filterType: 'stops', filterCode: '0', minDurationMinutes: null, maxDurationMinutes: null,
    minPrice: null, maxPrice: null, airlineNames: null, layoverAirportNames: null,
    departureAirportNames: null, arrivalAirportNames: null, rawUserFilter: null };
  const parse = (value: unknown): any => typeof value === 'string' ? JSON.parse(value) : value;
  const scoped = parse(await ApplyFilterTool.invoke({ context: filterContext(), toolInput: { input: 'Remove all filters' } },
    JSON.stringify({ filters: [suppliedFilter] }), {}));
  assert.match(JSON.stringify(scoped), /reset/);
  const narrow = parse(await ApplyFilterTool.invoke({ context: filterContext(), toolInput: { input: 'Show nonstop flights only' } },
    JSON.stringify({ filters: [suppliedFilter] }), {}));
  assert.doesNotMatch(JSON.stringify(narrow.finalFilterPayload ?? narrow), /"filterType":"reset"/);
});

test('a second turn preserves hydrated route, dates, and result context without a text-driven render decision', async () => {
  const first = await runManagerTurn({ input: 'Find flights to Dubai',
    script: (call) => call === 1 ? toolCall('flight_agent', 'Find flights to Dubai', 'c1') : modelAnswer('Found two flights.'),
    flight: (state) => {
      state.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      state.flight.totalResultsFound = 2; state.flight.showFlight = true;
      state.flight.outboundDate = '2026-10-20';
      return flightAnswer({ presentation: 'flight_cards_with_price_note' });
    } });
  const second = await runManagerTurn({ input: 'What date did you find?',
    seed: hydrateGatewayContext(snapshotGatewayContext(first.appContext)) as any,
    script: () => modelAnswer('The options are for 20 October.') });
  assert.equal(second.appContext.flight.outboundDate, '2026-10-20');
  assert.ok(Array.isArray(second.appContext.flight.searchResults));
  assert.equal(second.appContext.flight.searchResults.length, 2);
  assert.deepEqual(second.order, []);
  assert.equal(second.output, 'The options are for 20 October.');
  assert.doesNotMatch(second.output, /Prices shown are per person|\[\[render:/);
});

test('client cancellation remains a terminal error', async () => {
  const controller = new AbortController();
  await assert.rejects(() => runGatewayAgent({ input: 'Find flights', context: makeContext('Find flights'), signal: controller.signal,
    runner: { async run(_agent: unknown, _input: unknown, options: any) {
      controller.abort(); options.signal.throwIfAborted(); return { finalOutput: 'unused' };
    } } as any }));
});

test('Manager max-turn errors remain terminal without recovery composition', async () => {
  const failure = new MaxTurnsExceededError('Manager turn limit reached');
  await assert.rejects(() => runGatewayAgent({ input: 'Find flights', context: makeContext('Find flights'),
    runner: { async run() { throw failure; } } as any }), (error: unknown) => error === failure);
});
