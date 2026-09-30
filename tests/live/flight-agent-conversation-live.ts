/**
 * Runs ONE multi-turn script from tests/fixtures/flight-agent-conversation-cases.ts
 * against the real models, through the production Manager path.
 *
 * One scenario per invocation on purpose: these scripts exist to find issues, and
 * a batch run buries the first failure under nine more conversations that were
 * shaped by it. `--case` is required for that reason.
 *
 * Run:    $env:RUN_FLIGHT_CONVERSATION_LIVE='1'; npx tsx tests/live/flight-agent-conversation-live.ts --case relative_dates_then_shift
 * Narrow: add --limit-turns 3
 *
 * Scoring follows the rules the fixture documents: drop the non-core
 * suggested-questions tool, collapse consecutive repeats of the same tool, and
 * treat the remainder as an ordered sequence. `specialistsUsed` is reported but
 * never scored — the fixture's expectations are about Flight's tool selection,
 * and whether the Manager delegated a context-only question is a separate signal
 * worth reading rather than failing on.
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.env.RUN_FLIGHT_CONVERSATION_LIVE !== '1') {
  throw new Error('Set RUN_FLIGHT_CONVERSATION_LIVE=1 to run this paid conversation script.');
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required.');
}

process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
// Traces are the point of a live run: each turn is inspectable in the Agents SDK
// dashboard afterwards. They are exported on a timer, so the run force-flushes
// before it exits or a short script finishes before anything is sent.
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const [
  { generateTraceId, getGlobalTraceProvider },
  { OpenAIConversationsSession },
  { hydrateGatewayContext, snapshotGatewayContext },
  { runGatewayAgent },
  { flightAgentConversationCases, NON_CORE_TOOLS, FLIGHT_CONVERSATION_CLOCK },
] = await Promise.all([
  import('@openai/agents'),
  import('@openai/agents-openai'),
  import('../../src/api/chat/context-hydration.js'),
  import('../../src/agents/manager-orchestrator/runner.js'),
  import('../fixtures/flight-agent-conversation-cases.js'),
]);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

const caseId = argument('--case');
if (!caseId) {
  throw new Error(
    `--case <id> is required; run one script at a time. Available: ${
      flightAgentConversationCases.map((item) => item.id).join(', ')}`,
  );
}
const scenario = flightAgentConversationCases.find((item) => item.id === caseId);
if (!scenario) {
  throw new Error(`Unknown case "${caseId}". Available: ${
    flightAgentConversationCases.map((item) => item.id).join(', ')}`);
}
const limitText = argument('--limit-turns');
const limitTurns = limitText === undefined ? Infinity : Number(limitText);
if (!(limitTurns === Infinity || (Number.isInteger(limitTurns) && limitTurns > 0))) {
  throw new Error('--limit-turns must be a positive integer.');
}

const nonCore = new Set<string>(NON_CORE_TOOLS);

/**
 * The fixture's comparison rules, in one place.
 *
 * `alsoAllowed` entries are stripped alongside the non-core tools, so everything
 * in `expectedTools` stays mandatory and ordered.
 */
function normalizeTools(tools: readonly string[], alsoAllowed: readonly string[] = []): string[] {
  const ignored = new Set<string>([...nonCore, ...alsoAllowed]);
  const core = tools.filter((tool) => tool && !ignored.has(tool));
  return core.filter((tool, index) => tool !== core[index - 1]);
}

const fixedNow = new Date(FLIGHT_CONVERSATION_CLOCK);
const session = new OpenAIConversationsSession();
const results: Array<Record<string, unknown>> = [];
let runtimeContext: any = {};
let failures = 0;

console.log(`\n${scenario.id} — ${scenario.focus}\n${'='.repeat(78)}`);

