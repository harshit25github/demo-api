import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { captureModelRequest, inputCountRequest } from './capture-model-request.js';
import { fixtureContext, fixtureHistory, realToolFixtures } from './session-optimization-fixtures.js';
import { deduplicateIndexedComparisonRule } from '../src/agents/flight/context/compact-result-guidance.js';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
const live = process.argv.includes('--live-count');
if (!live) process.env.OPENAI_API_KEY ||= 'offline-audit-only';
const { FlightAgent } = await import('../src/agents/flight/agent.js');
const { FLIGHT_PROMPT } = await import('../src/agents/flight/prompt.js');
const { search } = await realToolFixtures();
const wire = await captureModelRequest(FlightAgent, fixtureHistory(search), fixtureContext(search), 'off');
const normalize = (line: string) => line.trim().replace(/^[-*\d.)\s]+/, '').replaceAll('`', '').replaceAll('**', '').replace(/\s+/g, ' ');
const staticLines = new Set(FLIGHT_PROMPT.split('\n').map(normalize));
const appendix = String(wire.instructions).slice(FLIGHT_PROMPT.length);
const duplicateLines = appendix.split('\n').map(normalize).filter((line) => line.length >= 80 && staticLines.has(line));
const rules = [
  { id: 'date-evidence', pattern: 'stateless', decision: 'retain', reason: 'Resolver evidence must survive follow-ups; structured Summary is not a replacement.' },
  { id: 'date-range-duration', pattern: 'tripDurationDays', decision: 'retain', reason: 'Range plus later duration is a distinct continuation requirement.' },
  { id: 'fresh-contracts', pattern: 'getGeneratedContractsContext', decision: 'retain-and-clarify', reason: 'Live projection/compaction tests exposed replies without the mandatory fresh tool call; shared input policy now states the receipt retrieval contract.' },
  { id: 'suggestion-ownership', pattern: 'update_flight_suggested_questions', decision: 'retain-best-effort', reason: 'Flight owns suggestion persistence, but enrichment must not gate core results.' },
  { id: 'search-before-filter', pattern: 'apply_filter', decision: 'retain', reason: 'Search/update ordering differs from a pure filter follow-up.' },
  { id: 'price-note', pattern: 'Prices shown are per person', decision: 'retain', reason: 'Search and filter turns have different copy requirements.' },
];
const requests = [
  { label: 'static_instructions_with_fixed_probe', wire: { ...wire, instructions: FLIGHT_PROMPT, input: 'x', tools: [] } },
  { label: 'rendered_instructions_with_fixed_probe', wire: { ...wire, input: 'x', tools: [] } },
  { label: 'complete_request', wire },
  { label: 'complete_request_after_exact_rule_deduplication', wire: { ...wire, instructions: deduplicateIndexedComparisonRule(String(wire.instructions)) } },
];
const client = live ? new OpenAI({ maxRetries: 0, timeout: 30000 }) : null;
let countRequests = 0, stopped: string | null = null;
const counts = [];
for (const request of requests) {
  let inputTokens: number | null = null;
  if (client && !stopped) {
    try { countRequests++; inputTokens = (await client.responses.inputTokens.count(inputCountRequest(request.wire))).input_tokens; }
    catch (error) { stopped = `${(error as any).name}:${(error as any).status ?? ''}:${(error as any).code ?? ''}`; }
  }
  counts.push({ label: request.label, bytes: Buffer.byteLength(JSON.stringify(inputCountRequest(request.wire))), inputTokens });
}
const report = { sdkVersion: '0.17.0', generatedAt: new Date().toISOString(), counts, countRequests, stopped,
  duplicateLines: duplicateLines.map((line) => ({ line, action: 'remove_later_exact_duplicate_preserve_first' })),
  rules: rules.map((rule) => ({ ...rule, activePresent: FLIGHT_PROMPT.includes(rule.pattern), appendixPresent: appendix.includes(rule.pattern) })),
  removedRules: [], removedDuplicateOccurrences: duplicateLines.length, cacheRetentionChanged: false, modelChanged: false,
  decision: 'Remove only the later exact indexed-comparison duplicate in enforce mode; preserve the first rule and every other instruction.' };
const directory = resolve('tests/results/session-optimization');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'prompt-audit.json'), JSON.stringify(report, null, 2));
await writeFile(resolve(directory, 'prompt-audit.md'), ['# Prompt and cache audit', '',
  'Attribution counts below are diagnostics, not separately billed categories.', '',
  '| Payload | Input tokens |', '| --- | ---: |', ...counts.map((c) => `| ${c.label} | ${c.inputTokens ?? 'unknown'} |`), '',
  '| Rule group | Decision | Reason |', '| --- | --- | --- |', ...rules.map((r) => `| ${r.id} | ${r.decision} | ${r.reason} |`), '',
  `Normalized duplicate appendix lines: ${duplicateLines.length}. The later identical indexed-comparison instruction is removed in enforce mode; its first occurrence is preserved.`, '',
  'FLIGHT_PROMPT is the single authoritative runtime prompt. The compact-result input policy applies the same retrieval guidance. Cache reads are measured in live reports; no model-specific retention feature was added.', ''].join('\n'));
console.log(JSON.stringify(report, null, 2));
if (stopped) process.exitCode = 2;
