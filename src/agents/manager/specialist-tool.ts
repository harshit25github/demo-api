import { tool } from '@openai/agents';
import type { FunctionTool, RunContext, Tool } from '@openai/agents';
import { getRequestState } from '../../shared/runtime/request-context.js';
import type { FlightAppContext } from '../flight/types.js';
import type { ManagerToolResult } from './result-contract.js';
import { recordOutcome, type ManagerTurnState, type SpecialistName } from './turn-state.js';
import { GENERIC_SPECIALIST_FAILURE, specialistInputSchema } from './specialist-result.js';

/** The SDK does not export `ToolCallDetails`; derive it from the public tool surface. */
type ToolCallDetails = NonNullable<Parameters<FunctionTool['invoke']>[2]>;

// Single source of truth lives in specialist-result.ts, which the direct
// asTool registrations use. Re-exported here while Flight still goes through
// this wrapper.
export { GENERIC_SPECIALIST_FAILURE, specialistInputSchema };

/**
 * The SDK's `defaultToolErrorFunction` message prefix.
 *
 * `Agent.asTool()` does not accept an `errorFunction`, so the SDK always installs
 * its default one. That default swallows any nested-run exception and returns this
 * string instead of throwing, which means `nested.invoke()` resolves on failure.
 * Sniffing the prefix is the only way to recover the real error. Pinned by a test
 * in tests/integration/manager-agent-tools.test.ts so an SDK change is caught.
 */
export const SDK_TOOL_ERROR_PREFIX =
  'An error occurred while running the tool. Please try again. Error: ';

export type NestedOutcome =
  | { ok: true; output: string }
  | { ok: false; code: string; retryable: boolean };

/** Classify what `nested.invoke()` resolved with: real output, or the SDK's error sentinel. */
export function readNestedOutcome(raw: string): NestedOutcome {
  if (!raw.startsWith(SDK_TOOL_ERROR_PREFIX)) {
    return { ok: true, output: raw };
  }
  const detail = raw.slice(SDK_TOOL_ERROR_PREFIX.length);
  const name = /^([A-Za-z][A-Za-z0-9_]*Error)\b/.exec(detail)?.[1] ?? 'TOOL_FAILED';
  return {
    ok: false,
    code: name === 'MaxTurnsExceededError' ? 'MAX_TURNS' : name,
    // Transient model timeouts are already retried inside the nested run by
    // gatewayModelRetrySettings; this flag tells the Manager whether a fresh
    // specialist call could still help.
    retryable: name === 'ModelTimeoutError',
  };
}

/** A module-level `Agent.asTool()` handle. */
interface NestedSpecialist {
  invoke(runContext: RunContext<any>, input: string, details?: ToolCallDetails): Promise<unknown>;
}

export interface SpecialistDefinition<TPending> {
  name: SpecialistName;
  description: string;
  /** Built once at module scope by `Agent.asTool()`. */
  nested: NestedSpecialist;
  /** Per-call timeout. Never put this in `runOptions` — a module-scope
   *  `AbortSignal.timeout` starts counting at import and aborts every later run. */
  timeoutMs?: number;
  /** Narrow `appContext.currentUserMessage` to this subtask for the nested run. */
  scopeUserMessage?: boolean;
  /** Snapshot watermarks before anything runs. Must not throw. */
  capture(state: ManagerTurnState, input: string): TPending;
  /** Side-effectful preparation, inside the try so a throw degrades to one tool failure. */
  before?(state: ManagerTurnState, input: string, pending: TPending): void;
  /** Cleanup, always runs. */
  after?(state: ManagerTurnState, pending: TPending | undefined): void;
  toResult(
    state: ManagerTurnState,
    input: string,
    outcome: NestedOutcome,
    pending: TPending,
  ): ManagerToolResult;
}

/**
 * The single adapter between the Manager and a specialist agent.
 *
 * Everything the plain `asTool()`-in-the-tools-array pattern cannot do lives here:
 * pre-run watermarks, subtask scoping with a guaranteed restore, failure -> contract
 * mapping, and `state.outcomes` bookkeeping that the deterministic output pipeline reads.
 *
 * Relies on `parallelToolCalls: false` (src/agents/manager-orchestrator/config.ts):
 * the `currentUserMessage` swap and its `finally` restore would race otherwise.
 */
export function createSpecialistTool<TPending>(
  state: ManagerTurnState,
  definition: SpecialistDefinition<TPending>,
): Tool<any> {
  // Captured once at construction, before any specialist has run this turn.
  const turnUserMessage = state.appContext.currentUserMessage;

  return tool({
    name: definition.name,
    description: definition.description,
    parameters: specialistInputSchema,
    strict: true,
    async execute({ input }, runContext, details) {
      // These summaries can be emitted verbatim by buildManagerPartialFallback,
      // so they must read as traveler-facing text, not as internal diagnostics.
      if (!runContext) {
        return recordOutcome(state, definition.name, input, {
          status: 'failure',
          summary: GENERIC_SPECIALIST_FAILURE,
          recovery: { code: 'MISSING_CONTEXT', retryable: false },
        });
      }
      if (getRequestState(runContext.context as FlightAppContext) !== state.appContext) {
        return recordOutcome(state, definition.name, input, {
          status: 'failure',
          summary: GENERIC_SPECIALIST_FAILURE,
          recovery: { code: 'CONTEXT_MISMATCH', retryable: false },
        });
      }

      const pending = definition.capture(state, input);

      try {
        if (definition.scopeUserMessage) {
          state.appContext.currentUserMessage = input;
        }
        definition.before?.(state, input, pending);

        const raw = String(await definition.nested.invoke(
          runContext,
          JSON.stringify({ input }),
          withSpecialistSignal(details, definition.timeoutMs),
        ));

        return recordOutcome(
          state,
          definition.name,
          input,
          definition.toResult(state, input, readNestedOutcome(raw), pending),
        );
      } catch (error) {
        // A real cancellation is not a specialist failure.
        if (details?.signal?.aborted) throw error;

        const value = error as Error & { code?: string };
        const outcome: NestedOutcome = {
          ok: false,
          code: value?.code || value?.name || 'TOOL_FAILED',
          retryable: false,
        };
        return recordOutcome(
          state,
          definition.name,
          input,
          definition.toResult(state, input, outcome, pending),
        );
      } finally {
        if (definition.scopeUserMessage) {
          state.appContext.currentUserMessage = turnUserMessage;
        }
        definition.after?.(state, pending);
      }
    },
  }) as Tool<any>;
}

/**
 * Combine the outer tool-call signal with this specialist's own per-call timeout.
 *
 * Clones via property descriptors, not a spread: the SDK attaches the parent run
 * config and the parent trace span to `details` as NON-ENUMERABLE symbols
 * (agentToolRunConfig.js `Object.defineProperty(..., { enumerable: false })`).
 * A spread or `Object.assign` would silently drop both, breaking model/settings
 * inheritance and orphaning the nested run's trace.
 */
function withSpecialistSignal(
  details: ToolCallDetails | undefined,
  timeoutMs: number | undefined,
): ToolCallDetails | undefined {
  if (!timeoutMs) return details;
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!details) return { signal: timeout } as ToolCallDetails;

  const descriptors = Object.getOwnPropertyDescriptors(details);
  delete (descriptors as Record<string, unknown>).signal;
  const cloned = Object.create(Object.getPrototypeOf(details), descriptors) as ToolCallDetails;
  cloned.signal = details.signal ? AbortSignal.any([details.signal, timeout]) : timeout;
  return cloned;
}
