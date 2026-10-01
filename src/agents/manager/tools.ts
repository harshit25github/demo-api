import type { Tool } from '@openai/agents';
import { createFlightTool } from './specialists/flight.js';
import { createTripPlannerTool } from './specialists/trip-planner.js';
import type { ManagerTurnState } from './turn-state.js';

export { createManagerTurnState } from './turn-state.js';
export type { ManagerTurnState, SpecialistName } from './turn-state.js';
export { finalizeManagerOutput } from './output.js';
export { createFlightTool } from './specialists/flight.js';
export { createTripPlannerTool, tripPlannerResult } from './specialists/trip-planner.js';
export {
  createSpecialistResultGuardrail,
  readSpecialistSubtask,
  readSubtaskFromResult,
  specialistInputSchema,
  specialistTimeoutResult,
  GENERIC_SPECIALIST_FAILURE,
} from './specialist-result.js';

/**
 * Build this turn's Manager tools.
 *
 * Both specialists are direct `Agent.asTool()` registrations; the Manager's own
 * tool behavior then produces the final answer. Only implemented specialists are
 * registered — policy and booking-page topics have no specialist, so the Manager
 * declines them per the "Out of scope" section of MANAGER_PROMPT rather than
 * routing them at all.
 */
export function createManagerTools(state: ManagerTurnState): Tool<any>[] {
  return [
    createFlightTool(state),
    createTripPlannerTool(state),
  ];
}
