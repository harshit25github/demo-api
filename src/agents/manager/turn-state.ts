import type { FlightAppContext } from '../flight/types.js';
import type { ManagerToolResult } from './result-contract.js';

export type SpecialistName = 'flight_agent' | 'trip_planner_agent';

/**
 * Evidence captured once, before any specialist has run this turn.
 *
 * Specialists report their own status, but a model saying "success" is a claim,
 * not evidence. These watermarks are what that claim is checked against: what
 * actually landed in shared state during this turn.
 *
 * Turn-scoped rather than call-scoped. Two `flight_agent` calls in one turn
 * therefore share evidence, which matches how the answer is composed — the
 * per-person price note is appended once per turn when a search happened
 * anywhere in it, and the cards shown are the turn's current results.
 */
export interface ManagerTurnWatermarks {
  /** Index into the shared `toolCallLog`, so evidence is scoped to this turn. */
  readonly toolCallLogLength: number;
  /** A changed key proves a search ran this turn. */
  readonly flightSearchKey: string | null;
  /** Compared by identity, so a prediction from an earlier turn is not read as fresh. */
  readonly flightPricePrediction: unknown;
}

export interface ManagerTurnState {
  appContext: FlightAppContext;
  requestId: string;
  outcomes: Array<{ name: SpecialistName; input: string; result: ManagerToolResult }>;
  renders: Map<string, string>;
  turnStart: ManagerTurnWatermarks;
}

export function createManagerTurnState(appContext: FlightAppContext, requestId: string): ManagerTurnState {
  return {
    appContext,
    requestId,
    outcomes: [],
    renders: new Map(),
    turnStart: {
      toolCallLogLength: appContext.toolCallLog.length,
      flightSearchKey: appContext.flight.searchKey || null,
      flightPricePrediction: appContext.flight.lastPricePrediction,
    },
  };
}

/**
 * Record a specialist outcome and serialize it for the model.
 *
 * The same result goes to two places: `state.outcomes` drives the deterministic
 * output pipeline (specialistsUsed, renderFlightOptions, the per-person note,
 * the max-turns fallback), and the returned string is what the Manager model sees.
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
