/**
 * Behavior of the PRODUCTION Flight tool when driven by a real Runner.
 *
 * `tool.invoke()` skips the runner-level output guardrail, so anything about what
 * the Manager actually sees has to go through `Runner.run()` with a stubbed
 * Manager model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { RunContext, Runner, Usage } = await import('@openai/agents');
const { createManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
  GENERIC_SPECIALIST_FAILURE,
} = await import('../../src/agents/manager/tools.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const {
  createRequestContext,
  getScopedRequestText,
} = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext(input: string) {
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
    responseId: 'resp_flight',
  };
}

/** A Flight Agent answer in the shape `flightManagerOutputSchema` requires. */
function flightStructuredAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({
    status: 'success',
    completedTask: 'Searched flights',
    resultSummary: 'Found options.',
    missingInformation: [],
    ...fields,
  }));
}

/** Simulates a Flight tool writing results into shared state. */
function seedFlightResults(appContext: any, tool: string, count = 2) {
  appContext.flight.searchResults = Array.from({ length: count },
    (_value, index) => ({ id: `card-${index}` }));
  appContext.flight.totalResultsFound = count;
  appContext.flight.showFlight = true;
  appContext.toolCallLog.push({ tool, ok: true });
}

/**
 * Drive one Manager turn that calls `flight_agent` once.
 *
 * `respond` receives the live app context, so it can seed shared state the way a
 * real Flight tool would before returning the specialist's structured answer.
 */
async function runFlightTurn(
  respond: (appContext: any) => unknown,
  { subtask = 'Find flights to Dubai', managerText = 'Here are your options.' } = {},
) {
  const appContext = makeContext('Find flights to Dubai');
  const state = createManagerTurnState(appContext, 'manager-request');
  const original = (FlightManagerAgent as any).model;
  const managerInputs: string[] = [];

  try {
    (FlightManagerAgent as any).model = {
      async getResponse() { return respond(appContext); },
      async *getStreamedResponse() { throw new Error('non-streaming expected'); },
    };

    let managerCalls = 0;
    const managerModel: any = {
      async getResponse(request: any) {
        managerCalls += 1;
        managerInputs.push(JSON.stringify(request.input));
        return managerCalls === 1
          ? {
            usage: new Usage(),
            output: [{
              type: 'function_call', callId: 'call_flight', name: 'flight_agent',
              arguments: JSON.stringify({ input: subtask }), status: 'completed',
            }],
            responseId: 'resp_manager_1',
          }
          : modelAnswer(managerText);
      },
    };

    const manager = createManagerAgent(createManagerTools(state)).clone({ model: managerModel });
    const result = await new Runner({ model: managerModel, tracingDisabled: true }).run(
      manager, 'Find flights to Dubai',
      { context: sdkContext(appContext), maxTurns: 6 },
    );

    const seen = managerInputs[1]
      ? JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result')
      : null;

    return {
      state,
      appContext,
      toolOutput: String(seen?.output?.text ?? ''),
      composed: finalizeManagerOutput(String(result.finalOutput), state),
    };
  } finally {
    (FlightManagerAgent as any).model = original;
  }
}

test('Flight runs as a direct agent tool: cards and the price note follow real evidence', async () => {
  const { toolOutput, composed } = await runFlightTurn((appContext) => {
    seedFlightResults(appContext, 'flight_search', 2);
    return flightStructuredAnswer({
      completedTask: 'Searched flights to Dubai',
      resultSummary: 'Found two Dubai options. Note: Prices shown are per person.',
    });
  });

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.presentation, 'flight_cards_with_price_note');
  assert.equal(parsed.userRelevantData.resultCount, 2);
  // Card payloads never reach the Manager, and the note is not duplicated there.
  assert.doesNotMatch(toolOutput, /card-0|card-1/);
  assert.doesNotMatch(toolOutput, /Prices shown are per person/);

  assert.equal(composed.renderFlightOptions, true);
  assert.equal(composed.output.match(/Note: Prices shown are per person\./g)?.length, 1);
  assert.deepEqual(composed.specialistsUsed, ['flight_agent']);
});

