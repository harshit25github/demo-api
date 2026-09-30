import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Agent, MaxTurnsExceededError, RunContext, Runner, Usage, tool } = await import('@openai/agents');
const { z } = await import('zod');
const { createManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { buildManagerInstructions } = await import('../../src/agents/manager-orchestrator/manager-prompt.js');
const { runGatewayAgentTextStream } = await import('../../src/agents/manager-orchestrator/streaming.js');
const {
  createManagerTools,
  createManagerTurnState,
  createSpecialistTool,
  finalizeManagerOutput,
  flightResult,
  readNestedOutcome,
  GENERIC_SPECIALIST_FAILURE,
  SDK_TOOL_ERROR_PREFIX,
} = await import('../../src/agents/manager/tools.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { buildFlightAgentInstructions, FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { TripPlannerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { createRequestContext, getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');
const {
  clearFlightSearchRuntime,
  initializeFlightSearchRuntime,
  updateFlightSearchRuntime,
} = await import('../../src/agents/flight/context/search-runtime-store.js');

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

// Mock specialists run through the PRODUCTION adapter (createSpecialistTool), so
// these tests exercise the real watermark/scope/failure path rather than a copy of it.
function makeAgentTool(
  state: ReturnType<typeof createManagerTurnState>,
  name: 'flight_agent' | 'trip_planner_agent',
  description: string,
  specialist: InstanceType<typeof Agent>,
  maxTurns: number,
  onSuccess: (output: unknown, input: string, logStart: number,
    priorPrediction: unknown, priorSearchKey: string | null) => any,
) {
  const nested = specialist.asTool({
    toolName: name,
    toolDescription: description,
    runOptions: { maxTurns },
    customOutputExtractor: (result: any) => JSON.stringify(result.finalOutput ?? null),
  });
  return createSpecialistTool(state, {
    name,
    description,
    nested: nested as any,
    scopeUserMessage: name === 'flight_agent',
    capture(turn) {
      return {
        logStart: turn.appContext.toolCallLog.length,
        priorPrediction: turn.appContext.flight.lastPricePrediction,
        priorSearchKey: turn.appContext.flight.searchKey || null,
      };
    },
    toResult(_turn, input, outcome, pending) {
      // `=== false`, not `!outcome.ok`: this project runs with `strictNullChecks`
      // off, where truthiness narrowing on a boolean discriminant does not narrow.
      if (outcome.ok === false) {
        return {
          status: 'failure',
          summary: GENERIC_SPECIALIST_FAILURE,
          recovery: { code: outcome.code, retryable: outcome.retryable },
        };
      }
      return onSuccess(JSON.parse(outcome.output), input, pending.logStart,
        pending.priorPrediction, pending.priorSearchKey);
    },
  });
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

test('agent-as-tool adapter passes the scoped input and shared context to a nested SDK Runner', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  let modelInput = '';
  const model: any = {
    async getResponse(request: any) {
      modelInput = JSON.stringify(request.input);
      return modelAnswer('Scoped specialist answer');
    },
    async *getStreamedResponse() {
      throw new Error('Nested tool should use the non-streaming SDK path.');
    },
  };
  const specialist = new Agent({ name: 'Mock Specialist', instructions: 'Reply.', model });
  const adapter = makeAgentTool(
    state,
    'flight_agent',
    'Mock flight work',
    specialist,
    2,
    (output) => ({ status: 'success', summary: String(output) }),
  );
  const result = JSON.parse(String(await (adapter as any).invoke(
    sdkContext(appContext),
    JSON.stringify({ input: 'Find Dubai flights for 20 September' }),
  )));
  assert.deepEqual(result, { status: 'success', summary: 'Scoped specialist answer' });
  assert.match(modelInput, /Find Dubai flights for 20 September/);
  assert.doesNotMatch(modelInput, /plan my trip/);
  assert.equal(state.outcomes[0].name, 'flight_agent');
  assert.equal(state.outcomes[0].input, 'Find Dubai flights for 20 September');

  const wrongContext = makeContext();
  const mismatch = JSON.parse(String(await (adapter as any).invoke(
    sdkContext(wrongContext),
    JSON.stringify({ input: 'Another request' }),
  )));
  assert.equal(mismatch.recovery.code, 'CONTEXT_MISMATCH');
});

test('typed Flight tool result reaches Manager without duplicating cards or user prose', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const privateCard = { id: 'private-card-id', fare: 123 };
  const model: any = {
    async getResponse() {
      appContext.flight.searchResults = [privateCard] as any;
      appContext.flight.totalResultsFound = 1;
      appContext.flight.showFlight = true;
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
      return modelAnswer(JSON.stringify({
        status: 'success',
        completedTask: 'Searched flights to Dubai',
        resultSummary: 'Found one matching flight. Note: Prices shown are per person.',
        missingInformation: [],
      }));
    },
  };
  const specialist = new Agent({
    name: 'Mock typed Flight', instructions: 'Return structured Flight feedback.',
    outputType: flightManagerOutputSchema, model,
  });
  const adapter = makeAgentTool(
    state, 'flight_agent', 'Find flights', specialist, 2,
    (output, input, logStart, priorPrediction, priorSearchKey) =>
      flightResult(state, output, input, logStart, priorPrediction, priorSearchKey),
  );
  const serialized = String(await (adapter as any).invoke(
    sdkContext(appContext), JSON.stringify({ input: 'Find flights to Dubai' }),
  ));
  const result = JSON.parse(serialized);
  assert.equal(result.status, 'success');
  assert.equal(result.completedTask, 'Searched flights to Dubai');
  assert.equal(result.presentation, 'flight_cards_with_price_note');
  assert.doesNotMatch(serialized, /private-card-id|Prices shown are per person/);
  assert.equal(serialized.length < 350, true);
  const composed = finalizeManagerOutput('Found one matching flight.', state);
  assert.equal(composed.renderFlightOptions, true);
  assert.equal(composed.output.match(/Note: Prices shown are per person\./g)?.length, 1);
  assert.doesNotMatch(composed.output, /private-card-id/);
});

