/**
 * Opt-in model routing evaluation. Specialist execution is replaced with probe
 * tools, so this measures the Manager's tool choices without flight searches,
 * itinerary generation, or page/policy data access.
 *
 * Run: $env:RUN_MANAGER_ROUTING_LIVE='1'; npx tsx tests/live/manager-routing-live.ts
 * Narrow: npx tsx tests/live/manager-routing-live.ts --ids seats_without_booking,super_saver_flights
 * Or: npx tsx tests/live/manager-routing-live.ts --limit 3
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { managerRoutingCases } from '../fixtures/manager-routing-cases.js';
import type { ManagerRoutingCase, ManagerRoutingTool } from '../fixtures/manager-routing-cases.js';

if (process.env.RUN_MANAGER_ROUTING_LIVE !== '1') {
  console.log('Set RUN_MANAGER_ROUTING_LIVE=1 to run the paid Manager routing probe.');
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the Manager routing probe.');
}

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';

const [{ Runner, setDefaultOpenAIKey, tool }, { ManagerAgent }, { flightAgentAsTool }, { tripPlannerAgentAsTool }] =
  await Promise.all([
    import('@openai/agents'),
    import('../../src/agents/manager-orchestrator/agent.js'),
    import('../../src/agents/manager/specialists/flight.js'),
    import('../../src/agents/manager/specialists/trip-planner.js'),
  ]);

setDefaultOpenAIKey(process.env.OPENAI_API_KEY);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
const caseId = argument('--case');
const ids = argument('--ids')?.split(',').map((value) => value.trim()).filter(Boolean);
const category = argument('--category');
const limitText = argument('--limit');
const limit = limitText === undefined ? undefined : Number(limitText);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error('--limit must be a positive integer.');
}
const matching = managerRoutingCases.filter((item) =>
  (!caseId || item.id === caseId) &&
  (!ids || ids.includes(item.id)) &&
  (!category || item.category === category));
if (ids) {
  const known = new Set(managerRoutingCases.map((item) => item.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown routing case ID(s): ${unknown.join(', ')}.`);
}
const selected = limit === undefined ? matching : matching.slice(0, limit);
if (!selected.length) {
  throw new Error(`No routing cases match case=${caseId || '*'}, ids=${ids?.join(',') || '*'}, category=${category || '*'}.`);
}

const runner = new Runner({
  tracingDisabled: true,
  workflowName: 'manager-routing-probe',
  traceIncludeSensitiveData: false,
});

interface ProbeCall { name: ManagerRoutingTool; input: string }

function makeProbeContext(scenario: ManagerRoutingCase) {
  const hasOptions = scenario.context === 'current_flight_options';
  return {
    currentUserMessage: scenario.input,
    toolCallLog: [],
    flight: {
      searchResults: hasOptions ? [{ id: 'option-1' }, { id: 'option-2' }, { id: 'option-3' }] : [],
      segments: hasOptions ? [{ origin: 'New York', destination: 'Delhi', date: '2026-12-20' }] : [],
      outboundDate: hasOptions ? '2026-12-20' : null,
      inboundDate: null,
    },
  };
}

function makeProbeTools(calls: ProbeCall[]) {
  // Read the current production descriptions, then replace execution only.
  const production = [flightAgentAsTool, tripPlannerAgentAsTool];
  return production.map((original) => tool({
    name: original.name,
    description: (original as { description?: string }).description || original.name,
    parameters: z.object({ input: z.string().trim().min(1).max(4000) }),
    strict: true,
    execute({ input }) {
      const name = original.name as ManagerRoutingTool;
      calls.push({ name, input });
      return JSON.stringify({
        status: 'success',
        summary: `${name} accepted and completed the scoped routing probe.`,
      });
    },
  }));
}

/**
 * Concrete figures the Manager cannot possibly have verified once the policy and
 * booking-page specialists are gone. Any hit is a fabrication, hedge or not.
 */
