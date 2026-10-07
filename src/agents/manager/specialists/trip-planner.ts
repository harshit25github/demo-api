/**
 * The Trip Planner specialist, as the Manager sees it.
 *
 * Registered directly with `Agent.asTool()`. The Manager never sees itinerary
 * text: `tripPlannerResult` stores the sanitized plan once under a render
 * reference and returns only a short summary plus that reference, which
 * `finalizeManagerOutput` resolves into the final answer exactly once.
 */
import { randomUUID } from 'node:crypto';
import type { Tool } from '@openai/agents';
import { TripPlannerAgent } from '../../trip-planner/agent.js';
import { tripPlannerAgentConfig } from '../../trip-planner/config.js';
import { finalizeTripPlannerTurn, prepareTripPlannerTurn } from '../../trip-planner/context/lifecycle.js';
import { sanitizeGatewayOutputForFinalAgent } from '../../manager-orchestrator/output-guardrail.js';
import type { ManagerToolResult } from '../result-contract.js';
import { recordOutcome, type ManagerTurnState } from '../turn-state.js';
import {
  createSpecialistResultGuardrail,
  readSubtaskFromResult,
  specialistInputSchema,
  specialistTimeoutResult,
} from '../specialist-result.js';

const TRIP_PLANNER_TOOL_DESCRIPTION =
  'Create or revise destination ideas, activities, attractions, and day plans. Give only the relevant Trip subtask and use confirmed flight facts only when the plan depends on them. Do not rank flight results or explain an existing selected booking itinerary.';

/**
 * Transform the Trip Planner Agent's text output into a Manager tool result.
 *
 * Scope and link filtering stay application policy: the plan is sanitized before
 * it is stored, so the text the render reference resolves to is already clean.
 */
export function tripPlannerResult(state: ManagerTurnState, output: string): ManagerToolResult {
  const guarded = sanitizeGatewayOutputForFinalAgent({
    output,
    finalAgentName: 'Trip Planner Agent',
    context: state.appContext,
  });
  const validated = guarded.output.trim();

  finalizeTripPlannerTurn({
    context: state.appContext,
    output: validated,
    responseMode: (state.appContext.tripPlanner as Record<string, any>)?.planningBrief?.responseStrategy?.renderMode || null,
    storePlanArtifact: !guarded.scopeGuardrail?.changed,
  });

  if (!validated) {
    return {
      status: 'failure',
      summary: 'Trip planning did not produce a usable answer.',
    };
  }

  const ref = `trip_${randomUUID()}`;
  state.renders.set(ref, validated);

  const summaryContext = state.appContext.summaryContext as Record<string, any> | undefined;
  const destination = summaryContext?.destination?.city || null;
  const days = summaryContext?.duration_days || null;
  const responseMode = (state.appContext.tripPlanner as Record<string, any>)?.planningBrief?.responseStrategy?.renderMode || null;

  return {
    status: guarded.scopeGuardrail?.changed ? 'partial' : 'success',
    summary: destination
      ? `Prepared ${responseMode || 'trip'} content for ${destination}${days ? ` (${days} days)` : ''}.`
      : `Prepared ${responseMode || 'trip'} content.`,
    userRelevantData: {
      destination: typeof destination === 'string' ? destination : null,
      durationDays: typeof days === 'number' ? days : null,
    },
    renderRef: ref,
  };
}

/**
 * Build this turn's Trip Planner tool.
 *
 * Per-turn rather than at module scope so `inputBuilder`,
 * `customOutputExtractor` and the guardrails can close over this turn's state.
 * Construction is just object creation; the nested `Runner` is built per call
 * inside the SDK.
 */
export function createTripPlannerTool(state: ManagerTurnState): Tool<any> {
  const tripTool = TripPlannerAgent.asTool({
    toolName: 'trip_planner_agent',
    toolDescription: TRIP_PLANNER_TOOL_DESCRIPTION,
    parameters: specialistInputSchema,
    /**
     * Runs immediately before the nested run, so this is where the Trip turn is
     * scoped to the subtask the Manager chose. Declaring `inputBuilder` is also
     * what makes the SDK carry the structured input into the nested run as
     * `RunContext.toolInput`.
     */
    inputBuilder: ({ params }) => {
      prepareTripPlannerTurn({
        context: state.appContext,
        input: params.input,
        requestId: state.requestId,
        sessionId: state.appContext.sessionId,
      });
      return params.input;
    },
    // No `signal` here: a module-scope AbortSignal.timeout would start counting
    // at import. The per-call budget is `timeoutMs` on the tool below.
    runOptions: { maxTurns: tripPlannerAgentConfig.maxTurns },
    customOutputExtractor: (result) => recordOutcome(
      state,
      'trip_planner_agent',
      readSubtaskFromResult(result),
      tripPlannerResult(state, String(result.finalOutput ?? '')),
    ),
  });

  // Trip planning is the long specialist. `error_as_result` keeps an overrun as
  // one failed tool call the Manager can answer around, instead of failing the
  // whole turn. The SDK combines its timeout with the tool call's own signal, so
  // the nested run is genuinely aborted.
  tripTool.timeoutMs = tripPlannerAgentConfig.timeoutMs;
  tripTool.timeoutBehavior = 'error_as_result';
  tripTool.timeoutErrorFunction = (_runContext, _error, details) =>
    specialistTimeoutResult(state, 'trip_planner_agent', details);

  tripTool.outputGuardrails = [createSpecialistResultGuardrail(state, 'trip_planner_agent')];

  return tripTool as Tool<any>;
}
