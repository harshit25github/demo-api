import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
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
  flightResult,
  GENERIC_SPECIALIST_FAILURE,
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
    resultSummary: 'Found options.',
    missingInformation: [],
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
        resultSummary: 'Found one matching flight. Note: Prices shown are per person.',
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
  }, 'Find flights to Dubai');
  assert.equal(needsInput.status, 'needs_input');
  assert.deepEqual(needsInput.missingInformation, ['Departure location']);
  assert.equal(needsInput.presentation, undefined);

  appContext.flight.searchResults = [{ fare: 123 }] as any;
  appContext.flight.showFlight = true;
  appContext.toolCallLog.push({ tool: 'flight_search', ok: true } as any);
  const partial = flightResult(state, {
    status: 'failure', completedTask: 'Searched flights',
    resultSummary: 'Could not complete the requested fare comparison.', missingInformation: [],
  }, 'Find and compare Dubai flights');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.presentation, 'flight_cards_with_price_note');
  assert.match(partial.summary, /Could not complete/);

  const unverified = flightResult(createManagerTurnState(makeContext(), 'new'), {
    status: 'success', completedTask: 'Searched flights',
    resultSummary: 'Found three flights.', missingInformation: [],
  }, 'Find flights');
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
  }, 'What is the cheapest date?');
  assert.equal(predicted.status, 'success');
  assert.equal(predicted.presentation, undefined);

  // A later turn: the turn watermark is captured with the earlier SUCCESS still
  // on the context, so the new NO_PREDICTIONS result is recognised as this
  // turn's own failure rather than a stale one.
  const laterTurn = createManagerTurnState(appContext, 'later-turn');
  appContext.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' } as any;
  const failed = flightResult(laterTurn, {
    status: 'failure', completedTask: 'Checked flexible travel dates',
    resultSummary: 'No prediction data available.', missingInformation: [],
  }, 'When should I travel?');
  assert.equal(failed.status, 'needs_input');
  assert.deepEqual(failed.missingInformation, ['Expected travel date']);
  assert.doesNotMatch(JSON.stringify(failed), /NO_PREDICTIONS|price_prediction_tool/);
});

test('cheaper-date prediction failure keeps known search dates and does not request them again', () => {
  const appContext = makeContext();
  appContext.flight.segments = [{ origin: 'NYC', destination: 'London', date: '2026-11-05' }];
  appContext.flight.outboundDate = '2026-11-05';
  appContext.flight.inboundDate = '2026-11-12';
  // The watermark is captured before the prediction lands, so this counts as
  // this turn's own failure rather than one carried over from an earlier turn.
  const cheaperDateTurn = createManagerTurnState(appContext, 'cheaper-date-turn');
  appContext.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' } as any;
  const result = flightResult(cheaperDateTurn, {
    status: 'failure', completedTask: 'Checked cheaper dates',
    resultSummary: 'No price-date comparison was available.', missingInformation: [],
  }, 'Any cheaper dates?');
  assert.equal(result.status, 'failure');
  assert.equal(result.userRelevantData?.outboundDate, '2026-11-05');
  assert.equal(result.missingInformation, undefined);
  assert.doesNotMatch(result.summary, /travel date|prediction_tool|NO_PREDICTIONS/i);
});

test('filter-only Flight cards do not add the search price note', () => {
  const appContext = makeContext();
  appContext.flight.searchResults = [{ fare: 123 }] as any;
  appContext.flight.showFlight = true;
  // The turn state is captured before the specialist runs, as production does,
  // so the filter entry below counts as this turn's evidence.
  const state = createManagerTurnState(appContext, 'manager-request');
  appContext.toolCallLog.push({ tool: 'apply_filter', ok: true } as any);
  const result = flightResult(state, {
    status: 'success', completedTask: 'Applied the nonstop filter',
    resultSummary: 'One nonstop option remains.', missingInformation: [],
  }, 'Show nonstop flights only');
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
  try {
    // Captured before the specialist runs, so the entry below is this turn's evidence.
    const state = createManagerTurnState(appContext, 'option-recovery-request');
    appContext.toolCallLog.push({
      tool: 'getGeneratedContractsContext', ok: false, code: 'INDEX_OUT_OF_RANGE',
    } as any);
    const result = flightResult(state, {
      status: 'partial',
      completedTask: 'Inspected the current Delhi to Dubai flight options',
      resultSummary: 'Could not verify option 2 from the previous results.',
      missingInformation: [],
    }, 'Show or inspect option 2 from the current filtered DEL to DXB options.');
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
    const readOnlyTurn = createManagerTurnState(appContext, 'read-only-option');
    appContext.toolCallLog.push({ tool: 'getGeneratedContractsContext', ok: true } as any);
    const readOnly = flightResult(readOnlyTurn, {
      status: 'partial',
      completedTask: 'Inspected option 2 in the current filtered results',
      resultSummary: 'The current result context returned only option 1.',
      missingInformation: [],
    }, 'Show option 2 from the filtered flights.');
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
        resultSummary: 'Found three Dubai flights.',
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
  const omitted = finalizeManagerOutput('Day 1: Visit the old town.', state);
  assert.equal(omitted.output.match(/Day 1:/g)?.length, 1);
  assert.match(omitted.output, /Found three flights/);
  assert.doesNotMatch(finalizeManagerOutput('[[render:unknown]]', state).output, /unknown/);
});

/**
 * A Flight specialist that reports a failure with no supporting evidence, so
 * `flightResult` maps it to a `failure` outcome with no presentation. Used by the
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
      resultSummary: GENERIC_SPECIALIST_FAILURE,
    });
  },
  async *getStreamedResponse() { throw new Error('non-streaming expected'); },
};

test('text stream resolves Manager results before emitting user text', async () => {
  const previousMode = process.env.ORCHESTRATION_MODE;
  process.env.ORCHESTRATION_MODE = 'manager';
  try {
    const runner: any = {
      async run(agent: any, _input: string, _options: any) {
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
    const { streamed, completed } = await withSpecialistModel(
      FlightManagerAgent, unevidencedFlightFailure, async () => {
        const run = runGatewayAgentTextStream({
          input: 'What is the cancellation policy?',
          context: makeContext(),
          runner,
          maxTimeoutRecoveries: 0,
        });
        let text = '';
        for await (const chunk of run.stream) text += String(chunk);
        return { streamed: text, completed: await run.completed };
      },
    );
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
    const { streamed, completed } = await withSpecialistModel(
      FlightManagerAgent, unevidencedFlightFailure, async () => {
        const run = runGatewayAgentTextStream({
          input: 'What is the cancellation policy?',
          context: makeContext(),
          runner,
          maxTimeoutRecoveries: 0,
        });
        let text = '';
        for await (const chunk of run.stream) text += String(chunk);
        return { streamed: text, completed: await run.completed };
      },
    );
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
