/** Production Flight agent-as-tool registration, using the SDK and deterministic model doubles. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { RunContext, Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { beginFlightSuggestionTurn, finalizeFlightSuggestedQuestions, markFlightSuggestionRun } =
  await import('../../src/agents/flight/tools/suggested-questions-tool.js');
const { flightAgentAsTool } = await import('../../src/agents/manager/tools.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { createRequestContext, getRequestState, getScopedRequestText } =
  await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function makeContext(input: string) {
  return buildGatewayContext({ context: {}, input, requestId: 'manager-request', sessionId: 'manager-session' });
}
function sdkContext(appContext: ReturnType<typeof makeContext>) {
  return new RunContext(createRequestContext(appContext,
    createRequestClock({ now: new Date('2026-09-19T10:00:00Z'), timeZone: 'UTC' })));
}
function modelAnswer(text: string) {
  return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }], responseId: 'resp_flight' };
}
function flightStructuredAnswer(fields: Record<string, unknown> = {}) {
  return modelAnswer(JSON.stringify({ status: 'success', completedTask: 'Searched flights', summary: 'Found options.',
    findings: [], limitations: [], missingInformation: [], nextStep: null, presentation: null, ...fields }));
}
function seedFlightResults(appContext: any, tool: string, count = 2) {
  appContext.flight.searchResults = Array.from({ length: count }, (_value, index) => ({ id: `card-${index}` }));
  appContext.flight.totalResultsFound = count;
  appContext.flight.showFlight = true;
  appContext.toolCallLog.push({ tool, ok: true });
}

async function runFlightTurn(respond: (appContext: any) => unknown,
  { subtask = 'Find flights to Dubai', managerText = 'Here are your options.', prepare }:
  { subtask?: string; managerText?: string; prepare?: (appContext: any) => void } = {}) {
  const appContext = makeContext('Find flights to Dubai');
  prepare?.(appContext);
  const originalManager = ManagerAgent.model;
  const originalFlight = FlightManagerAgent.model;
  const managerInputs: string[] = [];
  try {
    FlightManagerAgent.model = { async getResponse() { return respond(appContext); } } as any;
    ManagerAgent.model = { async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      return managerInputs.length === 1 ? { usage: new Usage(), output: [{ type: 'function_call', callId: 'call_flight',
        name: 'flight_agent', arguments: JSON.stringify({ input: subtask }), status: 'completed' }], responseId: 'resp_manager' }
        : modelAnswer(managerText);
    } } as any;
    const result = await new Runner({ tracingDisabled: true }).run(ManagerAgent, 'Find flights to Dubai',
      { context: sdkContext(appContext), maxTurns: 6 });
    const seen = JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result');
    return { appContext, toolOutput: String(seen.output.text), output: String(result.finalOutput) };
  } finally { ManagerAgent.model = originalManager; FlightManagerAgent.model = originalFlight; }
}

test('SDK default extraction passes Flight structured feedback while private cards stay in client state', async () => {
  const { appContext, toolOutput, output } = await runFlightTurn((state) => {
    seedFlightResults(state, 'flight_search');
    return flightStructuredAnswer({ summary: 'Found two Dubai options.', findings: ['Two matching Dubai flights.'],
      presentation: 'flight_cards_with_price_note' });
  }, { managerText: 'Here are your two Dubai options. Note: Prices shown are per person.' });
  const parsed = JSON.parse(toolOutput);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.presentation, 'flight_cards_with_price_note');
  assert.deepEqual(parsed.findings, ['Two matching Dubai flights.']);
  assert.doesNotMatch(toolOutput, /card-0|card-1|Prices shown are per person/);
  assert.equal(appContext.flight.showFlight, true);
  assert.ok(Array.isArray(appContext.flight.searchResults));
  assert.equal(appContext.flight.searchResults.length, 2);
  assert.equal(output, 'Here are your two Dubai options. Note: Prices shown are per person.');
  assert.doesNotMatch(output, /\[\[render:/);
});

test('Flight feedback presentation and final prose do not decide or overwrite the client render flag', async () => {
  const { appContext, toolOutput, output } = await runFlightTurn((state) => {
    seedFlightResults(state, 'flight_search');
    return flightStructuredAnswer({ presentation: null });
  }, { managerText: 'I have checked the current options.' });
  assert.equal(JSON.parse(toolOutput).presentation, null);
  assert.equal(appContext.flight.showFlight, true);
  assert.equal(output, 'I have checked the current options.');
  const noResults = await runFlightTurn(() => flightStructuredAnswer({ presentation: 'flight_cards_with_price_note' }));
  assert.equal(noResults.appContext.flight.showFlight, false);
  assert.equal(noResults.appContext.flight.searchResults, null);
  assert.equal(noResults.output, 'Here are your options.');
});

test('a filter-only Flight turn preserves shared cards without appending the search price note', async () => {
  const { appContext, toolOutput, output } = await runFlightTurn((state) => {
    seedFlightResults(state, 'apply_filter', 1);
    return flightStructuredAnswer({ completedTask: 'Applied the nonstop filter', summary: 'One nonstop option remains.',
      presentation: 'flight_cards' });
  }, { subtask: 'Show nonstop flights only', managerText: 'One nonstop option remains.' });
  assert.equal(JSON.parse(toolOutput).presentation, 'flight_cards');
  assert.equal(appContext.flight.showFlight, true);
  assert.equal(appContext.flight.totalResultsFound, 1);
  assert.doesNotMatch(output, /Prices shown are per person|\[\[render:/);
});

test('rich Flight feedback passes through unchanged for partial, missing-input, failure, and zero-result outcomes', async (t) => {
  const scenarios = [
    { status: 'partial', completedTask: 'Checked option 2', summary: 'Option 2 is unavailable.',
      findings: ['One option remains.'], limitations: ['The requested option cannot be compared.'],
      missingInformation: [], nextStep: 'Offer to remove filters.', presentation: null },
    { status: 'needs_input', completedTask: 'Identified departure-date change', summary: 'A new date is needed.',
      findings: ['Existing date: 2026-11-05'], limitations: [], missingInformation: ['New departure date'],
      nextStep: 'Ask which date should replace the existing date.', presentation: null },
    { status: 'failure', completedTask: 'Checked cheaper dates', summary: 'No cheaper date could be verified.',
      findings: ['Existing trip: NYC to London on 5 November.'], limitations: ['No verified recommendation.'],
      missingInformation: [], nextStep: null, presentation: null },
    { status: 'success', completedTask: 'Searched route and date', summary: 'No matching flights were found.',
      findings: ['Zero matching flights.'], limitations: [], missingInformation: [],
      nextStep: 'Offer a nearby date.', presentation: null },
  ];
  for (const feedback of scenarios) await t.test(feedback.status + ': ' + feedback.completedTask, async () => {
    const { toolOutput, output } = await runFlightTurn((state) => {
      state.flight.outboundDate = '2026-11-05';
      state.flight.lastPricePrediction = { status: 'NO_PREDICTIONS' };
      return modelAnswer(JSON.stringify(feedback));
    }, { managerText: 'The Manager response is independent of serialization.' });
    assert.deepEqual(JSON.parse(toolOutput), feedback);
    assert.equal(output, 'The Manager response is independent of serialization.');
  });
});

test('the Flight filter reads its scoped subtask rather than the whole mixed user turn', async () => {
  const appContext = makeContext('Remove all filters and plan my Dubai trip');
  const originalModel = FlightManagerAgent.model;
  const originalInstructions = FlightManagerAgent.instructions;
  let scopedText = '';
  try {
    FlightManagerAgent.instructions = ((nested: any) => {
      scopedText = getScopedRequestText(nested, appContext.currentUserMessage); return 'Reply.';
    }) as any;
    FlightManagerAgent.model = { async getResponse() { return flightStructuredAnswer(); } } as any;
    await flightAgentAsTool.invoke(sdkContext(appContext), JSON.stringify({ input: 'Remove all filters' }));
  } finally { FlightManagerAgent.model = originalModel; FlightManagerAgent.instructions = originalInstructions; }
  assert.equal(scopedText, 'Remove all filters');
  assert.equal(appContext.currentUserMessage, 'Remove all filters and plan my Dubai trip');
});

test('standalone Flight retains its fallback when scoped input is absent or blank', () => {
  for (const context of [{}, undefined, { toolInput: {} }, { toolInput: { input: '   ' } }]) {
    assert.equal(getScopedRequestText(context, 'Turn message'), 'Turn message');
  }
  assert.equal(getScopedRequestText({ toolInput: { input: 'Scoped' } }, 'Turn message'), 'Scoped');
});

const SHOWN_LAST_TURN = ['Show nonstop flights only', 'Which option is fastest?', 'Any cheaper dates nearby?'];
function withShownSuggestions(appContext: any) {
  appContext.flight.searchKey = 'manager-active-search';
  appContext.flight.suggestedQuestions = [...SHOWN_LAST_TURN];
  beginFlightSuggestionTurn(appContext, { flightRan: false });
}

test('a singleton Flight run marks existing suggestion lifecycle and stale suggestions are cleared', async () => {
  const { appContext } = await runFlightTurn(() => flightStructuredAnswer(), { prepare: withShownSuggestions });
  assert.deepEqual(appContext.flight.suggestedQuestions, SHOWN_LAST_TURN);
  const outcome = finalizeFlightSuggestedQuestions(appContext);
  assert.equal(outcome.flightRan, true);
  assert.equal(outcome.cleared, true);
  assert.deepEqual(appContext.flight.suggestedQuestions, []);
});

test('a failed nested Flight run is still marked for stale-suggestion clearing', async () => {
  const { appContext } = await runFlightTurn(() => { throw new Error('FLIGHT_RUN_FAILED'); },
    { prepare: withShownSuggestions, managerText: 'That search could not be completed.' });
  assert.equal(finalizeFlightSuggestedQuestions(appContext).cleared, true);
  assert.deepEqual(appContext.flight.suggestedQuestions, []);
});

test('existing Flight suggestion finalization runs even if the Manager throws', async () => {
  const context: any = { flight: { searchKey: 'manager-active-search', suggestedQuestions: [...SHOWN_LAST_TURN] } };
  await assert.rejects(runGatewayAgent({ input: 'Show nonstop flights', context,
    runner: { async run(_agent: unknown, _input: unknown, options: any) {
      markFlightSuggestionRun(getRequestState(options.context)); throw new Error('MANAGER_RUN_FAILED');
    } } as any }), /MANAGER_RUN_FAILED/);
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('Manager-only recall preserves suggestions for the active search', async () => {
  const context: any = { flight: { searchKey: 'manager-active-search', suggestedQuestions: [...SHOWN_LAST_TURN] } };
  await runGatewayAgent({ input: 'What date did I give you?', context,
    runner: { async run() { return { finalOutput: 'You searched for Feb 10.', newItems: [] }; } } as any });
  assert.deepEqual(context.flight.suggestedQuestions, SHOWN_LAST_TURN);
});
