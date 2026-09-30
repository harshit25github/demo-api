import { ModelTimeoutError, retryPolicies } from '@openai/agents';
import type {
  ModelRetrySettings,
  RetryDecision,
  RetryPolicyContext,
} from '@openai/agents';
import { log } from '../../shared/logging/logger.js';

const standardGatewayRetryPolicy = retryPolicies.any(
  retryPolicies.providerSuggested(),
  retryPolicies.retryAfter(),
  retryPolicies.networkError(),
  retryPolicies.httpStatus([408, 409, 429, 500, 502, 503, 504]),
);

type TimeoutError = Error & { code?: string; timeoutMs?: number };

export function isModelTimeoutError(error: unknown): error is TimeoutError {
  const value = error as TimeoutError;
  return (
    error instanceof ModelTimeoutError ||
    (value?.name === 'ModelTimeoutError' && value?.code === 'ETIMEDOUT')
  );
}

function normalizeRetryDecision(decision: RetryDecision | undefined) {
  if (typeof decision === 'boolean') {
    return { retry: decision };
  }
  return decision || { retry: false };
}

export async function gatewayModelRetryPolicy(
  context: RetryPolicyContext,
): Promise<RetryDecision> {
  const decision = isModelTimeoutError(context.error)
    ? {
        retry: true,
        approveUnsafeReplay: true,
        reason: 'flight model timed out before stream output',
      }
    : await standardGatewayRetryPolicy(context);
  const normalizedDecision = normalizeRetryDecision(decision);
  const error = context.error as Error & { code?: string };

  log('info', 'model_retry_decision', {
    attempt: context.attempt,
    maxRetries: context.maxRetries,
    errorName: error?.name || 'UnknownError',
    errorCode: context.normalized?.errorCode || error?.code || null,
    stream: Boolean(context.stream),
    responseStarted: context.responseStarted ?? null,
    replaySafety: context.replaySafety || 'unknown',
    statefulRequest: Boolean(context.statefulRequest),
    retry: Boolean(normalizedDecision.retry),
    delayMs: normalizedDecision.delayMs ?? null,
    reason: normalizedDecision.reason || null,
  });

  return decision;
}

export const gatewayModelRetrySettings: ModelRetrySettings = {
  maxRetries: 1,
  backoff: {
    initialDelayMs: 500,
    maxDelayMs: 2_000,
    multiplier: 2,
    jitter: true,
  },
  policy: gatewayModelRetryPolicy,
};