test('Flight result preserves missing input and partial progress without claiming success', () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const needsInput = flightResult(state, {
    status: 'needs_input', completedTask: 'Checked available flight details',
    resultSummary: 'Departure location is missing.', missingInformation: ['Departure location'],
  }, 'Find flights to Dubai', 0, null, null);
  assert.equal(needsInput.status, 'needs_input');
  assert.deepEqual(needsInput.missingInformation, ['Departure location']);
  assert.equal(needsInput.presentation, undefined);

  appContext.flight.searchResults = [{ fare: 123 }] as any;
  appContext.flight.showFlight = true;
  appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
  const partial = flightResult(state, {
    status: 'failure', completedTask: 'Searched flights',
    resultSummary: 'Could not complete the requested fare comparison.', missingInformation: [],
  }, 'Find and compare Dubai flights', 0, null, null);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.presentation, 'flight_cards_with_price_note');
  assert.match(partial.summary, /Could not complete/);

  const unverified = flightResult(createManagerTurnState(makeContext(), 'new'), {
    status: 'success', completedTask: 'Searched flights',
    resultSummary: 'Found three flights.', missingInformation: [],
  }, 'Find flights', 0, null, null);
  assert.equal(unverified.status, 'failure');
  assert.equal(unverified.recovery?.code, 'UNVERIFIED_FLIGHT_RESULT');
});

test('Manager-mode Flight prompt keeps domain rules while requiring internal feedback', () => {
  const appContext = makeContext();
  appContext.managerToolMode = 'flight';
  appContext.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  const instructions = buildFlightAgentInstructions({ context: sdkContext(appContext).context });
  assert.match(instructions, /Tool-feedback recovery policy/);
  assert.match(instructions, /getGeneratedContractsContext/);
  assert.match(instructions, /Manager tool mode/);
  assert.match(instructions, /structured feedback to the Manager/);
  assert.match(instructions, /Current price-prediction route codes: NYC to LON/);
  assert.equal(FlightManagerAgent.outputType, flightManagerOutputSchema);
});

