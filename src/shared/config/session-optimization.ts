import 'dotenv/config';

export type OptimizationMode = 'off' | 'observe' | 'enforce';
export interface SessionOptimizationConfig {
  mode: OptimizationMode;
  compactionEnabled: boolean;
  compactionThresholdTokens: number;
}

export function readSessionOptimizationConfig(
  env: Record<string, string | undefined> = process.env,
): SessionOptimizationConfig {
  const mode = env.SESSION_OPTIMIZATION_MODE ?? 'observe';
  if (!['off', 'observe', 'enforce'].includes(mode)) {
    throw new Error('SESSION_OPTIMIZATION_MODE must be off, observe, or enforce.');
  }
  const enabled = env.SESSION_COMPACTION_ENABLED ?? 'false';
  if (enabled !== 'true' && enabled !== 'false') {
    throw new Error('SESSION_COMPACTION_ENABLED must be true or false.');
  }
  const raw = env.SESSION_COMPACTION_THRESHOLD_TOKENS ?? '50000';
  const threshold = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new Error('SESSION_COMPACTION_THRESHOLD_TOKENS must be a positive integer.');
  }
  return { mode: mode as OptimizationMode, compactionEnabled: enabled === 'true', compactionThresholdTokens: threshold };
}

// Startup validation. Explicit parameters in helpers make isolated evaluations deterministic.
export const sessionOptimization = readSessionOptimizationConfig();
