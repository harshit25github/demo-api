# Flight suggested questions

How the Flight Agent produces the "You might ask" suggestions, and what keeps them current. The gap analysis that led here is tracked in [flight-suggested-questions-gap-analysis.xlsx](flight-suggested-questions-gap-analysis.xlsx).

## The rule

`update_flight_suggested_questions` is the required final tool call of every Flight turn, as it is in production. That includes turns that only clarify, ask for missing details, answer from the active source options, or take no action. Nothing runs after it, and its failure never changes a completed result.

The model decides what to pass after its other tools have finished:

- **Three suggestions whenever any trip detail is known**, before or after a search. A detail can be a route endpoint, a date, the route of an earlier price prediction, or an active search.
- **An empty array only when nothing about the trip is known**, such as a bare "I want to book a flight". It clears the stored suggestions.
- **A failed or empty result is never a reason for an empty array.** A prediction with no data, zero matching options or a failed search still leaves details to build on.

The tool never writes suggestions of its own. It stores what it is given, or rejects it.

## Before a search exists

The suggestions follow production's state matrix, adapted to the tools this agent registers.

| What is known | Suggestions to offer |
|---|---|
| Departure and arrival, no date | Price windows ("Cheapest next month") or concrete timing ("Search flights next weekend") |
| Only the departure | Discovery from it ("Weekend getaways from Delhi"); never a cheapest destination |
| Only the arrival | Destination planning only ("Best time to visit Goa"); no fare, date or search suggestion |
| Departure and dates, no arrival | Discovery grounded in both ("Beach trips from Delhi this weekend") |
| Arrival and dates, no departure | Planning for those dates ("Plan my Goa weekend") |
| Route and exact date, no search yet | "Search this trip", plus a trip-type, passenger or cabin refinement |
| Round trip without return timing | "Return after 3 days", "Return after a week", "Make it one way" |
| Successful prediction, no search yet | The strongest returned date by name ("Search flights on Oct 27") |
| Failed prediction with a known route | Concrete search timing; never the comparison that just failed |

A suggestion may add a timing choice, but never a departure or arrival location the traveler has not given. Discovery and planning suggestions go to Trip Planner when tapped; the Manager routes them.

## Approved chains

Every chain ends with `update_flight_suggested_questions`.

| Request | Core tools before the update |
|---|---|
| Clarification, missing details, source-option answer, ambiguity, no action | none |
| New or changed search | `flight_search` |
| Search plus filters, including recovery from `MISSING_SEARCH` | `flight_search`, `apply_filter` |
| Filter addition, removal, replacement or reset | `apply_filter` |
| Option facts, comparisons, rankings, recommendations | `getGeneratedContractsContext` read |
| Explicit display of chosen options, or restoring all | `getGeneratedContractsContext` select or show_all |
| Price or date advice only | `price_prediction_tool` |
| Price or date advice plus requested results | `price_prediction_tool`, `flight_search`, then `apply_filter` if filters were requested |
| Price advice about a current option | `getGeneratedContractsContext` read, `price_prediction_tool` |

Production lists 15 chains. Six of them start with `resolve_flight_date`, which this agent does not register, so they fold into the rows above. Production's ranking chain is read then select. Here ranking reads without changing which cards are visible.

## What makes a good suggestion

The full wording is in the `update_flight_suggested_questions` section of `FLIGHT_PROMPT`. In short, each suggestion:

- is written in the traveler's voice, 3-8 words and under 80 characters, and never as the assistant ("Would you like...");
- is a concrete next step grounded in the current state, so airlines and airports come only from the active source options and option numbers stay within the result count;
- is never empty slot-filling such as "Add travel date", and never says "origin" or "destination". Concrete choices such as "Cheapest next month" or "Return after a week" are welcome;
- repeats nothing the traveler just did, nothing that failed this turn, and no filter that is already active;
- is not one the traveler already used. If the latest request selects or paraphrases a suggestion from the previous turn, that suggestion is not offered again while the trip is unchanged, and neither half of an action and its reversal comes back.

The three are chosen as a set, with different intents, judged by intent rather than wording. They are fitted to the kind of turn, and they are never the same three as last turn.

## Enforcement in code

Code enforces what can be checked mechanically, in `src/agents/flight/tools/suggested-questions-tool.ts`:

