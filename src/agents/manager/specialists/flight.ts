import { z } from 'zod';
import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import { flightManagerOutputSchema } from '../../flight/manager-output.js';
import type { FlightAppContext } from '../../flight/types.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import { isRecord } from '../../../shared/types/json.js';

const FLIGHT_TOOL_DESCRIPTION =
  'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results, and alongside trip_planner_agent when the traveler changes travelers, dates or destination in trip terms, such as "kids 5 and 8", while a search exists. Do not use for seats or selected-booking benefits.';

// The Manager turn starts with flightRanThisTurn = false because it does not yet
// know whether Flight will run. Flight sets it here when a run actually starts,
// so the turn-end finalize clears stale suggestions after a Flight run that wrote
// none, and leaves them alone on a turn the Manager answered without Flight.
FlightManagerAgent.on('agent_start', (runContext) => {
  getRequestState(runContext.context as FlightAppContext).flightRanThisTurn = true;
});

interface InvocationBaseline {
  logLength: number;
  prediction: unknown;
}
interface TurnRecovery {
  requestId: FlightAppContext['requestId'];
  baselines: Map<string, InvocationBaseline>;
  failedOutput?: string;
}

// Private, request-local evidence only. No conversation/context schema changes,
// and no state from another user turn can disable Flight or become a result.
const turnRecovery = new WeakMap<object, TurnRecovery>();
function recoveryFor(context: object): TurnRecovery {
  const appContext = getRequestState(context as FlightAppContext);
  let recovery = turnRecovery.get(context);
  if (!recovery || recovery.requestId !== appContext.requestId) {
    recovery = { requestId: appContext.requestId, baselines: new Map() };
    turnRecovery.set(context, recovery);
  }
  return recovery;
}

function interruptedFeedback(appContext: FlightAppContext, baseline?: InvocationBaseline): string {
  const completed = baseline
    ? appContext.toolCallLog.slice(baseline.logLength)
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.ok === true)
    : [];
  const searched = completed.some((entry) => entry.tool === 'flight_search');
  const filtered = completed.some((entry) => entry.tool === 'apply_filter');
  const inspected = completed.some((entry) => entry.tool === 'getGeneratedContractsContext');
  const prediction = appContext.flight.lastPricePrediction;
  const predicted = Boolean(baseline && prediction !== baseline.prediction && isRecord(prediction)
    && prediction.ok === true && prediction.status === 'SUCCESS'
    && Array.isArray(prediction.predictions) && prediction.predictions.length > 0);
  const findings = [
    ...(searched ? ['The flight search completed before the interruption.'] : []),
    ...(filtered ? ['The flight filter changes were processed before the interruption.'] : []),
    ...(inspected ? ['Existing flight options were retrieved before the interruption.'] : []),
    ...(predicted ? ['The travel-date prediction lookup completed before the interruption.'] : []),
  ];
  const visible = appContext.flight.showFlight && Array.isArray(appContext.flight.searchResults)
    && appContext.flight.searchResults.some((option) => isRecord(option) && option.display !== false);
  const displayed = completed.some((entry) => entry.tool === 'getGeneratedContractsContext'
    && (entry.mode === 'select' || entry.mode === 'show_all'));
  const presentation = visible && (searched || filtered || displayed)
    ? searched ? 'flight_cards_with_price_note' : 'flight_cards'
    : null;
  return JSON.stringify(flightManagerOutputSchema.parse({
    status: findings.length > 0 ? 'partial' : 'failure',
    completedTask: findings.length > 0
      ? 'Completed part of the flight request.' : 'The flight request could not be completed.',
    summary: findings.length > 0
      ? 'Completed flight work has been preserved, but I could not finish the remaining request right now.'
      : 'I could not complete the flight request right now.',
    findings,
    limitations: ['The remaining flight request could not be completed right now.'],
    missingInformation: [],
    nextStep: null,
    presentation,
  }));
}

/** The SDK serializes Flight's structured feedback without an outcome adapter. */
export const flightAgentAsTool = FlightManagerAgent.asTool({
  toolName: 'flight_agent',
  toolDescription: FLIGHT_TOOL_DESCRIPTION,
  parameters: z.object({
    input: z.string(),
    acknowledgement: z.string().describe(
      'One sentence of 11 to 21 words, with no emojis, acknowledging the entire user request on the first specialist call this turn; an empty string on every other call.',
    ),
  }),
  // Also captures the scoped subtask as RunContext.toolInput for Flight tools.
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: flightAgentConfig.maxTurns },
});

// Native tool guardrails keep the specialist itself an ordinary asTool() run.
// Its default exception text is not structured feedback and must not leak to
// Manager or cause the same failed task to be reopened with a fresh retry budget.
flightAgentAsTool.inputGuardrails = [{
  type: 'tool_input',
  name: 'flight_recovery_turn_boundary',
  async run({ context, toolCall }) {
    const recovery = recoveryFor(context.context as object);
    if (recovery.failedOutput) {
      return { behavior: { type: 'rejectContent', message: recovery.failedOutput } };
    }
    const appContext = getRequestState(context.context as FlightAppContext);
    recovery.baselines.set(toolCall.callId, {
      logLength: appContext.toolCallLog.length,
      prediction: appContext.flight.lastPricePrediction,
    });
    return { behavior: { type: 'allow' } };
  },
}];

flightAgentAsTool.outputGuardrails = [{
  type: 'tool_output',
  name: 'flight_recovery_feedback',
  async run({ context, toolCall, output }) {
    const recovery = recoveryFor(context.context as object);
    const baseline = recovery.baselines.get(toolCall.callId);
    recovery.baselines.delete(toolCall.callId);
    let parsed: unknown;
    try { parsed = typeof output === 'string' ? JSON.parse(output) : output; } catch { /* Native failure text. */ }
    if (flightManagerOutputSchema.safeParse(parsed).success) {
      return { behavior: { type: 'allow' } };
    }
    recovery.failedOutput = interruptedFeedback(
      getRequestState(context.context as FlightAppContext), baseline,
    );
    return { behavior: { type: 'rejectContent', message: recovery.failedOutput } };
  },
}];
