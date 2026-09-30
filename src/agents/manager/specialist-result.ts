/**
 * The contract between a specialist agent tool and the Manager.
 *
 * Specialists are registered with the SDK's own `Agent.asTool()`, so there is no
 * application-level wrapper around a nested run any more. What used to live in
 * that wrapper is expressed with SDK hooks instead:
 *
 *   - `inputBuilder`  : per-call preparation, and it makes the SDK carry the
 *                       structured subtask into the nested run as
 *                       `RunContext.toolInput`.
 *   - `customOutputExtractor`
 *                     : maps the nested run's output to a compact
 *                       `ManagerToolResult` and records the turn outcome.
 *   - `outputGuardrails`
 *                     : the single failure choke point. Every way a specialist
 *                       call can fail — the nested run throwing, exceeding its
 *                       own maxTurns, the extractor throwing, or the extractor
 *                       returning something unusable — arrives here as tool
 *                       output rather than as an exception, so one guardrail
 *                       both masks the failure and records it.
 *
 * That last point is why no code reads the SDK's error wording. It is pinned by
 * tests/integration/sdk-agent-tool-contract.test.ts.
 */
import { defineToolOutputGuardrail, ToolGuardrailFunctionOutputFactory } from '@openai/agents';
import type { FunctionTool, ToolOutputGuardrailDefinition } from '@openai/agents';
import { z } from 'zod';
import { ObservedModelProvider, observeModelInput } from '../../shared/observability/model-usage.js';
import { gatewayModelRetrySettings } from '../manager-orchestrator/retry.js';
import type { ManagerToolResult, ManagerToolStatus } from './result-contract.js';
import { recordOutcome, type ManagerTurnState, type SpecialistName } from './turn-state.js';

/** The SDK does not export `ToolCallDetails`; derive it from the public tool surface. */
type ToolCallDetails = NonNullable<Parameters<FunctionTool['invoke']>[2]>;

/** The subtask schema every specialist takes. Also the SDK's own default shape. */
export const specialistInputSchema = z.object({ input: z.string().trim().min(1).max(4000) });

/** One traveler-facing failure line. Never name agents, tools, or statuses. */
export const GENERIC_SPECIALIST_FAILURE = "I couldn't finish that part of your request right now.";

const MANAGER_TOOL_STATUSES: ReadonlySet<string> = new Set<ManagerToolStatus>([
  'success',
  'partial',
  'needs_input',
  'failure',
]);

/**
 * Shared run configuration for every specialist's nested run.
 *
 * `modelProvider` must stay set. `getInheritedAgentToolRunConfig()` forwards the
 * Manager's `model` and `modelSettings` only when the tool does not override
 * `modelProvider`, so without it any setting a specialist leaves undeclared is
 * taken from the Manager instead. Both specialists declare their own model,
 * reasoning effort and verbosity, so this guards the rest — and
 * `ObservedModelProvider` is also how per-model usage is observed.
 */
export function specialistRunConfig() {
  return {
    modelProvider: new ObservedModelProvider(),
    callModelInputFilter: observeModelInput,
    modelSettings: { preserveRawUsage: true, retry: gatewayModelRetrySettings },
    traceIncludeSensitiveData: true,
  };
}

/**
 * The subtask the Manager passed, read back from the SDK's own invocation record.
 *
 * Taken from the invocation rather than remembered between `inputBuilder` and
 * `customOutputExtractor`, so it stays correct per call without depending on
 * tool calls being serialized.
 */
export function readSpecialistSubtask(toolArguments: string | undefined): string {
  if (!toolArguments) return '';
  try {
    const parsed = JSON.parse(toolArguments);
    return typeof parsed?.input === 'string' ? parsed.input : '';
  } catch {
    return '';
  }
}

/** The same, for the `details` a timeout handler receives. */
export function readSubtaskFromDetails(details: ToolCallDetails | undefined): string {
  return readSpecialistSubtask(details?.toolCall?.arguments);
}

/** Does this tool output look like a result the Manager can consume? */
function isManagerToolResult(value: unknown): value is ManagerToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return MANAGER_TOOL_STATUSES.has(String(candidate.status)) && typeof candidate.summary === 'string';
}

/**
 * Allow only a mapped `ManagerToolResult` through to the Manager; replace
 * anything else with one generic line.
 *
 * Rejecting also records the failure, because on a failed call the extractor
 * never ran and would otherwise leave no outcome for the deterministic output
 * pipeline to see. The recorded `code` stays coarse on purpose: it is for logs
 * and composition, never for the traveler.
 */
export function createSpecialistResultGuardrail(
  state: ManagerTurnState,
  name: SpecialistName,
): ToolOutputGuardrailDefinition<any> {
  return defineToolOutputGuardrail({
    name: `${name}_result_contract`,
    async run({ output, toolCall }) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(output));
      } catch {
        parsed = null;
      }
      if (isManagerToolResult(parsed)) {
        return ToolGuardrailFunctionOutputFactory.allow();
      }

      recordOutcome(state, name, readSpecialistSubtask(toolCall?.arguments), {
        status: 'failure',
        summary: GENERIC_SPECIALIST_FAILURE,
        recovery: { code: 'SPECIALIST_FAILED', retryable: false },
      });
      return ToolGuardrailFunctionOutputFactory.rejectContent(GENERIC_SPECIALIST_FAILURE, {
        specialist: name,
      });
    },
  });
}

/**
 * The model-visible result for a specialist that ran past its own time budget.
 *
 * Returned through `timeoutBehavior: 'error_as_result'`, so one slow specialist
 * is a single failed tool call rather than a failed Manager run. Already a valid
 * result shape, so the guardrail passes it through and records nothing twice.
 */
export function specialistTimeoutResult(
  state: ManagerTurnState,
  name: SpecialistName,
  details: ToolCallDetails | undefined,
): string {
  return recordOutcome(state, name, readSubtaskFromDetails(details), {
    status: 'failure',
    summary: GENERIC_SPECIALIST_FAILURE,
    recovery: { code: 'SPECIALIST_TIMEOUT', retryable: false },
  });
}
