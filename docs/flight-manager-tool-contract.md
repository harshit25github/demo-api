# Flight feedback for the Manager

The Manager owns the conversation and the final answer. `FlightManagerAgent`
uses the existing Flight model, domain instructions, and tools. Its additional
Manager instructions ask it to report what it accomplished, the useful facts,
any unresolved limitations, and what it needs next.

```text
User -> Manager -> Flight Agent -> flight tools and shared context
                           -> structured feedback -> Manager -> user response
```

## Feedback owned by Flight

`src/agents/flight/manager-output.ts` defines the SDK `outputType` and the
Manager-specific instructions:

```ts
{
  status: 'success' | 'partial' | 'needs_input' | 'failure',
  completedTask: string,
  summary: string,
  findings: string[],
  limitations: string[],
  missingInformation: string[],
  nextStep: string | null,
  presentation: 'flight_cards' | 'flight_cards_with_price_note' | null,
}
```

Flight authors every field from its assigned task, current context, and actual
tool results. The SDK enforces the schema. There is no application mapper that
infers success, projects facts, interprets option numbers, rewrites prediction
failures, or invents a next step.

- `completedTask` and `summary` explain the outcome.
- `findings` carries relevant verified route/date, count, filter, comparison,
  and price facts. It excludes raw card arrays and private implementation data.
- `limitations` explains unresolved parts and uncertainty that affect the answer.
- `missingInformation` lists genuine blockers; known details are reused.
- `nextStep` gives one useful grounded suggestion or is null.
- `presentation` expresses whether this task's results should show cards.
  Old results or a stale `showFlight` value alone do not justify it.

The prompt covers partial success, searches with no matches, unavailable options,
and unsuccessful price intelligence. Flight must preserve useful completed work,
report uncertainty honestly, and avoid asking again for dates it already knows.
These decisions belong to Flight's reasoning.

## Direct SDK tool boundary

`src/agents/manager/specialists/flight.ts` registers `FlightManagerAgent.asTool()`.
The input builder passes the scoped subtask through the SDK. The output extractor
only records and serializes `result.finalOutput` unchanged. `recordOutcome` keeps
the same feedback for UI metadata and returns it as JSON to the Manager.

The existing shared SDK tool-output guardrail still masks execution failures
when a specialist run cannot produce feedback. It does not alter successful
structured Flight feedback. No Flight turn watermarks are retained.

## Manager and application responsibilities

The Manager reads the feedback and writes the user response: useful findings,
practical limitations, and a question or next step when needed. Its prompt
prevents disclosure of agents, tools, internal identifiers, errors, and JSON
field names. It writes the per-person price note when Flight requests the
corresponding presentation.

The application renders flight cards from shared context when Flight requests
them and visible card data exists. It resolves Trip render references. It does
not rebuild the Flight reply, repair date questions, or append Flight prose.
Standalone Flight instructions retain their direct-user audience; the Manager
instructions are appended only on `FlightManagerAgent`.

## Verification

Integration tests drive the real SDK with mocked models. They verify that rich
Flight feedback reaches the Manager unchanged, that shared context cannot
rewrite it, that UI card data stays outside the feedback, and that the Manager's
text is preserved. They do not establish live model reasoning or answer quality;
those need a separate model smoke test.

SDK pattern: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools).
