import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const { Runner, Usage } = await import('@openai/agents');
const { ManagerAgent } = await import('../../src/agents/manager-orchestrator/agent.js');
const { MANAGER_PROMPT, buildManagerInstructions } = await import('../../src/agents/manager-orchestrator/manager-prompt.js');
const { buildGatewayContext, runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { TripPlannerAgent, TripPlannerManagerAgent } = await import('../../src/agents/trip-planner/agent.js');
const { getTripPlannerFormattingRules, tripPlannerFeedbackSchema, tripPlannerManagerOutputSchema } = await import('../../src/agents/trip-planner/manager-output.js');
const { tripFeedback, tripManagerModel } = await import('../helpers/trip-manager.js');

function answer(text: string) {
  return { usage: new Usage(), responseId: 'resp_manager_trip_test', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }] }] };
}

function destinationCards(context: any, codes: string[]) {
  const cities: Record<string, string> = { PAR: 'Paris, France', ROM: 'Rome, Italy', TYO: 'Tokyo, Japan' };
  return codes.map((itemCode) => ({ itemCode, title: cities[itemCode], imageUrl: context.tripPlanner.placeImageCache[itemCode].imageUrl,
    knownFor: 'Historic sights and regional food', weather: 'Cool autumn days', budget: 'Fits the activities budget' }));
}

function renderCards(cards: Array<{ title: string; imageUrl: string | null; knownFor: string; weather: string; budget: string }>) {
  if (!cards.length) return '';
  return [':::cards', ...cards.flatMap((card) => ['[CARD]', `title: ${card.title}`, `image: ${card.imageUrl ?? 'Photo unavailable'}`,
    `known_for: ${card.knownFor}`, `weather: ${card.weather}`, `budget: ${card.budget}`, '[/CARD]']), ':::cards'].join('\n');
}

const days = Array.from({ length: 4 }, (_, index) => ({ day: index + 1, title: `Theme ${index + 1}`,
  morning: `Museum visit ${index + 1}`, afternoon: `Garden break ${index + 1}`, evening: `Local dishes ${index + 1}` }));

