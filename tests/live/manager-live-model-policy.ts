import { ManagerAgent } from '../../src/agents/manager-orchestrator/agent.js';
import { FlightManagerAgent } from '../../src/agents/flight/agent.js';
import { TripPlannerManagerAgent } from '../../src/agents/trip-planner/agent.js';

/** Paid evaluations are test-only overrides, independent of production defaults. */
export function pinManagerLiveModels(): void {
  for (const agent of [ManagerAgent, FlightManagerAgent, TripPlannerManagerAgent]) {
    agent.model = 'gpt-5.2';
    agent.modelSettings = {
      ...agent.modelSettings,
      reasoning: { effort: 'low' },
    };
  }
}
