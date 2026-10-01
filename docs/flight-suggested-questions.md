# Flight suggested questions

How the Flight Agent produces the "You might ask" suggestions, and what keeps them current. The gap analysis that led here is tracked in [flight-suggested-questions-gap-analysis.xlsx](flight-suggested-questions-gap-analysis.xlsx).

## The rule

`update_flight_suggested_questions` is the required final tool call of every Flight turn, as it was in production. That includes turns that only clarify, ask for missing details, answer from the active source options, or take no action. Nothing runs after it, and its failure never changes a completed result.

The model decides what to pass after its other tools have finished:

- If a search key exists at that point, it passes exactly 3 suggestions. The key can come from hydrated context, or from a `flight_search` earlier in the same turn.
- If no search key exists, it passes an empty array, which clears the stored suggestions.

The tool never writes suggestions of its own. It stores what it is given, or rejects it.

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

Production listed 15 chains. Six of them started with `resolve_flight_date`, which this agent does not register, so they fold into the rows above. Production's ranking chain was read then select. Here ranking reads without changing which cards are visible.

## What makes a good suggestion

The full wording is in the `update_flight_suggested_questions` section of `FLIGHT_PROMPT`. In short, each suggestion:

- is written in the traveler's voice, 3-8 words and under 80 characters, and never as the assistant ("Would you like...");
- names something the agent can do next on the current trip: a filter, removing or relaxing one, ranking or comparing options, details of one option, cheaper-date insight, or a cabin, passenger or trip-type change;
- is grounded in the current state, so airlines and airports come only from the active source options and option numbers stay within the result count;
- never asks the traveler to supply or change the route or dates, and never says "origin" or "destination";
- repeats nothing the traveler just did, nothing that failed this turn, and no filter that is already active.

The three are chosen as a set, with different intents. They are fitted to the kind of turn: after a search, after a filter change, with empty results, after option reasoning, after price advice, or after a clarification. They are never the same three as last turn.

## Enforcement in code

Code enforces what can be checked mechanically, in `src/agents/flight/tools/suggested-questions-tool.ts`:

- **Validation.** A draft is rejected when it has the wrong count, an empty or overlong entry, an assistant-style opener, route or date field wording, a duplicate, or the exact set shown before the turn. Length is checked here rather than as a schema `maxLength`, because constrained decoding enforces that by cutting strings mid-word.
- **One retry.** The first rejection is marked retry-safe and lists the issues. A second rejection, or a fourth call, withdraws the tool for the turn.
- **Reopening.** A successful `flight_search` or `apply_filter` after the update reopens the tool, because the stored suggestions described the previous results.

## Turn lifecycle

1. **Begin.** The standalone runner and the Manager both call `beginFlightSuggestionTurn` when a user turn starts. It records the suggestions on screen at that moment. The dynamic prompt's "Previous suggested questions" block and the anti-repeat check both read that snapshot. They cannot read the live copy, because searches and filters clear it mid-turn and the prompt is rebuilt before every model call.
2. **Flight runs.** On the Manager path, Flight marks the turn from its `agent_start` hook. The Manager starts every turn unmarked.
3. **Finalize.** `finalizeFlightSuggestedQuestions` runs once at the end of every turn, on success and on failure. The standalone runner calls it in both branches, and the Manager runner calls it in a `finally`.
   - If Flight ran and left no current suggestions, the old ones are cleared rather than shown against a conversation that has moved on.
   - If the Manager answered without Flight, the suggestions are kept, because they still describe the active search.
   - Either way it logs `flight_suggestions.turn` with `flightRan`, `written`, `cleared`, `count`, `calls` and `rejected`.

## Who reads them

- The chat API persists `context.flight` with the chat's runtime context and sends it in the SSE `done` event as `flightContext`. A client renders the suggestions from `flightContext.suggestedQuestions`. The dashboard in `public/` does not render them.
- The next Flight turn shows them to the model as "Previous suggested questions".

## Tests

- `tests/unit/flight-agent-suggested-questions.test.ts` covers the tool contract, validation, retry and reopening, finalize, and the prompt rules.
- `tests/integration/flight-agent-recovery-loop.test.ts` covers a scripted run that corrects a rejected draft, and one that is withdrawn after two.
- `tests/integration/manager-flight-registration.test.ts` covers the Manager path: the `agent_start` mark, finalize after a failed run, and a turn that never reaches Flight.
- The live runs check the update on every Flight turn:
  - `tests/live/flight-agent-conversation-live.ts` requires it last on every Flight turn, with 3 suggestions with a search and none without, and records the suggestions.
  - `tests/live/flight-agent-session-complex-report-live.ts` requires it last.
  - `npm run test:flight:suggested-questions-variation` runs one standalone conversation. It starts before a search exists, then moves through a search, a filter, a ranking question and a round-trip change, checking the suggestions on every turn.

## Reference text

`FLIGHT_PROD_PROMPT_TEXT` in `src/agents/flight/prompt.ts` is the production prompt, kept for comparison only. It is never sent to the model. Every rule has to live in `FLIGHT_PROMPT`, the dynamic instructions in `agent.ts`, or `FLIGHT_MANAGER_INSTRUCTIONS`.
