/**
 * Opt-in, paid mixed-intent checks through the production Manager Runner.
 * All three agents use real GPT-5.2 calls. Existing Flight inventory is dummy
 * data; this tests orchestration and feedback, not live fares or availability.
 *
 * Offline: npx tsx tests/live/manager-parallel-live.ts --check
 * Paid: $env:RUN_MANAGER_PARALLEL_LIVE='1'; npx tsx tests/live/manager-parallel-live.ts
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const scenarios = [
  {
    id: 'independent-flight-and-trip', kind: 'independent',
    user: 'Find one-way flights from Delhi to Dubai on November 20, 2026 for one adult in economy. Separately, plan a relaxed two-day Rome trip for two adults on November 13–14, 2026, focused on food and history, with a €250 total activities-and-food budget.',
  },
  {
    id: 'arrival-dependent-trip', kind: 'dependent',
    user: 'Find one-way flights from Delhi to Dubai on November 20, 2026 for one adult in economy and identify the earliest-arriving current option. Then plan my first afternoon in Dubai around that option’s confirmed arrival time. Use only arrival details you can verify; do not assume an arrival time.',
  },
  {
    id: 'missing-origin-with-independent-trip', kind: 'missing-origin',
    user: 'Find one-way flights to Rome on November 12, 2026 for two adults in economy. Also plan a relaxed two-day Rome trip on November 13–14, 2026 for those two adults, focused on food and history, with a €250 total activities-and-food budget.',
  },
] as const;

assert.equal(scenarios.length, 3);
assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
if (process.argv.includes('--check')) {
  console.log('Validated three bounded mixed-intent scenarios. No imports of application runners or API calls.');
  process.exit(0);
}
if (process.env.RUN_MANAGER_PARALLEL_LIVE !== '1') {
  console.log('Set RUN_MANAGER_PARALLEL_LIVE=1 to run three paid GPT-5.2 mixed-intent checks. Flight inventory remains dummy data.');
  process.exit(0);
}
assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required.');
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
process.env.OPENAI_FLIGHT_REASONING_EFFORT = 'low';
process.env.OPENAI_GATEWAY_REASONING_EFFORT = 'low';

const originalGlobalFetch = globalThis.fetch;
const traceExports: Array<{ status: number; at: string }> = [];
globalThis.fetch = async (input, init) => {
  const response = await originalGlobalFetch(input, init);
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (url.includes('/traces/ingest')) traceExports.push({ status: response.status, at: new Date().toISOString() });
  return response;
};

const [
  { MemorySession, generateTraceId, getGlobalTraceProvider },
  { getDefaultOpenAIClient, setDefaultOpenAIClient }, { default: OpenAI },
  { runGatewayAgent, mainChatRunner }, { ManagerAgent }, { FlightManagerAgent }, { TripPlannerV2Agent },
  { hydrateGatewayContext, snapshotGatewayContext }, { getRequestState },
  { flightManagerOutputSchema }, { tripFeedbackSchema },
] = await Promise.all([
  import('@openai/agents'), import('@openai/agents-openai'), import('openai'),
  import('../../src/agents/manager-orchestrator/runner.js'),
  import('../../src/agents/manager-orchestrator/agent.js'), import('../../src/agents/flight/agent.js'),
  import('../../src/agents/trip-planner-v2/agent.js'), import('../../src/api/chat/context-hydration.js'),
  import('../../src/shared/runtime/request-context.js'), import('../../src/agents/flight/manager-output.js'),
  import('../../src/agents/trip-planner-v2/schema.js'),
]);
for (const agent of [ManagerAgent, FlightManagerAgent, TripPlannerV2Agent]) {
  assert.equal(agent.model, 'gpt-5.2', `${agent.name} must use GPT-5.2; this harness never substitutes a model.`);
}
assert.equal(ManagerAgent.modelSettings.parallelToolCalls, true, 'Enable Manager parallelToolCalls before this check.');
assert.equal(mainChatRunner.config.tracingDisabled, false, 'Production Runner tracing must be enabled.');
assert.ok((mainChatRunner.config.toolExecution?.maxFunctionToolConcurrency ?? Infinity) >= 2,
  'Production Runner must permit concurrent Flight and Trip calls.');

function parsed(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
const reportPath = path.resolve('tests/results', `manager-parallel-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const report: any = {
  startedAt: new Date().toISOString(), model: 'gpt-5.2', tracingEnabled: true,
  runner: 'Production runGatewayAgent / mainChatRunner; no Runner, model, tool or backend replacement',
  inventory: 'Flight uses its configured dummy inventory. Fares, routes, arrival times and availability are not live travel validation.',
  sessions: 'One fresh MemorySession and empty hydrated context per query',
  scenarios: [], traceExports,
};
await mkdir(path.dirname(reportPath), { recursive: true });
const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const byRequest = new Map<string, any>();
let activeScenario: any;
const responseReads: Promise<void>[] = [];
const configuredClient = getDefaultOpenAIClient();
const originalClientFetch = configuredClient && typeof Reflect.get(configuredClient, 'fetch') === 'function'
  ? Reflect.get(configuredClient, 'fetch') as typeof fetch : globalThis.fetch;

// Guard every outgoing model request before sending; never inspect/log headers or keys.
const observedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  let metric: any;
  const owner = activeScenario;
  if (url.pathname.endsWith('/responses')) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '{}');
    assert.equal(body.model, 'gpt-5.2', 'Only GPT-5.2 is authorized for this evaluation.');
    const toolNames = (body.tools ?? []).map((tool: any) => tool.name ?? tool.type);
    const agent = toolNames.includes('flight_agent') ? 'manager'
      : toolNames.includes('flight_search') ? 'flight' : 'trip';
    if (agent === 'manager') assert.equal(body.parallel_tool_calls, true, 'Actual Manager requests must enable parallel_tool_calls.');
    metric = { sequence: owner.modelCalls.length + 1, agent, requestedModel: body.model,
      parallelToolCalls: body.parallel_tool_calls, reasoningEffort: body.reasoning?.effort,
      toolNames, startedAt: new Date().toISOString(), startMs: performance.now() - owner.startedMs };
    owner.modelCalls.push(metric);
  }
  const started = performance.now();
  try {
    const response = await originalClientFetch(input, init);
    if (metric) {
      metric.httpStatus = response.status;
      metric.providerRequestId = response.headers.get('x-request-id');
      responseReads.push(response.clone().json().then((body: any) => {
        Object.assign(metric, { responseModel: body.model, responseId: body.id, usage: body.usage,
          latencyMs: performance.now() - started, endMs: performance.now() - owner.startedMs });
        if (metric.agent === 'manager') {
          metric.functionCalls = (body.output ?? []).filter((item: any) => item.type === 'function_call')
            .map((item: any) => ({ name: item.name, callId: item.call_id, input: parsed(item.arguments) }));
        }
      }).catch(() => { metric.responseReadFailed = true; }));
    }
    return response;
  } catch (error) {
    if (metric) { metric.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    throw error;
  }
};
setDefaultOpenAIClient(configuredClient?.withOptions({ maxRetries: 0, fetch: observedFetch })
  ?? new OpenAI({ maxRetries: 0, fetch: observedFetch }));

const evidenceFor = (context: any) => byRequest.get(String((getRequestState(context.context) as any).requestId));
ManagerAgent.on('agent_tool_start', (context, tool, details: any) => {
  const evidence = evidenceFor(context);
  const call = details.toolCall;
  evidence.specialistCalls.push({ name: tool.name, callId: call.callId ?? call.id,
    input: parsed(call.arguments), startMs: performance.now() - evidence.startedMs,
    startedAt: new Date().toISOString(), completed: false });
});
ManagerAgent.on('agent_tool_end', (context, _tool, output, details: any) => {
  const evidence = evidenceFor(context);
  const call = evidence.specialistCalls.find((item: any) => item.callId === (details.toolCall.callId ?? details.toolCall.id));
  if (call) Object.assign(call, { feedback: parsed(output), completed: true,
    endMs: performance.now() - evidence.startedMs, endedAt: new Date().toISOString() });
});
for (const [name, agent] of [['flight_agent', FlightManagerAgent], ['trip_planner_agent', TripPlannerV2Agent]] as const) {
  agent.on('agent_start', (context) => {
    const evidence = evidenceFor(context);
    evidence.scopedInputs.push({ name, input: context.toolInput,
      currentUserMessage: (getRequestState(context.context as object) as any).currentUserMessage,
      startMs: performance.now() - evidence.startedMs });
  });
}
FlightManagerAgent.on('agent_tool_start', (context, tool, details: any) => {
  const evidence = evidenceFor(context);
  evidence.flightTools.push({ name: tool.name, callId: details.toolCall.callId ?? details.toolCall.id,
    input: parsed(details.toolCall.arguments), startMs: performance.now() - evidence.startedMs, completed: false });
});
FlightManagerAgent.on('agent_tool_end', (context, _tool, output, details: any) => {
  const evidence = evidenceFor(context);
  const call = evidence.flightTools.find((item: any) => item.callId === (details.toolCall.callId ?? details.toolCall.id));
  if (call) Object.assign(call, { output: parsed(output), completed: true, endMs: performance.now() - evidence.startedMs });
});

function check(evidence: any, name: string, pass: boolean, detail?: unknown) {
  evidence.checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
}
function inspect(evidence: any, result: any) {
  const calls = evidence.specialistCalls;
  const flight = calls.find((call: any) => call.name === 'flight_agent');
  const trip = calls.find((call: any) => call.name === 'trip_planner_agent');
  evidence.managerBatches = evidence.modelCalls.filter((call: any) => call.agent === 'manager' && call.functionCalls?.length)
    .map((call: any) => ({ responseId: call.responseId, sequence: call.sequence, calls: call.functionCalls }));
  const sameBatch = evidence.managerBatches.some((batch: any) => batch.calls.some((call: any) => call.name === 'flight_agent')
    && batch.calls.some((call: any) => call.name === 'trip_planner_agent'));
  const overlapMs = flight?.completed && trip?.completed
    ? Math.max(0, Math.min(flight.endMs, trip.endMs) - Math.max(flight.startMs, trip.startMs)) : null;
  evidence.parallelBehavior = { sameManagerBatch: sameBatch, observedOverlapMs: overlapMs,
    decision: sameBatch ? 'parallel batch' : trip ? 'separate batches' : 'Trip not called',
    dependencyOrderVerified: evidence.kind === 'dependent' && trip ? trip.startMs >= flight?.endMs : null };
  evidence.specialistOutcomes = { flight: flight?.feedback?.status ?? 'not_called', trip: trip?.feedback?.status ?? 'not_called' };
  const statuses = Object.values(evidence.specialistOutcomes);
  evidence.outcome = statuses.includes('failure') ? 'failure'
    : statuses.includes('needs_input') ? 'needs_input'
      : statuses.includes('partial') || statuses.includes('not_called') ? 'partial' : 'success';
  check(evidence, 'nonempty Manager final response', result.finalAgentName === 'Manager Agent' && !!result.output.trim());
  check(evidence, 'Flight called exactly once', calls.filter((call: any) => call.name === 'flight_agent').length === 1);
  check(evidence, 'no duplicate specialist calls', ['flight_agent', 'trip_planner_agent'].every((name) => calls.filter((call: any) => call.name === name).length <= 1));
  check(evidence, 'all specialist calls completed', calls.every((call: any) => call.completed));
  check(evidence, 'schema-valid Flight feedback', flightManagerOutputSchema.safeParse(flight?.feedback).success);
  if (trip) check(evidence, 'schema-valid Trip feedback', tripFeedbackSchema.safeParse(trip.feedback).success);
  check(evidence, 'all paid requests and responses use GPT-5.2', evidence.modelCalls.length > 0 && evidence.modelCalls.every((call: any) =>
    call.requestedModel === 'gpt-5.2' && /^gpt-5\.2(?:-|$)/.test(call.responseModel ?? '') && !!call.responseId && !!call.usage));
  check(evidence, 'all actual Manager requests enable parallel calls', evidence.modelCalls.filter((call: any) => call.agent === 'manager')
    .every((call: any) => call.parallelToolCalls === true));
  check(evidence, 'shared user message remains the complete original query', evidence.scopedInputs.every((input: any) => input.currentUserMessage === evidence.user));
  if (evidence.kind === 'dependent') {
    check(evidence, 'dependent work is never batched with its prerequisite', !sameBatch);
    check(evidence, 'Trip starts after Flight finishes when delegated', !trip || (flight?.completed && trip.startMs >= flight.endMs),
      trip ? { flightEndMs: flight?.endMs, tripStartMs: trip.startMs } : 'Trip deferred; inspect Flight feedback for verified arrival or its blocker.');
    evidence.dependencyEvidence = { flightFeedback: flight?.feedback, tripInput: trip?.input ?? null,
      note: 'Review the captured arrival evidence and Trip subtask; no arrival time is prefilled or assumed by this harness.' };
  } else {
    check(evidence, 'independent Trip called exactly once', calls.filter((call: any) => call.name === 'trip_planner_agent').length === 1);
    check(evidence, 'same-batch independent specialists overlap', !sameBatch || (overlapMs !== null && overlapMs > 0), evidence.parallelBehavior);
    check(evidence, 'independent Trip saved a two-day Rome plan', result.context.tripPlanner?.plan?.days?.length === 2
      && /Rome/i.test(result.context.tripPlanner?.plan?.destination?.city ?? ''));
  }
  if (evidence.kind === 'missing-origin') {
    check(evidence, 'missing Flight origin is reported as needs_input', flight?.feedback?.status === 'needs_input'
      && flight.feedback.missingInformation.length > 0, flight?.feedback);
    check(evidence, 'Flight does not search with an invented origin', !evidence.flightTools.some((call: any) => call.name === 'flight_search'));
    check(evidence, 'Trip completes independently of Flight clarification', trip?.feedback?.status === 'success'
      && trip.feedback.saved.plan === 'created', trip?.feedback?.status);
  }
}

try {
  for (const scenario of scenarios) {
    const evidence: any = { ...scenario, requestId: `parallel-${scenario.id}-${Date.now()}`, traceId: generateTraceId(),
      startedAt: new Date().toISOString(), startedMs: performance.now(), specialistCalls: [], scopedInputs: [],
      flightTools: [], modelCalls: [], checks: [] };
    activeScenario = evidence;
    byRequest.set(evidence.requestId, evidence);
    report.scenarios.push(evidence);
    console.log(JSON.stringify({ scenario: scenario.id, traceId: evidence.traceId, state: 'running', inventory: 'dummy, not live' }));
    const state = hydrateGatewayContext({});
    try {
      const result = await runGatewayAgent({ input: scenario.user, context: state, session: new MemorySession(),
        requestId: evidence.requestId, traceId: evidence.traceId, sessionId: scenario.id,
        now: '2026-10-16T10:00:00Z', timeZone: 'Asia/Kolkata', maxTurns: 8 });
      await Promise.all(responseReads);
      evidence.output = result.output;
      evidence.contextAfter = snapshotGatewayContext(result.context);
      evidence.usage = result.result.runContext.usage;
      evidence.latencyMs = result.latencyMs;
      inspect(evidence, result);
      evidence.passed = evidence.checks.every((item: any) => item.pass);
    } catch (error) {
      await Promise.all(responseReads);
      evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      evidence.contextAfter = snapshotGatewayContext(state);
      evidence.outcome = 'failure';
      evidence.passed = false;
    }
    delete evidence.startedMs;
    await persist();
    console.log(JSON.stringify({ scenario: scenario.id, outcome: evidence.outcome, passed: evidence.passed,
      parallelBehavior: evidence.parallelBehavior, specialistOutcomes: evidence.specialistOutcomes,
      failedChecks: evidence.checks.filter((item: any) => !item.pass).map((item: any) => item.name), error: evidence.error }));
  }
} finally {
  await Promise.all(responseReads);
  await getGlobalTraceProvider().forceFlush();
  report.finishedAt = new Date().toISOString();
  report.summary = { scenarios: report.scenarios.length, passed: report.scenarios.filter((scenario: any) => scenario.passed).length,
    failed: report.scenarios.filter((scenario: any) => !scenario.passed).length,
    paidRequests: report.scenarios.reduce((sum: number, scenario: any) => sum + scenario.modelCalls.length, 0),
    traceExportStatuses: traceExports.map((entry) => entry.status) };
  await persist();
  globalThis.fetch = originalGlobalFetch;
  console.log(JSON.stringify({ ...report.summary, reportPath }));
}
if (report.summary.failed > 0 || report.summary.scenarios !== scenarios.length) process.exitCode = 1;
