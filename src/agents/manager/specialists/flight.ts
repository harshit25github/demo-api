import type { Tool } from '@openai/agents';
import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import { recordOutcome, type ManagerTurnState } from '../turn-state.js';
import {
  createSpecialistResultGuardrail,
  readSubtaskFromResult,
  specialistFailureResult,
  specialistInputSchema,
} from '../specialist-result.js';

const FLIGHT_TOOL_DESCRIPTION =
  'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results. Do not use for seats or selected-booking benefits.';

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

  // A failed nested run otherwise reaches the guardrail as the SDK's own wording
  // and is masked without trace. This logs the cause first.
  flightTool.errorFunction = (_runContext, error, details) =>
    specialistFailureResult(state, 'flight_agent', error, details);

  flightTool.outputGuardrails = [createSpecialistResultGuardrail(state, 'flight_agent')];
  return flightTool as Tool<any>;
}
