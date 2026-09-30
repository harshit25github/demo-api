/**
 * Behavior of the PRODUCTION specialist tools when driven by a real Runner.
 *
 * `tool.invoke()` called directly skips guardrails and the tool timeout, because
 * both are enforced by the runner. These tests therefore go through
 * `Runner.run()` with a stubbed Manager model, which is the only way to observe
 * what the Manager actually sees.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Agent, RunContext, Runner, Usage } = await import('@openai/agents');
const { createManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
  GENERIC_SPECIALIST_FAILURE,
} = await import('../../src/agents/manager/tools.js');
const { TripPlannerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext(input = 'Plan my Dubai trip') {
  return buildGatewayContext({
    context: {},
    input,
    requestId: 'manager-request',
    sessionId: 'manager-session',
  });
}

function sdkContext(appContext: ReturnType<typeof makeContext>) {
  return new RunContext(createRequestContext(
    appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' }),
  ));
}

function modelAnswer(text: string) {
  return {
    usage: new Usage(),
    output: [{
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    responseId: 'resp_specialist',
  };
}

/**
 * Drive one Manager turn that calls `trip_planner_agent` once, with the Trip
 * Planner's model replaced by `tripModel`. Returns what the Manager saw.
 */
async function runTripTurn(tripModel: unknown, { managerText = 'Here is your plan.\n' } = {}) {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const originalModel = (TripPlannerAgent as any).model;
  const managerInputs: string[] = [];

  try {
    (TripPlannerAgent as any).model = tripModel;

    let managerCalls = 0;
    const managerModel: any = {
      async getResponse(request: any) {
        managerCalls += 1;
        managerInputs.push(JSON.stringify(request.input));
        if (managerCalls === 1) {
          return {
            usage: new Usage(),
            output: [{
              type: 'function_call', callId: 'call_trip', name: 'trip_planner_agent',
              arguments: JSON.stringify({ input: 'Plan 3 days in Dubai' }), status: 'completed',
            }],
            responseId: 'resp_manager_1',
          };
        }
        // The Manager writes its own lead-in and places the render reference.
        const ref = [...state.renders.keys()][0];
        return modelAnswer(ref ? `${managerText}[[render:${ref}]]` : managerText);
      },
    };

    const manager = createManagerAgent(createManagerTools(state)).clone({ model: managerModel });
    const result = await new Runner({ model: managerModel, tracingDisabled: true }).run(
      manager, 'Plan my Dubai trip',
      { context: sdkContext(appContext), maxTurns: 6 },
    );

    const toolResultSeenByManager = managerInputs[1]
      ? JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result')
      : null;

    return {
      state,
      appContext,
      managerInputs,
      toolOutput: String(toolResultSeenByManager?.output?.text ?? ''),
      composed: finalizeManagerOutput(String(result.finalOutput), state),
    };
  } finally {
    (TripPlannerAgent as any).model = originalModel;
  }
}

test('Trip Planner runs as a direct agent tool: compact result out, plan text rendered once', async () => {
  const plan = 'Day 1: Dubai Creek.\nDay 2: Desert safari.\nDay 3: Museum of the Future.';
  const { state, appContext, toolOutput, composed } = await runTripTurn({
    async getResponse() { return modelAnswer(plan); },
  });

  // The subtask, not the whole turn, scoped the Trip turn.
  assert.equal((appContext as any).tripPlanner.currentUserMessage, 'Plan 3 days in Dubai');
  assert.equal((appContext as any).tripPlanner.turnState.requestId, 'manager-request');

  // The Manager sees a compact result and never the itinerary body.
  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.ok(parsed.renderRef, 'expected a renderRef in the model-facing result');
  assert.doesNotMatch(toolOutput, /Desert safari/, 'plan text leaked into the Manager context');
  assert.ok(toolOutput.length < 250, `model-facing result too large: ${toolOutput.length}`);

  // Exactly one outcome, and the plan appears exactly once in the final answer.
  assert.deepEqual(state.outcomes.map((item) => item.name), ['trip_planner_agent']);
  assert.equal(composed.output.match(/Day 1: Dubai Creek/g)?.length, 1);
  assert.equal(composed.output.match(/Desert safari/g)?.length, 1);
  assert.deepEqual(composed.specialistsUsed, ['trip_planner_agent']);
});

