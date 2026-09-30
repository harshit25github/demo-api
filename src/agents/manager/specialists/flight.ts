/**
 * The Flight specialist, as the Manager sees it.
 *
 * Registered directly with `Agent.asTool()`. `FlightManagerAgent` declares an
 * `outputType`, so the SDK has already validated `finalOutput` against
 * `flightManagerOutputSchema` by the time it arrives here — no JSON round trip
 * and no re-parsing.
 *
 * The central idea in this file is VERIFICATION. The Flight Agent reports its own
 * status, but a model saying "success" is a claim, not evidence. Everything here
 * cross-checks that claim against what actually landed in shared state this turn
 * — `toolCallLog` entries past the turn watermark, a changed `searchKey`, a fresh
 * price prediction. A claimed success with no evidence is downgraded to a
 * failure; a claimed failure with real evidence is upgraded to partial.
 *
 * Raw `searchResults` never cross into the Manager's context. The application
 * draws cards from shared state; the Manager only learns whether to ask for them.
 */
import type { Tool } from '@openai/agents';
import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import { flightManagerOutputSchema } from '../../flight/manager-output.js';
import { latestSuccessfulFlightCoreTool } from '../../flight/context/recovery-outcome.js';
import { getFlightSearchRuntime } from '../../flight/context/search-runtime-store.js';
import { sanitizePricePredictionFailureResponse } from '../../flight/tools/price-prediction/failure-response.js';
import type { FlightAppContext } from '../../flight/types.js';
import type { ManagerToolResult } from '../result-contract.js';
import { recordOutcome, type ManagerTurnState } from '../turn-state.js';
import {
  createSpecialistResultGuardrail,
  readSubtaskFromResult,
  specialistInputSchema,
  specialistRunConfig,
} from '../specialist-result.js';

const FLIGHT_TOOL_DESCRIPTION =
  'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results. Do not use for seats or selected-booking benefits.';

/**
 * Count flight records regardless of how the search wrote them.
 *
 * `searchResults` is a bare array in some paths and a container keyed by
 * `flights` / `contracts` / `results` / `data` in others, so probe all of them and
 * take the largest. This count is load-bearing: it gates `renderFlightOptions`
 * (whether the UI draws cards at all) and decides whether a requested option
 * number is out of range.
 */
export function countFlightResults(results: unknown): number {
  if (Array.isArray(results)) return results.length;
  if (!results || typeof results !== 'object') return 0;
  let count = 0;
  for (const key of ['flights', 'contracts', 'results', 'data']) {
    const records = (results as Record<string, unknown>)[key];
    if (Array.isArray(records)) count = Math.max(count, records.length);
  }
  return count;
}

/**
 * The only flight facts allowed to cross the specialist -> Manager boundary.
 *
 * Deliberately a tiny scalar projection. Raw `searchResults` must never reach the
 * Manager's context: the cards are rendered by the application from shared state,
 * and putting card payloads in the prompt both bloats it and tempts the model to
 * re-enumerate flights it should not be describing.
 */
export function extractFlightFacts(context: FlightAppContext): Record<string, string | number | null> {
  const flight = context.flight;
  const segment = flight.segments?.[0];
  return {
    // Trust the search's own total first; fall back to counting what we hold.
    resultCount: Number(flight.totalResultsFound || 0) || countFlightResults(flight.searchResults),
    origin: segment?.origin || null,
    destination: segment?.destination || null,
    outboundDate: flight.outboundDate || segment?.date || null,
    returnDate: flight.inboundDate || null,
  };
}

/**
 * Decide how the application should display results, based on what actually
 * happened THIS TURN.
 *
 * `logStart` is the turn watermark, so the slice sees only this turn's tool
 * entries and never evidence carried over from a previous turn.
 *
 * The search/filter split matters: a fresh `flight_search` produces new prices, so
 * the reply must carry the per-person note. A filter or a re-read of existing
 * options does not, and repeating the note there would be noise.
 */
export function determineFlightPresentation(
  context: FlightAppContext,
  logStart: number,
): ManagerToolResult['presentation'] {
  // No cards when the app has suppressed them or there is nothing to show.
  if (context.flight.showFlight === false || countFlightResults(context.flight.searchResults) === 0) {
    return undefined;
  }
  const successfulTools = context.toolCallLog.slice(logStart)
    // `ok` is undefined on older entries, so only an explicit false counts as failed.
    .filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok !== false)
    .map((entry) => (entry as Record<string, unknown>).tool);

  if (successfulTools.includes('flight_search')) return 'flight_cards_with_price_note';
  if (successfulTools.includes('apply_filter') || successfulTools.includes('getGeneratedContractsContext')) {
    return 'flight_cards';
  }
  return undefined;
}

