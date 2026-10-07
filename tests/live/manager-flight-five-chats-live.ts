/**
 * Paid, end-to-end Manager -> Flight Agent conversation evaluation.
 *
 * Each invocation requires exactly one --chat so conversations are run,
 * inspected, and stabilized sequentially rather than as a blind batch.
 *
 * Run:
 *   $env:RUN_MANAGER_FLIGHT_LIVE='1'
 *   npx tsx tests/live/manager-flight-five-chats-live.ts --chat <id>
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  managerFlightComplexConversations,
  type ManagerFlightConversationTurn,
} from '../fixtures/manager-flight-complex-conversations.js';
import { managerFlightNormalizationConversation } from '../fixtures/manager-flight-normalization-conversation.js';
import { expectedFilterValues, expectedPredictionInput, expectedSearchPayload } from '../fixtures/manager-flight-complex-state.js';
import {
  activeFilterValues, comparableToolSequence, filterValueIssues, fullAirportGroupEvidence, parseToolValue, payloadFieldIssues, dateSweepPromiseIssues, failedPredictionCtaIssues, flightCardsVisible, managerSpecialistNames,
  predictionSearchIssues, searchProducedResults, suggestionIssues,
  type ObservedFlightToolCall,
} from './manager-flight-evidence.js';

if (process.env.RUN_MANAGER_FLIGHT_LIVE !== '1') {
  throw new Error('Set RUN_MANAGER_FLIGHT_LIVE=1 to run the paid Manager -> Flight evaluation.');
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the live evaluation.');
}

process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
process.env.OPENAI_FLIGHT_REASONING_EFFORT = 'low';
process.env.OPENAI_GATEWAY_REASONING_EFFORT = 'low';
process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT = 'low';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const traceExportStatuses: number[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (url.includes('/v1/responses') && String(init?.method || input?.method || 'POST').toUpperCase() === 'POST') {
    const body = typeof init?.body === 'string' ? init.body : await input.clone().text();
    const request = JSON.parse(body);
    if (request.model !== 'gpt-5.2' || request.reasoning?.effort !== 'low') {
      throw new Error('This eval permits only gpt-5.2 with low reasoning.');
    }
  }
  const response = await originalFetch(input, init);
  if (url.includes('/v1/traces/ingest')) traceExportStatuses.push(response.status);
  return response;
}) as typeof fetch;

const [
  { OpenAIConversationsSession },
  { generateTraceId, getGlobalTraceProvider },
  { runGatewayAgentTextStream },
  { hydrateGatewayContext, snapshotGatewayContext },
  { ManagerAgent },
  { TripPlannerAgent },
  { pinManagerLiveModels },
  { flightTools },
  { snapshotFlightSearchRuntime },
  { FlightManagerAgent },
  { getRequestState },
  { getFlightSearchState },
  { defaultPricePredictionRepository },
] = await Promise.all([
  import('@openai/agents-openai'),
  import('@openai/agents'),
  import('../../src/agents/manager-orchestrator/streaming.js'),
  import('../../src/api/chat/context-hydration.js'),
  import('../../src/agents/manager-orchestrator/agent.js'),
  import('../../src/agents/trip-planner/agent.js'),
  import('./manager-live-model-policy.js'),
  import('../../src/agents/flight/tools/index.js'),
  import('../../src/agents/flight/context/search-runtime-store.js'),
  import('../../src/agents/flight/agent.js'),
  import('../../src/shared/runtime/request-context.js'),
  import('../../src/agents/flight/context/flight-context.js'),
  import('../../src/agents/flight/tools/price-prediction/repository.js'),
]);

// Pin the actual singleton agents, not configuration objects that were already
// read at module initialization. Production defaults remain unchanged on disk.
pinManagerLiveModels();

const liveModels = {
  manager: ManagerAgent.model,
  flight: FlightManagerAgent.model,
  tripPlanner: TripPlannerAgent.model,
};
if (Object.values(liveModels).some((model) => model !== 'gpt-5.2')) {
  throw new Error(`All agents in this eval must use gpt-5.2: ${JSON.stringify(liveModels)}`);
}
if (FlightManagerAgent.modelSettings.reasoning?.effort !== 'low') {
  throw new Error('Flight reasoning effort must be low for this eval.');
}
if (ManagerAgent.modelSettings.reasoning?.effort !== 'low') {
  throw new Error('Manager reasoning effort must be low for this eval.');
}
if (TripPlannerAgent.modelSettings.reasoning?.effort !== 'low') {
  throw new Error('Supporting-agent reasoning effort must be low for this eval.');
}

const registeredFlightTools = flightTools.map((tool) => String(tool.name));
const expectedRegisteredTools = [
  'flight_search',
  'getGeneratedContractsContext',
  'apply_filter',
  'price_prediction_tool',
  'update_flight_suggested_questions',
];
if (JSON.stringify(registeredFlightTools) !== JSON.stringify(expectedRegisteredTools)) {
  throw new Error(
    `Fixture coverage must be updated for current flightTools. Registered: ${registeredFlightTools.join(', ')}`,
  );
}

// Check the existing account's availability once without replaying a paid
// conversation. This still uses the production Manager path, never Flight alone.
if (process.argv.includes('--check-api')) {
  const [{ default: OpenAI }, { Runner, OpenAIProvider }, { runGatewayAgent }] = await Promise.all([
    import('openai'), import('@openai/agents'),
    import('../../src/agents/manager-orchestrator/runner.js'),
  ]);
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ openAIClient: new OpenAI({ maxRetries: 0 }) }),
    toolExecution: { maxFunctionToolConcurrency: 1 },
  });
  try {
    const result = await runGatewayAgent({
      input: 'Hello.', context: {}, runner, maxTurns: 2,
      requestId: 'manager-flight-api-availability',
    });
    console.log(JSON.stringify({ apiAvailable: true, models: liveModels, reasoningEffort: 'low',
      finalAgent: result.finalAgentName, specialistsUsed: managerSpecialistNames(result) }));
  } catch (error) {
    const failure = error as Error & { code?: string };
    console.log(JSON.stringify({ apiAvailable: false, code: failure.code || null,
      message: String(failure.message || '').slice(0, 500), retries: 0 }));
    process.exitCode = 1;
  }
  await getGlobalTraceProvider().forceFlush();
  process.exit(process.exitCode || 0);
}

// Observe actual nested SDK calls, including successful predictions that are
// absent from the application log. Never infer occurrence or order from intent.
const toolCallsByRequest = new Map<string, ObservedFlightToolCall[]>();
FlightManagerAgent.on('agent_tool_start', (runContext, tool, details) => {
  const state = getRequestState(runContext.context as any) as any;
  const requestId = String(state.requestId || '');
  const calls = toolCallsByRequest.get(requestId) || [];
  const raw = details.toolCall as any;
  calls.push({ callId: String(raw.callId || raw.id || ''), tool: tool.name,
    input: parseToolValue(raw.arguments), completed: false });
  toolCallsByRequest.set(requestId, calls);
});
FlightManagerAgent.on('agent_tool_end', (runContext, _tool, output, details) => {
  const state = getRequestState(runContext.context as any) as any;
  const raw = details.toolCall as any;
  const call = toolCallsByRequest.get(String(state.requestId || ''))
    ?.find((entry) => entry.callId === String(raw.callId || raw.id || '') && !entry.completed);
  if (call) { call.output = parseToolValue(output); call.completed = true; }
});

const limitIndex = process.argv.indexOf('--limit-turns');
const limitTurns = limitIndex < 0 ? Infinity : Number(process.argv[limitIndex + 1]);
const chatIndex = process.argv.indexOf('--chat');
const chatId = chatIndex < 0 ? null : process.argv[chatIndex + 1];
if (!chatId) {
  throw new Error('Pass exactly one conversation with --chat <id>; batch execution is intentionally disabled.');
}
if (!(limitTurns === Infinity || (Number.isInteger(limitTurns) && limitTurns > 0))) {
  throw new Error('--limit-turns must be a positive integer.');
}
const availableConversations = [...managerFlightComplexConversations, managerFlightNormalizationConversation];
const scenario = availableConversations.find((item) => item.id === chatId);
if (!scenario) {
  throw new Error(
    `Unknown chat: ${chatId}. Available: ${availableConversations.map((item) => item.id).join(', ')}`,
  );
}

// The production prediction client is a stub that returns no rows, so every
// prediction would be NO_PREDICTIONS. Conversations marked 'available' get
// deterministic ranked dates instead, so the success path is exercised too:
// the same date always gets the same price, and re-runs rank identically.
const PREDICTION_TODAY = '2026-10-05';
function isoDay(base: string, offset: number): string {
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function predictedPrice(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 100_003;
  return 180 + (hash % 260);
}
function predictionRow(isRoundTrip: boolean) {
  const trips: Record<string, unknown> = {};
  for (let offset = 0; offset <= 89; offset += 1) {
    const outbound = isoDay(PREDICTION_TODAY, offset);
    if (!isRoundTrip) {
      trips[outbound] = predictedPrice(outbound);
      continue;
    }
    const returns: Record<string, number> = {};
    for (let stay = 1; stay <= 14; stay += 1) {
      const back = isoDay(PREDICTION_TODAY, offset + stay);
      returns[back] = predictedPrice(`${outbound}/${back}`);
    }
    trips[outbound] = returns;
  }
  return {
    SearchDate: isoDay(PREDICTION_TODAY, -1),
    Currency: 'USD',
    Thresholds: JSON.stringify({ LowerLimit: 250, UpperLimit: 380 }),
    TripPredictions: JSON.stringify(trips),
  };
}
if (scenario.predictionData === 'available') {
  defaultPricePredictionRepository.findCityPrediction = async (criteria) => predictionRow(criteria.isRoundTrip);
}

type ManagerResult = {
  status: string;
  summary: string;
  completedTask: string | null;
  findings: string[];
  limitations: string[];
  nextStep: string | null;
  missingInformation: string[];
  presentation: string | null;
};

type ToolFeedback = {
  tool: string;
  ok: boolean | null;
  code: string | null;
  affectedFields: string[];
};

type TurnReport = {
  chat: string;
  turn: number;
  traceId: string;
  user: string;
  expectedIntent: string;
  expectedTools: readonly string[];
  why: string;
  expectedStateChange: string;
  validates: string;
  output: string;
  finalAgent: string | null;
  specialistsUsed: string[];
  specialistSubtasks: Array<{ tool: string; input: string }>;
  flightToolCalls: ObservedFlightToolCall[];
  searchStateBefore: any;
  searchStateAfter: any;
  activeFilters: any[];
  observedFlightTools: string[];
  comparedFlightTools: string[];
  managerResults: ManagerResult[];
  toolFeedback: ToolFeedback[];
  predictionStatus: string | null;
  searchKeyBefore: string | null;
  searchKeyAfter: string | null;
  activeFilterTypes: string[];
  suggestions: string[];
  renderFlightOptions: boolean;
  resultCount: number;
  noteCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  latencyMs: number;
  classification: 'stable' | 'unexpected_failure' | 'blocked_external';
  checks: string[];
  acceptableDeviations?: string[];
  error?: string;
};

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parseManagerResults(items: any[]): ManagerResult[] {
  return (items || [])
    .filter((item: any) => item?.type === 'tool_call_output_item')
    .flatMap((item: any) => {
      try {
        const value = JSON.parse(String(item.output || ''));
        return typeof value.status === 'string' && typeof value.summary === 'string'
          ? [{
              status: value.status,
              summary: value.summary,
              completedTask: typeof value.completedTask === 'string' ? value.completedTask : null,
              findings: Array.isArray(value.findings) ? value.findings : [],
              limitations: Array.isArray(value.limitations) ? value.limitations : [],
              nextStep: typeof value.nextStep === 'string' ? value.nextStep : null,
              missingInformation: Array.isArray(value.missingInformation) ? value.missingInformation : [],
              presentation: typeof value.presentation === 'string' ? value.presentation : null,
            }] : [];
      } catch {
        return [];
      }
    });
}

function searchKeyCheck(
  expected: ManagerFlightConversationTurn['expectedSearchKeyChange'],
  before: string | null,
  after: string | null,
): string | null {
  if (expected === 'new' && (!after || after === before)) {
    return `expected a new search key; before=${before || 'none'} after=${after || 'none'}`;
  }
  if (expected === 'same' && (!after || after !== before)) {
    return `expected the same search key; before=${before || 'none'} after=${after || 'none'}`;
  }
  if (expected === 'none' && (before || after)) {
    return `expected no search key; before=${before || 'none'} after=${after || 'none'}`;
  }
  return null;
}

function renderMarkdown(report: TurnReport[], coverage: Record<string, boolean>): string {
  const lines = [
    `# ${scenario.title}`,
    '',
    `Focus: ${scenario.focus}`,
    '',
    `Model policy: Manager=${liveModels.manager}, Flight=${liveModels.flight}, supporting=${liveModels.tripPlanner}; reasoning=low.`,
    '',
  ];
  for (const turn of report) {
    lines.push(
      `## Turn ${turn.turn}`,
      '',
      `- User message: ${turn.user}`,
      `- Expected intent: ${turn.expectedIntent}`,
      `- Expected tool(s): ${turn.expectedTools.join(' -> ')}`,
      `- Why that tool should be used: ${turn.why}`,
      `- Expected state/context change: ${turn.expectedStateChange}`,
      `- What we are validating: ${turn.validates}`,
      `- Manager -> Flight subtask: ${turn.specialistSubtasks.map((item) => item.input).join(' | ') || 'none'}`,
      `- Actual tool(s): ${turn.observedFlightTools.join(' -> ') || 'none'}`,
      `- Actual search key change: ${turn.searchKeyBefore || 'none'} -> ${turn.searchKeyAfter || 'none'}`,
      `- Actual active filters: ${turn.activeFilterTypes.join(', ') || 'none'}`,
      `- Actual filter values: ${JSON.stringify(activeFilterValues(turn.activeFilters))}`,
      `- Classification: ${turn.classification}`,
      `- Checks: ${turn.checks.join('; ') || 'none'}`,
      `- Acceptable deviations: ${turn.acceptableDeviations?.join('; ') || 'none'}`,
      `- Manager output: ${turn.output.replace(/\s+/g, ' ').trim() || 'none'}`,
      '',
    );
  }
  lines.push('## Tool coverage checklist', '');
  for (const toolName of registeredFlightTools) {
    lines.push(`- [${coverage[toolName] ? 'x' : ' '}] ${toolName}`);
  }
  lines.push('');
  return lines.join('\n');
}

const report: TurnReport[] = [];
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputBase = path.resolve(`artifacts/manager-flight-complex-${scenario.id}-${timestamp}`);
const jsonPath = `${outputBase}.json`;
const markdownPath = `${outputBase}.md`;
await fs.mkdir(path.dirname(jsonPath), { recursive: true });

function currentCoverage() {
  return Object.fromEntries(registeredFlightTools.map((name) => [
    name, report.some((turn) => turn.observedFlightTools.includes(name)),
  ]));
}

async function persistReport() {
  const coverage = currentCoverage();
  await fs.writeFile(jsonPath, JSON.stringify({
    fixedNow: fixedNow.toISOString(), models: liveModels, reasoningEffort: 'low',
    registeredFlightTools, scenario, coverage, turns: report,
  }, null, 2));
  await fs.writeFile(markdownPath, renderMarkdown(report, coverage));
}

const fixedNow = new Date('2026-10-05T10:00:00.000Z');
const session = new OpenAIConversationsSession();
let runtimeContext: any = {};
let attempted = 0;

for (const [index, expectation] of scenario.turns.entries()) {
  if (attempted >= limitTurns) break;
  attempted += 1;
  const started = Date.now();
  const traceId = generateTraceId();
  const requestId = `manager-flight-complex-${scenario.id}-${index + 1}`;
  const context = hydrateGatewayContext(runtimeContext);
  const searchKeyBefore = typeof context.flight?.searchKey === 'string'
    ? context.flight.searchKey : null;
  const predictionBefore = JSON.stringify(context.flight?.lastPricePrediction || null);
  const searchStateBefore = structuredClone(getFlightSearchState(context));
  const filtersBefore = snapshotFlightSearchRuntime(searchKeyBefore)?.appliedFilters || [];
  const visibilityBefore = (Array.isArray(context.flight?.searchResults) ? context.flight.searchResults : [])
    .map((flight: any) => ({ id: flight.id, display: flight.display }));
  const suggestionsBefore = Array.isArray(context.flight?.suggestedQuestions)
    ? context.flight.suggestedQuestions.map(String) : [];

  try {
    const run = runGatewayAgentTextStream({
      input: expectation.user,
      requestId,
      traceId,
      sessionId: `manager-flight-complex-${scenario.id}`,
      context,
      session,
      now: fixedNow,
      timeZone: 'Asia/Kolkata',
      maxTurns: 12,
    });
    let streamed = '';
    const streamDone = (async () => {
      for await (const chunk of run.stream) streamed += String(chunk);
    })();
    const [streamResult, completionResult] = await Promise.allSettled([streamDone, run.completed]);
    if (completionResult.status === 'rejected') throw completionResult.reason;
    if (streamResult.status === 'rejected') throw streamResult.reason;

    const result = completionResult.value;
    const specialistsUsed = managerSpecialistNames(result);
    const renderFlightOptions = flightCardsVisible(result.context);
    const predictionAfter = JSON.stringify(result.context.flight?.lastPricePrediction || null);
    const predictionChanged = predictionAfter !== predictionBefore;
    const flightToolCalls = toolCallsByRequest.get(requestId) || [];
    const observedFlightTools = flightToolCalls.map((call) => call.tool);
    const comparedFlightTools = comparableToolSequence(flightToolCalls);
    const output = String(result.output || '');
    const specialistSubtasks = (result.result?.newItems || [])
      .filter((item: any) => item?.type === 'tool_call_item')
      .flatMap((item: any) => {
        const raw = item.rawItem || {};
        try {
          const parsed = JSON.parse(String(raw.arguments || '{}'));
          return typeof parsed.input === 'string'
            ? [{ tool: String(raw.name || ''), input: parsed.input }]
            : [];
        } catch {
          return [];
        }
      });
    const searchKeyAfter = typeof result.context.flight?.searchKey === 'string'
      ? result.context.flight.searchKey : null;
    const searchRuntime = snapshotFlightSearchRuntime(searchKeyAfter);
    const activeFilters = searchRuntime?.appliedFilters || [];
    const searchStateAfter = structuredClone(getFlightSearchState(result.context));
    const activeFilterTypes = Array.from(new Set(
      (searchRuntime?.appliedFilters || []).map((filter: any) => String(filter.filterType)),
    ));
    const suggestions = Array.isArray(result.context.flight?.suggestedQuestions)
      ? result.context.flight.suggestedQuestions.map(String) : [];
    const managerResults = parseManagerResults(result.result?.newItems || []);
    const toolFeedback = flightToolCalls.map((call) => ({
      tool: call.tool,
      ok: typeof call.output?.ok === 'boolean' ? call.output.ok : null,
      code: call.output?.code || (call.output?.ok === false ? call.output.status : null) || null,
      affectedFields: call.output?.recovery?.affectedFields || [],
    }));
    const prediction = result.context.flight?.lastPricePrediction as { status?: unknown } | null;
    const predictionStatus = typeof prediction?.status === 'string' ? prediction.status : null;
    const resultCount = Array.isArray(result.context.flight?.searchResults)
      ? result.context.flight.searchResults.length : 0;
    const noteCount = (output.match(/Note: Prices shown are per person\./g) || []).length;
    const checks: string[] = [];

    if (result.finalAgentName !== 'Manager Agent') checks.push('final agent was not Manager');
    if (streamed !== output) checks.push('stream differs from finalized output');
    if (!output.trim()) checks.push('empty final output');
    if (/^\s*\{\s*"status"\s*:/.test(output)) checks.push('structured specialist JSON leaked to user');
    if (/\b(?:flight_search|apply_filter|price_prediction_tool|searchKey|toolCallLog)\b/.test(output)) {
      checks.push('internal tool identifier leaked to user');
    }
    if (!sameSequence(specialistsUsed, ['flight_agent'])) {
      checks.push(`expected only flight_agent specialist; got ${specialistsUsed.join(', ') || 'none'}`);
    }
    if (managerResults.length !== 1) {
      checks.push(`expected one Flight specialist result; got ${managerResults.length}`);
    }
    if (flightToolCalls.some((call) => !call.completed)) checks.push('a Flight tool started without a captured result');
    const allowedSequences = [expectation.expectedTools, ...(expectation.acceptableToolSequences || [])];
    if (!allowedSequences.some((sequence) => sameSequence(comparedFlightTools, sequence))) {
      checks.push(
        `expected tools ${allowedSequences.map((sequence) => sequence.join(' -> ')).join(' OR ')}, got ${comparedFlightTools.join(' -> ') || 'none'}`,
      );
    }
    const allowedStatuses = expectation.expectedStatuses || ['success', 'partial'];
    const flightStatus = managerResults[0]?.status;
    if (flightStatus && !allowedStatuses.includes(flightStatus as any)) {
      checks.push(`Flight feedback status ${flightStatus}; expected ${allowedStatuses.join(' or ')}`);
    }
    if (flightStatus === 'needs_input' && !managerResults[0]?.missingInformation.length) {
      checks.push('needs_input feedback named no missing information');
    }
    if (observedFlightTools.at(-1) !== 'update_flight_suggested_questions') {
      checks.push('suggested-questions update was not the last Flight tool');
    }
    const keyIssue = searchKeyCheck(expectation.expectedSearchKeyChange, searchKeyBefore, searchKeyAfter);
    if (keyIssue) checks.push(keyIssue);
    const filterEvidence = fullAirportGroupEvidence(activeFilterValues(activeFilters), expectedFilterValues[scenario.id][index], {
      departureAirport: result.context.flight?.departAirports || [],
      arrivalAirport: result.context.flight?.depLandAirports || [],
      flights: searchRuntime?.sourceFlights || [],
    });
    if (!sameSet(Object.keys(filterEvidence.values), expectation.expectedFilterTypes)) {
      checks.push(
        `expected active filters ${expectation.expectedFilterTypes.join(', ') || 'none'}, got ${activeFilterTypes.join(', ') || 'none'}`,
      );
    }
    checks.push(...filterValueIssues(filterEvidence.values, expectedFilterValues[scenario.id][index]));
    if (expectation.expectedSearchKeyChange === 'same' && JSON.stringify(searchStateBefore) !== JSON.stringify(searchStateAfter)) {
      checks.push('a filter/inspection/advice turn changed core search parameters');
    }
    if (!observedFlightTools.includes('flight_search') && !observedFlightTools.includes('apply_filter')) {
      checks.push(...filterValueIssues(activeFilterValues(activeFilters), activeFilterValues(filtersBefore)));
    }
    const expectedPrediction = expectedPredictionInput[scenario.id]?.[index + 1];
    if (expectedPrediction) {
      const call = flightToolCalls.find((entry) => entry.tool === 'price_prediction_tool');
      for (const [field, expected] of Object.entries(expectedPrediction)) {
        const actual = field === 'tripDurationFlexibility' ? call?.input?.[field] ?? 0 : call?.input?.[field];
        if (actual !== expected) checks.push(`prediction ${field}: expected ${expected}, got ${actual}`);
      }
    }
    const expectedSearch = expectedSearchPayload[scenario.id]?.[index + 1];
    if (expectedSearch) {
      const call = flightToolCalls.find((entry) => entry.tool === 'flight_search');
      checks.push(...payloadFieldIssues(call?.input, expectedSearch));
    }
    if (expectation.reusesPreviousSearchDates) {
      const ond = flightToolCalls.find((entry) => entry.tool === 'flight_search')?.input?.onds?.[0] || {};
      if (ond.outbound_date !== searchStateBefore?.outbound_date) {
        checks.push(`search did not reuse the previous outbound date ${searchStateBefore?.outbound_date}; got ${ond.outbound_date}`);
      }
      if ((ond.return_date ?? null) !== (searchStateBefore?.return_date ?? null)) {
        checks.push(`search did not reuse the previous return date ${searchStateBefore?.return_date ?? null}; got ${ond.return_date ?? null}`);
      }
    }
    checks.push(...predictionSearchIssues(flightToolCalls));
    if (suggestions.length !== 3) {
      checks.push(`expected exactly three grounded suggestions; got ${suggestions.length}`);
    }
    checks.push(...suggestionIssues({
      suggestions,
      previous: suggestionsBefore,
      activeFilters,
      airlineOptions: Array.isArray(result.context.flight?.airlineFilterOptions)
        ? result.context.flight.airlineFilterOptions as any[] : [],
      resultCount,
    }));
    const successfulSearch = flightToolCalls.some((call) => call.tool === 'flight_search' && searchProducedResults(call));
    if (successfulSearch && resultCount > 0 && !renderFlightOptions) {
      checks.push('successful search did not leave visible client flight cards');
    }
    if (successfulSearch && renderFlightOptions && noteCount !== 1) {
      checks.push('new search cards need exactly one per-person note');
    }
    if (successfulSearch && renderFlightOptions && managerResults[0]?.presentation !== 'flight_cards_with_price_note') {
      checks.push(`a new search with visible cards reported presentation ${managerResults[0]?.presentation ?? null}`);
    }
    if (!successfulSearch && noteCount > 0) {
      checks.push('per-person note added without a successful current-turn search');
    }
    if (
      predictionChanged && predictionStatus !== 'SUCCESS' &&
      /\b(?:cheapest|best|strongest)\s+(?:travel\s+)?date\s+(?:is|was)\b/i.test(output)
    ) {
      checks.push('non-success prediction produced an unsupported winning-date claim');
    }
    if (predictionChanged && predictionStatus !== 'SUCCESS') {
      checks.push(...dateSweepPromiseIssues(`${output} ${managerResults.map((entry) => entry.nextStep || '').join(' ')}`));
      checks.push(...failedPredictionCtaIssues(suggestions));
    }
    if (scenario.id === 'normalization_fewshots' && index === 4 &&
      suggestions.some((suggestion: string) => /\bnon[ -]?stop\b/i.test(suggestion))) {
      checks.push('suggestions recycled the used-and-reset nonstop action on the unchanged trip');
    }
    if (scenario.id === 'normalization_fewshots' && index === 5) {
      const rankingRead = flightToolCalls.find((call) => call.tool === 'getGeneratedContractsContext');
      if (rankingRead?.input?.mode !== 'read' || rankingRead?.input?.indexes !== null) {
        checks.push('open-ended cheapest ranking must read all current contracts without selecting an index');
      }
      const visibilityAfter = (Array.isArray(result.context.flight?.searchResults) ? result.context.flight.searchResults : [])
        .map((flight: any) => ({ id: flight.id, display: flight.display }));
      if (JSON.stringify(visibilityAfter) !== JSON.stringify(visibilityBefore)) {
        checks.push('open-ended cheapest ranking changed current card visibility');
      }
      if (!specialistSubtasks.some((subtask) => /historical/i.test(subtask.input) && /non[ -]?stop/i.test(subtask.input))) {
        checks.push('Manager dropped the consumed/reversed-action history on the next inspection turn');
      }
      if (suggestions.some((suggestion: string) => /\bprice cap\b/i.test(suggestion))) {
        checks.push('suggestions recycled the used-and-removed price-cap action on the unchanged trip');
      }
    }

    const sdkUsage = result.result?.runContext?.usage;
    const item: TurnReport = {
      chat: scenario.id,
      turn: index + 1,
      traceId,
      user: expectation.user,
      expectedIntent: expectation.expectedIntent,
      expectedTools: expectation.expectedTools,
      why: expectation.why,
      expectedStateChange: expectation.expectedStateChange,
      validates: expectation.validates,
      output,
      finalAgent: result.finalAgentName,
      specialistsUsed,
      specialistSubtasks,
      flightToolCalls,
      searchStateBefore,
      searchStateAfter,
      activeFilters,
      observedFlightTools,
      comparedFlightTools,
      managerResults,
      toolFeedback,
      predictionStatus,
      searchKeyBefore,
      searchKeyAfter,
      activeFilterTypes,
      suggestions,
      renderFlightOptions,
      resultCount,
      noteCount,
      inputTokens: sdkUsage?.inputTokens ?? null,
      outputTokens: sdkUsage?.outputTokens ?? null,
      modelCalls: sdkUsage?.requests ?? 0,
      latencyMs: Date.now() - started,
      classification: checks.length === 0 ? 'stable' : 'unexpected_failure',
      checks,
      acceptableDeviations: filterEvidence.acceptableDeviations,
    };
    report.push(item);
    runtimeContext = snapshotGatewayContext(result.context);
    await persistReport();
    console.log(JSON.stringify({ ...item, output: output.slice(0, 500),
      flightToolCalls: flightToolCalls.map(({ callId, tool, input, completed }) => ({ callId, tool, input, completed })),
    }));
    if (checks.length > 0) break;
  } catch (error) {
    const failure = error as Error & { code?: string };
    const blockedExternal = /credit_balance_exhausted|insufficient_quota|no credits remaining/i.test(`${failure.code} ${failure.message}`);
    const flightToolCalls = toolCallsByRequest.get(requestId) || [];
    const activeFilters = snapshotFlightSearchRuntime(context.flight?.searchKey)?.appliedFilters || [];
    const item: TurnReport = {
      chat: scenario.id,
      turn: index + 1,
      traceId,
      user: expectation.user,
      expectedIntent: expectation.expectedIntent,
      expectedTools: expectation.expectedTools,
      why: expectation.why,
      expectedStateChange: expectation.expectedStateChange,
      validates: expectation.validates,
      output: '',
      finalAgent: null,
      specialistsUsed: [],
      specialistSubtasks: [],
      flightToolCalls,
      searchStateBefore,
      searchStateAfter: structuredClone(getFlightSearchState(context)),
      activeFilters,
      observedFlightTools: flightToolCalls.map((call) => call.tool),
      comparedFlightTools: comparableToolSequence(flightToolCalls),
      managerResults: [],
      toolFeedback: [],
      predictionStatus: null,
      searchKeyBefore,
      searchKeyAfter: searchKeyBefore,
      activeFilterTypes: [...new Set(activeFilters.map((filter: any) => String(filter.filterType)))],
      suggestions: context.flight?.suggestedQuestions || [],
      renderFlightOptions: false,
      resultCount: 0,
      noteCount: 0,
      inputTokens: null,
      outputTokens: null,
      modelCalls: 0,
      latencyMs: Date.now() - started,
      classification: blockedExternal ? 'blocked_external' : 'unexpected_failure',
      checks: [blockedExternal ? 'API billing prevents further model calls' : 'turn failed'],
      error: `${failure.name || 'Error'}:${failure.code || ''}:${String(failure.message || '').slice(0, 500)}`,
    };
    report.push(item);
    await persistReport();
    console.log(JSON.stringify(item));
    break;
  }
}

const coverage = currentCoverage();
const completedConversation = report.length === scenario.turns.length &&
  report.every((turn) => turn.classification === 'stable');
const missingCoverage = registeredFlightTools.filter((name) => !coverage[name]);
if (completedConversation && missingCoverage.length > 0) {
  report.at(-1)?.checks.push(`conversation missed registered tools: ${missingCoverage.join(', ')}`);
  if (report.at(-1)) report.at(-1)!.classification = 'unexpected_failure';
}

await persistReport();
await getGlobalTraceProvider().forceFlush();

const unexpectedFailures = report.filter((item) => item.classification === 'unexpected_failure');
console.log(JSON.stringify({
  summary: true,
  chat: scenario.id,
  attempted: report.length,
  expectedTurns: scenario.turns.length,
  completedConversation,
  unexpectedFailures: unexpectedFailures.length,
  externalBlockers: report.filter((turn) => turn.classification === 'blocked_external').length,
  missingCoverage,
  totalInputTokens: report.reduce((sum, item) => sum + (item.inputTokens || 0), 0),
  totalOutputTokens: report.reduce((sum, item) => sum + (item.outputTokens || 0), 0),
  traceExportStatuses,
  jsonReport: jsonPath,
  markdownReport: markdownPath,
}));

if (!completedConversation || unexpectedFailures.length > 0 || missingCoverage.length > 0) {
  process.exitCode = 1;
}