test('Flight price prediction success is verified without cards; a new prediction failure requests a date', () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  appContext.flight.lastPricePrediction = { status: 'SUCCESS' } as any;
  const predicted = flightResult(state, {
    status: 'success', completedTask: 'Checked flexible travel dates',
    resultSummary: 'Strongest predicted travel date is October 12.', missingInformation: [],
  }, 'What is the cheapest date?', 0, null, null);
  assert.equal(predicted.status, 'success');
  assert.equal(predicted.presentation, undefined);

  const previous = appContext.flight.lastPricePrediction;
  appContext.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' } as any;
  const failed = flightResult(state, {
    status: 'failure', completedTask: 'Checked flexible travel dates',
    resultSummary: 'No prediction data available.', missingInformation: [],
  }, 'When should I travel?', 0, previous, null);
  assert.equal(failed.status, 'needs_input');
  assert.deepEqual(failed.missingInformation, ['Expected travel date']);
  assert.doesNotMatch(JSON.stringify(failed), /NO_PREDICTIONS|price_prediction_tool/);
});

test('cheaper-date prediction failure keeps known search dates and does not request them again', () => {
  const appContext = makeContext();
  appContext.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  appContext.flight.outboundDate = '2026-11-05';
  appContext.flight.inboundDate = '2026-11-12';
  appContext.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' } as any;
  const result = flightResult(createManagerTurnState(appContext, 'cheaper-date-turn'), {
    status: 'failure', completedTask: 'Checked cheaper dates',
    resultSummary: 'No price-date comparison was available.', missingInformation: [],
  }, 'Any cheaper dates?', 0, null, null);
  assert.equal(result.status, 'failure');
  assert.equal(result.userRelevantData?.outboundDate, '2026-11-05');
  assert.equal(result.missingInformation, undefined);
  assert.doesNotMatch(result.summary, /travel date|prediction_tool|NO_PREDICTIONS/i);
});

test('filter-only Flight cards do not add the search price note', () => {
  const appContext = makeContext();
  appContext.flight.searchResults = [{ fare: 123 }] as any;
  appContext.flight.showFlight = true;
  appContext.toolCallLog.push({ tool: 'apply_filter', ok: true } as any);
  const state = createManagerTurnState(appContext, 'manager-request');
  const result = flightResult(state, {
    status: 'success', completedTask: 'Applied the nonstop filter',
    resultSummary: 'One nonstop option remains.', missingInformation: [],
  }, 'Show nonstop flights only', 0, null, null);
  assert.equal(result.presentation, 'flight_cards');
  state.outcomes.push({ name: 'flight_agent', input: 'Show nonstop flights only', result });
  const composed = finalizeManagerOutput('One nonstop option remains.', state);
  assert.equal(composed.renderFlightOptions, true);
  assert.doesNotMatch(composed.output, /Prices shown are per person/);
});

test('unavailable filtered option does not turn into a date clarification', () => {
  const appContext = makeContext();
  appContext.currentUserMessage = 'Show me option 2.';
  appContext.flight.searchKey = 'option-recovery-search';
  appContext.flight.outboundDate = '2026-09-26';
  appContext.flight.segments = [{ origin: 'DEL', destination: 'DXB', date: '2026-09-26' }];
  const earlierOptions = [{ id: 'first' }, { id: 'second' }, { id: 'third' }] as any;
  initializeFlightSearchRuntime(appContext.flight.searchKey, earlierOptions);
  updateFlightSearchRuntime(appContext.flight.searchKey, {
    appliedFilters: [{ filterType: 'stops', filterCode: '0' }],
    visibleFlights: [earlierOptions[0]],
  });
  appContext.flight.searchResults = [earlierOptions[0]];
  appContext.flight.totalResultsFound = 1;
  appContext.toolCallLog.push({
    tool: 'getGeneratedContractsContext', ok: false, code: 'INDEX_OUT_OF_RANGE',
  } as any);
  try {
    const state = createManagerTurnState(appContext, 'option-recovery-request');
    const result = flightResult(state, {
      status: 'partial',
      completedTask: 'Inspected the current Delhi to Dubai flight options',
      resultSummary: 'Could not verify option 2 from the previous results.',
      missingInformation: [],
    }, 'Show or inspect option 2 from the current filtered DEL to DXB options.',
    0, null, appContext.flight.searchKey);
    assert.equal(result.status, 'partial');
    assert.match(result.summary, /Option 2 is not available.*only 1 option is available/);
    assert.equal(result.userRelevantData?.outboundDate, '2026-09-26');
    assert.match(result.suggestedNextAction || '', /remove the current filters/);
    assert.equal(result.missingInformation, undefined);
    state.outcomes.push({ name: 'flight_agent', input: 'Show option 2', result });

    const incorrect = finalizeManagerOutput(
      'Sure — what date would you like to fly from Delhi to Dubai?', state,
    );
    assert.doesNotMatch(incorrect.output, /what date|which date/i);
    assert.match(incorrect.output, /Option 2 is not available/);
    assert.match(incorrect.output, /remove the current filters/);
    assert.doesNotMatch(incorrect.output, /Prices shown are per person/);

    const correct = finalizeManagerOutput(
      'Option 2 isn’t in the current filtered results; only one option remains.', state,
    );
    assert.equal(correct.output,
      'Option 2 isn’t in the current filtered results; only one option remains.');

    // The specialist may read the one visible option and report partial
    // without attempting an out-of-range selection.
    appContext.toolCallLog[0] = { tool: 'getGeneratedContractsContext', ok: true } as any;
    const readOnly = flightResult(createManagerTurnState(appContext, 'read-only-option'), {
      status: 'partial',
      completedTask: 'Inspected option 2 in the current filtered results',
      resultSummary: 'The current result context returned only option 1.',
      missingInformation: [],
    }, 'Show option 2 from the filtered flights.', 0, null, appContext.flight.searchKey);
    assert.match(readOnly.summary, /Option 2 is not available.*only 1 option is available/);
    assert.match(readOnly.suggestedNextAction || '', /earlier flight options/);
  } finally {
    clearFlightSearchRuntime(appContext.flight.searchKey);
  }
});

