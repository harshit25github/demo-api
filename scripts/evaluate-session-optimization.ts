import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { createEvaluationClient, dateScenarios, median, safeError, scenarioSteps, textHash } from './session-live-support.js';
import type { EvaluationBudget, ScenarioStep } from './session-live-support.js';
import { fixtureHistory, realToolFixtures, scaleFixture } from './session-optimization-fixtures.js';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.AGENT_LOG_LEVEL = 'silent';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'silent';
const flags = new Set(process.argv.slice(2));
if (!flags.has('--live')) throw new Error('Live generation requires --live. Use the offline benchmark for local counting.');
const value = (name: string, fallback: number) => {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const parsed = raw ? Number(raw.split('=')[1]) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
  return parsed;
};
const budget: EvaluationBudget = { maxRequests: value('max-requests', 80), maxUsd: value('budget-usd', 8),
  requests: 0, countRequests: 0, reservedUsd: 0, countingMs: 0, stopped: null };
const client = createEvaluationClient(budget);
const { setDefaultOpenAIClient, OpenAIConversationsSession } = await import('@openai/agents-openai');
setDefaultOpenAIClient(client);
const { Runner } = await import('@openai/agents');
const { mainChatRunner } = await import('../src/agents/manager-orchestrator/runner.js');
const { runGatewayAgentTextStream } = await import('../src/agents/manager-orchestrator/streaming.js');
const { JsonChatStore } = await import('../src/api/chat/store.js');
const { streamChatTurn } = await import('../src/api/chat/orchestrator.js');
const { SseWriter } = await import('../src/api/chat/sse.js');
const { sessionOptimization } = await import('../src/shared/config/session-optimization.js');
const { createEmptySummaryContext } = await import('../src/api/chat/context-hydration.js');
const originalMode = sessionOptimization.mode;
const directory = resolve('tests/results/session-optimization', `live-${Date.now()}`);
await mkdir(directory, { recursive: true });
let store = await new JsonChatStore({ filePath: resolve(directory, 'synthetic-chats.json') }).init();
const originalLog = console.log;
console.log = () => {}; // Existing application/tool logs may include synthetic messages; keep the report metadata only.
type Row = Record<string, any>;
const rows: Row[] = [];
const runs: Row[] = [];
const clock = new Date('2026-09-09T09:00:00Z');

class TestResponse extends PassThrough {
  writeHead() { return this; }
  flushHeaders() {}
}

