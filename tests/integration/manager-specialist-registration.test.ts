/** Native singleton specialist registrations, driven through the actual SDK with stubbed models. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { RunContext, Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { tripPlannerAgentAsTool } = await import('../../src/agents/manager/tools.js');
const { TripPlannerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { createRequestContext, getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext(input = 'Plan my Dubai trip', requestId = 'manager-request') {
  return buildGatewayContext({ context: {}, input, requestId, sessionId: 'manager-session' });
}
function sdkContext(appContext: ReturnType<typeof makeContext>) {
  return new RunContext(createRequestContext(appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' })));
}
function modelAnswer(text: string) {
  return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }], responseId: 'resp_specialist' };
}

async function runTripTurn(plan: string, managerText = 'Here is your plan.') {
  const appContext = makeContext();
  const originalManager = ManagerAgent.model;
  const originalTrip = TripPlannerAgent.model;
  const managerInputs: string[] = [];
  try {
    TripPlannerAgent.model = { async getResponse() { return modelAnswer(plan); } } as any;
    ManagerAgent.model = { async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      return managerInputs.length === 1 ? { usage: new Usage(), output: [{ type: 'function_call',
        callId: 'call_trip', name: 'trip_planner_agent',
        arguments: JSON.stringify({ input: 'Plan 3 days in Dubai' }), status: 'completed' }], responseId: 'resp_manager' }
        : modelAnswer(managerText);
    } } as any;
    const result = await new Runner({ tracingDisabled: true }).run(ManagerAgent, 'Plan my Dubai trip',
      { context: sdkContext(appContext), maxTurns: 6 });
    const seen = JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result');
    return { appContext, toolOutput: String(seen.output.text), output: String(result.finalOutput) };
  } finally { ManagerAgent.model = originalManager; TripPlannerAgent.model = originalTrip; }
}

test('Trip Planner receives its scoped task and returns full plan text without a render-reference wrapper', async () => {
  const plan = 'Day 1: Dubai Creek.\nDay 2: Desert safari.\nDay 3: Museum of the Future.';
  const { appContext, toolOutput, output } = await runTripTurn(plan, plan);
  assert.equal(appContext.tripPlanner.currentUserMessage, 'Plan 3 days in Dubai');
  assert.equal((appContext.tripPlanner.turnState as any).requestId, 'manager-request');
  assert.equal(typeof (appContext.tripPlanner.turnState as any).baseRevision, 'number');
  assert.equal(toolOutput, plan);
  assert.equal(output, plan);
  assert.doesNotMatch(toolOutput, /renderRef|\[\[render:/);
  assert.equal((appContext.tripPlanner.lastPlanArtifact as any).content, plan.replace(/\s+/g, ' '));
});

test('Trip scope policy sanitizes returned text before the Manager sees it or a plan is stored', async () => {
  const { appContext, toolOutput } = await runTripTurn(
    'Day 1: Dubai Creek.\nBook a hotel near the Marina and take a taxi there.');
  assert.doesNotMatch(toolOutput, /hotel|taxi/i);
  assert.equal((appContext as any).tripPlannerScopeGuardrail.applied, true);
  assert.equal((appContext as any).tripPlannerScopeGuardrail.changed, true);
  assert.equal(appContext.tripPlanner.lastPlanArtifact, undefined);
});

test('in-scope Trip output is returned unchanged and persisted using the existing compact artifact format', async () => {
  const plan = 'Day 1: Dubai Creek.\nDay 2: museums and local food.';
  const { appContext, toolOutput } = await runTripTurn(plan);
  assert.equal(toolOutput, plan);
  assert.equal((appContext as any).tripPlannerScopeGuardrail.changed, false);
  assert.equal((appContext.tripPlanner.lastPlanArtifact as any).content, plan.replace(/\s+/g, ' '));
});

test('the singleton Trip tool prepares and finalizes each invocation using that invocation context', async () => {
  const a = makeContext('Flight and trip A', 'trip-request-A');
  const b = makeContext('Flight and trip B', 'trip-request-B');
  const states = new Map<string, any>();
  const originalModel = TripPlannerAgent.model;
  const originalInstructions = TripPlannerAgent.instructions;
  TripPlannerAgent.instructions = ((nested: any) => {
    const state = getRequestState(nested.context) as any;
    states.set(nested.toolInput.input, state);
    assert.equal(state.tripPlanner.currentUserMessage, nested.toolInput.input);
    return typeof originalInstructions === 'function' ? originalInstructions(nested, TripPlannerAgent) : originalInstructions;
  }) as any;
  TripPlannerAgent.model = { async getResponse(request: any) {
    const marker = JSON.stringify(request.input).includes('Plan Dubai A') ? 'A' : 'B';
    await new Promise((resolve) => setTimeout(resolve, marker === 'A' ? 20 : 5));
    assert.equal(states.get(`Plan Dubai ${marker}`).tripPlanner.turnState.requestId, `trip-request-${marker}`);
    return modelAnswer(`Day 1: Dubai museums ${marker}.`);
  } } as any;
  try {
    const outputs = await Promise.all([
      tripPlannerAgentAsTool.invoke(sdkContext(a), JSON.stringify({ input: 'Plan Dubai A' })),
      tripPlannerAgentAsTool.invoke(sdkContext(b), JSON.stringify({ input: 'Plan Dubai B' })),
    ]);
    assert.deepEqual(outputs, ['Day 1: Dubai museums A.', 'Day 1: Dubai museums B.']);
  } finally { TripPlannerAgent.model = originalModel; TripPlannerAgent.instructions = originalInstructions; }
  assert.equal((a.tripPlanner.lastPlanArtifact as any).content, 'Day 1: Dubai museums A.');
  assert.equal((b.tripPlanner.lastPlanArtifact as any).content, 'Day 1: Dubai museums B.');
  assert.equal(a.currentUserMessage, 'Flight and trip A');
  assert.equal(b.currentUserMessage, 'Flight and trip B');
});
