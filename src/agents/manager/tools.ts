import type { Tool } from '@openai/agents';
import { createSpecialistTool } from './specialist-tool.js';
import { flightSpecialist } from './specialists/flight.js';
import { tripPlannerSpecialist } from './specialists/trip-planner.js';
import type { ManagerTurnState } from './turn-state.js';

export { createManagerTurnState } from './turn-state.js';
export type { ManagerTurnState, SpecialistName } from './turn-state.js';
export { finalizeManagerOutput, buildManagerPartialFallback } from './output.js';
export { flightResult } from './specialists/flight.js';
export {
  createSpecialistTool,
  readNestedOutcome,
  SDK_TOOL_ERROR_PREFIX,
  GENERIC_SPECIALIST_FAILURE,
} from './specialist-tool.js';

/**
 * Build this turn's Manager tools.
 *
 * Only implemented specialists are registered. Policy and booking-page topics
 * have no specialist, so the Manager declines them per the "Out of scope"
 * section of MANAGER_PROMPT rather than routing them at all.
 */
export function createManagerTools(state: ManagerTurnState): Tool<any>[] {
  return [
    createSpecialistTool(state, flightSpecialist),
    createSpecialistTool(state, tripPlannerSpecialist),
  ];
}
