import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { captureModelRequest, inputCountRequest } from './capture-model-request.js';
import { fixtureContext, fixtureHistory, realToolFixtures, scaleFixture } from './session-optimization-fixtures.js';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.AGENT_LOG_LEVEL = 'silent';
const live = process.argv.includes('--live-count');
if (!live) process.env.OPENAI_API_KEY ||= 'offline-capture-only';
const { FlightAgent } = await import('../src/agents/flight/agent.js');
const { gatewayAgentConfig } = await import('../src/agents/manager-orchestrator/config.js');
const fixtures = await realToolFixtures();
const client = live ? new OpenAI({ maxRetries: 0, timeout: 30000 }) : null;
const budget = process.argv.includes('--long-count') ? 24 : 6;
let requests = 0;
let stopped: { status: number | null; code: string | null; name: string } | null = null;
const rows: Record<string, unknown>[] = [];
for (const tool of ['flight_search', 'apply_filter']) {
  for (const [count, turns] of [[3, 1], [20, 1], [100, 1], [20, 5], [20, 20], [20, 50]]) {
    const payload = scaleFixture(tool === 'flight_search' ? fixtures.search : fixtures.filter, count!);
    const input = fixtureHistory(payload, tool, turns);
    const context = fixtureContext(payload);
    const before = await captureModelRequest(FlightAgent, input, context, 'off', gatewayAgentConfig.modelSettings);
    const after = await captureModelRequest(FlightAgent, input, context, 'enforce', gatewayAgentConfig.modelSettings);
    const row: Record<string, unknown> = { tool, resultCount: count, turns, model: before.model,
      fixture: count === 3 && turns === 1 ? 'current_dummy' : 'synthetic_scaling',
      beforeBytes: Buffer.byteLength(JSON.stringify(before)), afterBytes: Buffer.byteLength(JSON.stringify(after)),
      beforeInputTokens: null, afterInputTokens: null, inputTokenReductionPercent: null };
    if (client && !stopped && requests + 2 <= budget) {
      try {
        requests++;
        row.beforeInputTokens = (await client.responses.inputTokens.count(inputCountRequest(before))).input_tokens;
        requests++;
        row.afterInputTokens = (await client.responses.inputTokens.count(inputCountRequest(after))).input_tokens;
        row.inputTokenReductionPercent = 100 * (1 - Number(row.afterInputTokens) / Number(row.beforeInputTokens));
      } catch (error) {
        const err = error as { status?: number; code?: string; name?: string };
        stopped = { status: err.status ?? null, code: err.code ?? null, name: err.name ?? 'Error' };
        // All provider errors stop further live work, including quota and billing errors.
      }
    }
    rows.push(row);
  }
}
const report = { generatedAt: new Date().toISOString(), sdkVersion: '0.17.0', optimizationDefault: 'observe',
  compactionEnabled: false, liveCountRequested: live, countRequestBudget: budget, countRequests: requests, stopped,
  generatedModelRequests: 0, behavioralLiveValidation: 'not_run', costSavings: null, latencyImprovement: null, rows };
const directory = resolve('tests/results/session-optimization');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'benchmark.json'), JSON.stringify(report, null, 2));
const markdown = ['# Session optimization measurement', '',
  `SDK 0.17.0. Token-count requests: ${requests}/${budget}; generated-model requests: 0.`, '',
  'Bytes measure serialization size, not tokens. Exact token columns are populated only by the provider counter.', '',
  '| Tool | Results | Turns | Bytes before | Bytes after | Tokens before | Tokens after |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((r) => `| ${r.tool} | ${r.resultCount} | ${r.turns} | ${r.beforeBytes} | ${r.afterBytes} | ${r.beforeInputTokens ?? 'unknown'} | ${r.afterInputTokens ?? 'unknown'} |`), '',
  `Live stop: ${stopped ? JSON.stringify(stopped) : 'none'}.`, '',
  'This validates request-size reduction only. Full-turn quality, extra contract-tool calls, caching, cost, latency and live compaction continuity remain release gates.', ''];
await writeFile(resolve(directory, 'benchmark.md'), markdown.join('\n'));
console.log(JSON.stringify(report, null, 2));
if (stopped) process.exitCode = 2;
