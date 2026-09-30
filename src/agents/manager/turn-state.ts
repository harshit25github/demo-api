import type { FlightAppContext } from '../flight/types.js';
import type { ManagerToolResult } from './result-contract.js';

export type SpecialistName = 'flight_agent' | 'trip_planner_agent';

export interface ManagerTurnState {
  appContext: FlightAppContext;
  requestId: string;
  outcomes: Array<{ name: SpecialistName; input: string; result: ManagerToolResult }>;
  renders: Map<string, string>;
}

export function createManagerTurnState(appContext: FlightAppContext, requestId: string): ManagerTurnState {
  return {
    appContext,
    requestId,
    outcomes: [],
    renders: new Map(),
  };
}

/**
 * Record a specialist outcome and serialize it for the model.
 *
 * The same result goes to two places: `state.outcomes` drives the deterministic
 * output pipeline (specialistsUsed and renderFlightOptions),
 * and the returned string is what the Manager model sees.
 */
export function recordOutcome(
  state: ManagerTurnState,
  name: SpecialistName,
  input: string,
  result: ManagerToolResult,
): string {
  state.outcomes.push({ name, input, result });
  return JSON.stringify(result);
}