/**
 * Application-owned narration of a core tool that succeeded.
 *
 * Used when the Flight Agent's own prose cannot be trusted. Grounded entirely in
 * shared state, so it can never over-claim.
 */
export function summarizeFlightCoreTool(context: FlightAppContext, toolName: string): string {
  const count = extractFlightFacts(context).resultCount as number;

  if (toolName === 'apply_filter') {
    return count > 0
      ? `Updated flight filters; ${count} matching options are available.`
      : 'Updated flight filters; no options match all active filters.';
  }
  if (toolName === 'getGeneratedContractsContext') {
    return 'Reviewed the current flight options.';
  }
  return count > 0
    ? `Found ${count} flight options.`
    : 'Completed the flight search; no matching options were found.';
}

/**
 * Transform the Flight Agent's structured output into a Manager tool result.
 *
 * `output` is what the SDK validated against `flightManagerOutputSchema`. It is
 * re-checked here because this function is also called directly by tests and by
 * the standalone paths, and because a mapper that throws would lose the evidence
 * narration below.
 */
export function flightResult(
  state: ManagerTurnState,
  output: unknown,
  input: string,
): ManagerToolResult {
  const { toolCallLogLength: logStart, flightPricePrediction: priorPricePrediction,
    flightSearchKey: priorSearchKey } = state.turnStart;
  const parsed = flightManagerOutputSchema.safeParse(output);

  // The evidence anchor: did flight_search / apply_filter / getGeneratedContractsContext
  // actually succeed during this turn?
  const core = latestSuccessfulFlightCoreTool(state.appContext, logStart);

  // Identity comparison, not a status check. A successful prediction from an earlier
  // turn is still sitting on the context, so only a DIFFERENT object proves this turn
  // produced one.
  const prediction = state.appContext.flight.lastPricePrediction;
  const predictionSucceeded = prediction !== priorPricePrediction &&
    Boolean(prediction && typeof prediction === 'object' &&
      (prediction as Record<string, unknown>).status === 'SUCCESS');

  const presentation = determineFlightPresentation(state.appContext, logStart);

  // Malformed output is not automatically a user-facing failure: if a core tool
  // landed, the traveler already has results and we narrate them ourselves.
  if (!parsed.success) {
    return core ? {
      status: 'partial',
      completedTask: 'Completed part of the flight request',
      summary: summarizeFlightCoreTool(state.appContext, core.tool),
      userRelevantData: extractFlightFacts(state.appContext),
      presentation,
      recovery: { code: 'INVALID_FLIGHT_RESULT', retryable: false },
    } : {
      status: 'failure',
      summary: 'Flight work did not produce a usable result.',
      recovery: { code: 'INVALID_FLIGHT_RESULT', retryable: false },
    };
  }

  const specialist = parsed.data;

  // Price-prediction guardrail: stops the Flight Agent narrating a prediction-tool
  // failure to the traveler. It needs the two "before" watermarks to tell a failure
  // that happened this turn from a stale one, and to notice that a search succeeded
  // alongside it. Only the decision is used here; the Manager writes its own summary.
  const predictionGuardrail = sanitizePricePredictionFailureResponse({
    output: specialist.resultSummary,
    context: state.appContext,
    currentUserMessage: input,
    previousPricePrediction: priorPricePrediction,
    previousSearchKey: priorSearchKey,
  }).guardrail;

  if (predictionGuardrail.applied) {
    // A search landed even though the prediction did not, so lead with the results.
    const searched = predictionGuardrail.action === 'search_confirmation' || core?.tool === 'flight_search';
    return searched ? {
      status: 'partial',
      completedTask: specialist.completedTask,
      summary: core ? summarizeFlightCoreTool(state.appContext, core.tool) : 'Flight options are available.',
      userRelevantData: extractFlightFacts(state.appContext),
      presentation,
    } : predictionGuardrail.action === 'price_unverified' ? {
      // Dates are known, so do not ask for them again; just admit the gap.
      status: 'failure',
      completedTask: specialist.completedTask,
      summary: "I couldn't verify a price recommendation for your current trip right now.",
      userRelevantData: extractFlightFacts(state.appContext),
    } : {
      // No usable date anywhere: this is the one case worth asking the traveler.
      status: 'needs_input',
      completedTask: specialist.completedTask,
      summary: 'A travel date is needed to search flight options.',
      missingInformation: ['Expected travel date'],
    };
  }

  // Did anything real happen this turn?
  const verified = Boolean(core || predictionSucceeded);

  const lastFlightWork = state.appContext.toolCallLog.slice(logStart)
    .filter((entry: any) => ['flight_search', 'apply_filter', 'getGeneratedContractsContext']
      .includes(entry?.tool)).at(-1) as Record<string, unknown> | undefined;

  // "Show me option 5" when filtering left only 3. Detected two ways: the tool said
  // INDEX_OUT_OF_RANGE, or the specialist reported partial progress on an option
  // number the current result set cannot satisfy.
  const count = countFlightResults(state.appContext.flight.searchResults);
  const requestedOptions = [...input.matchAll(/\b(?:option|contract)\s*#?\s*(\d+)\b/gi)]
    .map((match) => Number(match[1]));
  const unavailableOption = requestedOptions.find((index) => index > count);
  const optionUnavailable = lastFlightWork?.tool === 'getGeneratedContractsContext' &&
    (lastFlightWork.ok === false && lastFlightWork.code === 'INDEX_OUT_OF_RANGE' ||
      specialist.status === 'partial' && Boolean(unavailableOption) &&
      /\b(?:option|contract)\b/i.test(specialist.completedTask));

  // The option only vanished because filters narrowed the list, and the unfiltered
  // list still holds more — so offering to clear the filters is a real next step.
  const runtime = getFlightSearchRuntime(state.appContext.flight.searchKey);
  const canRestoreEarlierOptions = optionUnavailable &&
    Boolean(runtime?.appliedFilters.length) &&
    (runtime?.sourceFlights.length || 0) > count;

  // Reconcile the specialist's claim with the evidence:
  //   claimed success, no evidence  -> failure   (never let an unbacked claim through)
  //   claimed failure, evidence     -> partial   (work landed; don't discard it)
  //   claimed needs_input, evidence -> partial   (results exist; don't stall the user)
  //   option out of range           -> partial   (the search itself was fine)
  const status = optionUnavailable ? 'partial'
    : specialist.status === 'success' && !verified ? 'failure'
    : specialist.status === 'failure' && verified ? 'partial'
    : specialist.status === 'needs_input' && verified ? 'partial'
    : specialist.status;

  // Strip the per-person note: finalizeManagerOutput appends it exactly once from
  // `presentation`, so leaving it here would duplicate it. The 480-char cap keeps
  // the Manager's context small.
  const summaryText = String(specialist.resultSummary || '').replace(/\s+/g, ' ').trim();
  const summary = optionUnavailable && count > 0
    ? `${unavailableOption ? `Option ${unavailableOption}` : 'The requested option'} is not available in the current${runtime?.appliedFilters.length ? ' filtered' : ''} results; ${count === 1 ? 'only 1 option is' : `only ${count} options are`} available.`
    : summaryText.replace(/\s*Note: Prices shown are per person\.?/gi, '').slice(0, 480);

  return {
    status,
    completedTask: specialist.completedTask,
    // A downgraded claim must not keep its optimistic prose.
    summary: status === 'failure' && specialist.status === 'success'
      ? 'Flight work did not produce a verified result.' : summary,
    // Facts only when something real backs them.
    ...(core || optionUnavailable ? { userRelevantData: extractFlightFacts(state.appContext) } : {}),
    // Never tell the UI to draw cards for a failed or blocked turn.
    ...(presentation && status !== 'failure' && status !== 'needs_input' ? { presentation } : {}),
    ...(specialist.missingInformation.length ? { missingInformation: specialist.missingInformation } : {}),
    ...(canRestoreEarlierOptions ? {
      suggestedNextAction: 'I can remove the current filters and show the earlier flight options if you like.',
    } : {}),
    ...(status === 'failure' && specialist.status === 'success'
      ? { recovery: { code: 'UNVERIFIED_FLIGHT_RESULT', retryable: false } } : {}),
  };
}

/**
 * Build this turn's Flight tool.
 *
 * Per-turn rather than at module scope so the hooks can close over this turn's
 * state and watermarks.
 *
 * `apply_filter` parses filter intent out of the user's own words, so it must see
 * the flight subtask rather than the whole turn. Declaring `inputBuilder` makes
 * the SDK carry that subtask into the nested run as `RunContext.toolInput`, which
 * the filter tool reads via `getScopedRequestText` — no shared-state swap.
 */
export function createFlightTool(state: ManagerTurnState): Tool<any> {
  const flightTool = FlightManagerAgent.asTool({
    toolName: 'flight_agent',
    toolDescription: FLIGHT_TOOL_DESCRIPTION,
    parameters: specialistInputSchema,
    inputBuilder: ({ params }) => params.input,
    runConfig: specialistRunConfig(),
    // No `signal` here: a module-scope AbortSignal.timeout would start counting
    // at import. Flight relies on its per-model timeout in flightAgentConfig.
    runOptions: { maxTurns: flightAgentConfig.maxTurns },
    customOutputExtractor: (result) => {
      const input = readSubtaskFromResult(result);
      return recordOutcome(state, 'flight_agent', input,
        flightResult(state, result.finalOutput, input));
    },
  });

  flightTool.outputGuardrails = [createSpecialistResultGuardrail(state, 'flight_agent')];

  return flightTool as Tool<any>;
}
