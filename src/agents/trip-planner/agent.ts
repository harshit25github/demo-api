import { Agent } from '@openai/agents';
import { getRequestState } from '../../shared/runtime/request-context.js';
import { TRIP_PLANNER } from './prompt.js';
import { buildTripPlannerCompactContext } from './context/serializer.js';
import { tripPlannerTools } from './tools/index.js';
import { tripPlannerAgentConfig } from './config.js';

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

  return `${compactContext.text}

<turn_rules>
If phase=context_capture, call update_trip_planner_context before any planning, other tool, or final text.
Interpret the user message yourself; send only changed structured values, preserve known fields, use null when unchanged, and never send raw text.
Normalize concise durable values; do not add raw synonyms beside canonical tripType values.
After capture succeeds, reread the refreshed trip_state and turn_plan.
If phase=planning, never call update_trip_planner_context again.
During planning, obey every compact turn_plan value and the static format, scope, card, and question rules; never ask for known fields.
If scope=excluded, call no date, image, web, or detail tool. Give only the configured in-scope capability redirect.
If scope=mixed, ignore excluded portions and answer only the in-scope request.
Use web_search only when tools says webSearch:call. Current facts must come only from that result.
Call update_trip_planner_suggested_questions last with the current revision and exactly three 3-8 word scope-safe suggestions.
Suggestions must avoid every completed value and semantic category, including reworded synonyms.
If the suggestions updater reports INVALID_SUGGESTIONS, correct them once. After success, call no more tools and return only the user-facing response.
</turn_rules>`;
}

export function buildTripPlannerInstructions(runContext: TripPlannerRunContext): string {
  return `${TRIP_PLANNER}

${buildTripPlannerDynamicContext(runContext)}`;
}

export const TripPlannerAgent = new Agent({
  name: 'Trip Planner Agent',
  instructions: buildTripPlannerInstructions,
  model: tripPlannerAgentConfig.model,
  modelSettings: tripPlannerAgentConfig.modelSettings,
  tools: tripPlannerTools,
});
