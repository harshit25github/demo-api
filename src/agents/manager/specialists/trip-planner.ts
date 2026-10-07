import { TripPlannerAgent } from '../../trip-planner/agent.js';
import { tripPlannerAgentConfig } from '../../trip-planner/config.js';
import { finalizeTripPlannerTurn, prepareTripPlannerTurn } from '../../trip-planner/context/lifecycle.js';
import { sanitizeGatewayOutputForFinalAgent } from '../../manager-orchestrator/output-guardrail.js';
import { getRequestState, getScopedRequestText } from '../../../shared/runtime/request-context.js';

const TRIP_PLANNER_TOOL_DESCRIPTION =
  'Create or revise destination ideas, activities, attractions, and day plans. Give only the relevant Trip subtask and use confirmed flight facts only when the plan depends on them. Do not rank flight results or explain an existing selected booking itinerary.';

// Preserve Trip's existing context-capture lifecycle without a Manager turn
// closure. Standalone runs already prepare themselves and have no toolInput.
TripPlannerAgent.on('agent_start', (runContext) => {
  if (!runContext.toolInput) return;
  const context = getRequestState(runContext.context as Record<string, any>);
  prepareTripPlannerTurn({
    context,
    input: getScopedRequestText(runContext, context.currentUserMessage),
    requestId: context.requestId,
    sessionId: context.sessionId,
  });
});

/** Return the actual plan, not a render reference or a recorded outcome. */
export const tripPlannerAgentAsTool = TripPlannerAgent.asTool({
  toolName: 'trip_planner_agent',
  toolDescription: TRIP_PLANNER_TOOL_DESCRIPTION,
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: tripPlannerAgentConfig.maxTurns },
  customOutputExtractor: (result) => {
    const context = getRequestState(result.runContext.context as Record<string, any>);
    const guarded = sanitizeGatewayOutputForFinalAgent({
      output: String(result.finalOutput ?? ''),
      finalAgentName: TripPlannerAgent.name,
      context,
    });
    finalizeTripPlannerTurn({
      context,
      output: guarded.output,
      responseMode: context.tripPlanner?.planningBrief?.responseStrategy?.renderMode || null,
      storePlanArtifact: !guarded.scopeGuardrail?.changed,
    });
    return guarded.output;
  },
});
