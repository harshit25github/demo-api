/**
 * The Flight specialist, as the Manager sees it.
 *
 * Two halves:
 *  1. Result mapping (`flightResult` and its helpers) — turns the Flight Agent's
 *     self-reported outcome into a `ManagerToolResult`.
 *  2. The `SpecialistDefinition` at the bottom — the module-level `asTool()` handle
 *     plus the watermarks and failure handling `createSpecialistTool` drives.
 *
 * The central idea in this file is VERIFICATION. The Flight Agent reports its own
 * status, but a model saying "success" is a claim, not evidence. Everything here
 * cross-checks that claim against what actually landed in shared state during this
 * invocation — the `toolCallLog` entries after `logStart`, a changed `searchKey`,
 * a fresh price prediction. A claimed success with no evidence is downgraded to a
 * failure; a claimed failure with real evidence is upgraded to partial.
 */
import { FlightManagerAgent } from '../../flight/agent.js';
import { flightAgentConfig } from '../../flight/config.js';
import { flightManagerOutputSchema } from '../../flight/manager-output.js';
import { latestSuccessfulFlightCoreTool } from '../../flight/context/recovery-outcome.js';
import { getFlightSearchRuntime } from '../../flight/context/search-runtime-store.js';
import { sanitizePricePredictionFailureResponse } from '../../flight/tools/price-prediction/failure-response.js';
import type { FlightAppContext } from '../../flight/types.js';
import { ObservedModelProvider, observeModelInput } from '../../../shared/observability/model-usage.js';
import { gatewayModelRetrySettings } from '../../manager-orchestrator/retry.js';
import type { ManagerToolResult } from '../result-contract.js';
import type { ManagerTurnState } from '../turn-state.js';
import {
  GENERIC_SPECIALIST_FAILURE,
  type NestedOutcome,
  type SpecialistDefinition,
} from '../specialist-tool.js';

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
 * Decide how the application should display results, based on what THIS invocation
 * actually did.
 *
 * `logStart` is the watermark captured before the nested run, so the slice sees only
 * this call's tool entries. Without it a second `flight_agent` call in the same turn
 * would inherit the first call's evidence.
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
 * Used whenever the Flight Agent's own prose cannot be trusted or does not exist —
 * an unparseable result, or a nested run that crashed after the real work landed.
 * Grounded entirely in shared state, so it can never over-claim.
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
 * Runs on the success path only; a failed nested run goes to `flightFailureResult`.
 */
