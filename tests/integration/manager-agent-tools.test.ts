import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Agent, MaxTurnsExceededError, RunContext, Runner, Usage } = await import('@openai/agents');
const { createManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { buildManagerInstructions } = await import('../../src/agents/manager-orchestrator/manager-prompt.js');
const { runGatewayAgentTextStream } = await import('../../src/agents/manager-orchestrator/streaming.js');
const {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
  GENERIC_SPECIALIST_FAILURE,
} = await import('../../src/agents/manager/tools.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { buildFlightAgentInstructions, FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { TripPlannerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { createRequestContext, getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext() {
  return buildGatewayContext({
    context: {},
    input: 'Find flights to Dubai and plan my trip',
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
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    responseId: 'resp_specialist_test',
  };
}

/**
 * Swap a production specialist agent's model for a stub, run `body`, restore.
 *
 * These tests drive the PRODUCTION tools from `createManagerTools`, so the only
 * thing mocked is the model. There is no test-only copy of the registration.
 */
async function withSpecialistModel<T>(
  agent: unknown,
  model: unknown,
  body: () => Promise<T>,
): Promise<T> {
  const target = agent as { model: unknown };
  const original = target.model;
  target.model = model;
  try {
    return await body();
  } finally {
    target.model = original;
  }
}

function managerToolNamed(state: ReturnType<typeof createManagerTurnState>, name: string) {
  const found = createManagerTools(state).find((item) => (item as any).name === name);
  assert.ok(found, `expected a ${name} tool`);
  return found as any;
}

/** A Flight Agent structured answer, as `flightManagerOutputSchema` requires. */
function flightAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({
    status: 'success',
    completedTask: 'Searched flights',
    summary: 'Found options.',
    findings: [],
    limitations: [],
    missingInformation: [],
    nextStep: null,
    presentation: null,
    ...fields,
  }));
}

test('Manager is active and has bounded routing context', () => {
  assert.equal(createManagerAgent([]).modelSettings.parallelToolCalls, false);
  const context = makeContext();
  context.flight.searchResults = [{ id: 'private-flight' }] as any;
  const instructions = buildManagerInstructions({ context: createRequestContext(
    context,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' }),
  ) });
  assert.match(instructions, /Generated flight options available: yes/);
  assert.match(instructions, /minimum specialist set/);
  assert.match(instructions, /Speak as one helpful travel assistant/);
  assert.match(instructions, /Do not call options cheap, good, or best unless verified facts support that claim/);
  assert.match(instructions, /icon per distinct topic or result block|occasional relevant icon/);
  assert.doesNotMatch(instructions, /private-flight/);
});

test('a specialist run is scoped to its subtask without touching shared state', async () => {
  const appContext = makeContext();
  const fullUserMessage = appContext.currentUserMessage;
  const state = createManagerTurnState(appContext, 'manager-request');
  let modelInput = '';
  let scopedToolInput: unknown = 'NOT_SET';
  let sharedMessageDuringRun: unknown = 'NOT_SET';

  await withSpecialistModel(FlightManagerAgent, {
    async getResponse(request: any) {
      modelInput = JSON.stringify(request.input);
      return flightAnswer();
    },
    async *getStreamedResponse() {
      throw new Error('Nested tool should use the non-streaming SDK path.');
    },
  }, async () => {
    const flightTool = managerToolNamed(state, 'flight_agent');
    // A stand-in for a nested Flight tool: it observes what the nested run is
    // scoped to, the same way apply_filter does via getScopedRequestText.
    const runContext = sdkContext(appContext);
    const originalInstructions = (FlightManagerAgent as any).instructions;
    (FlightManagerAgent as any).instructions = (nested: any) => {
      scopedToolInput = nested?.toolInput;
      sharedMessageDuringRun = appContext.currentUserMessage;
      return typeof originalInstructions === 'function'
        ? originalInstructions(nested) : String(originalInstructions);
    };
    try {
      await flightTool.invoke(runContext, JSON.stringify({ input: 'Find Dubai flights for 20 September' }));
    } finally {
      (FlightManagerAgent as any).instructions = originalInstructions;
    }
  });

  // Only the flight half of the turn reaches the specialist.
  assert.match(modelInput, /Find Dubai flights for 20 September/);
  assert.doesNotMatch(modelInput, /plan my trip/);

  // The SDK carries the subtask as structured tool input on the nested context,
  // which is what replaced mutating the shared currentUserMessage.
  assert.deepEqual(scopedToolInput, { input: 'Find Dubai flights for 20 September' });
  assert.equal(sharedMessageDuringRun, fullUserMessage,
    'shared currentUserMessage must not be swapped during a nested run');
  assert.equal(appContext.currentUserMessage, fullUserMessage);

  assert.equal(state.outcomes[0].name, 'flight_agent');
  assert.equal(state.outcomes[0].input, 'Find Dubai flights for 20 September');
});

