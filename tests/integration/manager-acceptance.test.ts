/** Minimal Manager acceptance: native SDK delegation, shared state, persistence, and existing runner errors. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { MaxTurnsExceededError, RunContext, Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { TripPlannerV2Agent } = await import('../../src/agents/trip-planner-v2/agent.js');
const { ApplyFilterTool: ApplyFilterToolDefinition } = await import('../../src/agents/flight/tools/filter/tool.js');
const { createProdFlightContext } = await import('../../src/agents/flight/context/flight-context.js');
const { snapshotGatewayContext, hydrateGatewayContext } = await import('../../src/api/chat/context-hydration.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

const ApplyFilterTool: any = ApplyFilterToolDefinition;
function makeContext(input: string, seed: Record<string, unknown> = {}) {
  return buildGatewayContext({ context: seed, input, requestId: 'acceptance-request', sessionId: 'acceptance-session' });
}
function sdkContext(appContext: object) {
  return new RunContext(createRequestContext(appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' })));
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
  input: string; seed?: Record<string, unknown>; script: (call: number) => any;
  flight?: (appContext: any) => unknown; trip?: (request: any) => unknown;
}) {
  const appContext = makeContext(input, seed);
  const originalManager = ManagerAgent.model;
  const originalFlight = FlightManagerAgent.model;
  const originalTrip = TripPlannerV2Agent.model;
  const inputs: any[][] = [];
  const order: string[] = [];
  try {
    if (flight) FlightManagerAgent.model = { async getResponse() { order.push('flight_agent'); return flight(appContext); } } as any;
    if (trip) TripPlannerV2Agent.model = { async getResponse(request: any) { order.push('trip_planner_agent'); return trip(request); } } as any;
    ManagerAgent.model = { async getResponse(request: any) { inputs.push(request.input); return script(inputs.length); } } as any;
    const result = await new Runner({ tracingDisabled: true, toolExecution: { maxFunctionToolConcurrency: 1 } })
      .run(ManagerAgent, input, { context: sdkContext(appContext), maxTurns: 8 });
    // Inspect the final Manager model input once, rather than duplicating accumulating tool results.
    const toolResults = inputs.at(-1)!.filter((item: any) => item.type === 'function_call_result')
      .map((item: any) => String(item.output.text));
    return { appContext, inputs, order, toolResults, output: String(result.finalOutput) };
  } finally { ManagerAgent.model = originalManager; FlightManagerAgent.model = originalFlight; TripPlannerV2Agent.model = originalTrip; }
}

const DUBAI_PLAN = {
  status: 'success', intent: 'plan', trip: null, dateHint: null, options: null, facts: null,
  plan: { scope: 'full', removeDays: [], card: { country: 'United Arab Emirates', knownFor: 'Museums and food', bestTime: 'Nov to Mar', cost: '$$' },
    days: [{ day: 1, title: 'Historic Dubai', morning: 'Dubai Creek and local food', afternoon: 'Free time', evening: 'Regional food', places: ['Dubai Creek'] },
      { day: 2, title: 'Culture', morning: 'Museums', afternoon: 'Beaches', evening: 'Regional food', places: [] }] },
  summary: 'Built a 2-day Dubai plan for a 20 October arrival.', findings: [], limitations: [], nextStep: null, suggestions: [],
};

test('dependent Flight then Trip delegation is ordered and Trip gets the confirmed flight date in its request', async () => {
  const answer = 'Found two Dubai flights for 20 October. Note: Prices shown are per person.\n\nYour two Dubai days are below.';
  const result = await runManagerTurn({ input: 'Find flights to Dubai on 20 October, then plan what to do there',
    seed: { summaryContext: { destination: { city: 'Dubai', iata: 'DXB' }, duration_days: 2 } },
    script: (call) => call === 1 ? toolCall('flight_agent', 'Find flights to Dubai on 20 October', 'c1')
      : call === 2 ? toolCall('trip_planner_agent', 'Plan Dubai activities for a 20 October arrival', 'c2') : modelAnswer(answer),
    flight: (state) => {
      state.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      state.flight.totalResultsFound = 2;
      state.flight.showFlight = true;
      state.flight.outboundDate = '2026-10-20';
      return flightAnswer({ findings: ['Outbound date: 2026-10-20'], presentation: 'flight_cards_with_price_note' });
    }, trip: (request) => {
      assert.match(JSON.stringify(request.input), /Plan Dubai activities for a 20 October arrival/);
      return modelAnswer(JSON.stringify(DUBAI_PLAN));
    } });
  assert.deepEqual(result.order, ['flight_agent', 'trip_planner_agent']);
  assert.deepEqual(JSON.parse(result.toolResults[0]).findings, ['Outbound date: 2026-10-20']);
  assert.equal(JSON.parse(result.toolResults[1]).status, 'success');
  assert.equal(JSON.parse(result.toolResults[1]).presentation, 'trip_plan');
  assert.equal(result.appContext.tripPlanner.plan.days[0].morning, 'Dubai Creek and local food');
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
