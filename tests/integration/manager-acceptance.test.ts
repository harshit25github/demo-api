/**
 * The acceptance scenarios for the Manager refactor, end to end through a real
 * Runner with only the models stubbed.
 *
 * Covers the request shapes that exercise the seams the refactor moved: a
 * dependent Flight -> Trip request, a mixed in-scope/out-of-scope request,
 * filter clearing through the scoped tool input, a second turn over persisted
 * context, and terminal error handling for abort and Manager max turns.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { MaxTurnsExceededError, RunContext, Runner, Usage } = await import('@openai/agents');
const { createManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { runGatewayAgentTextStream } = await import('../../src/agents/manager-orchestrator/streaming.js');
const {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
  GENERIC_SPECIALIST_FAILURE,
} = await import('../../src/agents/manager/tools.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { TripPlannerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { ApplyFilterTool: ApplyFilterToolDefinition } = await import('../../src/agents/flight/tools/index.js');
const { createProdFlightContext } = await import('../../src/agents/flight/context/flight-context.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

const ApplyFilterTool: any = ApplyFilterToolDefinition;

/** The tool returns either a JSON string or an object, depending on the path. */
function parseToolResult(result: unknown): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function makeContext(input: string, seed: Record<string, unknown> = {}) {
  return buildGatewayContext({
    context: seed,
    input,
    requestId: 'acceptance-request',
    sessionId: 'acceptance-session',
  });
}

function sdkContext(appContext: unknown) {
  return new RunContext(createRequestContext(
    appContext as object,
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
    responseId: 'resp_acceptance',
  };
}

function flightStructuredAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({
    status: 'success',
    completedTask: 'Searched flights',
    resultSummary: 'Found options.',
    missingInformation: [],
    ...fields,
  }));
}

function toolCallResponse(calls: Array<{ name: string; input: string; callId: string }>) {
  return {
    usage: new Usage(),
    output: calls.map(({ name, input, callId }) => ({
      type: 'function_call', callId, name,
      arguments: JSON.stringify({ input }), status: 'completed',
    })),
    responseId: `resp_manager_${calls[0].callId}`,
  };
}

/**
 * Run one Manager turn with scripted specialist behavior.
 *
 * `script` returns, for each Manager model call, either the tool calls to make or
 * the final text. The specialist models are replaced for the duration.
 */
async function runManagerTurn({
  input,
  seed = {},
  script,
  flight,
  trip,
  signal,
}: {
  input: string;
  seed?: Record<string, unknown>;
  script: (call: number, state: any) => any;
  flight?: (appContext: any) => unknown;
  trip?: (appContext: any) => unknown;
  signal?: AbortSignal;
}) {
  const appContext = makeContext(input, seed);
  const state = createManagerTurnState(appContext, 'acceptance-request');
  const originalFlight = (FlightManagerAgent as any).model;
  const originalTrip = (TripPlannerAgent as any).model;
  const managerInputs: string[] = [];

  try {
    if (flight) {
      (FlightManagerAgent as any).model = {
        async getResponse() { return flight(appContext); },
      };
    }
    if (trip) {
      (TripPlannerAgent as any).model = {
        async getResponse() { return trip(appContext); },
      };
    }

    let managerCalls = 0;
    const managerModel: any = {
      async getResponse(request: any) {
        managerCalls += 1;
        managerInputs.push(JSON.stringify(request.input));
        return script(managerCalls, state);
      },
    };

    const manager = createManagerAgent(createManagerTools(state)).clone({ model: managerModel });
    const result = await new Runner({
      model: managerModel,
      tracingDisabled: true,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    }).run(manager, input, { context: sdkContext(appContext), maxTurns: 8, signal });

    const toolResults = managerInputs.flatMap((raw) => {
      try {
        return JSON.parse(raw).filter((item: any) => item.type === 'function_call_result');
      } catch { return []; }
    });

    return {
      state,
      appContext,
      managerInputs,
      toolResults: toolResults.map((item: any) => String(item.output?.text ?? '')),
      composed: finalizeManagerOutput(String(result.finalOutput), state),
    };
  } finally {
    (FlightManagerAgent as any).model = originalFlight;
    (TripPlannerAgent as any).model = originalTrip;
  }
}

