import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import type { FlightAppContext } from '../../flight/types.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';

const FLIGHT_TOOL_DESCRIPTION =
  'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results. Do not use for seats or selected-booking benefits.';

// The Manager turn starts with flightRanThisTurn = false because it does not yet
// know whether Flight will run. Flight sets it here when a run actually starts,
// so the turn-end finalize clears stale suggestions after a Flight run that wrote
// none, and leaves them alone on a turn the Manager answered without Flight.
FlightManagerAgent.on('agent_start', (runContext) => {
  getRequestState(runContext.context as FlightAppContext).flightRanThisTurn = true;
});

/** The SDK serializes Flight's structured feedback without an outcome adapter. */
export const flightAgentAsTool = FlightManagerAgent.asTool({
  toolName: 'flight_agent',
  toolDescription: FLIGHT_TOOL_DESCRIPTION,
  // Also captures the scoped subtask as RunContext.toolInput for Flight tools.
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: flightAgentConfig.maxTurns },
});