test('typed Flight tool result reaches Manager without duplicating cards or user prose', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const privateCard = { id: 'private-card-id', fare: 123 };
  const serialized = await withSpecialistModel(FlightManagerAgent, {
    async getResponse() {
      appContext.flight.searchResults = [privateCard] as any;
      appContext.flight.totalResultsFound = 1;
      appContext.flight.showFlight = true;
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
      return flightAnswer({
        completedTask: 'Searched flights to Dubai',
        summary: 'Found one matching flight.',
        findings: ['One matching flight to Dubai.'],
        presentation: 'flight_cards_with_price_note',
      });
    },
  }, async () => String(await managerToolNamed(state, 'flight_agent').invoke(
    sdkContext(appContext), JSON.stringify({ input: 'Find flights to Dubai' }),
  )));
  const result = JSON.parse(serialized);
  assert.equal(result.status, 'success');
  assert.equal(result.completedTask, 'Searched flights to Dubai');
  assert.equal(result.presentation, 'flight_cards_with_price_note');
  assert.doesNotMatch(serialized, /private-card-id|Prices shown are per person/);
  assert.equal(serialized.length < 500, true);
  const composed = finalizeManagerOutput('Found one matching flight. Note: Prices shown are per person.', state);
  assert.equal(composed.renderFlightOptions, true);
  assert.equal(composed.output.match(/Note: Prices shown are per person\./g)?.length, 1);
  assert.doesNotMatch(composed.output, /private-card-id/);
});

test('Manager-mode Flight prompt keeps domain rules while requiring internal feedback', async () => {
  const appContext = makeContext();
  appContext.managerToolMode = 'flight';
  appContext.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  assert.ok(typeof FlightManagerAgent.instructions === 'function');
  const instructions = await FlightManagerAgent.instructions(sdkContext(appContext), FlightManagerAgent);
  assert.match(instructions, /Tool-feedback recovery policy/);
  assert.match(instructions, /getGeneratedContractsContext/);
  assert.match(instructions, /Manager tool mode/);
  assert.match(instructions, /structured feedback to the Manager/);
  assert.match(instructions, /Current price-prediction route codes: NYC to LON/);
  assert.equal(FlightManagerAgent.outputType, flightManagerOutputSchema);
  assert.match(instructions, /findings:|limitations:|nextStep:/);
  assert.doesNotMatch(buildFlightAgentInstructions({ context: sdkContext(appContext).context }), /Manager tool mode/);
});

test('Manager registers only the implemented specialists', () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const names = createManagerTools(state).map((item) => item.name);
  assert.deepEqual(names, ['flight_agent', 'trip_planner_agent']);
  // Policy and booking-page topics have no specialist; the Manager declines them
  // via the "Out of scope" prompt section instead of routing them anywhere.
  const instructions = buildManagerInstructions({ context: createRequestContext(
    appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' }),
  ) });
  assert.doesNotMatch(instructions, /cheapoair_policy_helper|cheapoair_pages_agent/);
  assert.match(instructions, /Out of scope — decline, never answer from memory/);
  assert.match(instructions, /Never state, estimate, approximate, or give examples of a policy/);
  // The Flight boundary must survive the collapse of the old Pages/Policy rules.
  assert.match(instructions, /baggage-included, airline, stop, time, price, duration, or layover filter/);
});

test('large nested output stays outside the Manager tool result', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const itinerary = `Dubai itinerary: ${'activity and card data '.repeat(1_000)}`.trimEnd();
  const serialized = await withSpecialistModel(TripPlannerAgent, {
    async getResponse() { return modelAnswer(itinerary); },
    async *getStreamedResponse() { throw new Error('Unexpected stream.'); },
  }, async () => String(await managerToolNamed(state, 'trip_planner_agent').invoke(
    sdkContext(appContext), JSON.stringify({ input: 'Plan Dubai' }),
  )));

  // The model-facing result carries a reference, never the itinerary body.
  assert.equal(serialized.length < 250, true, `result too large: ${serialized.length}`);
  assert.doesNotMatch(serialized, /activity and card data/);
  const ref = JSON.parse(serialized).renderRef;
  assert.ok(ref, 'expected a renderRef');
  assert.equal(state.renders.get(ref), itinerary);
  assert.equal(finalizeManagerOutput(`[[render:${ref}]]`, state).output, itinerary);
});

