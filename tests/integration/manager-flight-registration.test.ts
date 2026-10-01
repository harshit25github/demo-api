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
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const {
  beginFlightSuggestionTurn,
  finalizeFlightSuggestedQuestions,
  markFlightSuggestionRun,
} = await import('../../src/agents/flight/tools/suggested-questions-tool.js');
const {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
  GENERIC_SPECIALIST_FAILURE,
} = await import('../../src/agents/manager/tools.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const {
  createRequestContext,
  getRequestState,
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
    summary: 'Found options.',
    findings: [],
    limitations: [],
    missingInformation: [],
    nextStep: null,
    presentation: null,
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
  {
    subtask = 'Find flights to Dubai',
    managerText = 'Here are your options.',
    prepare,
  }: { subtask?: string; managerText?: string; prepare?: (appContext: any) => void } = {},
) {
  const appContext = makeContext('Find flights to Dubai');
  prepare?.(appContext);
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

test('Flight feedback passes through the SDK; the Manager writes the response', async () => {
  const { toolOutput, composed } = await runFlightTurn((appContext) => {
    seedFlightResults(appContext, 'flight_search', 2);
    return flightStructuredAnswer({
      completedTask: 'Searched flights to Dubai',
      summary: 'Found two Dubai options.',
      findings: ['Two matching Dubai flights.'],
      presentation: 'flight_cards_with_price_note',
    });
  }, { managerText: 'Here are your two Dubai options. Note: Prices shown are per person.' });

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.presentation, 'flight_cards_with_price_note');
  assert.deepEqual(parsed.findings, ['Two matching Dubai flights.']);
  assert.equal('userRelevantData' in parsed, false);
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

test('Flight Agent status reaches the Manager; cards require current results', async () => {
  const { state, toolOutput, composed } = await runFlightTurn(
    () => flightStructuredAnswer({ summary: 'Found three great flights.' }),
  );

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.equal('recovery' in parsed, false);
  assert.match(parsed.summary, /three great flights/);
  assert.equal(parsed.presentation, null);
  assert.equal(composed.renderFlightOptions, false);
  assert.equal(state.outcomes[0].result.status, 'success');
});

test('a filter-only Flight turn shows cards without the search price note', async () => {
  const { toolOutput, composed } = await runFlightTurn((appContext) => {
    seedFlightResults(appContext, 'apply_filter', 1);
    return flightStructuredAnswer({
      completedTask: 'Applied the nonstop filter',
      summary: 'One nonstop option remains.',
      presentation: 'flight_cards',
    });
  }, { subtask: 'Show nonstop flights only', managerText: 'One nonstop option remains.' });

  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.presentation, 'flight_cards');
  assert.equal(composed.renderFlightOptions, true);
  assert.doesNotMatch(composed.output, /Prices shown are per person/);
});

test('rich Flight feedback reaches the Manager unchanged across task outcomes', async (t) => {
  const cases = [
    {
      name: 'unavailable option',
      feedback: {
        status: 'partial',
        completedTask: 'Checked the requested option in the filtered results',
        summary: 'Option 2 is unavailable in the current results.',
        findings: ['One option is available for NYC to London on 5 November.'],
        limitations: ['The requested option cannot be compared with the current selection.'],
        missingInformation: [],
        nextStep: 'Offer to remove the current filters and show the earlier options.',
        presentation: null,
      },
      answer: 'Only one option remains. Would you like me to remove the filters?',
    },
    {
      name: 'new date needed',
      feedback: {
        status: 'needs_input',
        completedTask: 'Identified the requested departure-date change',
        summary: 'The new departure date is needed before changing the search.',
        findings: ['The existing departure date is 5 November.'],
        limitations: [],
        missingInformation: ['New departure date'],
        nextStep: 'Ask which date should replace the existing departure date.',
        presentation: null,
      },
      answer: 'What date would you like to fly instead?',
    },
    {
      name: 'price comparison unavailable',
      feedback: {
        status: 'failure',
        completedTask: 'Checked cheaper dates for the current trip',
        summary: 'A cheaper travel date could not be verified.',
        findings: ['The current trip is NYC to London on 5 November.'],
        limitations: ['There is no verified cheaper-date recommendation to offer.'],
        missingInformation: [],
        nextStep: null,
        presentation: null,
      },
      answer: 'I could not verify a cheaper date for your trip.',
    },
    {
      name: 'search with no matches',
      feedback: {
        status: 'success',
        completedTask: 'Searched the requested route and date',
        summary: 'No matching flights were found.',
        findings: ['Zero matching flights for NYC to London on 5 November.'],
        limitations: [],
        missingInformation: [],
        nextStep: 'Offer to search a nearby date.',
        presentation: null,
      },
      answer: 'No flights matched. Would you like to try a nearby date?',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { state, toolOutput, composed } = await runFlightTurn((appContext) => {
        // Stored dates, tool success, and prediction failure must not rebuild feedback.
        appContext.flight.outboundDate = '2026-11-05';
        appContext.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' };
        seedFlightResults(appContext, 'flight_search', scenario.name === 'search with no matches' ? 0 : 1);
        return modelAnswer(JSON.stringify(scenario.feedback));
      }, { subtask: scenario.name, managerText: scenario.answer });

      assert.deepEqual(JSON.parse(toolOutput), scenario.feedback);
      assert.deepEqual(state.outcomes[0].result, scenario.feedback);
      assert.equal(composed.output, scenario.answer);
      assert.equal(composed.renderFlightOptions, false);
    });
  }
});

