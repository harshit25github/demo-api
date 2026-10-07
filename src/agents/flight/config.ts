import 'dotenv/config';
import { retryPolicies } from '@openai/agents';
import type { ModelRetrySettings, ModelSettings, RetryPolicyContext } from '@openai/agents';
import { log } from '../../shared/logging/logger.js';

const model = 'gpt-5.2';
const isGpt5Model = /^gpt-5/i.test(model);
const flightModelTimeoutMs = Number(
  process.env.FLIGHT_AGENT_MODEL_TIMEOUT_MS || 20_000,
);
const configuredReasoningEffort = process.env.OPENAI_FLIGHT_REASONING_EFFORT;
const reasoningEffort = ['low', 'medium', 'high', 'xhigh'].includes(
  configuredReasoningEffort || '',
)
  ? configuredReasoningEffort as 'low' | 'medium' | 'high' | 'xhigh'
  : 'medium';

const sharedModelSettings = {
  toolChoice: 'auto',
  parallelToolCalls: false,
} as const;

const transientFailure = retryPolicies.any(
  retryPolicies.providerSuggested(),
  retryPolicies.retryAfter(),
  retryPolicies.networkError(),
  retryPolicies.httpStatus([408, 409, 429, 500, 502, 503, 504]),
);

/**
 * Retry one model call that failed transiently.
 *
 * Flight runs on a per-call budget of `flightModelTimeoutMs`, and without this a
 * single slow call fails the entire specialist: the run never reaches its output
 * schema, the guardrail masks whatever came back, and the traveler is told the
 * request could not be finished. Live conversation scripts hit exactly that —
 * "ModelTimeoutError: Model call timed out after 20000ms" — intermittently.
 *
 * A timeout needs `approveUnsafeReplay` because the SDK cannot know whether the
 * call it is abandoning had already done work. It is acceptable here only
 * because the budget expires before any output is emitted, so the replay repeats
 * a call that produced nothing.
 *
 * This is deliberately the specialist's own setting rather than the Manager's. A
 * transient failure inside Flight is still recoverable — the Manager can answer
 * around it — while a Manager failure ends the turn and is reported as such.
 */
const flightModelRetry: ModelRetrySettings = {
  maxRetries: 1,
  backoff: { initialDelayMs: 500, maxDelayMs: 2_000, multiplier: 2, jitter: true },
  policy: async (context: RetryPolicyContext) => {
    const error = context.error as { name?: string; code?: string } | undefined;
    const timedOut = error?.name === 'ModelTimeoutError' || error?.code === 'ETIMEDOUT';
    const decision = timedOut
      ? { retry: true, approveUnsafeReplay: true, reason: 'flight model call timed out' }
      : await transientFailure(context);
    // A retry that stops working is silent otherwise: the specialist simply
    // starts failing again, which is how this gap went unnoticed in the first
    // place.
    log('info', 'flight_model_retry_decision', {
      attempt: context.attempt,
      errorName: error?.name || 'UnknownError',
      retry: typeof decision === 'boolean' ? decision : Boolean(decision?.retry),
    });
    return decision;
  },
};

const modelSettings: ModelSettings = isGpt5Model
  ? {
      ...sharedModelSettings,
      timeoutMs: flightModelTimeoutMs,
      retry: flightModelRetry,
      reasoning: { effort: reasoningEffort },
      text: { verbosity: 'medium' },
    }
  : {
      ...sharedModelSettings,
      timeoutMs: flightModelTimeoutMs,
      retry: flightModelRetry,
      temperature: Number(process.env.OPENAI_FLIGHT_TEMPERATURE || 0.2),
    };

export const flightAgentConfig = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  model,
  maxTurns: Number(process.env.FLIGHT_AGENT_MAX_TURNS || 10),
  logLevel: process.env.FLIGHT_AGENT_LOG_LEVEL || 'info',
  modelSettings,
};

export function assertOpenAIConfig(): string {
  if (!flightAgentConfig.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required to run the agent workflow.');
  }
  return flightAgentConfig.openaiApiKey;
}