- **Validation.** A draft is rejected when it has the wrong count or an empty or overlong entry. It is also rejected for an assistant-style opener, slot-filling or internal field wording, a duplicate, or the exact set shown before the turn. Length is checked here rather than as a schema `maxLength`, because constrained decoding enforces that by cutting strings mid-word.
- **No empty list while details are known.** An empty array is refused with `EMPTY_CTA_NOT_ALLOWED` whenever the context holds a search key, a route endpoint or date, or a prediction route. Details the Manager carries only in a subtask are invisible to the tool, so it never refuses three suggestions.
- **One retry.** The first rejection is marked retry-safe and lists the issues. A second rejection, or a fourth call, withdraws the tool for the turn.
- **Reopening.** A successful `flight_search` or `apply_filter` after the update reopens the tool, because the stored suggestions described the previous results.

## Turn lifecycle

1. **Begin.** The standalone runner and the Manager both call `beginFlightSuggestionTurn` when a user turn starts, passing the suggestions on screen before turn preparation. The dynamic prompt's "Previous suggested questions" block and the anti-repeat check both read that snapshot. They cannot read the live copy: preparation clears it when no search exists, searches and filters clear it mid-turn, and the prompt is rebuilt before every model call.
2. **Flight runs.** On the Manager path, Flight marks the turn from its `agent_start` hook. The Manager starts every turn unmarked, and it sends Flight any reply that supplies part of a flight request, such as "from Delhi".
3. **Finalize.** `finalizeFlightSuggestedQuestions` runs once at the end of every turn, on success and on failure. The standalone runner calls it in both branches, and the Manager runner calls it in a `finally`.
   - If Flight ran and left no current suggestions, the old ones are cleared rather than shown against a conversation that has moved on.
   - If the Manager answered without Flight, the suggestions are kept, because they still describe the trip.
   - Either way it logs `flight_suggestions.turn` with `flightRan`, `written`, `cleared`, `count`, `calls` and `rejected`.

The dynamic instructions also show the last successful price prediction and its strongest dates. A later turn can then search the recommended date without predicting again, and suggestions can name that date.

## Not adopted from production

- **Canonical intent-key records and a persisted intent state.** Production stores `{ text, intentKey }` records with used and generated keys. Here the prompt judges sameness by intent and blocks suggestions used on the previous turn. A suggestion used two turns ago can still return in Manager mode, where Flight sees no history.
- **Blocking every generated intent for a whole search phase.** In a long conversation about one search this can run out of good suggestions, because the phase ignores filter changes.

## Who reads them

- The chat API persists `context.flight` with the chat's runtime context and sends it in the SSE `done` event as `flightContext`. A client renders the suggestions from `flightContext.suggestedQuestions`. The dashboard in `public/` does not render them.
- The next Flight turn shows them to the model as "Previous suggested questions".

## Tests

- `tests/unit/flight-agent-suggested-questions.test.ts` covers the tool contract, pre-search storage, the empty-list refusal, validation, retry and reopening, finalize, the prediction summary, and the prompt and Manager rules.
- `tests/integration/flight-agent-recovery-loop.test.ts` covers a scripted run that corrects a rejected draft, and one that is withdrawn after two.
- `tests/integration/manager-flight-registration.test.ts` covers the Manager path: the `agent_start` mark, finalize after a failed run, and a turn that never reaches Flight.
- The live runs check the update on every Flight turn:
  - `tests/live/flight-agent-conversation-live.ts` requires it last on every Flight turn, with 3 suggestions whenever the context holds trip details, and records the suggestions. The `trip_details_one_at_a_time` script walks a request in from nothing to a search.
  - `tests/live/flight-agent-session-complex-report-live.ts` requires it last.
  - `npm run test:flight:suggested-questions-variation` runs one standalone conversation from a bare destination through a search, a filter, a ranking question and a round-trip change.

## Reference text

`FLIGHT_PROD_PROMPT_TEXT` in `src/agents/flight/prompt.ts` is the production prompt, kept for comparison only. It is never sent to the model. Every rule has to live in `FLIGHT_PROMPT`, the dynamic instructions in `agent.ts`, `FLIGHT_MANAGER_INSTRUCTIONS`, or the Manager prompt.