async function runScenario(config: string, steps: ScenarioStep[], repetition: number, label: string) {
  sessionOptimization.mode = config === 'baseline' ? 'off' : 'enforce';
  const runner = config === 'compaction' ? new Runner({ ...mainChatRunner.config,
    modelSettings: { ...mainChatRunner.config.modelSettings, contextManagement: [{ type: 'compaction', compactThreshold: 50000 }] },
  }) : mainChatRunner;
  // Evaluation explicitly tests unsupported settings; it never edits the production compatibility allowlist.
  let chat = await store.createChat({ title: `synthetic-${label}-${config}-${repetition}` });
  if ((flags.has('--seeded') || flags.has('--continuity')) && /^\d+-turn$/.test(label)) {
    const seedTurns = Number(label.split('-')[0]);
    const fixture = await realToolFixtures();
    const payload = scaleFixture(fixture.search, 20);
    const runtime = fixture.runtimeContext;
    runtime.flight.searchResults = structuredClone(payload.flights);
    runtime.flight.totalResultsFound = 20;
    if (runtime.flightSearchRuntime) {
      runtime.flightSearchRuntime.sourceFlights = structuredClone(payload.flights);
      runtime.flightSearchRuntime.visibleFlights = structuredClone(payload.flights);
    }
    const session = new OpenAIConversationsSession({ client });
    const conversationId = await session.getSessionId();
    const input = fixtureHistory(payload, 'flight_search', seedTurns).slice(0, -1);
    for (let i = 0; i < input.length; i += 20) await session.addItems(input.slice(i, i + 20));
    if (flags.has('--continuity')) await session.addItems([{ role: 'user', content: 'For the Mumbai itinerary, avoid all museums on both days.' }]);
    chat = (await store.updateChat(chat.chatId, (record) => {
      record.conversationId = conversationId;
      record.runtimeContext = runtime;
      const summary = createEmptySummaryContext();
      summary.origin = { city: 'Delhi', iata: 'DEL' }; summary.destination = { city: 'Mumbai', iata: 'BOM' };
      summary.outbound_date = '2026-10-15'; summary.tripType = ['oneway'];
      summary.passengerData = { ...summary.passengerData, total: 1, adults: 1 };
      record.summaryContext = summary;
    }))!;
  }
  const startRow = rows.length;
  let failed = false;
  for (const step of steps) {
    if (budget.stopped) break;
    if (step.restart) store = await new JsonChatStore({ filePath: store.filePath }).init();
    chat = store.getChat(chat.chatId)!;
    if (step.seedBefore) {
      const fixture = await realToolFixtures();
      const input = fixtureHistory(scaleFixture(fixture.search, 20), 'flight_search', 50).slice(0, -1);
      for (const item of input) if ('callId' in item) item.callId = `${step.id}_${item.callId}`;
      const session = new OpenAIConversationsSession({ conversationId: chat.conversationId!, client });
      for (let i = 0; i < input.length; i += 20) await session.addItems(input.slice(i, i + 20));
    }
    const release = store.acquireTurn(chat.chatId);
    if (!release) throw new Error('Evaluation chat unexpectedly locked');
    const response = new TestResponse();
    let sse = '';
    response.on('data', (chunk) => { sse += String(chunk); });
    const writer = new SseWriter(response as unknown as ServerResponse);
    const countingBefore = budget.countingMs;
    const reservedBefore = budget.reservedUsd;
    let firstDeltaCountingMs: number | null = null;
    response.on('data', (chunk) => {
      if (firstDeltaCountingMs === null && String(chunk).includes('event: delta')) firstDeltaCountingMs = budget.countingMs - countingBefore;
    });
    const start = performance.now();
    budget.expectedUserHash = textHash(step.message);
    await streamChatTurn({ store, chat, releaseTurn: release, isNewChat: chat.turns.length === 0,
      writer, response: response as unknown as ServerResponse, message: step.message, timeZone: 'Asia/Kolkata',
      now: clock, maxTimeoutRecoveries: 0, maxTurns: 10,
      createConversationSession: (options) => new OpenAIConversationsSession({ ...options, client }),
      runGateway: (options) => runGatewayAgentTextStream({ ...options, input: options.input, runner: runner as any, maxTimeoutRecoveries: 0 }),
    });
    chat = store.getChat(chat.chatId)!;
    const turn = chat.turns.at(-1)!;
    const doneRaw = sse.match(/event: done\ndata: ([^\n]+)/)?.[1];
    const done = doneRaw ? JSON.parse(doneRaw) : null;
    const toolNames = (done?.flightContext?.toolCallLog ?? []) as string[];
    const runtime = chat.runtimeContext.flight as Record<string, any>;
    const historySession = new OpenAIConversationsSession({ conversationId: chat.conversationId!, client });
    const items: any[] = await historySession.getItems();
    const userIndex = items.map((i) => i.role === 'user').lastIndexOf(true);
    const turnCalls = items.slice(userIndex + 1).filter((i) => i.type === 'function_call').map((i) => i.name);
    const assertions: Record<string, boolean> = {
      completed: turn.status === 'completed', summaryCompleted: turn.summaryStatus === 'completed',
      oneTerminalEvent: (sse.match(/event: (done|error)\n/g) ?? []).length === 1,
      expectedAgent: step.expectedAgent === null || turn.finalAgent?.replaceAll(' ', '') === step.expectedAgent.replaceAll(' ', ''),
      requiredTools: (step.requiredTools ?? []).every((name) => turnCalls.includes(name) || toolNames.includes(name)),
      expectedResults: step.expectedResults === undefined || (Array.isArray(runtime.searchResults) && runtime.searchResults.length === step.expectedResults),
      expectedDate: step.expectedDate === undefined || chat.summaryContext.outbound_date === step.expectedDate,
    };
    if (step.avoidMuseums) assertions.museumPreference = chat.summaryContext.placesOfInterest.length > 0 &&
      chat.summaryContext.placesOfInterest.every((p) => !/museum|sangrahalaya/i.test(p.placeName));
    if (step.id === 'same_turn_search_filter') assertions.searchBeforeFilter = turnCalls.indexOf('flight_search') >= 0 && turnCalls.indexOf('apply_filter') > turnCalls.indexOf('flight_search');
    const usage = turn.usage;
    if (usage?.cost.tokenCostComplete && usage.cost.estimatedTokenCostUsd !== null && usage.calls.every((c) => c.hostedToolCalls === 0)) {
      budget.reservedUsd = reservedBefore + usage.cost.estimatedTokenCostUsd;
    }
    const knownCache = usage?.calls.every((c) => c.cachedInputTokens !== null && c.inputTokens !== null);
    const inputTokens = usage?.inputTokens ?? null;
    const countingMs = budget.countingMs - countingBefore;
    rows.push({ config, label, repetition, step: step.id, assertions, usage, toolCalls: turnCalls,
      latencyMs: performance.now() - start, countingMs,
      applicationLatencyExcludingCounterMs: Math.max(0, (usage?.latencyMs ?? 0) - countingMs),
      firstDeltaExcludingCounterMs: usage?.firstDeltaMs != null ? Math.max(0, usage.firstDeltaMs - (firstDeltaCountingMs ?? 0)) : null,
      cachedInputRatio: knownCache && inputTokens ? usage!.calls.reduce((n, c) => n + c.cachedInputTokens!, 0) / inputTokens : null,
      compactionMarkersStored: items.filter((i) => i.type === 'compaction').length,
      error: turn.error ? { name: (turn.error as any).name, code: (turn.error as any).code } : null });
    originalLog(JSON.stringify({ config, label, repetition, step: step.id, passed: Object.values(assertions).every(Boolean), modelRequests: budget.requests, reservedUsd: Number(budget.reservedUsd.toFixed(4)) }));
    await save();
    if (!Object.values(assertions).every(Boolean)) { failed = true; break; }
  }
  const runRows = rows.slice(startRow);
  runs.push({ config, label, repetition, completedSteps: runRows.length, plannedSteps: steps.length,
    passed: !failed && runRows.length === steps.length && !budget.stopped,
    inputTokens: runRows.every((r) => r.usage?.inputTokens != null) ? runRows.reduce((n, r) => n + r.usage.inputTokens, 0) : null,
    calculatedTokenCostUsd: runRows.every((r) => r.usage?.cost?.estimatedTokenCostUsd != null) ? runRows.reduce((n, r) => n + r.usage.cost.estimatedTokenCostUsd, 0) : null,
    latencyMs: runRows.reduce((n, r) => n + r.applicationLatencyExcludingCounterMs, 0),
    firstDeltaMs: median(runRows.map((r) => r.firstDeltaExcludingCounterMs).filter((v) => typeof v === 'number')),
  });
  await save();
  return !failed && !budget.stopped;
}

