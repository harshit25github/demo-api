import type { ModelCallUsage } from './model-usage.js';

// USD per 1M tokens, standard synchronous processing, verified 2026-09-08.
// Sources: https://developers.openai.com/api/docs/models/gpt-5.5
// https://developers.openai.com/api/docs/models/gpt-5.2
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
export const tokenPricing = {
  'gpt-5.5': { input: 5, cached: 0.5, output: 30, maxInput: 272000 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14, maxInput: 400000 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5, maxInput: 400000 },
} as const;

export function estimateTokenCost(calls: readonly ModelCallUsage[]) {
  let usd = 0;
  let reason: string | null = calls.length ? null : 'no_calls';
  // Long-context pricing can affect the session; avoid quoting a partial low-band total.
  const longContext = calls.some((c) => c.model.startsWith('gpt-5.5') && (c.inputTokens ?? 0) > 272000);
  for (const call of calls) {
    const model = Object.keys(tokenPricing).find((name) => call.model === name || new RegExp(`^${name.replaceAll('.', '\\.')}-\\d{4}-\\d{2}-\\d{2}$`).test(call.model)) as keyof typeof tokenPricing | undefined;
    const rates = model ? tokenPricing[model] : undefined;
    if (!rates) { reason = 'unknown_model_rate'; break; }
    if (call.status !== 'completed' || call.inputTokens === null || call.outputTokens === null || call.cachedInputTokens === null || call.transportAttempts.some((a) => a.failed)) { reason = 'missing_usage'; break; }
    if (longContext || call.inputTokens > rates.maxInput) { reason = 'pricing_band_requires_session_evidence'; break; }
    if (call.serviceTier !== null && call.serviceTier !== 'default') { reason = 'nonstandard_service_tier'; break; }
    if (call.cachedInputTokens > call.inputTokens || (call.cacheWriteTokens ?? 0) > 0) { reason = 'unsupported_usage_details'; break; }
    usd += ((call.inputTokens - call.cachedInputTokens) * rates.input + call.cachedInputTokens * rates.cached + call.outputTokens * rates.output) / 1_000_000;
  }
  return { estimatedTokenCostUsd: reason ? null : usd, tokenCostComplete: reason === null, reason,
    pricingDate: '2026-09-08', pricingTier: 'standard', excludesHostedToolFees: true,
    // Token cost is deliberately distinct from complete invoice cost.
    totalCostUsd: null };
}
