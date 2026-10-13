/** Offline checks for native Manager -> Flight failure feedback and turn isolation. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Agent, Runner, Usage } = await import('@openai/agents');
const { flightAgentAsTool } = await import('../../src/agents/manager/specialists/flight.js');
const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { buildGatewayContext } = await import('../../src/agents/manager-orchestrator/runner.js');
const { createRequestContext } = await import('../../src/shared/runtime/request-context.js');
const { createRequestClock } = await import('../../src/shared/time/request-clock.js');

function answer(text: string) {
  return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }], responseId: 'resp_mock' };
}
function state(requestId = 'recovery-request') {
  return buildGatewayContext({ context: {}, input: 'Find Delhi to London flights',
    requestId, sessionId: 'recovery-session' });
}
function visibleResults(appContext: ReturnType<typeof state>) {
  appContext.flight.searchKey = 'current-search';
  appContext.flight.searchResults = [{ id: 'option-1', display: true }];
  appContext.flight.showFlight = true;
}

async function runManager(
  appContext: ReturnType<typeof state>,
  flightResponse: (request: any) => unknown | Promise<unknown>,
  repeat = false,
) {
  let managerCalls = 0;
  let flightCalls = 0;
  const toolOutputs: string[] = [];
  const manager = new Agent({ name: 'Recovery test Manager', instructions: 'Delegate to Flight.',
    tools: [flightAgentAsTool], model: { async getResponse(request: any) {
      managerCalls += 1;
      toolOutputs.length = 0;
      for (const item of request.input) {
        if (item.type === 'function_call_result') toolOutputs.push(String(item.output.text));
      }
      return managerCalls === 1 || (repeat && managerCalls === 2)
        ? { usage: new Usage(), output: [{ type: 'function_call', name: 'flight_agent',
          callId: `flight_${managerCalls}`, arguments: JSON.stringify({ input: 'Find the requested flights' }),
          status: 'completed' }], responseId: `resp_manager_${managerCalls}` }
        : answer('Final Manager answer.');
    } } as any,
  });
  const runner = new Runner({ tracingDisabled: true, modelProvider: {
    async getModel() { return { async getResponse(request: any) {
      flightCalls += 1;
      return flightResponse(request);
    } } as any; },
  } });
  await runner.run(manager, appContext.currentUserMessage as string, {
    context: createRequestContext(appContext,
      createRequestClock({ now: '2026-10-08T10:00:00Z', timeZone: 'UTC' })), maxTurns: 6,
  });
  return { toolOutputs, flightCalls };
}

const validFeedback = {
  status: 'success', completedTask: 'Answered the request.', summary: 'Verified flight facts.',
  findings: [], limitations: [], missingInformation: [], nextStep: null, presentation: null,
};

test('schema-valid Flight feedback passes unchanged, including business failures', async () => {
  for (const status of ['success', 'failure']) {
    const raw = JSON.stringify({ ...validFeedback, status }, null, 2);
    const result = await runManager(state(), () => answer(raw), true);
    assert.equal(result.flightCalls, 2, 'a valid business outcome must not latch execution failure');
    assert.deepEqual(result.toolOutputs, [raw, raw]);
  }
});

test('native exception becomes clean failure feedback and blocks reopened Flight this turn', async () => {
  const appContext = state();
  visibleResults(appContext);
  appContext.toolCallLog.push({ tool: 'flight_search', ok: true });
  const result = await runManager(appContext, () => { throw new Error('PRIVATE_TRANSPORT_ERROR'); }, true);
  assert.equal(result.flightCalls, 1);
  assert.equal(result.toolOutputs.length, 2);
  assert.equal(result.toolOutputs[0], result.toolOutputs[1]);
  const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
  assert.equal(feedback.status, 'failure');
  assert.deepEqual(feedback.findings, []);
  assert.deepEqual(feedback.missingInformation, []);
  assert.equal(feedback.presentation, null, 'historical visible cards are not new completion evidence');
  assert.doesNotMatch(result.toolOutputs[0], /PRIVATE_TRANSPORT_ERROR|Error:|flight_search|searchKey/);
  assert.equal(appContext.flight.searchKey, 'current-search');
});

test('confirmed current search and filter work survives later failure without replay', async () => {
  const appContext = state();
  const result = await runManager(appContext, () => {
    visibleResults(appContext);
    appContext.flight.suggestedQuestions = ['A completed suggestion'];
    appContext.toolCallLog.push({ tool: 'flight_search', ok: true, searchKey: 'current-search' },
      { tool: 'apply_filter', ok: true, searchKey: 'current-search' },
      { tool: 'update_flight_suggested_questions', ok: true });
    throw new Error('failed after completed tools');
  }, true);
  const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
  assert.equal(feedback.status, 'partial');
  assert.equal(feedback.presentation, 'flight_cards_with_price_note');
  assert.equal(feedback.findings.length, 2);
  assert.equal(appContext.toolCallLog.length, 3);
  assert.deepEqual(appContext.flight.suggestedQuestions, ['A completed suggestion']);
  assert.equal(result.flightCalls, 1);
});

test('filter-only completion uses existing cards, while read-only retrieval creates no card claim', async () => {
  for (const tool of ['apply_filter', 'getGeneratedContractsContext']) {
    const appContext = state();
    visibleResults(appContext);
    const result = await runManager(appContext, () => {
      appContext.toolCallLog.push({ tool, ok: true, mode: 'read' });
      return answer('unusable structured output');
    });
    const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
    assert.equal(feedback.status, 'partial');
    assert.equal(feedback.presentation, tool === 'apply_filter' ? 'flight_cards' : null);
  }
});

test('empty or wholly hidden results never request cards after interrupted search', async () => {
  for (const results of [[], [{ id: 'hidden', display: false }]]) {
    const appContext = state();
    const result = await runManager(appContext, () => {
      visibleResults(appContext);
      appContext.flight.searchResults = results;
      appContext.toolCallLog.push({ tool: 'flight_search', ok: true });
      throw new Error('cannot finish');
    });
    const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
    assert.equal(feedback.status, 'partial');
    assert.equal(feedback.presentation, null);
  }
});

test('suggestions-only success is not fulfillment of the flight task', async () => {
  const appContext = state();
  const result = await runManager(appContext, () => {
    appContext.toolCallLog.push({ tool: 'update_flight_suggested_questions', ok: true });
    throw new Error('cannot finish');
  });
  const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
  assert.equal(feedback.status, 'failure');
  assert.deepEqual(feedback.findings, []);
});

test('only a newly completed successful prediction is recovery evidence', async () => {
  for (const changed of [false, true]) {
    const appContext = state();
    const prediction = { ok: true, status: 'SUCCESS', predictions: [{ departureDate: '2026-10-10' }] };
    appContext.flight.lastPricePrediction = prediction;
    const result = await runManager(appContext, () => {
      if (changed) appContext.flight.lastPricePrediction = { ...prediction };
      throw new Error('cannot finish');
    });
    const feedback = flightManagerOutputSchema.parse(JSON.parse(result.toolOutputs[0]));
    assert.equal(feedback.status, changed ? 'partial' : 'failure');
    assert.equal(feedback.presentation, null);
    assert.equal(feedback.findings.length, changed ? 1 : 0);
    assert.doesNotMatch(result.toolOutputs[0], /cheapest|2026-10-10/);
  }
});

test('failure latch ends at the next Manager request and does not cross concurrent contexts', async () => {
  const appContext = state();
  await runManager(appContext, () => { throw new Error('cannot finish'); }, true);
  const nextTurn = await runManager(appContext, () => answer(JSON.stringify(validFeedback)));
  assert.equal(nextTurn.flightCalls, 1, 'the new request wrapper must reset recovery');
  const [failed, successful] = await Promise.all([
    runManager(state('request-a'), () => { throw new Error('cannot finish'); }, true),
    runManager(state('request-b'), () => answer(JSON.stringify(validFeedback)), true),
  ]);
  assert.equal(failed.flightCalls, 1);
  assert.equal(successful.flightCalls, 2);
});