function comparisons() {
  const labels = [...new Set(runs.map((r) => r.label))];
  return labels.flatMap((label) => ['projections', 'compaction'].map((config) => {
    const base = runs.filter((r) => r.label === label && r.config === 'baseline' && r.passed);
    const candidate = runs.filter((r) => r.label === label && r.config === config && r.passed);
    const complete = base.length >= 3 && candidate.length >= 3;
    const stats = (list: Row[], key: string) => list.every((r) => typeof r[key] === 'number') ? median(list.map((r) => r[key])) : null;
    const baselineCost = stats(base, 'calculatedTokenCostUsd'), candidateCost = stats(candidate, 'calculatedTokenCostUsd');
    const baselineLatency = stats(base, 'latencyMs'), candidateLatency = stats(candidate, 'latencyMs');
    return { label, config, complete, baselineCost, candidateCost, baselineLatency, candidateLatency,
      costGate: complete && baselineCost !== null && candidateCost !== null && candidateCost < baselineCost,
      latencyGate: complete && baselineLatency !== null && candidateLatency !== null && candidateLatency <= baselineLatency * 1.1 };
  }));
}
async function save() {
  const report = { generatedAt: new Date().toISOString(), sdkVersion: '0.17.0', budget, clock: clock.toISOString(), seededHistory: flags.has('--seeded'),
    evaluationLimits: { maxOutputTokens: 2048, maxHostedToolCallsPerRequest: 1, timeoutRecoveries: 0,
      latencyIncludesCounter: true, correctedLatencyIsDiagnostic: true },
    runs, rows, comparisons: comparisons(), releaseApproved: false };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(directory, 'report.md'), ['# Live session evaluation', '',
    `Generated requests: ${budget.requests}; count requests: ${budget.countRequests}; conservative reserved budget: $${budget.reservedUsd.toFixed(4)}.`,
    `Stop: ${budget.stopped ?? 'none'}. Release approved: false (full gates require explicit review).`, '',
    '| Configuration | Scenario | Repetition | Steps | Passed | Token cost estimate USD |', '| --- | --- | ---: | ---: | --- | ---: |',
    ...runs.map((r) => `| ${r.config} | ${r.label} | ${r.repetition} | ${r.completedSteps}/${r.plannedSteps} | ${r.passed} | ${r.calculatedTokenCostUsd ?? 'unknown'} |`), '',
    'Counter time is recorded separately. Output/tool limits apply equally to both configurations. Synthetic local chat storage is separate from production chats. No raw content or compaction payload is included in this report.', ''].join('\n'));
}

