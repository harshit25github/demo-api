import { log } from '../../../shared/logging/logger.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';

type DynamicRecord = Record<string, any>;
interface ToolRunContext {
  context?: unknown;
}

export const TRIP_PLANNER_TOOL_NAMES = {
  validateTripDate: 'validate_trip_date',
  getPlaceImagesBatch: 'get_place_images_batch',
  webSearch: 'web_search',
  getContextDetails: 'get_trip_planner_context_details',
  updateContext: 'update_trip_planner_context',
  updateSuggestedQuestions: 'update_trip_planner_suggested_questions',
};

export function getTripPlannerContext(runContext?: ToolRunContext): DynamicRecord {
  return getRequestState(
    (runContext?.context || {}) as DynamicRecord,
  ) as DynamicRecord;
}

export function getTripPlannerState(runContext?: ToolRunContext): DynamicRecord {
  const context = getTripPlannerContext(runContext);
  context.tripPlanner =
    context.tripPlanner && typeof context.tripPlanner === 'object'
      ? context.tripPlanner
      : {};
  return context.tripPlanner;
}

export function recordToolCall<TOutput extends DynamicRecord>(
  runContext: ToolRunContext | undefined,
  toolName: string,
  input: DynamicRecord,
  output: TOutput,
): TOutput {
  const context = getTripPlannerContext(runContext);
  const state = getTripPlannerState(runContext);
  const recordedInput =
    toolName === TRIP_PLANNER_TOOL_NAMES.updateContext
      ? {
          baseRevision: input.baseRevision,
          contextPatch: input.contextPatch || null,
          clearFields: input.clearFields || [],
        }
      : toolName === TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions
        ? {
            baseRevision: input.baseRevision,
            suggestedQuestions: input.suggestedQuestions || [],
          }
        : input;
  const recordedOutput =
    toolName === TRIP_PLANNER_TOOL_NAMES.getContextDetails
      ? {
          ok: output.ok,
          status: output.status,
          revision: output.revision,
          detailSections: Object.keys(output.details || {}),
        }
      : output;
  const entry = {
    tool: toolName,
    input: recordedInput,
    status: output.status || (output.ok ? 'SUCCESS' : 'ERROR'),
    output: recordedOutput,
  };
  context.toolCallLog ||= [];
  context.toolCallLog.push(entry);
  state.currentTurnToolCalls ||= [];
  state.currentTurnToolCalls.push(entry);

  log('info', 'trip_planner.tool_called', {
    requestId: context.requestId,
    sessionId: context.sessionId,
    tool: toolName,
    input: recordedInput,
    status: output.status || (output.ok ? 'SUCCESS' : 'ERROR'),
  });
  return output;
}
