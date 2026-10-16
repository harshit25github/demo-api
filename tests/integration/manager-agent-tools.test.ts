import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { MemorySession, MaxTurnsExceededError, RunContext, Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { buildManagerInstructions } = await import('../../src/agents/manager-orchestrator/manager-prompt.js');
const { flightAgentAsTool } = await import('../../src/agents/manager/specialists/flight.js');
const { tripPlannerV2AgentAsTool } = await import('../../src/agents/manager/specialists/trip-planner-v2.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { buildFlightAgentInstructions, FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { createRequestContext, getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext(input = 'Find flights to Dubai and plan my trip', requestId = 'manager-request') {
  return buildGatewayContext({ context: {}, input, requestId, sessionId: 'manager-session' });
}
function sdkContext(appContext: ReturnType<typeof makeContext>) {
  return new RunContext(createRequestContext(appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' })));
}
function modelAnswer(text: string) {
  return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }], responseId: 'resp_manager_test' };
}
function flightAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({ status: 'success', completedTask: 'Searched flights',
    summary: 'Found options.', findings: [], limitations: [], missingInformation: [],
    nextStep: null, presentation: null, ...fields }));
}
async function withModels<T>(managerModel: unknown, flightModel: unknown, body: () => Promise<T>) {
  const originalManager = ManagerAgent.model;
  const originalFlight = FlightManagerAgent.model;
  ManagerAgent.model = managerModel as any;
  FlightManagerAgent.model = flightModel as any;
  try { return await body(); }
  finally { ManagerAgent.model = originalManager; FlightManagerAgent.model = originalFlight; }
}

test('the configured Manager singleton registers only the two implemented specialist tools', () => {
  assert.equal(ManagerAgent.modelSettings.parallelToolCalls, false);
  assert.deepEqual(ManagerAgent.tools, [flightAgentAsTool, tripPlannerV2AgentAsTool]);
  assert.deepEqual(ManagerAgent.tools.map((item) => item.name), ['flight_agent', 'trip_planner_agent']);
  assert.deepEqual(flightAgentAsTool.inputGuardrails?.map((guardrail) => guardrail.name), ['flight_recovery_turn_boundary']);
  assert.deepEqual(flightAgentAsTool.outputGuardrails?.map((guardrail) => guardrail.name), ['flight_recovery_feedback']);
  assert.equal(flightAgentAsTool.timeoutMs, undefined, 'deadlines belong to model calls, not whole Flight tasks');
  assert.deepEqual(tripPlannerV2AgentAsTool.outputGuardrails?.map((guardrail) => guardrail.name), ['trip_v2_typed_feedback']);
  assert.equal(tripPlannerV2AgentAsTool.timeoutErrorFunction, undefined);
});

