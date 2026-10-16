import { TripPlannerV2Agent } from '../../trip-planner-v2/agent.js';
import { applyTripResult, tripFailureFeedback } from '../../trip-planner-v2/apply.js';
import { tripPlannerV2Config } from '../../trip-planner-v2/config.js';
import { startTripPhotoLookup } from '../../trip-planner-v2/photos.js';
import { tripFeedbackSchema, tripResultSchema } from '../../trip-planner-v2/result.js';
import { describeTripForModel } from '../../trip-planner-v2/state.js';
import { getRequestClock, getRequestState } from '../../../shared/runtime/request-context.js';
import { log } from '../../../shared/logging/logger.js';

const TRIP_PLANNER_V2_TOOL_DESCRIPTION =
  'Destination ideas, day-by-day plans, changes to the saved plan, questions about a destination or the saved trip, and time-sensitive local facts such as events or closures. Input: the trip part of the request in one sentence, with references resolved.';

function completedWebSearch(items: Array<{ rawItem?: any }>): boolean {
  return items.some(({ rawItem }) => rawItem?.type === 'hosted_tool_call'
    && ['web_search_call', 'web_search'].includes(rawItem.name) && rawItem.status === 'completed');
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
    callModelInputFilter: ({ modelData, context }) => ({
      ...modelData,
      input: [
        { role: 'user', content: describeTripForModel(getRequestState((context ?? {}) as object) as Record<string, any>, getRequestClock(context as object)) },
        ...modelData.input,
      ],
    }),
  },
  customOutputExtractor: async (result) => {
    const state = getRequestState(result.runContext.context as Record<string, any>) as Record<string, any>;
    const clock = getRequestClock(result.runContext.context as object);
    try {
      const applied = applyTripResult(state, tripResultSchema.parse(result.finalOutput), {
        requestId: state.requestId ?? null,
        researched: completedWebSearch(result.newItems),
        checkedOn: clock?.localDate ?? null,
      });
      // Photos load while the Manager writes its reply.
      startTripPhotoLookup(state, applied.photoCodes);
      return JSON.stringify(applied.feedback);
    } catch (error) {
      log('warn', 'trip_planner_v2.result_rejected', { requestId: state.requestId, reason: String(error) });
      return JSON.stringify(tripFailureFeedback());
    }
  },
});

// Request-local; a later user turn may try again.
const failedTurns = new WeakMap<object, { requestId: unknown; output: string }>();

tripPlannerV2AgentAsTool.inputGuardrails = [{
  type: 'tool_input',
  name: 'trip_v2_turn_boundary',
  async run({ context }) {
    const state = getRequestState(context.context as object) as Record<string, any>;
    const failed = failedTurns.get(state);
    return failed && failed.requestId === state.requestId
      ? { behavior: { type: 'rejectContent', message: failed.output } }
      : { behavior: { type: 'allow' } };
  },
}];

// A failed nested run reaches the Manager as typed feedback, never SDK error text it would retry.
tripPlannerV2AgentAsTool.outputGuardrails = [{
  type: 'tool_output',
  name: 'trip_v2_typed_feedback',
  async run({ context, output }) {
    const state = getRequestState(context.context as object) as Record<string, any>;
    let parsed: unknown;
    try { parsed = typeof output === 'string' ? JSON.parse(output) : output; } catch { /* SDK error text. */ }
    const feedback = tripFeedbackSchema.safeParse(parsed);
    if (feedback.success && feedback.data.status !== 'failure') return { behavior: { type: 'allow' } };
    const failure = feedback.success ? JSON.stringify(feedback.data) : JSON.stringify(tripFailureFeedback());
    failedTurns.set(state, { requestId: state.requestId, output: failure });
    return feedback.success ? { behavior: { type: 'allow' } } : { behavior: { type: 'rejectContent', message: failure } };
  },
}];