test('a new date clarification remains valid when Flight explicitly needs that input', () => {
  const appContext = makeContext();
  appContext.currentUserMessage = 'Change my departure date.';
  appContext.flight.outboundDate = '2026-09-26';
  const state = createManagerTurnState(appContext, 'new-date-request');
  state.outcomes.push({
    name: 'flight_agent', input: 'Change my departure date',
    result: {
      status: 'needs_input',
      summary: 'A new departure date is needed to change this search.',
      missingInformation: ['New departure date'],
    },
  });
  assert.equal(
    finalizeManagerOutput('What date would you like to fly instead?', state).output,
    'What date would you like to fly instead?',
  );
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
  const model: any = {
    async getResponse() { return modelAnswer(itinerary); },
    async *getStreamedResponse() { throw new Error('Unexpected stream.'); },
  };
  const specialist = new Agent({ name: 'Mock Trip Planner', instructions: 'Reply.', model });
  const adapter = makeAgentTool(
    state, 'trip_planner_agent', 'Mock trip work', specialist, 2,
    (output) => {
      state.renders.set('trip_test', String(output));
      return { status: 'success', summary: 'Itinerary prepared.', renderRef: 'trip_test' };
    },
  );
  const serialized = String(await (adapter as any).invoke(
    sdkContext(appContext), JSON.stringify({ input: 'Plan Dubai' }),
  ));
  assert.equal(serialized.length < 150, true);
  assert.equal(state.renders.get('trip_test'), itinerary);
  assert.equal(finalizeManagerOutput('[[render:trip_test]]', state).output, itinerary);
});

test('SDK Manager can sequence two specialists and sees only compact tool results', async () => {
  const appContext = makeContext();
  const state = createManagerTurnState(appContext, 'manager-request');
  const itinerary = `Day 1: Dubai. ${'Card details '.repeat(800)}ACTIVITY_END_MARKER`;
  const flightModel: any = {
    async getResponse() { return modelAnswer('Found three Dubai flights.'); },
  };
  const tripModel: any = {
    async getResponse() { return modelAnswer(itinerary); },
  };
  const flight = new Agent({ name: 'Mock Flight', instructions: 'Reply.', model: flightModel });
  const trip = new Agent({ name: 'Mock Trip', instructions: 'Reply.', model: tripModel });
  const tools = [
    makeAgentTool(state, 'flight_agent', 'Find flights', flight, 2,
      (output) => ({ status: 'success', summary: String(output) })),
    makeAgentTool(state, 'trip_planner_agent', 'Plan itinerary', trip, 2,
      () => {
        state.renders.set('trip_mixed', itinerary);
        return { status: 'success', summary: 'Dubai itinerary prepared.', renderRef: 'trip_mixed' };
      }),
  ];
  const managerInputs: string[] = [];
  const managerModel: any = {
    async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      const call = managerInputs.length;
      if (call === 2) assert.match(managerInputs[1], /Found three Dubai flights/);
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
      return modelAnswer('Found three Dubai flights.\n\n[[render:trip_mixed]]');
    },
  };
  const manager = createManagerAgent(tools).clone({ model: managerModel });
  const result = await new Runner({ model: managerModel, tracingDisabled: true }).run(
    manager, 'Find flights to Dubai and plan my trip',
    { context: sdkContext(appContext), maxTurns: 6 },
  );
  assert.deepEqual(state.outcomes.map((item) => item.name), ['flight_agent', 'trip_planner_agent']);
  assert.equal(managerInputs.length, 3);
  assert.match(managerInputs[2], /Dubai itinerary prepared/);
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
  const omitted = finalizeManagerOutput('Day 1: Visit the old town.', state);
  assert.equal(omitted.output.match(/Day 1:/g)?.length, 1);
  assert.match(omitted.output, /Found three flights/);
  assert.doesNotMatch(finalizeManagerOutput('[[render:unknown]]', state).output, /unknown/);
});

