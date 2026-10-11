import { Agent } from '@openai/agents';
import { getRequestClock, getRequestState } from '../../shared/runtime/request-context.js';
import { TRIP_PLANNER, TRIP_PLANNER_STANDALONE_PRESENTATION } from './prompt.js';
import { buildTripPlannerCompactContext } from './context/serializer.js';
import { tripPlannerTools } from './tools/index.js';
import { tripPlannerAgentConfig } from './config.js';
import { tripPlannerFeedbackSchema, TRIP_PLANNER_MANAGER_INSTRUCTIONS } from './manager-output.js';

type DynamicRecord = Record<string, any>;
interface TripPlannerRunContext {
  context?: unknown;
}

export function buildTripPlannerDynamicContext(runContext: TripPlannerRunContext): string {
  const context = getRequestState(
    (runContext?.context || {}) as DynamicRecord,
  ) as DynamicRecord;
  const currentUserMessage = String(context.tripPlanner?.currentUserMessage || '');
  const latestPatch = context.tripPlanner?.latestContextPatch || {};
  const compactContext = buildTripPlannerCompactContext({
    summaryContext: context.summaryContext,
    latestPatch,
    tripPlannerState: context.tripPlanner || {},
    currentUserMessage,
  });
  if (context.tripPlanner && compactContext.planningBrief) {
    context.tripPlanner.planningBrief = compactContext.planningBrief;
  }
  // The request clock the Manager and Flight use; Trip resolves dates from it.
  const clock = getRequestClock(runContext?.context as object | undefined);

  return `<turn_clock>
${clock ? `today=${clock.localDate}|time_zone=${clock.timeZone}` : 'today=unknown'}
</turn_clock>

${compactContext.text}

<turn_rules>
If phase=context_capture, call update_trip_planner_context before any planning, other tool, or final output.
Interpret the user message yourself; send only changed structured values, preserve known fields, use null when unchanged, and never send raw text.
Normalize concise durable values; do not add raw synonyms beside canonical tripType values.
After capture succeeds, reread the refreshed trip_state and turn_plan.
If phase=planning, never call update_trip_planner_context again.
During planning, obey every compact turn_plan value and the scope, card-data, planning and question-intent rules; never request known fields.
For discovery_cards, images:call_after_selecting_suggestions means choose the candidate cities for this task, then call get_place_images_batch once for all of them before finalizing destination facts. Do not wait for the traveler to choose a destination. Use its returned image URLs; do not report images unavailable without an actual failed image call.
If scope=excluded, call no image, web, or detail tool. Return only the configured in-scope capability outcome.
If scope=mixed, ignore excluded portions and complete only the in-scope request.
web_search is your decision: call it only when the requested outcome depends on a current, time-sensitive fact, with the query anchored to turn_clock and the trip window. Current facts must come only from this turn's results.
Before any final output, call update_trip_planner_suggested_questions as the mandatory last tool with the current revision and exactly three 3-8 word scope-safe suggestions. Do not skip it when no preferences changed or when discovery is complete.
Suggestions must avoid every completed value and semantic category, including reworded synonyms.
If the suggestions updater reports INVALID_SUGGESTIONS, correct them once. After success, call no more tools and return the final output.
</turn_rules>`;
}

export function buildTripPlannerInstructions(runContext: TripPlannerRunContext): string {
  return `${TRIP_PLANNER}

${TRIP_PLANNER_STANDALONE_PRESENTATION}

${buildTripPlannerDynamicContext(runContext)}`;
}

const tripPlannerAgentDefinition = {
  name: 'Trip Planner Agent',
  instructions: buildTripPlannerInstructions,
  model: tripPlannerAgentConfig.model,
  modelSettings: tripPlannerAgentConfig.modelSettings,
  tools: tripPlannerTools,
};

export const TripPlannerAgent = new Agent(tripPlannerAgentDefinition);

/** Same planning intelligence/tools; only the internal presentation contract differs. */
export const TripPlannerManagerAgent = new Agent({
  ...tripPlannerAgentDefinition,
  instructions: (runContext: TripPlannerRunContext) =>
    `${TRIP_PLANNER}\n\n${buildTripPlannerDynamicContext(runContext)}\n\n${TRIP_PLANNER_MANAGER_INSTRUCTIONS}`,
  // Findings only; the sanitizer attaches the deterministic formatting rules.
  outputType: tripPlannerFeedbackSchema,
});