for (const [index, turn] of scenario.turns.entries()) {
  if (index + 1 > limitTurns) break;
  const traceId = generateTraceId();
  const started = Date.now();
  try {
    const context = hydrateGatewayContext(runtimeContext);
    const result: any = await runGatewayAgent({
      input: turn.user,
      requestId: `flight-conversation-${scenario.id}-${index + 1}`,
      traceId,
      sessionId: `flight-conversation-${scenario.id}`,
      context,
      session,
      now: fixedNow,
      timeZone: 'Asia/Kolkata',
      maxTurns: 12,
    });
    runtimeContext = snapshotGatewayContext(result.context);

    const rawTools: string[] = (result.context.toolCallLog || [])
      .map((entry: any) => String(entry?.tool || '')).filter(Boolean);
    const actual = normalizeTools(rawTools, turn.alsoAllowed ?? []);
    const expected = [...turn.expectedTools];
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    if (!passed) failures += 1;

    const subtasks = (result.result?.newItems || [])
      .filter((item: any) => item?.type === 'tool_call_item')
      .flatMap((item: any) => {
        const raw = item.rawItem || {};
        try {
          const parsed = JSON.parse(String(raw.arguments || '{}'));
          return typeof parsed.input === 'string' ? [parsed.input] : [];
        } catch { return []; }
      });

    const outputItems = (result.result?.newItems || [])
      .filter((item: any) => item?.type === 'tool_call_output_item')
      .map((item: any) => String(item.output ?? ''));
    const feedback = outputItems.flatMap((text: string) => {
      try {
        const value = JSON.parse(text);
        return typeof value.status === 'string' ? [value] : [];
      } catch { return []; }
    });
    // A specialist run that fails never reaches the extractor: the guardrail
    // returns one plain line instead, which is not JSON and would otherwise leave
    // the turn looking like it produced no feedback at all.
    const specialistFailures = outputItems.filter((text: string) => {
      try { return typeof JSON.parse(text)?.status !== 'string'; } catch { return true; }
    });

    const output = String(result.output || '');
    console.log(`\n${passed ? 'PASS' : 'FAIL'} turn ${index + 1}: ${JSON.stringify(turn.user)}`);
    console.log(`  expected : ${JSON.stringify(expected)}`);
    console.log(`  actual   : ${JSON.stringify(actual)}${
      rawTools.length !== actual.length ? `   (raw: ${JSON.stringify(rawTools)})` : ''}`);
    console.log(`  delegated: ${JSON.stringify(result.specialistsUsed || [])}  cards=${
      Boolean(result.renderFlightOptions)}  trace=${traceId}`);
    for (const item of feedback) {
      console.log(`  feedback : status=${item.status} presentation=${item.presentation ?? 'null'} missingInfo=${
        (item.missingInformation || []).length}`);
    }
    for (const text of specialistFailures) {
      console.log(`  SPECIALIST RUN FAILED: ${text.slice(0, 200)}`);
    }
    if (!passed) {
      console.log(`  why      : ${turn.why}`);
      console.log(`  expected understanding: ${turn.understanding}`);
    }
    for (const subtask of subtasks) console.log(`  subtask  : ${JSON.stringify(subtask)}`);
    console.log(`  reply    : ${output.replace(/\n+/g, ' | ').slice(0, 260)}`);

    results.push({
      turn: index + 1,
      user: turn.user,
      understanding: turn.understanding,
      why: turn.why,
      expectedTools: expected,
      actualTools: actual,
      rawTools,
      passed,
      specialistsUsed: result.specialistsUsed || [],
      renderFlightOptions: Boolean(result.renderFlightOptions),
      subtasks,
      feedback,
      specialistFailures,
      output,
      traceId,
      latencyMs: Date.now() - started,
    });
  } catch (error) {
    const failure = error as Error & { code?: string };
    failures += 1;
    console.log(`\nERROR turn ${index + 1}: ${failure.name}: ${String(failure.message).slice(0, 200)}`);
    results.push({
      turn: index + 1,
      user: turn.user,
      expectedTools: [...turn.expectedTools],
      actualTools: [],
      passed: false,
      error: `${failure.name}:${failure.code || ''}:${String(failure.message).slice(0, 220)}`,
      traceId,
      latencyMs: Date.now() - started,
    });
    break;
  }
}

await getGlobalTraceProvider().forceFlush();

const reportPath = path.join(process.cwd(), 'artifacts', `flight-conversation-${scenario.id}.json`);
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify({
  case: scenario.id,
  focus: scenario.focus,
  description: scenario.description,
  clock: FLIGHT_CONVERSATION_CLOCK,
  turnsRun: results.length,
  failures,
  turns: results,
}, null, 2)}\n`);

console.log(`\n${'='.repeat(78)}`);
console.log(`${scenario.id}: ${results.length - failures}/${results.length} turns matched. Report: ${reportPath}`);
if (failures) process.exitCode = 1;
