import type { ModelSettings } from '@openai/agents';
import type { SessionOptimizationConfig } from './session-optimization.js';

export interface CompactionValidation {
  model: string;
  endpoint: 'responses.create';
  sdkVersion: string;
  contextWindow: number;
  outputReserve: number;
  evidence: string;
}

// Add entries only after two real boundaries and bidirectional handoff continuity pass.
// A model accepting context_management alone is insufficient evidence.
export const validatedCompactionModels: readonly CompactionValidation[] = [];

export function resolveCompactionPolicy(
  config: SessionOptimizationConfig,
  reachableModels: readonly string[],
  validations: readonly CompactionValidation[] = validatedCompactionModels,
): { enabled: boolean; reason: string; settings: ModelSettings; thresholdTokens: number | null } {
  const disabled = (reason: string) => ({ enabled: false, reason, settings: {}, thresholdTokens: null });
  if (!config.compactionEnabled) return disabled('disabled_by_configuration');
  const evidence = [...new Set(reachableModels)].map((model) => validations.find((entry) =>
    entry.model === model && entry.endpoint === 'responses.create' && entry.sdkVersion === '0.17.0' && entry.evidence.length > 0));
  if (!evidence.length || evidence.some((entry) => !entry)) return disabled('live_compatibility_not_validated');
  if (evidence.some((entry) => config.compactionThresholdTokens >= entry!.contextWindow - entry!.outputReserve)) {
    throw new Error('Compaction threshold must leave output headroom for every reachable model.');
  }
  return {
    enabled: true, reason: 'validated', thresholdTokens: config.compactionThresholdTokens,
    settings: { contextManagement: [{ type: 'compaction', compactThreshold: config.compactionThresholdTokens }] },
  };
}
