# Flight Agent as a Manager tool

The Manager owns the conversation and the final response. In Manager mode the
Flight Agent receives a scoped flight task, runs its existing search, filter,
contract, prediction, and recovery workflow, then returns a small structured
result. The standalone `FlightAgent` remains available for debugging during the
transition. The active Manager uses `FlightManagerAgent`.

## Flight specialist output

`src/agents/flight/manager-output.ts` defines the model output:

```ts
{
  status: 'success' | 'partial' | 'needs_input' | 'failure',
  completedTask: string,
  resultSummary: string,
  missingInformation: string[],
}
```

`completedTask` names the work actually done, including an attempted check when
it did not succeed. `resultSummary` gives the Manager only verified flight facts
or a short, safe explanation. `missingInformation` contains at most three
blocking details and is empty otherwise. The schema bounds text length and
rejects extra fields. It has no reasoning, tool history, search keys, internal
IDs, or flight card arrays.

`flightResult` in `src/agents/manager/specialists/flight.ts` reads the typed
`finalOutput` from `agent.asTool()` and adds only application-owned information:

- `userRelevantData`: a small route/date/result count projection of shared
  Flight context when current work was verified.
- `presentation`: `flight_cards` or `flight_cards_with_price_note` when a
  current-turn Flight action produced visible options. The application renders
  the actual cards from shared context, so the Manager does not receive them.
- `recovery`: a bounded code and retry flag for adapter/runtime failures.

The adapter checks current-turn core tool results or a new successful price
prediction before accepting a `success` claim. A completed core action survives
an invalid final result or nested-run failure as `partial`. A new prediction
failure retains the existing safe date-request/search-confirmation behavior
without exposing prediction errors to the Manager. Tool details stay in the
tool log and tracing, outside the Manager result.

The Manager uses status, summary, and missing information to decide whether to
answer, ask a question, or continue. For `flight_cards_with_price_note`, it
adds the existing per-person note once; the finalizer supplies the note if the
Manager omits it. No note is added for filter-only cards or non-card results.

## Prompt audience change

The original Flight prompt remains the source of domain behavior. The dynamic
Manager-mode section in `src/agents/flight/agent.ts` changes its final-output
audience only:

| Original direct-response wording in `prompt.ts` | Manager-mode meaning |
| --- | --- |
| User-facing language, selected date, and concise final answer (lines 5, 31, 65, 117) | Put concise, verified facts in `resultSummary`; Manager writes the final answer. |
| Ask the user for missing fields or ambiguous corrections (lines 18, 33, 50, 52, 83, 86, 97, 103, 107) | Return `needs_input` and the smallest `missingInformation`; Manager asks. |
| Search-card price note and card wording (lines 73-75) | Return no card prose; adapter marks card presentation and Manager handles the note. |
| Prediction failure disclosure and date-only wording (lines 84, 87) | Keep the same disclosure and wording rules in the compact summary. |
| Suggested questions (lines 111-113) | Keep the existing best-effort context/UI update; it does not enlarge the Manager result. |

Evidence priority, defaults, date handling, tool choice, filter rules, retry
limits, and failure recovery are unchanged. The Manager-mode section is appended
after those rules so direct-user final-response instructions do not control the
structured final output.

## Reusable pattern for later specialists

Trip Planner and BGS/pages are **not migrated here**. When they are migrated,
use a specialist-specific typed output for task status, short verified summary,
and blocking information; keep domain rules in that specialist. Let the Manager
adapter verify completion and project only facts needed for composition. Keep
large itinerary/card/page payloads outside the Manager model context and pass
them through with a render reference or existing UI state. Do not return full
polished specialist prose and then ask the Manager to regenerate it.

The SDK behavior used here is documented in the official
[Agents output types](https://openai.github.io/openai-agents-js/guides/agents/#output-types),
[agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools),
and [agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
guides. The four-field schema, evidence checks, shared-context card path, and
presentation flags are application decisions.