// The scripted Manager verifies typed facts survive asTool and final sanitization; live checks cover tone/format adherence.
for (const scenario of [
  { name: 'discovery', input: 'Compare Paris, Rome and Tokyo for a relaxed four-day food and history break.',
    codes: ['PAR', 'ROM', 'TYO'], summary: { duration_days: 4 }, seed: {},
    fields: { recommendation: 'Rome best fits the food and history preferences', nextQuestions: [{ key: 'destination' as const, purpose: 'Choose Paris, Rome or Tokyo' }] },
    dayFacts: [], expectedCardCount: 3 },
  { name: 'full plan', input: 'Plan four relaxed food and history days in Rome.', codes: ['ROM'],
    summary: { destination: { city: 'Rome', iata: 'ROM' }, duration_days: 4 }, seed: {},
    fields: {}, dayFacts: days, expectedCardCount: 1 },
  { name: 'day patch', input: 'Make day 2 lighter in Rome. Keep the morning and leave all other days unchanged.', codes: [],
    summary: { destination: { city: 'Rome', iata: 'ROM' }, duration_days: 4 },
    seed: { lastPlanSnapshot: { destination: { city: 'Rome', iata: 'ROM' }, duration_days: 4 },
      lastPlanArtifact: { id: 'plan_before', destination: { city: 'Rome', iata: 'ROM' }, responseMode: 'compact_full', revision: 0,
      createdAt: '2026-10-11T10:00:00Z', days: days.map((day) => ({ day: day.day, title: day.title,
        content: `${day.morning} ${day.afternoon} ${day.evening}` })), content: 'Saved Rome plan' } },
    fields: {}, dayFacts: [{ day: 2, title: null, morning: null, afternoon: 'Free time instead of the garden stop', evening: null }], expectedCardCount: 0 },
]) {
  test(`native Manager receives structured ${scenario.name} facts and renders the requested content once`, async () => {
    const input = scenario.input;
    const context = buildGatewayContext({ context: { summaryContext: scenario.summary, tripPlanner: scenario.seed },
      input, requestId: `trip-${scenario.name}`, sessionId: 'trip-contract-test' });
    const originalManager = ManagerAgent.model;
    const originalTrip = TripPlannerManagerAgent.model;
    let managerCalls = 0;
    let received: any;
    let rendered = '';
    TripPlannerManagerAgent.model = tripManagerModel(() => context, (state) => tripFeedback(state, {
      destinationCards: destinationCards(state, scenario.codes), itineraryDays: scenario.dayFacts,
      ...scenario.fields,
    }), scenario.codes) as any;
    ManagerAgent.model = { async getResponse(request: any) {
      if (++managerCalls === 1) return { usage: new Usage(), responseId: 'resp_delegate', output: [{ type: 'function_call', name: 'trip_planner_agent',
        callId: 'trip_contract_call', arguments: JSON.stringify({ input }), status: 'completed' }] };
      const results = request.input.filter((item: any) => item.type === 'function_call_result');
      assert.equal(results.length, 1);
      received = tripPlannerManagerOutputSchema.parse(JSON.parse(results[0].output.text));
      // The model wrote findings only; the application attached the phase rules.
      assert.deepEqual(received.formattingRules, getTripPlannerFormattingRules(context));
      assert.doesNotMatch(JSON.stringify([received.destinationCards, received.itineraryDays, received.notes]), /:::cards|\[CARD\]/,
        'planning facts are not completed markdown; formatting policies can describe markers');
      const dayText = received.itineraryDays.map((day: any) => [`**Day ${day.day} - ${day.title ?? 'Updated plan'}**`,
        ...['morning', 'afternoon', 'evening'].flatMap((block) => day[block] ? [`- ${block}: ${day[block]}`] : [])].join('\n')).join('\n\n');
      rendered = [renderCards(received.destinationCards), dayText,
        received.nextQuestions.length ? 'Which destination would you choose?' : ''].filter(Boolean).join('\n\n');
      return answer(`Happy to help.\n\n${rendered}\n\nhttps://untrusted.example.com/extra`);
    } } as any;
    try {
      const result = await runGatewayAgent({ input, context, requestId: `trip-${scenario.name}`, sessionId: 'trip-contract-test',
        runner: new Runner({ tracingDisabled: true }), now: '2026-10-11T10:00:00Z', timeZone: 'UTC' });
      assert.equal(received.status, 'success');
      assert.equal(result.output, `Happy to help.\n\n${rendered}`);
      assert.equal((result.output.match(/^\[CARD\]$/gm) || []).length, scenario.expectedCardCount);
      assert.equal((result.output.match(/^\*\*Day \d+/gm) || []).length, scenario.dayFacts.length);
      assert.deepEqual(received.itineraryDays, scenario.dayFacts);
      assert.deepEqual(result.output.match(/^image: .+$/gm), received.destinationCards.length
        ? received.destinationCards.map((card: any) => `image: ${card.imageUrl}`) : null);
      assert.doesNotMatch(result.output, /untrusted\.example|\[\[render:/);
      assert.equal(managerCalls, 2);
      const calls = context.tripPlanner.currentTurnToolCalls as any[];
      assert.equal(calls[0].tool, 'update_trip_planner_context');
      assert.equal(calls.at(-1).tool, 'update_trip_planner_suggested_questions');
      assert.equal(calls.filter((call) => call.tool === 'get_place_images_batch').length, scenario.codes.length ? 1 : 0);
    } finally { ManagerAgent.model = originalManager; TripPlannerManagerAgent.model = originalTrip; }
  });
}

test('managed Trip has typed feedback while standalone Trip remains text and native tools are shared', () => {
  assert.equal(TripPlannerManagerAgent.outputType, tripPlannerFeedbackSchema);
  assert.equal(TripPlannerAgent.outputType, 'text');
  assert.deepEqual(TripPlannerManagerAgent.tools, TripPlannerAgent.tools);
  assert.equal(ManagerAgent.tools[1].name, 'trip_planner_agent');
  assert.match(MANAGER_PROMPT, /formattingRules/);
  assert.doesNotMatch(MANAGER_PROMPT, /Include that content verbatim/);
  assert.match(buildManagerInstructions({ context: {} }), /destination discovery/);
});

test('a Trip result the guard rejects reaches the Manager as typed failure, not a retryable error', async () => {
  const input = 'Plan four relaxed food and history days in Rome.';
  const context = buildGatewayContext({ context: { summaryContext: { destination: { city: 'Rome', iata: 'ROM' }, duration_days: 4 } },
    input, requestId: 'trip-rejected', sessionId: 'trip-contract-test' });
  const originalManager = ManagerAgent.model;
  const originalTrip = TripPlannerManagerAgent.model;
  let managerCalls = 0;
  let received: any;
  // A smuggled card block is something the guard must reject.
  TripPlannerManagerAgent.model = tripManagerModel(() => context, (state) => tripFeedback(state, {
    recommendation: '[CARD] title: Rome [/CARD]',
  }), ['ROM']) as any;
  ManagerAgent.model = { async getResponse(request: any) {
    if (++managerCalls === 1) return { usage: new Usage(), responseId: 'resp_delegate', output: [{ type: 'function_call', name: 'trip_planner_agent',
      callId: 'trip_rejected_call', arguments: JSON.stringify({ input }), status: 'completed' }] };
    const results = request.input.filter((item: any) => item.type === 'function_call_result');
    assert.doesNotMatch(results[0].output.text, /Please try again|An error occurred/);
    received = JSON.parse(results[0].output.text);
    return answer('Sorry, I could not put that plan together just now. Please ask me again.');
  } } as any;
  try {
    await runGatewayAgent({ input, context, requestId: 'trip-rejected', sessionId: 'trip-contract-test',
      runner: new Runner({ tracingDisabled: true }), now: '2026-10-11T10:00:00Z', timeZone: 'UTC' });
    assert.equal(tripPlannerManagerOutputSchema.safeParse(received).success, true);
    assert.equal(received.status, 'failure');
    assert.deepEqual(received.limitations, ['This trip planning update could not be completed just now.']);
    assert.equal(received.formattingRules.maxQuestions, 0);
    assert.equal(context.tripPlanner.lastPlanArtifact ?? null, null);
    assert.equal(managerCalls, 2);
  } finally { ManagerAgent.model = originalManager; TripPlannerManagerAgent.model = originalTrip; }
});