test('a dependent Flight then Trip request runs in order and composes once', async () => {
  const plan = 'Day 1: Dubai Creek and local food.\nDay 2: museums and beaches.';
  const { state, toolResults, composed } = await runManagerTurn({
    input: 'Find flights to Dubai on 20 October, then plan what to do there',
    script: (call, state) => {
      if (call === 1) {
        return toolCallResponse([
          { name: 'flight_agent', input: 'Find flights to Dubai on 20 October', callId: 'c1' },
        ]);
      }
      if (call === 2) {
        // The Trip subtask carries the confirmed flight facts the plan depends on.
        return toolCallResponse([
          { name: 'trip_planner_agent', input: 'Plan Dubai activities for a 20 October arrival', callId: 'c2' },
        ]);
      }
      const ref = [...state.renders.keys()][0];
      return modelAnswer(`Found two Dubai flights for 20 October.\n\n[[render:${ref}]]`);
    },
    flight: (appContext) => {
      appContext.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      appContext.flight.totalResultsFound = 2;
      appContext.flight.showFlight = true;
      appContext.flight.outboundDate = '2026-10-20';
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true });
      return flightStructuredAnswer({
        completedTask: 'Searched Dubai flights for 20 October',
        resultSummary: 'Found two Dubai options for 20 October.',
      });
    },
    trip: () => modelAnswer(plan),
  });

  // Ordered, one call each.
  assert.deepEqual(state.outcomes.map((item) => item.name), ['flight_agent', 'trip_planner_agent']);
  assert.equal(state.outcomes[1].input, 'Plan Dubai activities for a 20 October arrival');

  // The Trip subtask ran against the flight facts already in shared state.
  assert.equal(state.outcomes[0].result.userRelevantData?.outboundDate, '2026-10-20');

  // Both results stayed compact; the plan body never entered the Manager context.
  for (const output of toolResults) {
    assert.ok(output.length < 300, `tool result too large: ${output.length}`);
    assert.doesNotMatch(output, /museums and beaches/);
  }

  // One composition: flight prose once, plan once, price note once.
  assert.equal(composed.output.match(/Found two Dubai flights/g)?.length, 1);
  assert.equal(composed.output.match(/Day 1: Dubai Creek/g)?.length, 1);
  assert.equal(composed.output.match(/Note: Prices shown are per person\./g)?.length, 1);
  assert.equal(composed.renderFlightOptions, true);
  assert.deepEqual(composed.specialistsUsed, ['flight_agent', 'trip_planner_agent']);
});

test('a mixed in-scope and out-of-scope request answers only the in-scope parts', async () => {
  const { state, toolResults, composed } = await runManagerTurn({
    input: 'Find flights to Dubai and book me a hotel and airport taxi',
    script: (call, state) => {
      if (call === 1) {
        return toolCallResponse([
          { name: 'flight_agent', input: 'Find flights to Dubai', callId: 'c1' },
        ]);
      }
      if (call === 2) {
        return toolCallResponse([
          { name: 'trip_planner_agent', input: 'Suggest Dubai things to do', callId: 'c2' },
        ]);
      }
      const ref = [...state.renders.keys()][0];
      return modelAnswer(`Found two Dubai flights.\n\n${ref ? `[[render:${ref}]]` : ''}`);
    },
    flight: (appContext) => {
      appContext.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      appContext.flight.totalResultsFound = 2;
      appContext.flight.showFlight = true;
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true });
      return flightStructuredAnswer({ resultSummary: 'Found two Dubai options.' });
    },
    // The Trip Planner drifts out of scope; the scope filter must catch it.
    trip: () => modelAnswer('Day 1: Dubai Creek.\nBook a hotel downtown and take a taxi from the airport.'),
  });

  // The out-of-scope content never reaches the stored plan or the final answer.
  const tripOutcome = state.outcomes.find((item) => item.name === 'trip_planner_agent');
  assert.equal(tripOutcome?.result.status, 'partial');
  assert.doesNotMatch(composed.output, /hotel|taxi/i);
  assert.doesNotMatch(toolResults.join(' '), /hotel|taxi/i);

  // The in-scope flight half still answered fully.
  assert.match(composed.output, /Found two Dubai flights/);
  assert.equal(composed.renderFlightOptions, true);
});

test('filter clearing uses the scoped subtask, not the whole mixed turn', async () => {
  let sequence = 0;
  const filterContext = () => {
    sequence += 1;
    return {
      requestId: 'acceptance-request',
      sessionId: 'acceptance-session',
      toolCallLog: [],
      // On a mixed turn the shared message holds far more than the filter clause.
      currentUserMessage: 'Remove all filters and plan my Dubai trip',
      flight: createProdFlightContext({
        flight: {
          uid: 'acceptance-user',
          searchKey: `search-acceptance-${sequence}`,
          searchResults: [],
        },
      }),
    };
  };

  // A dummy filter the model supplies; a recognised clear-all request replaces it.
  const suppliedFilter = {
    filterType: 'stops', filterCode: '0',
    minDurationMinutes: null, maxDurationMinutes: null,
    minPrice: null, maxPrice: null,
    airlineNames: null, layoverAirportNames: null,
    departureAirportNames: null, arrivalAirportNames: null,
    rawUserFilter: null,
  };

  // Scoped to the flight clause: the clear-all request is recognised.
  const scoped = parseToolResult(await ApplyFilterTool.invoke(
    { context: filterContext(), toolInput: { input: 'Remove all filters' } },
    JSON.stringify({ filters: [suppliedFilter] }),
    {},
  ));
  assert.ok(
    JSON.stringify(scoped).includes('reset'),
    `expected a reset filter from the scoped clear-all request: ${JSON.stringify(scoped).slice(0, 300)}`,
  );

  // Scoped to a narrower clause on the same turn: the mixed shared message must
  // NOT be read as a clear-all, so the supplied filter stands.
  const narrow = parseToolResult(await ApplyFilterTool.invoke(
    { context: filterContext(), toolInput: { input: 'Show nonstop flights only' } },
    JSON.stringify({ filters: [suppliedFilter] }),
    {},
  ));
  assert.doesNotMatch(
    JSON.stringify(narrow.finalFilterPayload ?? narrow),
    /"filterType":"reset"/,
    'a narrow subtask must not trigger clear-all from the shared turn message',
  );
});

