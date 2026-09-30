/**
 * Paid, end-to-end Manager -> Flight Agent conversation evaluation.
 * Exports Agents SDK traces for each turn to the OpenAI dashboard.
 * Run: $env:RUN_MANAGER_FLIGHT_LIVE='1'; npx tsx tests/live/manager-flight-five-chats-live.ts
 * Smoke: add --limit-turns 1
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.env.RUN_MANAGER_FLIGHT_LIVE !== '1') {
  throw new Error('Set RUN_MANAGER_FLIGHT_LIVE=1 to run the paid five-chat evaluation.');
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the live evaluation.');
}
process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
const traceExportStatuses: number[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const response = await originalFetch(input, init);
  if (String(input).includes('/v1/traces/ingest')) traceExportStatuses.push(response.status);
  return response;
}) as typeof fetch;

const [{ OpenAIConversationsSession }, { generateTraceId, getGlobalTraceProvider }, { runGatewayAgentTextStream }, { hydrateGatewayContext, snapshotGatewayContext }] =
  await Promise.all([
    import('@openai/agents-openai'),
    import('@openai/agents'),
    import('../../src/agents/manager-orchestrator/streaming.js'),
    import('../../src/api/chat/context-hydration.js'),
  ]);

const scenarios = [
  {
    id: 'search_filter_options',
    turns: [
      'Find flights from Delhi to Dubai on October 20, 2026 for one adult in economy.',
      'Show nonstop flights only.',
      'Which of the current options is cheapest?',
      'Show me option 2.',
      'Change departure to October 22, 2026, and keep everything else.',
    ],
  },
  {
    id: 'roundtrip_context_changes',
    turns: [
      'Find round-trip flights from New York to London, departing November 3, 2026 and returning November 12, 2026, for two adults.',
      'Actually make the destination Paris; keep the dates and passengers.',
      'Show morning departures.',
      'Remove the morning filter and show flights with checked baggage.',
      'Compare the shortest and cheapest current options.',
    ],
  },
  {
    id: 'clarification_to_search',
    turns: [
      'Find flights to Tokyo on November 7, 2026.',
      'I am leaving from San Francisco.',
      'Show flights under $300.',
      'Make it nonstop.',
      'What date and route are we searching now?',
    ],
  },
  {
    id: 'relative_dates_and_value',
    turns: [
      'Find flights from Los Angeles to Las Vegas next weekend.',
      'Make it for two adults instead.',
      'Now search October 10, 2026.',
      'Show flights with carry-on baggage.',
      'Which option is best value and why?',
    ],
  },
  {
    id: 'prediction_and_recovery',
    turns: [
      'What is the cheapest date to fly from Mumbai to Delhi in October 2026?',
      'Find flights from Mumbai to Delhi on October 15, 2026 instead.',
      'Show me a Super Saver fare.',
      'Show one-stop flights instead.',
      'Is option 1 shorter than option 3?',
    ],
  },
] as const;

const limitIndex = process.argv.indexOf('--limit-turns');
const limitTurns = limitIndex < 0 ? Infinity : Number(process.argv[limitIndex + 1]);
const chatIndex = process.argv.indexOf('--chat');
const chatId = chatIndex < 0 ? null : process.argv[chatIndex + 1];
if (!(limitTurns === Infinity || (Number.isInteger(limitTurns) && limitTurns > 0))) {
  throw new Error('--limit-turns must be a positive integer.');
}
if (chatId && !scenarios.some((scenario) => scenario.id === chatId)) {
  throw new Error(`Unknown chat: ${chatId}`);
}

type TurnReport = {
  chat: string;
  turn: number;
  traceId: string;
  user: string;
  output: string;
  finalAgent: string | null;
  specialistsUsed: string[];
  flightTools: string[];
  managerResults: Array<{ status: string; summary: string; completedTask: string | null; missingInformation: string[]; presentation: string | null }>;
  toolFeedback: Array<{ tool: string; ok: boolean | null; code: string | null; affectedFields: string[] }>;
  predictionStatus: string | null;
  renderFlightOptions: boolean;
  resultCount: number;
  noteCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  latencyMs: number;
  checks: string[];
  error?: string;
};

const report: TurnReport[] = [];
const fixedNow = new Date('2026-09-19T10:00:00.000Z');
let attempted = 0;

for (const scenario of scenarios.filter((item) => !chatId || item.id === chatId)) {
  if (attempted >= limitTurns) break;
  const session = new OpenAIConversationsSession();
  let runtimeContext: any = {};
  for (const [index, user] of scenario.turns.entries()) {
    if (attempted >= limitTurns) break;
    attempted += 1;
    const started = Date.now();
    const traceId = generateTraceId();
    try {
      const context = hydrateGatewayContext(runtimeContext);
      const run = runGatewayAgentTextStream({
        input: user,
        requestId: `manager-flight-live-${scenario.id}-${index + 1}`,
        traceId,
        sessionId: `manager-flight-live-${scenario.id}`,
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
      runtimeContext = snapshotGatewayContext(result.context);
      const output = String(result.output || '');
      const flightTools = (result.context.toolCallLog || [])
        .map((entry: any) => String(entry?.tool || '')).filter(Boolean);
      const managerResults = (result.result?.newItems || [])
        .filter((item: any) => item?.type === 'tool_call_output_item')
        .flatMap((item: any) => {
          try {
            const value = JSON.parse(String(item.output || ''));
            return typeof value.status === 'string' && typeof value.summary === 'string'
              ? [{
                  status: value.status,
                  summary: value.summary,
                  completedTask: typeof value.completedTask === 'string' ? value.completedTask : null,
                  missingInformation: Array.isArray(value.missingInformation) ? value.missingInformation : [],
                  presentation: typeof value.presentation === 'string' ? value.presentation : null,
                }] : [];
          } catch { return []; }
        });
      const toolFeedback = (result.context.toolCallLog || []).map((entry: any) => ({
        tool: String(entry?.tool || ''),
        ok: typeof entry?.ok === 'boolean' ? entry.ok : null,
        code: typeof entry?.code === 'string' ? entry.code : null,
        affectedFields: Array.isArray(entry?.affectedFields) ? entry.affectedFields : [],
      }));
      const prediction = result.context.flight.lastPricePrediction as { status?: unknown } | null;
      const predictionStatus = typeof prediction?.status === 'string' ? prediction.status : null;
      const resultCount = Array.isArray(result.context.flight.searchResults)
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
      if (result.specialistsUsed?.some((name: string) => name !== 'flight_agent')) {
        checks.push('unrelated specialist selected');
      }
      if (flightTools.includes('flight_search') && result.renderFlightOptions && noteCount !== 1) {
        checks.push('new search cards need exactly one per-person note');
      }
      if (!flightTools.includes('flight_search') && noteCount > 0) {
        checks.push('per-person note added without current-turn search');
      }
      const item: TurnReport = {
        chat: scenario.id, turn: index + 1, traceId, user, output,
        finalAgent: result.finalAgentName,
        specialistsUsed: result.specialistsUsed || [],
        flightTools, managerResults, toolFeedback, predictionStatus,
        renderFlightOptions: Boolean(result.renderFlightOptions),
        resultCount, noteCount,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        modelCalls: result.usage?.calls?.length || 0,
        latencyMs: Date.now() - started,
        checks,
      };
      report.push(item);
      console.log(JSON.stringify({ ...item, output: output.slice(0, 500) }));
    } catch (error) {
      const failure = error as Error & { code?: string };
      const item: TurnReport = {
        chat: scenario.id, turn: index + 1, traceId, user, output: '', finalAgent: null,
        specialistsUsed: [], flightTools: [], managerResults: [], toolFeedback: [], predictionStatus: null,
        renderFlightOptions: false,
        resultCount: 0, noteCount: 0, inputTokens: null, outputTokens: null,
        modelCalls: 0, latencyMs: Date.now() - started,
        checks: ['turn failed'], error: `${failure.name || 'Error'}:${failure.code || ''}:${String(failure.message || '').slice(0, 220)}`,
      };
      report.push(item);
      console.log(JSON.stringify(item));
      if (/\b(?:401|403|429|insufficient_quota|invalid_api_key)\b/i.test(item.error || '')) break;
    }
  }
}

const outputPath = path.resolve(chatId
  ? `artifacts/manager-flight-${chatId}-traced-diagnostic.json`
  : 'artifacts/manager-flight-five-chats-traced-live.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify({ fixedNow: fixedNow.toISOString(), turns: report }, null, 2));
await getGlobalTraceProvider().forceFlush();
console.log(JSON.stringify({ summary: true, attempted: report.length,
  checkFailures: report.filter((item) => item.checks.length).length,
  totalInputTokens: report.reduce((sum, item) => sum + (item.inputTokens || 0), 0),
  totalOutputTokens: report.reduce((sum, item) => sum + (item.outputTokens || 0), 0),
  traceExportStatuses,
  report: outputPath }));
