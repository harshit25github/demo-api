import { TripPlannerV2Agent } from '../../trip-planner-v2/agent.js';
import { applyTripResult, tripFailureFeedback } from '../../trip-planner-v2/apply.js';
import { tripPlannerV2Config } from '../../trip-planner-v2/config.js';
import { tripFeedbackSchema, type TripClock } from '../../trip-planner-v2/schema.js';
import { describeTripForModel } from '../../trip-planner-v2/state.js';

const TRIP_PLANNER_V2_TOOL_DESCRIPTION =
  'Destination ideas, day-by-day plans, changes to the saved plan, questions about a destination or the saved trip, and time-sensitive local facts such as events or closures. Input: the trip part of the request in one sentence, with references resolved.';

/** The run context is { state, runtime: { clock } } (src/shared/runtime/request-context.ts); unwrapped state also works. */
function requestOf(context: unknown): { state: Record<string, any>; clock: TripClock | null } {
  const value = (context ?? {}) as { state?: Record<string, any>; runtime?: { clock?: TripClock } };
  return { state: value.state ?? (value as Record<string, any>), clock: value.runtime?.clock ?? null };
}

/** Same tool name as v1, so the Manager routes to Trip the same way. */
export const tripPlannerV2AgentAsTool = TripPlannerV2Agent.asTool({
  toolName: 'trip_planner_agent',
  toolDescription: TRIP_PLANNER_V2_TOOL_DESCRIPTION,
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: tripPlannerV2Config.maxTurns },
  runConfig: {
    // The saved trip, today's date and the traveler's words go before the Manager's request;
    // the instructions stay static, so their prefix stays cached across calls.
    callModelInputFilter: ({ modelData, context }) => {
      const { state, clock } = requestOf(context);
      return { ...modelData, input: [{ role: 'user', content: describeTripForModel(state, clock) }, ...modelData.input] };
    },
  },
  customOutputExtractor: async (result) => {
    const { state, clock } = requestOf(result.runContext.context);
    // A researched fact counts only when a hosted web_search completed in this run.
    const researched = result.newItems.some((item: any) => item.rawItem?.type === 'hosted_tool_call'
      && ['web_search_call', 'web_search'].includes(item.rawItem.name) && item.rawItem.status === 'completed');
    return JSON.stringify(applyTripResult(state, result.finalOutput, { researched, checkedOn: clock?.localDate ?? null }));
  },
});

// Any failure, including an error inside the nested run, reaches the Manager as typed
// feedback, never SDK error text it would retry.
tripPlannerV2AgentAsTool.outputGuardrails = [{
  type: 'tool_output',
  name: 'trip_v2_typed_feedback',
  async run({ output }) {
    let parsed: unknown;
    try { parsed = typeof output === 'string' ? JSON.parse(output) : output; } catch { /* SDK error text. */ }
    return tripFeedbackSchema.safeParse(parsed).success
      ? { behavior: { type: 'allow' } }
      : { behavior: { type: 'rejectContent', message: JSON.stringify(tripFailureFeedback()) } };
  },
}];
