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
 *                     : records Flight's structured output unchanged; Trip
 *                       stores its render content and returns a reference.
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
import { log } from '../../shared/logging/logger.js';
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

/**
 * The subtask, from a completed nested run.
 *
 * Prefers the tool call's own arguments. Falls back to the nested run's input,
 * which is whatever `inputBuilder` returned and so is the subtask itself: the
 * arguments are only present when a runner supplied `details.toolCall`, and a
 * caller invoking the tool directly does not. Both sources are per call, so
 * neither depends on tool calls being serialized.
 */
export function readSubtaskFromResult(result: {
  agentToolInvocation?: { toolArguments?: string };
  input?: unknown;
}): string {
  const fromArguments = readSpecialistSubtask(result.agentToolInvocation?.toolArguments);
  if (fromArguments) return fromArguments;
  return typeof result.input === 'string' ? result.input.trim() : '';
}

/** Does this tool output look like a result the Manager can consume? */
function isManagerToolResult(value: unknown): value is ManagerToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return MANAGER_TOOL_STATUSES.has(String(candidate.status)) && typeof candidate.summary === 'string';
}

/**
 * Allow structured specialist feedback through to the Manager; replace
 * anything else with one generic line.
 *
 * Rejecting also records the failure, because on a failed call the extractor
 * never ran and would otherwise leave no outcome for the deterministic output
 * pipeline to see.
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

      // Everything that goes wrong inside a specialist arrives here as text: the
      // SDK's own failure wording for a run that threw or exhausted its turns, or
      // whatever the extractor produced that was not a usable result. Masking it
      // is correct — the traveler must not read it — but masking it without a
      // record left intermittent specialist failures with nothing to diagnose
      // them by. Logged here, and nowhere else does anything read this text, so
      // the contract pinned by tests/integration/sdk-agent-tool-contract.test.ts
      // still holds.
      log('warn', 'manager_agent.specialist_result_rejected', {
        requestId: state.requestId,
        specialist: name,
        rejected: String(output ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      });

      recordOutcome(state, name, readSpecialistSubtask(toolCall?.arguments), {
        status: 'failure',
        summary: GENERIC_SPECIALIST_FAILURE,
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
  });
}

