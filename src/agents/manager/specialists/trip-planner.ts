import { randomUUID } from 'node:crypto';
import { TripPlannerAgent } from '../../trip-planner/agent.js';
import { tripPlannerAgentConfig } from '../../trip-planner/config.js';
import { finalizeTripPlannerTurn, prepareTripPlannerTurn } from '../../trip-planner/context/lifecycle.js';
import { sanitizeGatewayOutputForFinalAgent } from '../../manager-orchestrator/output-guardrail.js';
import { ObservedModelProvider, observeModelInput } from '../../../shared/observability/model-usage.js';
import { gatewayModelRetrySettings } from '../../manager-orchestrator/retry.js';
import type { ManagerToolResult } from '../result-contract.js';
import type { ManagerTurnState } from '../turn-state.js';
import { GENERIC_SPECIALIST_FAILURE, type SpecialistDefinition } from '../specialist-tool.js';

/** Transform Trip Planner Agent's text output into Manager tool result */
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
      recovery: { code: 'EMPTY_TRIP_OUTPUT', retryable: false },
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

// ---------------------------------------------------------------------------
// Specialist definition
// ---------------------------------------------------------------------------

/**
 * Built once at module scope. The per-run timeout deliberately does NOT live in
 * `runOptions` — a module-scope `AbortSignal.timeout` starts counting at import
 * and would abort every run after the process has been up that long. The wrapper
 * derives a fresh signal per call from `timeoutMs` below.
 */
const tripNested = TripPlannerAgent.asTool({
  toolName: 'trip_planner_agent',
  toolDescription: 'Trip planning specialist',
  runConfig: {
    // `modelProvider` MUST stay set. getInheritedAgentToolRunConfig() gates both
    // `inheritedRunConfig.model` and `inheritedRunConfig.modelSettings` on
    // `!overridesModelProvider`, so dropping this line makes the Trip Planner
    // silently inherit the Manager's model and reasoning effort instead of its own.
    modelProvider: new ObservedModelProvider(),
    callModelInputFilter: observeModelInput,
    modelSettings: { preserveRawUsage: true, retry: gatewayModelRetrySettings },
    traceIncludeSensitiveData: true,
  },
  runOptions: { maxTurns: tripPlannerAgentConfig.maxTurns },
  customOutputExtractor: (result) => JSON.stringify(result.finalOutput ?? null),
});

export const tripPlannerSpecialist: SpecialistDefinition<void> = {
  name: 'trip_planner_agent',
  description: 'Create or revise destination ideas, activities, attractions, and day plans. Give only the relevant Trip subtask and use confirmed flight facts only when the plan depends on them. Do not rank flight results or explain an existing selected booking itinerary.',
  nested: tripNested,
  timeoutMs: tripPlannerAgentConfig.timeoutMs,
  capture() {
    // Trip Planner scopes its own turn inside `context.tripPlanner`, so there is
    // no shared watermark to snapshot here.
  },
  before(state, input) {
    prepareTripPlannerTurn({
      context: state.appContext,
      input,
      requestId: state.requestId,
      sessionId: state.appContext.sessionId,
    });
  },
  toResult(state, _input, outcome) {
    if (!outcome.ok) {
      return {
        status: 'failure',
        summary: GENERIC_SPECIALIST_FAILURE,
        recovery: { code: outcome.code, retryable: outcome.retryable },
      };
    }
    let finalOutput: unknown;
    try {
      finalOutput = JSON.parse(outcome.output);
    } catch {
      finalOutput = outcome.output;
    }
    return tripPlannerResult(state, String(finalOutput || ''));
  },
};