test('text stream resolves Manager results before emitting user text', async () => {
  const previousMode = process.env.ORCHESTRATION_MODE;
  process.env.ORCHESTRATION_MODE = 'manager';
  try {
    const runner: any = {
      async run(agent: any, _input: string, _options: any) {
        // A mismatched context fails before any nested run, so this exercises the
        // stream contract without a model call.
        const flight = agent.tools.find((item: any) => item.name === 'flight_agent');
        await flight.invoke(sdkContext(makeContext()), JSON.stringify({ input: 'Find Dubai flights' }));
        const finalOutput = 'I can’t help with that yet, but I can search flights for you.';
        return {
          finalOutput,
          lastResponseId: 'resp_manager_test',
          rawResponses: [],
          state: {},
          completed: Promise.resolve(),
          toTextStream: () => Readable.from([finalOutput]),
        };
      },
    };
    const run = runGatewayAgentTextStream({
      input: 'What is the cancellation policy?',
      context: makeContext(),
      runner,
      maxTimeoutRecoveries: 0,
    });
    let streamed = '';
    for await (const chunk of run.stream) streamed += String(chunk);
    const completed = await run.completed;
    assert.equal(streamed, 'I can’t help with that yet, but I can search flights for you.');
    assert.doesNotMatch(streamed, /source|connected|specialist/i);
    assert.equal(completed.output, streamed);
    assert.equal(completed.finalAgentName, 'Manager Agent');
    assert.deepEqual(completed.specialistsUsed, ['flight_agent']);
    assert.equal(completed.renderFlightOptions, false);
  } finally {
    if (previousMode === undefined) delete process.env.ORCHESTRATION_MODE;
    else process.env.ORCHESTRATION_MODE = previousMode;
  }
});

