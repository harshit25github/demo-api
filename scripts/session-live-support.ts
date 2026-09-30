import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { observeOpenAIFetch } from '../src/shared/observability/model-usage.js';
import { inputCountRequest } from './capture-model-request.js';
import { tokenPricing } from '../src/shared/observability/token-cost.js';

export interface EvaluationBudget {
  maxRequests: number;
  maxUsd: number;
  requests: number;
  countRequests: number;
  reservedUsd: number;
  countingMs: number;
  stopped: string | null;
  expectedUserHash?: string;
  requestMetadata?: Record<string, unknown>[];
}

export function textHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function createEvaluationClient(budget: EvaluationBudget, maxOutputTokens = 2048) {
  const counter = new OpenAI({ maxRetries: 0, timeout: 30000 });
  return new OpenAI({ maxRetries: 0, timeout: 120000, fetch: observeOpenAIFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const isGeneration = url.pathname.endsWith('/responses') && init?.method?.toUpperCase() === 'POST';
    if (isGeneration) {
      const fail = (reason: string): never => { budget.stopped = reason; throw new Error(reason); };
      if (budget.stopped) fail(budget.stopped);
      if (budget.requests >= budget.maxRequests) fail('evaluation_request_budget_exhausted');
      if (typeof init?.body !== 'string') fail('unsupported_evaluation_request_body');
      const wire = JSON.parse(init!.body as string) as Record<string, unknown>;
      const latest = Array.isArray(wire.input) ? wire.input.filter((item: any) => item.role === 'user').at(-1) : null;
      const latestText = typeof wire.input === 'string' ? wire.input : typeof latest?.content === 'string' ? latest.content :
        Array.isArray(latest?.content) ? latest.content.map((item: any) => item.text ?? '').join('') : '';
      (budget.requestMetadata ??= []).push({ model: wire.model, latestUserMatches: textHash(latestText) === budget.expectedUserHash,
        latestUserChars: latestText.length, toolChoice: wire.tool_choice ?? 'default',
        toolNames: Array.isArray(wire.tools) ? wire.tools.map((t: any) => t.name ?? t.type) : [],
        inputTailTypes: Array.isArray(wire.input) ? wire.input.slice(-8).map((i: any) => `${i.type ?? 'message'}:${i.role ?? ''}`) : [],
        compactGuidancePresent: String(wire.instructions).includes('A handoff acknowledgment'),
      });
      const model = String(wire.model) as keyof typeof tokenPricing;
      const rates = tokenPricing[model];
      if (!rates) fail('unpriced_evaluation_model');
      const start = performance.now();
      let count: number;
      try {
        budget.countRequests++;
        count = (await counter.responses.inputTokens.count(inputCountRequest(wire))).input_tokens;
      } catch (error) {
        budget.stopped = safeError(error); throw error;
      } finally { budget.countingMs += performance.now() - start; }
      if (count > rates.maxInput) fail('evaluation_pricing_band_exceeded');
      // Conservative uncached input + maximum output. Reserve extra for one hosted call.
      const hosted = Array.isArray(wire.tools) && wire.tools.some((t: any) => t.type !== 'function');
      const upper = (count * rates.input + maxOutputTokens * rates.output) / 1e6 + (hosted ? 0.25 : 0);
      if (budget.reservedUsd + upper > budget.maxUsd) fail('evaluation_cost_budget_exhausted');
      budget.reservedUsd += upper;
      budget.requests++;
      wire.max_output_tokens = maxOutputTokens;
      if (hosted) wire.max_tool_calls = 1;
      init = { ...init, body: JSON.stringify(wire) };
    }
    try {
      const response = await globalThis.fetch(input, init);
      if (!response.ok && isGeneration) budget.stopped = `provider_http_${response.status}`;
      return response;
    } catch (error) {
      if (isGeneration) budget.stopped ??= safeError(error);
      throw error;
    }
  }) });
}

export function safeError(error: unknown): string {
  const value = error as { status?: number; code?: string; name?: string };
  return [value.name ?? 'Error', value.status, value.code].filter(Boolean).join(':');
}

export interface ScenarioStep {
  id: string;
  message: string;
  expectedAgent: 'Flight Agent' | 'Trip Planner Agent' | null;
  requiredTools?: string[];
  expectedDate?: string;
  expectedResults?: number;
  restart?: boolean;
  seedBefore?: boolean;
  avoidMuseums?: boolean;
}

export function scenarioSteps(turns: number): ScenarioStep[] {
  const core: ScenarioStep[] = [
    { id: 'search', message: 'Find one-way Delhi to Mumbai flights on 15 October 2026 for one adult in economy.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search'], expectedDate: '2026-10-15', expectedResults: 3 },
    { id: 'option_read', message: 'Tell me about option 3.', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedDate: '2026-10-15', expectedResults: 3 },
    { id: 'filter', message: 'Keep flights under 9999999, keeping every other search detail.', expectedAgent: 'Flight Agent', requiredTools: ['apply_filter'], expectedDate: '2026-10-15', expectedResults: 3 },
    { id: 'restore', message: 'Show all my current flight options again.', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedDate: '2026-10-15', expectedResults: 3, restart: true },
    { id: 'compare', message: 'Which of these flights is cheapest?', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedDate: '2026-10-15', expectedResults: 3 },
  ];
  const extension: ScenarioStep[] = [
    { id: 'cabin_correction', message: 'Change only cabin to business.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search'], expectedDate: '2026-10-15', expectedResults: 3 },
    { id: 'passenger_correction', message: 'Make it two adults, keep everything else.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search'], expectedDate: '2026-10-15', expectedResults: 3 },
    { id: 'trip_handoff', message: 'Plan a relaxed two-day Mumbai itinerary with museums and food. Do not change my flight search.', expectedAgent: 'Trip Planner Agent' },
    { id: 'trip_correction', message: 'For that Mumbai itinerary, make day two quieter and avoid museums that day.', expectedAgent: 'Trip Planner Agent' },
    { id: 'flight_return', message: 'Back to my flights. Tell me about flight option 3.', expectedAgent: 'Flight Agent', requiredTools: ['getGeneratedContractsContext'], expectedDate: '2026-10-15', expectedResults: 3, restart: true },
  ];
  return Array.from({ length: turns }, (_, i) => {
    const step = i < 5 ? core[i]! : extension[(i - 5) % extension.length]!;
    return { ...step, id: `${i + 1}_${step.id}` };
  });
}

export const dateScenarios: ScenarioStep[][] = [
  [
    { id: 'date_before_route', message: 'Find flights next weekend.', expectedAgent: 'Flight Agent', requiredTools: [] },
    { id: 'route_after_date', message: 'Delhi to Mumbai, one adult, economy, one-way.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search'], expectedResults: 3 },
  ],
  [
    { id: 'roundtrip_range', message: 'Round-trip Delhi to Mumbai next month for one adult, economy.', expectedAgent: 'Flight Agent', requiredTools: [] },
    { id: 'later_duration', message: 'Stay for five days.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search'], expectedResults: 3 },
  ],
  [{ id: 'same_turn_search_filter', message: 'Find one-way Delhi to Mumbai flights on 15 October 2026 for one adult, economy, then keep flights under 9999999.', expectedAgent: 'Flight Agent', requiredTools: ['flight_search', 'apply_filter'], expectedResults: 3, expectedDate: '2026-10-15' }],
];

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