test('SDK Manager can sequence two specialists and sees only compact tool results', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const itinerary = `Day 1: Dubai museums and local food. ${'Card details '.repeat(800)}ACTIVITY_END_MARKER`;
  const managerInputs: string[] = [];

  const managerModel: any = {
    async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      const call = managerInputs.length;
      if (call <= 2) {
        return {
          usage: new Usage(),
          output: [{
            type: 'function_call',
            callId: `call_${call}`,
            name: call === 1 ? 'flight_agent' : 'trip_planner_agent',
            arguments: JSON.stringify({ input: call === 1 ? 'Find Dubai flights' : 'Plan Dubai' }),
            status: 'completed',
          }],
          responseId: `resp_manager_${call}`,
        };
      }
      const ref = [...state.renders.keys()][0];
      return modelAnswer(`Found three Dubai flights.\n\n[[render:${ref}]]`);
    },
  };

  const result = await withSpecialistModel(FlightManagerAgent, {
    async getResponse() {
      appContext.flight.searchResults = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as any;
      appContext.flight.totalResultsFound = 3;
      appContext.flight.showFlight = true;
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
      return flightAnswer({
        completedTask: 'Searched Dubai flights',
        summary: 'Found three Dubai flights.',
        presentation: 'flight_cards_with_price_note',
      });
    },
  }, () => withSpecialistModel(TripPlannerAgent, {
    async getResponse() { return modelAnswer(itinerary); },
  }, async () => {
    const manager = createManagerAgent(createManagerTools(state)).clone({ model: managerModel });
    return new Runner({ model: managerModel, tracingDisabled: true }).run(
      manager, 'Find flights to Dubai and plan my trip',
      { context: sdkContext(appContext), maxTurns: 6 },
    );
  }));

  assert.deepEqual(state.outcomes.map((item) => item.name), ['flight_agent', 'trip_planner_agent']);
  assert.equal(managerInputs.length, 3);
  // The Flight summary reached the Manager; the itinerary body never did.
  assert.match(managerInputs[1], /Found three Dubai flights/);
  assert.match(managerInputs[2], /Prepared .*content|renderRef/);
  assert.doesNotMatch(managerInputs[2], /ACTIVITY_END_MARKER/);

  const output = finalizeManagerOutput(String(result.finalOutput), state).output;
  assert.equal(output.match(/Found three Dubai flights/g)?.length, 1);
  assert.equal(output.match(/ACTIVITY_END_MARKER/g)?.length, 1);
});

test('Manager composition passes itinerary render data through exactly once', () => {
  const state = createManagerTurnState(makeContext(), 'manager-request');
  state.outcomes.push({
    name: 'flight_agent', input: 'Find flights',
    result: { status: 'success', summary: 'Found three flights.' },
  });
  state.outcomes.push({
    name: 'trip_planner_agent', input: 'Plan Dubai',
    result: { status: 'success', summary: 'Prepared the Dubai itinerary.', renderRef: 'trip_one' },
  });
  // A third outcome with no renderRef: its summary must NOT be injected when the
  // Manager already wrote its own text.
  state.outcomes.push({
    name: 'flight_agent', input: 'Cheaper dates',
    result: { status: 'failure', summary: 'Cheaper-date guidance is unavailable.' },
  });
  state.renders.set('trip_one', 'Day 1: Visit the old town.\n\n:::cards\nCard payload');
  const marked = finalizeManagerOutput('✈️ I found three flights.\n\nI can’t verify the cancellation policy right now.\n\n🗺️ Here’s a plan for Dubai:\n[[render:trip_one]]', state);
  assert.equal(marked.output.match(/Day 1:/g)?.length, 1);
  assert.equal(marked.output.match(/found three flights/gi)?.length, 1);
  assert.equal(marked.output.match(/cancellation policy/g)?.length, 1);
  assert.doesNotMatch(marked.output, /Policy guidance is unavailable/);
  const unmarked = finalizeManagerOutput('✈️ I found three flights.\n\n🗺️ Here’s a plan for Dubai:', state);
  assert.match(unmarked.output, /Here’s a plan for Dubai:/);
  assert.equal(unmarked.output.match(/Day 1:/g)?.length, 1);
  const omitted = finalizeManagerOutput('I found three flights.\n\n' + state.renders.get('trip_one'), state);
  assert.equal(omitted.output.match(/Day 1:/g)?.length, 1);
  assert.match(omitted.output, /I found three flights/);
  assert.doesNotMatch(finalizeManagerOutput('[[render:unknown]]', state).output, /unknown/);
});