export function flightResult(
  state: ManagerTurnState,
  output: unknown,
  input: string,
  logStart: number,
  priorPricePrediction: unknown,
  priorSearchKey: string | null,
): ManagerToolResult {
  // The model wrote this output, so it is untrusted until the schema accepts it.
  const parsed = flightManagerOutputSchema.safeParse(output);

  // The evidence anchor: did flight_search / apply_filter / getGeneratedContractsContext
  // actually succeed during THIS invocation?
  const core = latestSuccessfulFlightCoreTool(state.appContext, logStart);

  // Identity comparison, not a status check. A successful prediction from an earlier
  // turn is still sitting on the context, so only a DIFFERENT object proves this call
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
  // that happened THIS turn from a stale one, and to notice that a search succeeded
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

  // Did anything real happen this invocation?
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

// ---------------------------------------------------------------------------
// Specialist definition
// ---------------------------------------------------------------------------

/**
 * Built once at module scope, the way the SDK's "agents as tools" guide shows.
 *
 * `customOutputExtractor` stays PURE — it only serializes `finalOutput`. Mapping
 * used to live here, which forced the whole `asTool()` call to be rebuilt inside
 * `execute` so it could close over the watermarks. Moving mapping to `toResult`
 * lets this be a module-level constant, and puts success and failure on one path.
 */
const flightNested = FlightManagerAgent.asTool({
  toolName: 'flight_agent',
  toolDescription: 'Flight search and filtering specialist',
  runConfig: {
    // `modelProvider` MUST stay set. getInheritedAgentToolRunConfig() gates both
    // `inheritedRunConfig.model` and `inheritedRunConfig.modelSettings` on
    // `!overridesModelProvider`, so dropping this line makes the Flight Agent
    // silently inherit the Manager's model and reasoning effort instead of its own.
    modelProvider: new ObservedModelProvider(),
    callModelInputFilter: observeModelInput,
    modelSettings: { preserveRawUsage: true, retry: gatewayModelRetrySettings },
    traceIncludeSensitiveData: true,
  },
  // No `signal` here on purpose: a module-scope AbortSignal.timeout would start
  // counting at import. Per-call timeouts belong in `definition.timeoutMs`.
  runOptions: { maxTurns: flightAgentConfig.maxTurns },
  customOutputExtractor: (result) => JSON.stringify(result.finalOutput ?? null),
});

/** Snapshots taken before the nested run, none of which can be recovered afterwards. */
interface FlightPending {
  /** Index into the shared `toolCallLog`, so evidence can be scoped to this call. */
  logStart: number;
  /** Detects that a search ran: used by the price guardrail and the retry gate. */
  priorSearchKey: string | null;
  /** Compared by identity, so a stale prediction is not read as a fresh one. */
  priorPricePrediction: unknown;
}

/**
 * The nested run failed. Report whatever landed before it did.
 *
 * `MaxTurnsExceededError` in particular does not mean nothing happened — the agent
 * may have completed a search and then run out of turns polishing its answer. Before
 * this refactor the whole branch was unreachable: `invoke()` resolves with the SDK's
 * error string instead of throwing, so the old `instanceof` checks never matched and
 * every nested failure was reported as a bare `SyntaxError`.
 */
function flightFailureResult(
  state: ManagerTurnState,
  pending: FlightPending,
  outcome: Extract<NestedOutcome, { ok: false }>,
): ManagerToolResult {
  const core = latestSuccessfulFlightCoreTool(state.appContext, pending.logStart);
  if (core) {
    return {
      status: 'partial',
      completedTask: 'Completed part of the flight request',
      summary: summarizeFlightCoreTool(state.appContext, core.tool),
      userRelevantData: extractFlightFacts(state.appContext),
      presentation: determineFlightPresentation(state.appContext, pending.logStart),
      recovery: {
        code: outcome.code === 'MAX_TURNS'
          ? 'MAX_TURNS_AFTER_CORE_SUCCESS'
          : 'NESTED_FAILURE_AFTER_CORE_SUCCESS',
        retryable: false,
      },
    };
  }

  // Retrying is only safe if the failed run left no trace. A new tool entry or a
  // rotated searchKey means a retry could duplicate work or contradict what is
  // already in shared state.
  const stateChanged = state.appContext.toolCallLog.length > pending.logStart ||
    state.appContext.flight.searchKey !== pending.priorSearchKey;

  return {
    status: 'failure',
    summary: GENERIC_SPECIALIST_FAILURE,
    recovery: { code: outcome.code, retryable: outcome.retryable && !stateChanged },
  };
}

export const flightSpecialist: SpecialistDefinition<FlightPending> = {
  name: 'flight_agent',
  description: 'Find or start booking flights; change search route, dates, passengers, or cabin; apply or clear listing filters; compare current flight options; find cheaper travel dates with price prediction. Use even on a booking/listing page when the action changes search results. Do not use for seats or selected-booking benefits.',
  nested: flightNested,
  // `apply_filter` parses filter intent straight out of `appContext.currentUserMessage`
  // (src/agents/flight/tools/filter/tool.ts), so it must see this subtask rather than
  // the whole turn — otherwise a mixed request leaks trip-planning words into it.
  scopeUserMessage: true,
  capture(state) {
    return {
      logStart: state.appContext.toolCallLog.length,
      priorSearchKey: state.appContext.flight.searchKey || null,
      priorPricePrediction: state.appContext.flight.lastPricePrediction,
    };
  },
  toResult(state, input, outcome, pending) {
    // `=== false`, not `!outcome.ok`: the test project runs with `strictNullChecks`
    // off, where truthiness narrowing on a boolean discriminant does not narrow.
    if (outcome.ok === false) {
      return flightFailureResult(state, pending, outcome);
    }
    let finalOutput: unknown;
    try {
      finalOutput = JSON.parse(outcome.output);
    } catch {
      // The extractor always emits JSON; this is defence in depth.
      return flightFailureResult(state, pending, {
        ok: false, code: 'INVALID_SPECIALIST_OUTPUT', retryable: false,
      });
    }
    return flightResult(
      state,
      finalOutput,
      input,
      pending.logStart,
      pending.priorPricePrediction,
      pending.priorSearchKey,
    );
  },
};