test('a failed Flight run reaches the Manager as one generic line and draws no cards', async () => {
  const { state, toolOutput, composed } = await runFlightTurn(() => {
    throw new Error('FLIGHT_INTERNAL_DETAIL_SHOULD_NOT_LEAK');
  }, { managerText: 'That flight search could not be completed.' });

  assert.equal(toolOutput, GENERIC_SPECIALIST_FAILURE);
  assert.doesNotMatch(toolOutput, /FLIGHT_INTERNAL_DETAIL_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(toolOutput, /An error occurred while running the tool/);

  assert.equal(state.outcomes.length, 1);
  assert.equal(state.outcomes[0].result.status, 'failure');
  assert.equal(state.outcomes[0].input, 'Find flights to Dubai');
  assert.equal(composed.renderFlightOptions, false);
});

test('a claimed Flight success with no evidence is downgraded, not shown as cards', async () => {
  // Claims success, but nothing landed in shared state.
  const { state, toolOutput, composed } = await runFlightTurn(
    () => flightStructuredAnswer({ resultSummary: 'Found three great flights.' }),
  );

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'failure');
  assert.equal(parsed.recovery.code, 'UNVERIFIED_FLIGHT_RESULT');
  assert.doesNotMatch(parsed.summary, /three great flights/);
  assert.equal(parsed.presentation, undefined);
  assert.equal(composed.renderFlightOptions, false);
  assert.equal(state.outcomes[0].result.status, 'failure');
});

test('a filter-only Flight turn shows cards without the search price note', async () => {
  const { toolOutput, composed } = await runFlightTurn((appContext) => {
    seedFlightResults(appContext, 'apply_filter', 1);
    return flightStructuredAnswer({
      completedTask: 'Applied the nonstop filter',
      resultSummary: 'One nonstop option remains.',
    });
  }, { subtask: 'Show nonstop flights only', managerText: 'One nonstop option remains.' });

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.presentation, 'flight_cards');
  assert.equal(composed.renderFlightOptions, true);
  assert.doesNotMatch(composed.output, /Prices shown are per person/);
});

test('the Flight filter reads the scoped subtask, not the whole user turn', async () => {
  // Mirrors what apply_filter does via getScopedRequestText: on a mixed request
  // only the flight half may reach the filter parser.
  const appContext = makeContext('Remove all filters and plan my Dubai trip');
  const state = createManagerTurnState(appContext, 'manager-request');
  const original = (FlightManagerAgent as any).model;
  const originalInstructions = (FlightManagerAgent as any).instructions;
  let scopedText = '';

  try {
    (FlightManagerAgent as any).instructions = (nested: any) => {
      scopedText = getScopedRequestText(nested, appContext.currentUserMessage);
      return 'Reply.';
    };
    (FlightManagerAgent as any).model = {
      async getResponse() { return flightStructuredAnswer(); },
    };
    const flightTool: any = createManagerTools(state)
      .find((item: any) => item.name === 'flight_agent');
    await flightTool.invoke(sdkContext(appContext), JSON.stringify({ input: 'Remove all filters' }));
  } finally {
    (FlightManagerAgent as any).model = original;
    (FlightManagerAgent as any).instructions = originalInstructions;
  }

  assert.equal(scopedText, 'Remove all filters');
  assert.doesNotMatch(scopedText, /plan my Dubai trip/);
  // Shared state is untouched, so a standalone Flight run still reads the whole turn.
  assert.equal(appContext.currentUserMessage, 'Remove all filters and plan my Dubai trip');
});

test('standalone Flight falls back to the turn message when there is no scoped input', () => {
  // No agent-tool wrapper, so there is no `toolInput`: the fallback must apply.
  assert.equal(getScopedRequestText({}, 'Remove all filters'), 'Remove all filters');
  assert.equal(getScopedRequestText(undefined, 'Remove all filters'), 'Remove all filters');
  assert.equal(getScopedRequestText({ toolInput: {} }, 'Remove all filters'), 'Remove all filters');
  // A blank scoped value is not a usable subtask either.
  assert.equal(getScopedRequestText({ toolInput: { input: '   ' } }, 'Turn message'), 'Turn message');
  // When both exist, the scoped subtask wins.
  assert.equal(getScopedRequestText({ toolInput: { input: 'Scoped' } }, 'Turn message'), 'Scoped');
});