test('Manager has bounded routing context without render-tag instructions or private card payloads', () => {
  const context = makeContext();
  context.flight.searchResults = [{ id: 'private-flight' }] as any;
  const instructions = buildManagerInstructions({ context: sdkContext(context).context });
  assert.match(instructions, /Generated flight options available: yes/);
  // The request clock Flight uses, so the Manager never resolves dates from its own.
  assert.match(instructions, /Today in the traveler's time zone: 2026-09-19 \(UTC\)/);
  assert.doesNotMatch(buildManagerInstructions({ context: {} }), /Today in the traveler's time zone/);
  assert.match(instructions, /minimum specialist set/);
  assert.match(instructions, /Speak as one helpful travel assistant/);
  assert.match(instructions, /Do not call options cheap, good, or best unless verified facts support that claim/);
  assert.doesNotMatch(instructions, /private-flight|\[\[render:|renderRef/);
  assert.doesNotMatch(instructions, /cheapoair_policy_helper|cheapoair_pages_agent/);
  assert.match(instructions, /Never state, estimate, approximate, or give examples of a policy/);
  assert.match(instructions, /baggage-included, airline, stop, time, price, duration, or layover filter/);
  assert.match(instructions, /A search or filter-only request does not authorize an extra ranking, comparison, or inspection task/);
  assert.match(instructions, /A stated maximum price is a constraint, not a request to find the minimum price/);
  assert.match(instructions, /Do not rewrite a relative-price preference into "sort\/filter the results"/);
  assert.match(instructions, /Keep the operation clause faithful to the traveler's words, expanding references but not enriching the task/);
  assert.match(instructions, /Ordinary search\/filter results already have cards and operation feedback/);
  assert.match(instructions, /Do not expand a city into an enumerated airport group/);
  assert.match(instructions, /selecting departure or arrival airports within the existing route is filter work, not a route change/);
  assert.match(instructions, /Do not rewrite these selections as an instruction to update the search endpoints/);
  assert.match(instructions, /copy that note into the new input, extending it for any further removals or replacements/);
  assert.match(instructions, /This note informs suggestions only; it never authorizes a filter or search operation/);
  assert.match(instructions, /Carry every traveler-relevant limitation into the final reply once/);
  assert.match(instructions, /A flight card's mismatched route or airport code is a traveler-visible warning, not private backend information/);
});

test('a singleton specialist gets scoped input and shared state without replacing the whole turn', async () => {
  const appContext = makeContext();
  const originalInstructions = FlightManagerAgent.instructions;
  let scopedToolInput: unknown;
  let nestedState: unknown;
  let modelInput = '';
  FlightManagerAgent.instructions = ((nested: any) => {
    scopedToolInput = nested.toolInput;
    nestedState = getRequestState(nested.context);
    return typeof originalInstructions === 'function' ? originalInstructions(nested, FlightManagerAgent) : originalInstructions;
  }) as any;
  try {
    await withModels(ManagerAgent.model, { async getResponse(request: any) {
      modelInput = JSON.stringify(request.input); return flightAnswer();
    } }, async () => { await flightAgentAsTool.invoke(sdkContext(appContext),
      JSON.stringify({ input: 'Find Dubai flights for 20 September' })); });
  } finally { FlightManagerAgent.instructions = originalInstructions; }
  assert.match(modelInput, /Find Dubai flights for 20 September/);
  assert.doesNotMatch(modelInput, /plan my trip/);
  assert.deepEqual(scopedToolInput, { input: 'Find Dubai flights for 20 September' });
  assert.equal(nestedState, appContext);
  assert.equal(appContext.currentUserMessage, 'Find flights to Dubai and plan my trip');
});

test('Manager-mode Flight retains its domain intelligence and SDK structured output schema', async () => {
  const appContext = makeContext();
  appContext.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  const instructions = await (FlightManagerAgent.instructions as any)(sdkContext(appContext), FlightManagerAgent);
  assert.match(instructions, /Tool-feedback recovery policy/);
  assert.match(instructions, /getGeneratedContractsContext/);
  assert.match(instructions, /select and show_all change visibility only: they never reorder the underlying result cards/);
  assert.match(instructions, /Manager tool mode/);
  assert.match(instructions, /structured feedback to the Manager/);
  assert.match(instructions, /Current price-prediction route codes: NYC to LON/);
  assert.equal(FlightManagerAgent.outputType, flightManagerOutputSchema);
  assert.doesNotMatch(buildFlightAgentInstructions({ context: sdkContext(appContext).context }), /Manager tool mode/);
});

test('the runner reuses the Manager singleton and forwards the existing session only to its run', async () => {
  const session = new MemorySession();
  const seen: any[] = [];
  const fakeRunner = { async run(agent: unknown, input: unknown, options: any) {
    seen.push({ agent, input, options }); return { finalOutput: `Answered ${input}`, rawResponses: [] };
  } };
  for (const input of ['First request', 'Second request']) {
    const result = await runGatewayAgent({ input, context: makeContext(input), session, runner: fakeRunner as any });
    assert.equal(result.output, `Answered ${input}`);
    assert.equal('specialistsUsed' in result, false);
    assert.equal('renderFlightOptions' in result, false);
  }
  assert.equal(seen[0].agent, ManagerAgent);
  assert.equal(seen[1].agent, ManagerAgent);
  assert.equal(seen[0].options.session, session);
  assert.equal(seen[1].options.session, session);
  assert.notEqual(getRequestState(seen[0].options.context), getRequestState(seen[1].options.context));
});

test('Manager session history stays out of specialist messages while saved context remains visible', async () => {
  const session = new MemorySession();
  await session.addItems([{ type: 'message', role: 'user', content: 'AUDIT_PRIOR_HISTORY_MARKER' }]);
  const appContext = makeContext('Show cheaper ones');
  appContext.flight.outboundDate = '2026-10-20';
  let managerSawHistory = false;
  let flightInput = '';
  let managerCalls = 0;
  const managerModel = { async getResponse(request: any) {
    managerSawHistory ||= JSON.stringify(request.input).includes('AUDIT_PRIOR_HISTORY_MARKER');
    return ++managerCalls === 1 ? { usage: new Usage(), output: [{ type: 'function_call', callId: 'history_call',
      name: 'flight_agent', arguments: JSON.stringify({ input: 'Show cheaper Delhi to New York options on October 20' }),
      status: 'completed' }], responseId: 'resp_history' } : modelAnswer('Here are the cheaper current options.');
  } };
  await withModels(managerModel, { async getResponse(request: any) {
    flightInput = JSON.stringify(request.input);
    assert.match(request.systemInstructions, /2026-10-20/);
    return flightAnswer();
  } }, async () => { await new Runner({ tracingDisabled: true }).run(ManagerAgent, 'Show cheaper ones',
    { context: sdkContext(appContext), session, maxTurns: 6 }); });
  assert.equal(managerSawHistory, true);
  assert.doesNotMatch(flightInput, /AUDIT_PRIOR_HISTORY_MARKER/);
  assert.match(flightInput, /Show cheaper Delhi to New York options on October 20/);
});

test('concurrent runs of the same singleton keep request contexts and scoped inputs isolated', async () => {
  const a = makeContext('Request A full turn', 'request-A');
  const b = makeContext('Request B full turn', 'request-B');
  const nested = new Map<string, any>();
  const originalInstructions = FlightManagerAgent.instructions;
  FlightManagerAgent.instructions = ((runContext: any) => {
    nested.set(runContext.toolInput.input, getRequestState(runContext.context));
    return typeof originalInstructions === 'function' ? originalInstructions(runContext, FlightManagerAgent) : originalInstructions;
  }) as any;
  const managerModel = { async getResponse(request: any) {
    const inputs = request.input as any[];
    const marker = JSON.stringify(inputs.find((item) => item.role === 'user')).includes('Request A') ? 'A' : 'B';
    return inputs.some((item) => item.type === 'function_call_result') ? modelAnswer(`Answer ${marker}`)
      : { usage: new Usage(), output: [{ type: 'function_call', callId: `call_${marker}`, name: 'flight_agent',
        arguments: JSON.stringify({ input: `Flight subtask ${marker}` }), status: 'completed' }], responseId: `resp_${marker}` };
  } };
  const flightModel = { async getResponse(request: any) {
    const marker = JSON.stringify(request.input).includes('Flight subtask A') ? 'A' : 'B';
    await new Promise((resolve) => setTimeout(resolve, marker === 'A' ? 20 : 5));
    const state = nested.get(`Flight subtask ${marker}`);
    assert.equal(state.requestId, `request-${marker}`);
    state.flight.outboundDate = marker === 'A' ? '2026-10-20' : '2026-11-05';
    state.flight.searchResults = [{ id: `private-${marker}` }];
    return flightAnswer({ summary: `Completed ${marker}` });
  } };
  try {
    await withModels(managerModel, flightModel, async () => {
      const runner = new Runner({ tracingDisabled: true });
      const results = await Promise.all([
        runner.run(ManagerAgent, String(a.currentUserMessage), { context: sdkContext(a), maxTurns: 6 }),
        runner.run(ManagerAgent, String(b.currentUserMessage), { context: sdkContext(b), maxTurns: 6 }),
      ]);
      assert.deepEqual(results.map((result) => result.finalOutput), ['Answer A', 'Answer B']);
    });
  } finally { FlightManagerAgent.instructions = originalInstructions; }
  assert.equal(a.flight.outboundDate, '2026-10-20');
  assert.equal(b.flight.outboundDate, '2026-11-05');
  assert.deepEqual(a.flight.searchResults, [{ id: 'private-A' }]);
  assert.deepEqual(b.flight.searchResults, [{ id: 'private-B' }]);
  assert.equal(a.currentUserMessage, 'Request A full turn');
  assert.equal(b.currentUserMessage, 'Request B full turn');
});

test('the Manager run returns its text without rendering metadata', async () => {
  const text = 'Here is your travel answer.';
  const completed = await runGatewayAgent({ input: 'Help with my trip', context: makeContext(),
    runner: { async run(agent: any) {
      assert.equal(agent, ManagerAgent);
      return { finalOutput: text, lastResponseId: 'resp_manager_test', rawResponses: [] };
    } } as any });
  assert.equal(completed.output, text);
  assert.equal(completed.finalAgentName, 'Manager Agent');
  assert.equal('specialistsUsed' in completed, false);
  assert.equal('renderFlightOptions' in completed, false);
});

test('terminal Manager errors propagate without inventing a partial answer', async () => {
  const failure = new MaxTurnsExceededError('Manager turn limit reached');
  await assert.rejects(() => runGatewayAgent({ input: 'Find flights', context: makeContext(),
    runner: { async run() { throw failure; } } as any }), (error: unknown) => error === failure);
});
