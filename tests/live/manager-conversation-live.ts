/**
 * Paid GPT-5.2 Manager conversation check. Specialist models are scripted; real SDK
 * adapters, shared context, Trip persistence and final reply sanitization still run.
 * Run: $env:RUN_MANAGER_CONVERSATION_LIVE='1'; npx tsx tests/live/manager-conversation-live.ts --trace
 * Offline fixture validation: npx tsx tests/live/manager-conversation-live.ts --check-fixtures
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { managerConversationCases, type ConversationTurn } from '../fixtures/manager-conversation-cases.js';

const { flightManagerOutputSchema } = await import('../../src/agents/flight/manager-output.js');
const { tripResultSchema, tripFeedbackSchema } = await import('../../src/agents/trip-planner-v2/schema.js');
const selectedId = process.argv.find((arg) => arg.startsWith('--case='))?.slice('--case='.length);
const selectedCases = managerConversationCases.filter((chat) => !selectedId || chat.id === selectedId);
assert.ok(selectedCases.length, 'Unknown conversation case.');
for (const chat of selectedCases) {
  assert.equal(chat.turns.length, 3);
  for (const turn of chat.turns) {
    if (turn.feedback) flightManagerOutputSchema.parse(turn.feedback);
    if (turn.tripResult) tripResultSchema.parse(turn.tripResult);
  }
}
if (process.argv.includes('--check-fixtures')) {
  console.log('Validated three conversations, nine turns, and all scripted specialist schemas. No model calls.');
  process.exit(0);
}
if (process.env.RUN_MANAGER_CONVERSATION_LIVE !== '1') {
  console.log('Set RUN_MANAGER_CONVERSATION_LIVE=1 to run the paid GPT-5.2 Manager conversation check.');
  process.exit(0);
}
assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required.');
const tracingEnabled = process.argv.includes('--trace');
if (tracingEnabled) delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
else process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';

const [{ MemorySession, Runner, Usage, getGlobalTraceProvider }, { ManagerAgent }, { FlightManagerAgent }, { TripPlannerV2Agent },
  { runGatewayAgent }, { hydrateGatewayContext, snapshotGatewayContext },
  { getDefaultOpenAIClient, setDefaultOpenAIClient }, { default: OpenAI }, { pinManagerLiveModels },
  { MANAGER_PROMPT }, { parseToolValue, flightCardsVisible }] = await Promise.all([
  import('@openai/agents'), import('../../src/agents/manager-orchestrator/agent.js'),
  import('../../src/agents/flight/agent.js'), import('../../src/agents/trip-planner-v2/agent.js'),
  import('../../src/agents/manager-orchestrator/runner.js'), import('../../src/api/chat/context-hydration.js'),
  import('@openai/agents-openai'), import('openai'), import('./manager-live-model-policy.js'),
  import('../../src/agents/manager-orchestrator/manager-prompt.js'), import('./manager-flight-evidence.js'),
]);
pinManagerLiveModels();
const runner = new Runner({ tracingDisabled: !tracingEnabled, traceIncludeSensitiveData: tracingEnabled,
  toolExecution: { maxFunctionToolConcurrency: 2 }, modelSettings: { retry: { maxRetries: 0 } } });
const reportPath = path.resolve('tests/results', `manager-conversation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const report: any = { model: 'gpt-5.2', reasoningEffort: 'low', tracingEnabled,
  promptSource: 'src/agents/manager-orchestrator/manager-prompt.ts / buildManagerInstructions',
  promptSha256: createHash('sha256').update(MANAGER_PROMPT).digest('hex'),
  live: 'Manager model only', controlled: 'Scripted specialist models and Flight state effects; actual specialist SDK adapters',
  session: 'MemorySession, independently recreated for each conversation',
  startedAt: new Date().toISOString(), conversations: [] };
await mkdir(path.dirname(reportPath), { recursive: true });
async function persist() { await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); }

let activeTurn: ConversationTurn;
let activeState: any;
let evidence: any;
let scriptedCalls = 0;
let expectedFlightView: any;
function scriptedModel(name: 'flight_agent' | 'trip_planner_agent') {
  return { async getResponse(request: any) {
    assert.equal(activeTurn.specialist, name, `Unexpected specialist ${name}`);
    scriptedCalls += 1;
    assert.equal(scriptedCalls, 1, 'The Manager repeated or added specialist work.');
    evidence.specialistInputs.push({ name, input: request.input });
    if (name === 'flight_agent') {
      Object.assign(activeState.flight, structuredClone(activeTurn.flightState ?? {}));
      expectedFlightView = { searchResults: structuredClone(activeState.flight.searchResults), showFlight: activeState.flight.showFlight };
    }
    const output = name === 'flight_agent' ? flightManagerOutputSchema.parse(activeTurn.feedback)
      : tripResultSchema.parse(activeTurn.tripResult);
    return { usage: new Usage(), responseId: `resp_scripted_${name}_${Date.now()}`, output: [{
      type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }],
    }] };
  }, getStreamedResponse() { throw new Error('Scripted specialists do not stream.'); } } as any;
}
FlightManagerAgent.model = scriptedModel('flight_agent');
TripPlannerV2Agent.model = scriptedModel('trip_planner_agent');
ManagerAgent.on('agent_tool_start', (_context, tool, details: any) => {
  const raw = details.toolCall;
  evidence.calls.push({ name: tool.name, callId: raw.callId || raw.id, input: parseToolValue(raw.arguments), completed: false });
});
ManagerAgent.on('agent_tool_end', (_context, _tool, output, details: any) => {
  const call = evidence.calls.find((item: any) => item.callId === (details.toolCall.callId || details.toolCall.id));
  if (call) { call.feedback = parseToolValue(output); call.completed = true; }
});

// Check every outgoing paid model request before sending it; never log headers or credentials.
const configured = getDefaultOpenAIClient();
const originalFetch = configured && typeof Reflect.get(configured, 'fetch') === 'function'
  ? Reflect.get(configured, 'fetch') as typeof fetch : globalThis.fetch;
let reads: Promise<unknown>[] = [];
const observedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  let metric: any;
  if (url.pathname.endsWith('/responses')) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '{}');
    assert.equal(body.model, 'gpt-5.2', 'Only GPT-5.2 is authorized for this evaluation.');
    metric = { model: body.model, reasoningEffort: body.reasoning?.effort };
    evidence.modelCalls.push(metric);
  }
  const started = Date.now();
  const response = await originalFetch(input, init);
  if (metric) {
    metric.httpStatus = response.status;
    reads.push(response.clone().json().then((body: any) => {
      Object.assign(metric, { responseModel: body.model, responseId: body.id, usage: body.usage, latencyMs: Date.now() - started });
    }).catch(() => { metric.responseReadFailed = true; }));
  }
  return response;
};
setDefaultOpenAIClient(configured?.withOptions({ maxRetries: 0, fetch: observedFetch })
  ?? new OpenAI({ maxRetries: 0, fetch: observedFetch }));

const priceNote = 'Note: Prices shown are per person.';
const cardText = (card: any) => `[CARD]\ntitle: ${card.title}\nimage: ${card.image}\nknown_for: ${card.known_for}\nweather: ${card.weather}\nbudget: ${card.budget}\n[/CARD]`;
const dayText = (day: any) => `**Day ${day.day} — ${day.title}**\n🌅 **Morning:** ${day.morning}\n☀️ **Afternoon:** ${day.afternoon}\n🌙 **Evening:** ${day.evening}`;
function check(name: string, pass: boolean, detail?: unknown) { evidence.checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) }); }
function checkTurn(turn: ConversationTurn, output: string, result: any, before: any, turnNumber: number) {
  const calls = evidence.calls;
  check('only the required specialist, once', JSON.stringify(calls.map((call: any) => call.name))
    === JSON.stringify(turn.specialist ? [turn.specialist] : []), calls.map((call: any) => call.name));
  check('specialist calls completed', calls.every((call: any) => call.completed));
  const subtask = calls.map((call: any) => call.input?.input ?? '').join('\n');
  for (const pattern of turn.subtaskIncludes ?? []) check(`subtask includes ${pattern}`, pattern.test(subtask), subtask);
  for (const pattern of turn.subtaskExcludes ?? []) check(`subtask excludes ${pattern}`, !pattern.test(subtask), subtask);
  for (const pattern of turn.outputIncludes ?? []) check(`reply includes ${pattern}`, pattern.test(output));
  for (const pattern of turn.outputExcludes ?? []) check(`reply excludes ${pattern}`, !pattern.test(output));
  check('nonempty final Manager response', !!output.trim() && result.finalAgentName === 'Manager Agent');
  check('no invented traveler preference', !/\b(?:vegetarian|vegan|honeymoon|anniversary|accessibility needs|young children|your kids|love nightlife)\b/i.test(output));
  check('no internal identifiers or raw specialist JSON', !/\b(?:flight_agent|trip_planner_agent|searchKey|missingInformation|toolCallLog|nextStep)\b|^\s*\{\s*"status"/m.test(output));
  const feedback = calls[0]?.feedback;
  const noteCount = output.split(priceNote).length - 1;
  check('exact Flight price note only when required', noteCount === (feedback?.presentation === 'flight_cards_with_price_note' ? 1 : 0), noteCount);
  check('model requests use GPT-5.2 only', evidence.modelCalls.length > 0 && evidence.modelCalls.every((call: any) =>
    call.model === 'gpt-5.2' && call.reasoningEffort === 'low' && /^gpt-5\.2(?:-|$)/.test(call.responseModel ?? '')), evidence.modelCalls);
  if (turn.questions !== undefined) check('only the expected questions', (output.match(/\?/g) ?? []).length === turn.questions);
  if (turn.specialist === 'flight_agent') {
    check('schema-valid Flight feedback', flightManagerOutputSchema.safeParse(feedback).success);
    check('Flight rendering state unchanged by final prose', JSON.stringify(expectedFlightView) === JSON.stringify({
      searchResults: result.context.flight.searchResults, showFlight: result.context.flight.showFlight }));
    check('Flight cards follow context visibility', flightCardsVisible(result.context) === !!(expectedFlightView?.showFlight && expectedFlightView?.searchResults?.length));
    check('no Flight cards regenerated in prose', !/\[CARD\]|:::cards/.test(output));
  }
  if (turn.specialist === 'trip_planner_agent') {
    check('schema-valid measured Trip feedback', tripFeedbackSchema.safeParse(feedback).success);
    for (const card of feedback?.cards ?? []) check('Trip card copied exactly', output.includes(cardText(card)), card.title);
    for (const day of feedback?.days ?? []) check('Trip day copied exactly', output.includes(dayText(day)), day.day);
    check('no duplicate or missing Trip cards', (output.match(/\[CARD\]/g) ?? []).length === feedback?.cards.length);
    check('no duplicate or missing Trip days', (output.match(/^\*\*Day \d+ — /gm) ?? []).length === feedback?.days.length);
    check('null Trip nextStep adds no question or offer', feedback?.nextStep === null && !/\?|\b(?:would you like|shall I|want me to|I can also|let me know)\b/i.test(output));
    const summary = result.context.summaryContext;
    check('Rome, party, budget and interests persist', summary.destination.city === 'Rome' && summary.passengerData.total === 2
      && summary.budget.amount === 250 && summary.budget.currency === 'EUR' && summary.budget.per_person === false
      && ['relaxed', 'food', 'history'].every((item) => summary.tripType.includes(item)));
    const days = result.context.tripPlanner.plan.days;
    if (turnNumber === 2) {
      const oldDays = before.tripPlanner.plan.days;
      check('only day 2 afternoon changes', JSON.stringify(oldDays[0]) === JSON.stringify(days[0])
        && oldDays[1].morning === days[1].morning && oldDays[1].evening === days[1].evening
        && days[1].afternoon === 'Free time to wander at your own pace');
    }
    if (turnNumber === 3) check('meal edit preserves the free afternoon', days[1].afternoon === before.tripPlanner.plan.days[1].afternoon);
  }
}

for (const chat of selectedCases) {
  const conversation: any = { id: chat.id, title: chat.title, turns: [] };
  report.conversations.push(conversation);
  const session = new MemorySession();
  let durableState: any = {};
  for (const [index, turn] of chat.turns.entries()) {
    activeTurn = turn;
    activeState = hydrateGatewayContext(durableState);
    const before = snapshotGatewayContext(activeState);
    evidence = { turn: index + 1, user: turn.user, calls: [], specialistInputs: [], modelCalls: [], checks: [] };
    conversation.turns.push(evidence);
    scriptedCalls = 0;
    reads = [];
    expectedFlightView = undefined;
    try {
      const result = await runGatewayAgent({ input: turn.user, context: activeState, session, runner,
        requestId: `${chat.id}-${index + 1}`, sessionId: chat.id, maxTurns: 6,
        now: new Date('2026-10-16T10:00:00Z'), timeZone: 'Asia/Kolkata' });
      await Promise.all(reads);
      evidence.output = result.output;
      evidence.traceId = result.traceId;
      evidence.usage = result.result.runContext.usage;
      evidence.latencyMs = result.latencyMs;
      checkTurn(turn, result.output, result, before, index + 1);
      durableState = snapshotGatewayContext(result.context);
      evidence.contextAfter = durableState;
      evidence.passed = evidence.checks.every((item: any) => item.pass);
    } catch (error) {
      await Promise.all(reads);
      evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      evidence.passed = false;
    }
    await persist();
    console.log(JSON.stringify({ chat: chat.id, turn: index + 1, passed: evidence.passed,
      failedChecks: evidence.checks.filter((item: any) => !item.pass).map((item: any) => item.name), error: evidence.error }));
    if (!evidence.passed) { process.exitCode = 1; break; }
  }
}
const turns = report.conversations.flatMap((chat: any) => chat.turns);
report.summary = { attempted: turns.length, expected: selectedCases.length * 3, passed: turns.filter((turn: any) => turn.passed).length,
  failed: turns.filter((turn: any) => !turn.passed).length,
  paidModelCalls: turns.reduce((sum: number, turn: any) => sum + turn.modelCalls.length, 0) };
if (report.summary.passed !== report.summary.expected) process.exitCode = 1;
await persist();
if (tracingEnabled) await getGlobalTraceProvider().forceFlush();
console.log(JSON.stringify({ ...report.summary, reportPath }));
