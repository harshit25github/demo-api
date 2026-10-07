import type { Tool } from '@openai/agents';
import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import { markFlightSuggestionRun } from '../../flight/tools/suggested-questions-tool.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import { recordOutcome, type ManagerTurnState } from '../turn-state.js';
import {
  createSpecialistResultGuardrail,
  readSubtaskFromResult,
  specialistInputSchema,
} from '../specialist-result.js';

const FLIGHT_TOOL_DESCRIPTION =
  'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results. Do not use for seats or selected-booking benefits.';

// The Manager turn opens suggestion tracking before it knows whether Flight will
// run. Flight marks the turn here when a run actually starts, so the turn-end
// finalize clears stale suggestions after a Flight run that wrote none, and
// leaves them alone on a turn the Manager answered without Flight. Registered
// once at module load: createFlightTool runs every turn.
FlightManagerAgent.on('agent_start', (runContext) => {
  markFlightSuggestionRun(getRequestState(runContext.context as object));
});

/** Run Flight as an SDK agent tool and record its feedback unchanged. */
export function createFlightTool(state: ManagerTurnState): Tool<any> {
  const flightTool = FlightManagerAgent.asTool({
    toolName: 'flight_agent',
    toolDescription: FLIGHT_TOOL_DESCRIPTION,
    parameters: specialistInputSchema,
    inputBuilder: ({ params }) => params.input,
    runOptions: { maxTurns: flightAgentConfig.maxTurns },
    // Storage and serialization only: Flight authors every feedback field.
    customOutputExtractor: (result) => recordOutcome(
      state, 'flight_agent', readSubtaskFromResult(result), result.finalOutput,
    ),
  });

  flightTool.outputGuardrails = [createSpecialistResultGuardrail(state, 'flight_agent')];
  return flightTool as Tool<any>;
}