try {
  if (flags.has('--continuity')) {
    await runScenario('compaction', [
      { id: 'first_boundary_flight', message: 'Tell me about flight option 3.', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedResults: 20, expectedDate: '2026-10-15' },
      { id: 'second_boundary_trip', message: 'Now plan two days in Mumbai respecting my earlier activity preference.', expectedAgent: 'Trip Planner Agent', seedBefore: true, avoidMuseums: true },
      { id: 'return_to_flight', message: 'Back to the flights. Tell me about option 3 and keep the original departure date.', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedResults: 20, expectedDate: '2026-10-15', restart: true },
    ], 1, '50-turn');
  } else {
  const repetitions = value('repetitions', flags.has('--full') ? 3 : 1);
  const lengthFlag = process.argv.find((arg) => arg.startsWith('--lengths='))?.split('=')[1];
  const lengths = flags.has('--dates-only') ? [] : lengthFlag ? lengthFlag.split(',').map(Number) : flags.has('--full') ? [5, 20, 50] : [5];
  if (lengths.some((length) => ![5, 20, 50].includes(length))) throw new Error('Lengths must be 5, 20, or 50');
  let healthy = true;
  outer: for (const length of lengths) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const selectedConfig = process.argv.find((arg) => arg.startsWith('--configuration='))?.split('=')[1];
    if (selectedConfig && !['baseline', 'projections', 'compaction'].includes(selectedConfig)) throw new Error('Invalid evaluation configuration');
    for (const config of selectedConfig ? [selectedConfig] : flags.has('--compaction') ? ['baseline', 'projections', 'compaction'] : ['baseline', 'projections']) {
      const steps = flags.has('--seeded') ? [{ id: 'live_option_after_seeded_history', message: 'Tell me about option 3 from the current flights.', expectedAgent: 'Flight Agent' as const,
        requiredTools: ['getGeneratedContractsContext'], expectedDate: '2026-10-15', expectedResults: 20 }] : scenarioSteps(length);
      healthy = await runScenario(config, steps, repetition, `${length}-turn`);
      if (!healthy) break outer; // Do not spend on a larger matrix while a prerequisite fails.
    }
  }
  if (healthy && (flags.has('--dates') || flags.has('--dates-only'))) {
    outerDates: for (let i = 0; i < dateScenarios.length; i++) for (const config of ['baseline', 'projections']) {
      if (!await runScenario(config, dateScenarios[i]!, 1, `date-case-${i + 1}`)) break outerDates;
    }
  }
  }
} catch (error) { budget.stopped ??= safeError(error); }
finally { sessionOptimization.mode = originalMode; console.log = originalLog; await save(); }
console.log(JSON.stringify({ report: resolve(directory, 'report.md'), budget, failedRuns: runs.filter((r) => !r.passed).length }));
if (budget.stopped || runs.some((r) => !r.passed)) process.exitCode = 2;