test('Manager max-turn recovery returns completed specialist work once', async () => {
  const previousMode = process.env.ORCHESTRATION_MODE;
  process.env.ORCHESTRATION_MODE = 'manager';
  try {
    const runner: any = {
      async run(agent: any, _input: string, _options: any) {
        const flight = agent.tools.find((item: any) => item.name === 'flight_agent');
        await flight.invoke(sdkContext(makeContext()), JSON.stringify({ input: 'Find Dubai flights' }));
        return {
          state: {},
          completed: Promise.reject(new MaxTurnsExceededError('Manager turn limit reached')),
          toTextStream: () => Readable.from([]),
        };
      },
    };
    const run = runGatewayAgentTextStream({
      input: 'What is the cancellation policy?',
      context: makeContext(),
      runner,
      maxTimeoutRecoveries: 0,
    });
    let streamed = '';
    for await (const chunk of run.stream) streamed += String(chunk);
    const completed = await run.completed;
    assert.equal(completed.recoveredFromMaxTurns, true);
    assert.equal(completed.output, streamed);
    // The fallback emits specialist summaries verbatim, so they must be traveler-facing.
    assert.match(streamed, /I couldn't finish that part of your request right now/);
    assert.doesNotMatch(streamed, /source|connected|specialist|context/i);
    assert.deepEqual(completed.specialistsUsed, ['flight_agent']);
  } finally {
    if (previousMode === undefined) delete process.env.ORCHESTRATION_MODE;
    else process.env.ORCHESTRATION_MODE = previousMode;
  }
});

test('SDK tool-error sentinel is pinned and nested failures classify by real error name', async () => {
  // asTool() accepts no errorFunction, so the SDK installs defaultToolErrorFunction:
  // a nested-run exception RESOLVES as this string instead of throwing. If the SDK
  // ever changes that wording, this test fails before recovery codes silently rot.
  const throwing = tool({
    name: 'throwing_probe',
    description: 'probe',
    parameters: z.object({}),
    strict: true,
    execute() { throw new MaxTurnsExceededError('Max turns (10) exceeded'); },
  });
  const raw = String(await (throwing as any).invoke(new RunContext({}), '{}'));
  assert.ok(raw.startsWith(SDK_TOOL_ERROR_PREFIX), `unexpected sentinel: ${raw}`);

  assert.deepEqual(readNestedOutcome(raw), { ok: false, code: 'MAX_TURNS', retryable: false });
  assert.deepEqual(
    readNestedOutcome(`${SDK_TOOL_ERROR_PREFIX}ModelTimeoutError: Model call timed out after 2000ms.`),
    { ok: false, code: 'ModelTimeoutError', retryable: true },
  );
  assert.deepEqual(
    readNestedOutcome('{"status":"success"}'),
    { ok: true, output: '{"status":"success"}' },
  );
});

test('Flight nested failure after a completed core tool reports partial progress', async () => {
  const appContext = makeContext();
  const fullUserMessage = appContext.currentUserMessage;
  const state = createManagerTurnState(appContext, 'manager-request');
  const originalModel = (FlightManagerAgent as any).model;
  try {
    (FlightManagerAgent as any).model = {
      async getResponse() {
        appContext.flight.searchResults = [{ id: 'c1' }, { id: 'c2' }] as any;
        appContext.flight.totalResultsFound = 2;
        appContext.flight.showFlight = true;
        appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
        throw new MaxTurnsExceededError('Max turns (10) exceeded');
      },
      async *getStreamedResponse() { throw new Error('non-streaming expected'); },
    };
    const flightTool: any = createManagerTools(state).find((item: any) => item.name === 'flight_agent');
    const result = JSON.parse(String(await flightTool.invoke(
      sdkContext(appContext), JSON.stringify({ input: 'Find flights to Dubai' }),
    )));

    assert.equal(result.status, 'partial');
    assert.equal(result.recovery.code, 'MAX_TURNS_AFTER_CORE_SUCCESS');
    assert.equal(result.presentation, 'flight_cards_with_price_note');
    assert.equal(result.userRelevantData.resultCount, 2);
    assert.equal(state.outcomes.length, 1);
    // The SDK's "Please try again" sentinel must never reach the Manager model.
    assert.doesNotMatch(String(JSON.stringify(result)), /An error occurred while running the tool/);
  } finally {
    (FlightManagerAgent as any).model = originalModel;
  }
  // The subtask scope is restored even though the nested run failed.
  assert.equal(appContext.currentUserMessage, fullUserMessage);
});

test('Flight subtask scoping is restored on both the success and failure paths', async () => {
  const appContext = makeContext();
  const fullUserMessage = appContext.currentUserMessage;
  const state = createManagerTurnState(appContext, 'manager-request');
  const originalModel = (FlightManagerAgent as any).model;
  const seen: string[] = [];
  try {
    (FlightManagerAgent as any).model = {
      async getResponse() {
        // apply_filter reads appContext.currentUserMessage, so it must be the subtask.
        seen.push(String(appContext.currentUserMessage));
        return modelAnswer(JSON.stringify({
          status: 'success', completedTask: 'Searched flights',
          resultSummary: 'Found options.', missingInformation: [],
        }));
      },
      async *getStreamedResponse() { throw new Error('non-streaming expected'); },
    };
    const flightTool: any = createManagerTools(state).find((item: any) => item.name === 'flight_agent');
    await flightTool.invoke(sdkContext(appContext), JSON.stringify({ input: 'Find Dubai flights on 20 Oct' }));
  } finally {
    (FlightManagerAgent as any).model = originalModel;
  }
  assert.deepEqual(seen, ['Find Dubai flights on 20 Oct']);
  assert.notEqual(fullUserMessage, 'Find Dubai flights on 20 Oct');
  assert.equal(appContext.currentUserMessage, fullUserMessage);
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