/**
 * A Flight specialist that reports a failure. Used by the
 * stream tests below, which need one recorded outcome without a real model.
 *
 * These tests drive the tool through `invoke()`, which the runner-level output
 * guardrail does not cover; masking of raw failures is asserted against a real
 * Runner in tests/integration/manager-specialist-registration.test.ts.
 */
const unevidencedFlightFailure = {
  async getResponse() {
    return flightAnswer({
      status: 'failure',
      completedTask: 'Checked the request',
      summary: GENERIC_SPECIALIST_FAILURE,
    });
  },
  async *getStreamedResponse() { throw new Error('non-streaming expected'); },
};

/** A Manager run that records one specialist outcome, then answers. */
function fakeManagerRunner(finalOutput: string, fail?: Error) {
  return {
    async run(agent: any) {
      const flight = agent.tools.find((item: any) => item.name === 'flight_agent');
      await flight.invoke(sdkContext(makeContext()), JSON.stringify({ input: 'Find Dubai flights' }));
      if (fail) throw fail;
      return { finalOutput, lastResponseId: 'resp_manager_test', rawResponses: [] };
    },
  };
}

test('the text-stream adapter emits the composed answer as one chunk', async () => {
  const { streamed, completed } = await withSpecialistModel(
    FlightManagerAgent, unevidencedFlightFailure, async () => {
      const run = runGatewayAgentTextStream({
        input: 'What is the cancellation policy?',
        context: makeContext(),
        runner: fakeManagerRunner('I can’t help with that yet, but I can search flights for you.') as any,
      });
      const chunks: string[] = [];
      for await (const chunk of run.stream) chunks.push(String(chunk));
      return { streamed: chunks, completed: await run.completed };
    },
  );

  // One chunk: composition has to finish before any text is user-visible.
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0], 'I can’t help with that yet, but I can search flights for you.');
  assert.doesNotMatch(streamed[0], /source|connected|specialist/i);
  assert.equal(completed.output, streamed[0]);
  assert.equal(completed.finalAgentName, 'Manager Agent');
  assert.deepEqual(completed.specialistsUsed, ['flight_agent']);
  assert.equal(completed.renderFlightOptions, false);
});

test('a terminal Manager failure propagates instead of inventing a partial answer', async () => {
  // The max-turn partial fallback is gone: exceeding the Manager turn limit is a
  // failed turn the caller reports, not a reconstructed answer. Recorded
  // specialist outcomes are still on the turn state for logging.
  const failure = new MaxTurnsExceededError('Manager turn limit reached');

  await withSpecialistModel(FlightManagerAgent, unevidencedFlightFailure, async () => {
    const run = runGatewayAgentTextStream({
      input: 'What is the cancellation policy?',
      context: makeContext(),
      runner: fakeManagerRunner('unused', failure) as any,
    });
    await assert.rejects(() => run.completed, (error: unknown) => error === failure);

    // The stream carries the same failure, and never a partial answer.
    let streamed = '';
    await assert.rejects(async () => {
      for await (const chunk of run.stream) streamed += String(chunk);
    });
    assert.equal(streamed, '');
  });
});

test('Trip Planner turn is prepared with the subtask and a revision watermark', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const originalModel = (TripPlannerAgent as any).model;
  try {
    (TripPlannerAgent as any).model = {
      async getResponse() { return modelAnswer('Day 1: Dubai Creek. Day 2: Desert safari.'); },
      async *getStreamedResponse() { throw new Error('non-streaming expected'); },
    };
    const tripTool: any = createManagerTools(state).find((item: any) => item.name === 'trip_planner_agent');
    const result = JSON.parse(String(await tripTool.invoke(
      sdkContext(appContext), JSON.stringify({ input: 'Plan 3 days in Dubai' }),
    )));

    // prepareTripPlannerTurn ran: the specialist sees only its subtask, not the full turn.
    assert.equal((appContext as any).tripPlanner.currentUserMessage, 'Plan 3 days in Dubai');
    assert.equal(typeof (appContext as any).tripPlanner.turnState.baseRevision, 'number');
    assert.equal((appContext as any).tripPlanner.turnState.requestId, 'manager-request');
    // Bulk content stays out of the Manager's context behind a render ref.
    assert.ok(result.renderRef, 'expected a renderRef');
    assert.equal(state.renders.get(result.renderRef), 'Day 1: Dubai Creek. Day 2: Desert safari.');
    assert.ok(JSON.stringify(result).length < 250);
  } finally {
    (TripPlannerAgent as any).model = originalModel;
  }
});