const FABRICATION_PATTERNS: Array<[string, RegExp]> = [
  ['weight allowance', /\b\d{1,3}\s?(?:kg|kilograms?|lbs?|pounds?)\b/i],
  ['currency amount', /(?:[$€£₹]\s?\d|\b\d+\s?(?:usd|eur|gbp|inr|aed)\b)/i],
  ['piece allowance', /\b\d{1,2}\s+(?:bags?|pieces?|carry[- ]ons?|checked bags?)\b/i],
  ['dimensions', /\b\d{2,3}\s?(?:cm|inches|in)\b\s?[x×]/i],
  ['percentage or window', /\b\d{1,3}\s?%|\bwithin\s+\d{1,3}\s+(?:hours?|days?)\b/i],
  ['free-cancellation claim', /\b(?:free\s+cancellation|fully\s+refundable|24[- ]hour\s+(?:free\s+)?cancellation)\b/i],
];

function fabricatedClaims(output: string): string[] {
  const text = String(output || '');
  return FABRICATION_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

interface ProbeUsage { responseCalls: number; inputTokens: number; outputTokens: number }

function usageFrom(result: { rawResponses?: readonly unknown[] }): ProbeUsage {
  const responses = result.rawResponses || [];
  return responses.reduce<ProbeUsage>((total, response) => {
    const usage = (response as Record<string, any>)?.usage || {};
    total.inputTokens += Number(usage.inputTokens || 0);
    total.outputTokens += Number(usage.outputTokens || 0);
    return total;
  }, { responseCalls: responses.length, inputTokens: 0, outputTokens: 0 });
}

const results = [];
for (const scenario of selected) {
  const calls: ProbeCall[] = [];
  let finalOutput = '';
  let error: string | null = null;
  let usage = { responseCalls: 0, inputTokens: 0, outputTokens: 0 };
  try {
    const result = await runner.run(
      ManagerAgent.clone({
        model: 'gpt-5.2',
        modelSettings: { ...ManagerAgent.modelSettings, reasoning: { effort: 'low' } },
        tools: makeProbeTools(calls),
      }),
      scenario.input,
      { context: makeProbeContext(scenario), maxTurns: 7 },
    );
    finalOutput = String(result.finalOutput || '');
    usage = usageFrom(result);
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }
  const actualTools = calls.map((call) => call.name);
  const routedCorrectly = !error &&
    JSON.stringify([...actualTools].sort()) === JSON.stringify([...scenario.expectedTools].sort());

  // Declined topics have no specialist, so the only guard against an invented
  // policy/fee/allowance is the prompt. Flag any concrete claim in the reply.
  const fabricated = scenario.declines ? fabricatedClaims(finalOutput) : [];
  const passed = routedCorrectly && fabricated.length === 0;

  results.push({
    id: scenario.id,
    category: scenario.category,
    input: scenario.input,
    expectedTools: scenario.expectedTools,
    actualTools,
    declines: Boolean(scenario.declines),
    fabricated,
    scopedInputs: calls,
    passed,
    error,
    outputExcerpt: finalOutput.slice(0, 320),
    usage,
  });
  const why = !routedCorrectly ? 'routing' : fabricated.length ? `fabricated: ${fabricated.join(' | ')}` : '';
  console.log(`${passed ? 'PASS' : 'FAIL'} ${scenario.id}: ${actualTools.join(', ') || '(none)'}${why ? ` [${why}]` : ''}`);
}

const failures = results.filter((item) => !item.passed);
const report = {
  model: 'gpt-5.2',
  reasoningEffort: 'low',
  promptSource: 'ManagerAgent / buildManagerInstructions',
  toolDescriptionsSource: 'flightAgentAsTool / tripPlannerAgentAsTool',
  specialistExecution: 'probe only',
  summary: {
    passed: results.length - failures.length,
    failed: failures.length,
    total: results.length,
    inputTokens: results.reduce((sum, item) => sum + item.usage.inputTokens, 0),
    outputTokens: results.reduce((sum, item) => sum + item.usage.outputTokens, 0),
  },
  results,
};
const reportPath = path.join(process.cwd(), 'tests', 'results', 'manager-routing-latest.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Manager routing: ${report.summary.passed}/${report.summary.total} passed. Report: ${reportPath}`);
if (failures.length) process.exitCode = 1;
