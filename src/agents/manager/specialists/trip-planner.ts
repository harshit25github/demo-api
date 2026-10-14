import { TripPlannerManagerAgent } from '../../trip-planner/agent.js';
import { tripPlannerAgentConfig } from '../../trip-planner/config.js';
import { finalizeTripPlannerTurn, prepareTripPlannerTurn } from '../../trip-planner/context/lifecycle.js';
import { sanitizeTripPlannerManagerOutput, tripPlannerFailureFeedback } from '../../trip-planner/scope-policy.js';
import { getRequestState, getScopedRequestText } from '../../../shared/runtime/request-context.js';
import { log } from '../../../shared/logging/logger.js';

const TRIP_PLANNER_TOOL_DESCRIPTION =
  'Create or revise destination ideas, activities, attractions, and day plans. Input: the traveler\'s own words for the Trip part, with references resolved and known trip facts added; confirmed flight facts only when the plan depends on them. Do not rank flight results or explain an existing selected booking itinerary.';

// Preserve Trip's existing context-capture lifecycle without a Manager turn
// closure. Standalone runs already prepare themselves and have no toolInput.
TripPlannerManagerAgent.on('agent_start', (runContext) => {
  if (!runContext.toolInput) return;
  const context = getRequestState(runContext.context as Record<string, any>);
  prepareTripPlannerTurn({
    context,
    input: getScopedRequestText(runContext, context.currentUserMessage),
    requestId: context.requestId,
  });
});

/** Native typed output is validated and serialized once for the Manager. */
export const tripPlannerAgentAsTool = TripPlannerManagerAgent.asTool({
  toolName: 'trip_planner_agent',
  toolDescription: TRIP_PLANNER_TOOL_DESCRIPTION,
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: tripPlannerAgentConfig.maxTurns },
  customOutputExtractor: (result) => {
    const context = getRequestState(result.runContext.context as Record<string, any>);
    let guarded;
    try {
      guarded = sanitizeTripPlannerManagerOutput(result.finalOutput, context, result.newItems);
    } catch (error) {
      // The SDK would hand Manager "Please try again" plus the exception; send typed failure instead.
      log('warn', 'trip_planner.feedback_rejected', { requestId: context.requestId, reason: String(error) });
      guarded = { output: tripPlannerFailureFeedback(context), storePlanArtifact: false };
    }
    finalizeTripPlannerTurn({
      context,
      feedback: guarded.output,
      responseMode: guarded.output.mode,
      storePlanArtifact: guarded.storePlanArtifact,
    });
    return JSON.stringify(guarded.output);
  },
});
