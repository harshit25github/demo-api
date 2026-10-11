import { Usage } from '@openai/agents';
import type { TripPlannerFeedback } from '../../src/agents/trip-planner/manager-output.js';
import { getTripPlannerContextRevision } from '../../src/agents/trip-planner/context/store.js';

/** What the Trip model writes: findings only; the sanitizer attaches the formatting rules. */
export function tripFeedback(context: Record<string, any>, fields: Partial<TripPlannerFeedback> = {}): TripPlannerFeedback {
  return {
    status: 'success', mode: context.tripPlanner.planningBrief.responseStrategy.renderMode,
    destinationCards: [], itineraryDays: [], recommendation: null, notes: [], tables: [],
    nextQuestions: [], limitations: [],
    ...fields,
  };
}

/** Scripted model exercises real registered tools; it does not evaluate LLM intent detection. */
export function tripManagerModel(
  contextForRequest: (request: any) => Record<string, any>,
  feedback: (context: Record<string, any>) => TripPlannerFeedback,
  imageCodes: string[] = [],
) {
  return { async getResponse(request: any) {
    const context = contextForRequest(request);
    const state = context.tripPlanner;
    const called = (name: string) => state.currentTurnToolCalls?.some((entry: any) => entry.tool === name && entry.output?.ok === true);
    const call = (name: string, input: unknown) => ({ usage: new Usage(), responseId: 'resp_trip_fixture',
      output: [{ type: 'function_call', name, callId: `call_${name}`, arguments: JSON.stringify(input), status: 'completed' }] });
    if (!state.turnState.contextCaptured) return call('update_trip_planner_context', {
      baseRevision: state.turnState.baseRevision, contextPatch: null, clearFields: null,
    });
    if (state.planningBrief.toolStrategy.contextDetails.action === 'call' && !called('get_trip_planner_context_details')) {
      return call('get_trip_planner_context_details', { sections: state.planningBrief.toolStrategy.contextDetails.sections, query: null, limit: 10 });
    }
    if (imageCodes.some((code) => !state.placeImageCache?.[code]?.imageUrl)) {
      return call('get_place_images_batch', { itemCodes: imageCodes });
    }
    if (!state.turnState.suggestionsUpdated) return call('update_trip_planner_suggested_questions', {
      baseRevision: getTripPlannerContextRevision(context),
      suggestedQuestions: ['Explore local market dishes', 'Compare neighborhood history walks', 'Add an art museum'],
    });
    return { usage: new Usage(), responseId: 'resp_trip_fixture', output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(feedback(context)) }] }] };
  } };
}
