import { log } from '../../shared/logging/logger.js';
import { countFlightResults } from './specialists/flight.js';
import type { ManagerTurnState } from './turn-state.js';

/**
 * Detect the Manager asking for a travel date it already has.
 *
 * A known failure mode: flight_agent returns results for 20 October, and the
 * Manager still closes with "what date would you like to fly?". That reads as if
 * the search never happened, so the question is replaced with grounded summaries.
 *
 * The check is deliberately narrow — three conditions must all hold:
 *  1. flight_agent actually ran this turn (otherwise there is no date to know).
 *  2. We hold a date for the direction being asked about. Outbound and return are
 *     tracked separately: asking for a return date is legitimate when only the
 *     outbound is known.
 *  3. No specialist listed that same direction's date in `missingInformation`. If
 *     the Flight Agent itself said the date is missing, the question is correct and
 *     must survive — this is what keeps rule 5 of the prompt honest.
 */
function asksForKnownFlightDate(output: string, state: ManagerTurnState): boolean {
  if (!state.outcomes.some(({ name }) => name === 'flight_agent')) return false;

  // Prefer the most recent verified facts over raw context: they were only attached
  // when a core tool actually landed.
  const flight = state.appContext.flight;
  const facts = [...state.outcomes].reverse()
    .find(({ name, result }) => name === 'flight_agent' && result.userRelevantData?.outboundDate)
    ?.result.userRelevantData;
  const outboundDate = facts?.outboundDate || flight.outboundDate || flight.segments?.[0]?.date;
  const returnDate = facts?.returnDate || flight.inboundDate;

  // Examine each question in the reply on its own; a reply may mix a legitimate
  // question with a redundant one.
  return (output.match(/[^?\n]*\?/g) || []).some((question) => {
    const asksDate = /\b(?:what|which)\s+(?:(?:travel|departure|outbound|return)\s+)?date\b|\bwhen\s+(?:would\s+you\s+like|do\s+you\s+want|are\s+you\s+planning)\s+to\s+(?:fly|travel|depart|return)\b|\bdate\s+would\s+you\s+like\b/i.test(question);
    if (!asksDate) return false;

    const isReturnQuestion = /\breturn\b/i.test(question);
    const knownDate = isReturnQuestion ? returnDate : outboundDate;
    if (!knownDate) return false;

    // A specialist explicitly flagged this date as missing, so the ask is justified.
    return !state.outcomes.some(({ result }) =>
      result.missingInformation?.some((item) =>
        /\b(?:date|when)\b/i.test(item) &&
        (isReturnQuestion ? /\breturn\b/i.test(item) : !/\breturn\b/i.test(item))));
  });
}

/** Resolve render references and finalize Manager output */
export function finalizeManagerOutput(managerText: string, state: ManagerTurnState) {
  let output = String(managerText || '');

  // The model asked for a date we already have. Drop its text entirely and rebuild
  // the reply from verified summaries, which cannot re-ask the question.
  if (asksForKnownFlightDate(output, state)) {
    log('warn', 'manager_agent.known_flight_date_clarification_replaced', {
      requestId: state.requestId,
    });
    output = state.outcomes
      .flatMap(({ result }) => [result.summary, result.suggestedNextAction])
      .filter(Boolean).join('\n\n');
  }

  // Resolve render markers
  const used = new Set<string>();
  for (const [ref, content] of state.renders) {
    const marker = `[[render:${ref}]]`;
    if (output.includes(marker)) {
      output = output.replace(marker, content).split(marker).join('');
      used.add(ref);
    }
  }

  // Remove unresolved markers
  output = output.replace(/\[\[render:[^\]]+\]\]/g, '');

  // Detect regenerated renders
  const missingRenders = [...state.renders].filter(([ref]) => !used.has(ref));
  const regeneratedRenderText = missingRenders.some(([, content]) =>
    content.split('\n').some((line) => line.trim().length >= 20 && output.includes(line.trim())));

  if (missingRenders.length && used.size === 0 && regeneratedRenderText) {
    output = state.outcomes
      .filter(({ result }) => !result.renderRef)
      .map(({ result }) => result.summary)
      .filter(Boolean)
      .join('\n\n');
  }

  // Append missing renders
  for (const [, content] of missingRenders) {
    output = `${output.trim()}\n\n${content}`.trim();
  }

  // Fallback to summaries if empty
  if (!output.trim()) {
    output = state.outcomes.map(({ result }) => result.summary).filter(Boolean).join('\n\n');
  }

  const specialistsUsed = [...new Set(state.outcomes.map(({ name }) => name))];

  // Whether the application draws flight cards. This ships to the browser on the SSE
  // `done` event and gates rendering in public/chat-dashboard/app.js, so it is a real
  // UI contract, not a hint. All three conditions are required: a flight outcome that
  // actually asked for a presentation, the app not suppressing cards, and results
  // genuinely present in shared state — the model has no say in it.
  const renderFlightOptions = state.outcomes.some(({ name, result }) =>
    name === 'flight_agent' && (result.status === 'success' || result.status === 'partial') &&
    Boolean(result.presentation)) &&
    state.appContext.flight.showFlight !== false &&
    countFlightResults(state.appContext.flight.searchResults) > 0;

  // Append the per-person note deterministically rather than trusting the prompt.
  // Only for `flight_cards_with_price_note` (a fresh search produced new prices), and
  // only once — `flightResult` already stripped any copy the specialist emitted, and
  // the includes() check covers the case where the Manager wrote it itself.
  if (renderFlightOptions &&
      state.outcomes.some(({ result }) => result.presentation === 'flight_cards_with_price_note') &&
      !output.includes('Note: Prices shown are per person.')) {
    output = `${output.trim()}\n\nNote: Prices shown are per person.`.trim();
  }

  return { output: output.trim(), specialistsUsed, renderFlightOptions };
}