test('a failed Trip Planner run reaches the Manager as one generic line', async () => {
  const { state, toolOutput, composed } = await runTripTurn({
    async getResponse() { throw new Error('TRIP_INTERNAL_DETAIL_SHOULD_NOT_LEAK'); },
  }, { managerText: "I couldn't put the plan together.\n" });

  // The output guardrail replaced the SDK's error text.
  assert.equal(toolOutput, GENERIC_SPECIALIST_FAILURE);
  assert.doesNotMatch(toolOutput, /TRIP_INTERNAL_DETAIL_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(toolOutput, /An error occurred while running the tool/);

  // The guardrail also recorded the failure, so composition still knows the
  // specialist ran and produced nothing renderable.
  assert.deepEqual(state.outcomes.map((item) => item.name), ['trip_planner_agent']);
  assert.equal(state.outcomes[0].result.status, 'failure');
  assert.equal(state.outcomes[0].result.recovery?.code, 'SPECIALIST_FAILED');
  assert.equal(state.outcomes[0].input, 'Plan 3 days in Dubai');
  assert.equal(state.renders.size, 0);
  assert.equal(composed.renderFlightOptions, false);
});

test('a Trip Planner overrun becomes one failed tool call, not a failed turn', async () => {
  const tripTool: any = createManagerTools(
    createManagerTurnState(makeContext(), 'manager-request'),
  ).find((item: any) => item.name === 'trip_planner_agent');

  // The production budget is configured, and an overrun is a result rather than
  // an exception so the Manager can still answer around it.
  assert.equal(typeof tripTool.timeoutMs, 'number');
  assert.ok(tripTool.timeoutMs > 0);
  assert.equal(tripTool.timeoutBehavior, 'error_as_result');

  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const originalModel = (TripPlannerAgent as any).model;
  try {
    (TripPlannerAgent as any).model = {
      async getResponse() {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return modelAnswer('too late');
      },
    };

    const tools = createManagerTools(state);
    const trip: any = tools.find((item: any) => item.name === 'trip_planner_agent');
    // Shorten the real budget so the test does not wait 120 seconds.
    trip.timeoutMs = 40;

    const managerInputs: string[] = [];
    let managerCalls = 0;
    const managerModel: any = {
      async getResponse(request: any) {
        managerCalls += 1;
        managerInputs.push(JSON.stringify(request.input));
        return managerCalls === 1
          ? {
            usage: new Usage(),
            output: [{
              type: 'function_call', callId: 'call_trip', name: 'trip_planner_agent',
              arguments: JSON.stringify({ input: 'Plan 3 days in Dubai' }), status: 'completed',
            }],
            responseId: 'resp_manager_1',
          }
          : modelAnswer('I could not finish the plan in time.');
      },
    };

    const manager = createManagerAgent(tools).clone({ model: managerModel });
    const result = await new Runner({ model: managerModel, tracingDisabled: true }).run(
      manager, 'Plan my Dubai trip',
      { context: sdkContext(appContext), maxTurns: 6 },
    );

    // The run completed: the timeout did not propagate as a run failure.
    assert.equal(String(result.finalOutput), 'I could not finish the plan in time.');
    const toolResult = JSON.parse(managerInputs[1])
      .find((item: any) => item.type === 'function_call_result');
    assert.match(String(toolResult?.output?.text), /couldn.{0,3}t finish that part/);

    assert.equal(state.outcomes.length, 1);
    assert.equal(state.outcomes[0].result.recovery?.code, 'SPECIALIST_TIMEOUT');
  } finally {
    (TripPlannerAgent as any).model = originalModel;
  }
});

test('Trip Planner scope filtering still applies before the plan is stored', async () => {
  // `accommodation` is one of the Trip Planner's prohibited categories, so this
  // output must not survive into the stored render text.
  const { state, toolOutput } = await runTripTurn({
    async getResponse() {
      return modelAnswer('Day 1: Dubai Creek.\nBook a hotel near the Marina and take a taxi there.');
    },
  });

  const parsed = JSON.parse(toolOutput);
  assert.ok(parsed.renderRef, 'expected a renderRef');
  const stored = String(state.renders.get(parsed.renderRef));
  assert.doesNotMatch(stored, /hotel|taxi/i, 'prohibited content survived scope filtering');
  assert.equal((state.appContext as any).tripPlannerScopeGuardrail?.applied, true);
  assert.equal((state.appContext as any).tripPlannerScopeGuardrail?.changed, true);

  // A replaced plan is reported as partial, not success.
  assert.equal(parsed.status, 'partial');
  assert.equal(state.outcomes[0].result.status, 'partial');
});

test('an in-scope plan is stored unchanged and reported as success', async () => {
  const { state, toolOutput } = await runTripTurn({
    async getResponse() {
      return modelAnswer('Day 1: Dubai Creek.\nDay 2: museums and local food.');
    },
  });

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.equal((state.appContext as any).tripPlannerScopeGuardrail?.changed, false);
  assert.match(String(state.renders.get(parsed.renderRef)), /museums and local food/);
});

test('Manager registers Flight and Trip Planner, and only those', async () => {
  const state = createManagerTurnState(makeContext(), 'manager-request');
  const names = createManagerTools(state).map((item: any) => item.name);
  assert.deepEqual(names, ['flight_agent', 'trip_planner_agent']);

  const trip: any = createManagerTools(state).find((item: any) => item.name === 'trip_planner_agent');
  // One result-contract guardrail, attached to the direct registration.
  assert.equal(trip.outputGuardrails?.length, 1);
  assert.equal(trip.outputGuardrails[0].type, 'tool_output');
});
