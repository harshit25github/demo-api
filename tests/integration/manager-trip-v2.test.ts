/** Manager -> Trip Planner v2 through the SDK with scripted models: one Trip call, app-rendered view, typed failures. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Runner, Usage } = await import('@openai/agents');
const { createManagerAgent, ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { buildManagerInstructions, buildManagerInstructionsV2, MANAGER_PROMPT, MANAGER_PROMPT_TRIP_V2 } =
  await import('../../src/agents/manager-orchestrator/manager-prompt.js');
const { runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { flightAgentAsTool } = await import('../../src/agents/manager/specialists/flight.js');
const { tripPlannerV2AgentAsTool } = await import('../../src/agents/manager/specialists/trip-planner-v2.js');
const { TripPlannerV2Agent } = await import('../../src/agents/trip-planner-v2/agent.js');
const { TRIP_PLANNER_V2_INSTRUCTIONS } = await import('../../src/agents/trip-planner-v2/prompt.js');
const { tripFeedbackSchema } = await import('../../src/agents/trip-planner-v2/schema.js');

const managerV2 = createManagerAgent({ tripPlannerV2: true });
const NOW = new Date('2026-10-16T14:00:00Z');

function message(text: string) {
  return { usage: new Usage(), responseId: 'resp_text', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }] };
}
function callTrip(input: string, callId = 'call_trip') {
  return { usage: new Usage(), responseId: `resp_${callId}`, output: [{ type: 'function_call', callId, name: 'trip_planner_agent',
    arguments: JSON.stringify({ input }), status: 'completed' }] };
}
const DISCOVERY = {
  status: 'success', intent: 'inspire',
  trip: { origin: null, destination: null, outbound_date: null, return_date: null, duration_days: null, budget: null,
    tripType: { add: ['warm weather', 'budget-conscious'], remove: [] },
    passengerData: { total: 2, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] },
    clear: [] },
  dateHint: 'December 2026',
  options: [
    { code: 'SJU', city: 'San Juan', country: 'Puerto Rico', why: 'Beaches and Old San Juan', bestTime: 'Dec to Apr', cost: '$$' },
    { code: 'CTG', city: 'Cartagena', country: 'Colombia', why: 'Walled city and Caribbean food', bestTime: 'Dec to Apr', cost: '$' },
    { code: 'MID', city: 'Mérida', country: 'Mexico', why: 'Yucatán food and cenotes', bestTime: 'Nov to Mar', cost: '$' },
  ],
  plan: null, facts: null,
  summary: 'Suggested San Juan, Cartagena and Mérida.',
  findings: ['Cartagena and Mérida stretch a budget furthest', 'Assumed about five days'],
  limitations: [], nextStep: 'Which one should I plan?',
  suggestions: ['Compare the food in all three', 'Which has the best beaches?', 'Plan 5 days in Mérida'],
};

async function withModels<T>(manager: any, trip: any, run: () => Promise<T>): Promise<T> {
  const originalManager = managerV2.model;
  const originalTrip = TripPlannerV2Agent.model;
  managerV2.model = manager;
  TripPlannerV2Agent.model = trip;
  try { return await run(); } finally { managerV2.model = originalManager; TripPlannerV2Agent.model = originalTrip; }
}

function runTurn(input: string) {
  return runGatewayAgent({ input, manager: managerV2, runner: new Runner({ tracingDisabled: true }), context: {},
    requestId: 'req-v2', sessionId: 'chat-v2', now: NOW, timeZone: 'America/New_York' });
}

test('the v2 Manager has the v2 Trip tool and prompt; v1 stays the default', () => {
  assert.deepEqual(managerV2.tools, [flightAgentAsTool, tripPlannerV2AgentAsTool]);
  assert.deepEqual(managerV2.tools.map((tool) => tool.name), ['flight_agent', 'trip_planner_agent']);
  assert.notEqual(ManagerAgent.tools[1], tripPlannerV2AgentAsTool);
  assert.match(MANAGER_PROMPT, /formattingRules/);
  assert.doesNotMatch(MANAGER_PROMPT_TRIP_V2, /formattingRules|## Trip markdown|time-block labels|image provenance/);
  for (const section of ['## Trip references', '## Trip: one request, Trip decides the rest', '## Trip feedback', '## Trip replies']) {
    assert.ok(MANAGER_PROMPT_TRIP_V2.includes(section), section);
  }
  // Flight guidance is shared text, not a copy.
  const flightGuidance = MANAGER_PROMPT.slice(MANAGER_PROMPT.indexOf('## Flight: search versus current-result work'), MANAGER_PROMPT.indexOf('## Trip: destination discovery'));
  assert.ok(MANAGER_PROMPT_TRIP_V2.includes(flightGuidance));
  assert.match(buildManagerInstructions({ context: {} }), /Previous trip plan available: no\./);
  assert.match(buildManagerInstructionsV2({ context: {} }), /- Trip options shown: none\.\n- Current trip plan: none\.\n- Last Trip question: none\.\n$/);
});

test('one Trip call: saved trip in its input, compact report to the Manager, cards rendered by the app', async () => {
  const tripRequests: any[] = [];
  const managerInputs: any[] = [];
  const result = await withModels(
    { async getResponse(request: any) {
      managerInputs.push(request.input);
      return managerInputs.length === 1
        ? callTrip('Suggest warm, good-value destinations for December for 2 travelers.')
        : message('Here are three warm, easy-on-the-wallet picks for December ☀️\n\nCartagena and Mérida stretch a budget furthest. Which one should I plan?');
    } },
    { async getResponse(request: any) { tripRequests.push(request); return message(JSON.stringify(DISCOVERY)); } },
    () => runTurn('somewhere warm in december, not too pricey. 2 of us'),
  );

  assert.equal(tripRequests.length, 1);
  const [request] = tripRequests;
  assert.equal(request.systemInstructions, TRIP_PLANNER_V2_INSTRUCTIONS);
  assert.deepEqual(request.tools.map((tool: any) => tool.name), ['web_search']);
  assert.match(request.input[0].content, /^<today>2026-10-16 · America\/New_York<\/today>/);
  assert.match(request.input[0].content, /<traveler_said>somewhere warm in december, not too pricey\. 2 of us<\/traveler_said>$/);
  assert.match(JSON.stringify(request.input.at(-1)), /Suggest warm, good-value destinations/);

  const toolResult = managerInputs[1].find((item: any) => item.type === 'function_call_result');
  const feedback = tripFeedbackSchema.parse(JSON.parse(toolResult.output.text));
  assert.equal(feedback.presentation, 'trip_options');
  assert.ok(toolResult.output.text.length < 600, `report is ${toolResult.output.text.length} chars`);
  assert.doesNotMatch(toolResult.output.text, /formattingRules|https?:/);

  const [lead, cards, rest] = result.output.split('\n\n');
  assert.equal(lead, 'Here are three warm, easy-on-the-wallet picks for December ☀️');
  assert.match(cards, /^:::cards\n\[CARD\]\ntitle: San Juan, Puerto Rico\nimage: https:\/\/images\.example\.test\/fallback-sju\.jpg\n/);
  assert.equal((cards.match(/\[CARD\]/g) || []).length, 3);
  assert.equal(rest, 'Cartagena and Mérida stretch a budget furthest. Which one should I plan?');
  assert.equal((result.tripView as any).presentation, 'trip_options');

  const summary = result.context.summaryContext as any;
  assert.equal(summary.passengerData.total, 2);
  assert.deepEqual(summary.tripType, ['warm weather', 'budget-conscious']);
  assert.equal(Object.hasOwn(summary, 'pax'), false);
  assert.deepEqual((result.context.tripPlanner as any).suggestions, DISCOVERY.suggestions);
});

test('a failed Trip run reaches the Manager as typed failure, never SDK error text, each time', async () => {
  let tripCalls = 0;
  const managerInputs: any[] = [];
  const result = await withModels(
    { async getResponse(request: any) {
      managerInputs.push(request.input);
      if (managerInputs.length === 1) return callTrip('Plan 4 days in Rome.', 'call_first');
      if (managerInputs.length === 2) return callTrip('Plan 4 days in Rome.', 'call_retry');
      return message("Sorry, I couldn't get that done just now. Please try asking again in a moment.");
    } },
    { async getResponse() { tripCalls += 1; throw new Error('model unavailable'); } },
    () => runTurn('plan 4 days in rome'),
  );
  // Not retrying a failed task is the Manager prompt's rule; every attempt gets the same typed failure.
  assert.equal(tripCalls, 2);
  const results = managerInputs[2].filter((item: any) => item.type === 'function_call_result');
  assert.equal(results.length, 2);
  for (const item of results) {
    const feedback = tripFeedbackSchema.parse(JSON.parse(item.output.text));
    assert.equal(feedback.status, 'failure');
    assert.doesNotMatch(item.output.text, /An error occurred|model unavailable/);
  }
  assert.equal(result.tripView, null);
  assert.equal((result.context.tripPlanner as any).plan, undefined);
});