test('a second turn keeps persisted context but scopes evidence to itself', async () => {
  // Turn one searches and leaves results plus a tool-log entry behind.
  const first = await runManagerTurn({
    input: 'Find flights to Dubai',
    script: (call) => (call === 1
      ? toolCallResponse([{ name: 'flight_agent', input: 'Find flights to Dubai', callId: 'c1' }])
      : modelAnswer('Found two Dubai flights.')),
    flight: (appContext) => {
      appContext.flight.searchResults = [{ id: 'f1' }, { id: 'f2' }];
      appContext.flight.totalResultsFound = 2;
      appContext.flight.showFlight = true;
      appContext.flight.outboundDate = '2026-10-20';
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true });
      return flightStructuredAnswer({ resultSummary: 'Found two Dubai options.' });
    },
  });
  assert.equal(first.composed.renderFlightOptions, true);
  assert.equal(first.state.outcomes[0].result.presentation, 'flight_cards_with_price_note');

  // Turn two reuses that context and answers from it without running a tool.
  const second = await runManagerTurn({
    input: 'What date did you find?',
    seed: first.appContext as any,
    script: () => modelAnswer('The options I found are for 20 October.'),
  });

  // Persisted state survived the turn boundary.
  assert.equal((second.appContext as any).flight.outboundDate, '2026-10-20');
  assert.equal((second.appContext as any).flight.searchResults.length, 2);

  // The new turn's watermark is past the earlier entry, so last turn's search is
  // not re-counted as this turn's evidence: no specialist ran, so no cards.
  assert.ok(second.state.turnStart.toolCallLogLength >= 1);
  assert.deepEqual(second.state.outcomes, []);
  assert.equal(second.composed.renderFlightOptions, false);
  assert.doesNotMatch(second.composed.output, /Prices shown are per person/);
});

test('a client abort surfaces as a terminal error, not a partial answer', async () => {
  const controller = new AbortController();
  const appContext = makeContext('Find flights to Dubai');
  const original = (FlightManagerAgent as any).model;

  try {
    (FlightManagerAgent as any).model = {
      async getResponse() {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return flightStructuredAnswer();
      },
    };

    const run = runGatewayAgentTextStream({
      input: 'Find flights to Dubai',
      context: appContext,
      signal: controller.signal,
      runner: {
        async run(agent: any, _input: unknown, options: any) {
          const flight = agent.tools.find((item: any) => item.name === 'flight_agent');
          await flight.invoke(sdkContext(appContext), JSON.stringify({ input: 'Find flights' }));
          options.signal?.throwIfAborted();
          return { finalOutput: 'unused', lastResponseId: null, rawResponses: [] };
        },
      } as any,
    });

    await assert.rejects(() => run.completed);
    let streamed = '';
    await assert.rejects(async () => {
      for await (const chunk of run.stream) streamed += String(chunk);
    });
    assert.equal(streamed, '', 'no partial answer may be emitted after an abort');
  } finally {
    (FlightManagerAgent as any).model = original;
  }
});

test('Manager max turns surfaces as a terminal error, not a partial answer', async () => {
  const appContext = makeContext('Find flights to Dubai');
  const failure = new MaxTurnsExceededError('Manager turn limit reached');

  const run = runGatewayAgentTextStream({
    input: 'Find flights to Dubai',
    context: appContext,
    runner: { async run() { throw failure; } } as any,
  });

  await assert.rejects(() => run.completed, (error: unknown) => error === failure);
  await assert.rejects(async () => { for await (const _chunk of run.stream) { /* drain */ } });
});

test('no SDK error wording can reach the Manager from either specialist', async () => {
  for (const specialist of ['flight_agent', 'trip_planner_agent'] as const) {
    const { toolResults, state } = await runManagerTurn({
      input: 'Find flights to Dubai and plan my trip',
      script: (call) => (call === 1
        ? toolCallResponse([{ name: specialist, input: 'Do the work', callId: 'c1' }])
        : modelAnswer('I could not complete that part.')),
      flight: () => { throw new Error('INTERNAL_FLIGHT_DETAIL'); },
      trip: () => { throw new Error('INTERNAL_TRIP_DETAIL'); },
    });

    assert.equal(toolResults.length, 1, `${specialist}: expected one tool result`);
    assert.equal(toolResults[0], GENERIC_SPECIALIST_FAILURE, `${specialist}: not the generic line`);
    assert.doesNotMatch(toolResults[0], /INTERNAL_(FLIGHT|TRIP)_DETAIL/);
    assert.doesNotMatch(toolResults[0], /An error occurred while running the tool|MaxTurnsExceeded|Error:/);
    assert.equal(state.outcomes[0].result.status, 'failure', `${specialist}: outcome not recorded`);
  }
});