test('finalization does not manufacture a user reply or price note from Flight feedback', async () => {
  const { state, composed } = await runFlightTurn((appContext) => {
    seedFlightResults(appContext, 'flight_search');
    return flightStructuredAnswer({ presentation: 'flight_cards_with_price_note' });
  }, { managerText: 'Here are your options.' });

  assert.equal(composed.output, 'Here are your options.');
  assert.equal(finalizeManagerOutput('', state).output, '');
  assert.equal(composed.renderFlightOptions, true);
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

const SHOWN_LAST_TURN = ['Show nonstop flights only', 'Which option is fastest?', 'Any cheaper dates nearby?'];

/** A Manager turn that starts with an active search and last turn's suggestions on screen. */
function withShownSuggestions(appContext: any) {
  appContext.flight.searchKey = 'manager-active-search';
  appContext.flight.suggestedQuestions = [...SHOWN_LAST_TURN];
  beginFlightSuggestionTurn(appContext, { flightRan: false });
}

test('a Flight run that writes no suggestions marks the turn, so finalize drops the stale ones', async () => {
  const { appContext } = await runFlightTurn(() => flightStructuredAnswer(), {
    prepare: withShownSuggestions,
  });

  assert.deepEqual(appContext.flight.suggestedQuestions, SHOWN_LAST_TURN);
  const outcome = finalizeFlightSuggestedQuestions(appContext);
  assert.equal(outcome.flightRan, true);
  assert.equal(outcome.cleared, true);
  assert.deepEqual(appContext.flight.suggestedQuestions, []);
});

test('a Flight run that fails is still marked, so its stale suggestions are dropped', async () => {
  const { appContext } = await runFlightTurn(() => {
    throw new Error('FLIGHT_RUN_FAILED');
  }, { prepare: withShownSuggestions, managerText: 'That search could not be completed.' });

  assert.equal(finalizeFlightSuggestedQuestions(appContext).cleared, true);
  assert.deepEqual(appContext.flight.suggestedQuestions, []);
});

test('the Manager turn finalizes suggestions even when the run itself fails', async () => {
  const context: any = {
    flight: { searchKey: 'manager-active-search', suggestedQuestions: [...SHOWN_LAST_TURN] },
  };
  const failingRunner = {
    async run(_agent: unknown, _input: unknown, options: any) {
      markFlightSuggestionRun(getRequestState(options.context));
      throw new Error('MANAGER_RUN_FAILED');
    },
  };

  await assert.rejects(
    runGatewayAgent({
      input: 'Show nonstop flights only',
      requestId: 'manager-failed-turn',
      sessionId: 'manager-session',
      context,
      runner: failingRunner as any,
    }),
    /MANAGER_RUN_FAILED/,
  );
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('a Manager turn that never reaches Flight keeps the suggestions for the active search', async () => {
  const context: any = {
    flight: { searchKey: 'manager-active-search', suggestedQuestions: [...SHOWN_LAST_TURN] },
  };
  const answeringRunner = {
    async run() {
      return { finalOutput: 'You searched for Feb 10.', newItems: [] };
    },
  };

  await runGatewayAgent({
    input: 'What date did I give you?',
    requestId: 'manager-recall-turn',
    sessionId: 'manager-session',
    context,
    runner: answeringRunner as any,
  });
  assert.deepEqual(context.flight.suggestedQuestions, SHOWN_LAST_TURN);
});
