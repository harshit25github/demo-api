/** Native singleton registrations, exercised with scripted models and real application tools. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { RunContext, Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { TripPlannerManagerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { createRequestContext, getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');
const { tripFeedback, tripManagerModel } = await import('../helpers/trip-manager.js');

function makeContext(input = 'Plan my Dubai trip', requestId = 'manager-request') {
  return buildGatewayContext({ context: { summaryContext: { destination: { city: 'Dubai', iata: 'DXB' }, duration_days: 3 } },
    input, requestId, sessionId: 'manager-session' });
}
function sdkContext(appContext: ReturnType<typeof makeContext>) {
  return new RunContext(createRequestContext(appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' })));
}
function modelAnswer(text: string) {
  return { usage: new Usage(), responseId: 'resp_specialist', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }] };
}
function tripFacts(context: any, morning = 'Dubai Creek') {
  return tripFeedback(context, { destinationCards: [{ itemCode: 'DXB', title: 'Dubai, UAE',
    imageUrl: context.tripPlanner.placeImageCache.DXB.imageUrl, knownFor: 'Museums and food', weather: 'Warm season', budget: 'Activities budget' }],
    itineraryDays: Array.from({ length: 3 }, (_, index) => ({ day: index + 1, title: `Theme ${index + 1}`,
      morning: index ? `Museums ${index + 1}` : morning, afternoon: 'Free time', evening: 'Regional food' })) });
}

async function runTripTurn(morning = 'Dubai Creek') {
  const appContext = makeContext();
  const originalManager = ManagerAgent.model;
  const originalTrip = TripPlannerManagerAgent.model;
  const managerInputs: string[] = [];
  try {
    TripPlannerManagerAgent.model = tripManagerModel(() => appContext, (state) => tripFacts(state, morning), ['DXB']) as any;
    ManagerAgent.model = { async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      return managerInputs.length === 1 ? { usage: new Usage(), responseId: 'resp_manager', output: [{ type: 'function_call',
        callId: 'call_trip', name: 'trip_planner_agent', arguments: JSON.stringify({ input: 'Plan 3 days in Dubai' }), status: 'completed' }] }
        : modelAnswer('Here is your Dubai plan.');
    } } as any;
    const result = await new Runner({ tracingDisabled: true }).run(ManagerAgent, 'Plan my Dubai trip',
      { context: sdkContext(appContext), maxTurns: 8 });
    const seen = JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result');
    return { appContext, toolOutput: JSON.parse(seen.output.text), output: String(result.finalOutput) };
  } finally { ManagerAgent.model = originalManager; TripPlannerManagerAgent.model = originalTrip; }
}

test('Trip receives scoped input and returns typed planning facts without a rendering wrapper', async () => {
  const { appContext, toolOutput, output } = await runTripTurn();
  assert.equal(appContext.tripPlanner.currentUserMessage, 'Plan 3 days in Dubai');
  assert.equal((appContext.tripPlanner.turnState as any).requestId, 'manager-request');
  assert.equal(toolOutput.status, 'success');
  assert.equal(toolOutput.mode, 'compact_full');
  assert.equal(toolOutput.itineraryDays[0].morning, 'Dubai Creek');
  assert.equal(output, 'Here is your Dubai plan.');
  assert.doesNotMatch(JSON.stringify(toolOutput), /renderRef|\[\[render:/);
  assert.equal((appContext.tripPlanner.lastPlanArtifact as any).days.length, 3);
});

test('scope-unsafe Trip facts become controlled capability feedback before Manager or persistence', async () => {
  const { appContext, toolOutput } = await runTripTurn('Book a hotel near the Marina and take a taxi there');
  assert.equal(toolOutput.status, 'failure');
  assert.equal(toolOutput.mode, 'answer');
  assert.equal(toolOutput.itineraryDays.length, 0);
  assert.ok(toolOutput.notes.some((note: any) => note.kind === 'capability'));
  assert.doesNotMatch(JSON.stringify(toolOutput), /hotel|taxi/i);
  assert.equal((appContext as any).tripPlannerScopeGuardrail.changed, true);
  assert.equal(appContext.tripPlanner.lastPlanArtifact, undefined);
});

test('saved Trip artifact contains planning facts, not Manager prose or the feedback envelope', async () => {
  const { appContext, toolOutput } = await runTripTurn();
  assert.equal(toolOutput.itineraryDays[0].morning, 'Dubai Creek');
  const artifact = appContext.tripPlanner.lastPlanArtifact as any;
  assert.match(artifact.content, /Dubai Creek/);
  assert.doesNotMatch(artifact.content, /Here is your Dubai plan|formattingRules|"status"/);
  assert.equal((appContext as any).tripPlannerScopeGuardrail.changed, false);
});

test('concurrent singleton Manager -> Trip invocations keep scoped facts and persistence isolated', async () => {
  const a = makeContext('Flight and trip A', 'trip-request-A');
  const b = makeContext('Flight and trip B', 'trip-request-B');
  const states = new Map<string, any>();
  const originalManager = ManagerAgent.model;
  const originalModel = TripPlannerManagerAgent.model;
  const originalInstructions = TripPlannerManagerAgent.instructions;
  TripPlannerManagerAgent.instructions = ((nested: any) => {
    const state = getRequestState(nested.context) as any;
    states.set(nested.toolInput.input, state);
    assert.equal(state.tripPlanner.currentUserMessage, nested.toolInput.input);
    return typeof originalInstructions === 'function' ? originalInstructions(nested, TripPlannerManagerAgent) : originalInstructions;
  }) as any;
  TripPlannerManagerAgent.model = tripManagerModel((request) => {
    const marker = JSON.stringify(request.input).includes('Plan Dubai A') ? 'A' : 'B';
    return states.get(`Plan Dubai ${marker}`);
  }, (state) => {
    const marker = state.requestId.endsWith('A') ? 'A' : 'B';
    return tripFacts(state, `Dubai museums ${marker}`);
  }, ['DXB']) as any;
  ManagerAgent.model = { async getResponse(request: any) {
    const marker = JSON.stringify(request.input).includes('Flight and trip A') ? 'A' : 'B';
    const result = request.input.find((item: any) => item.type === 'function_call_result');
    if (result) {
      assert.equal(JSON.parse(result.output.text).itineraryDays[0].morning, `Dubai museums ${marker}`);
      return modelAnswer(`Dubai plan ${marker}`);
    }
    return { usage: new Usage(), responseId: `resp_${marker}`, output: [{ type: 'function_call', callId: `call_${marker}`,
      name: 'trip_planner_agent', arguments: JSON.stringify({ input: `Plan Dubai ${marker}` }), status: 'completed' }] };
  } } as any;
  try {
    const runner = new Runner({ tracingDisabled: true });
    const results = await Promise.all([runner.run(ManagerAgent, 'Flight and trip A', { context: sdkContext(a), maxTurns: 8 }),
      runner.run(ManagerAgent, 'Flight and trip B', { context: sdkContext(b), maxTurns: 8 })]);
    assert.deepEqual(results.map((result) => result.finalOutput), ['Dubai plan A', 'Dubai plan B']);
  } finally {
    ManagerAgent.model = originalManager;
    TripPlannerManagerAgent.model = originalModel;
    TripPlannerManagerAgent.instructions = originalInstructions;
  }
  assert.match((a.tripPlanner.lastPlanArtifact as any).content, /Dubai museums A/);
  assert.doesNotMatch((a.tripPlanner.lastPlanArtifact as any).content, /Dubai museums B/);
  assert.match((b.tripPlanner.lastPlanArtifact as any).content, /Dubai museums B/);
  assert.equal(a.currentUserMessage, 'Flight and trip A');
  assert.equal(b.currentUserMessage, 'Flight and trip B');
});
