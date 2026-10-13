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

On normal completion, Flight authors every field from its assigned task, current
context, and actual tool results. The SDK enforces the schema, and valid feedback
passes through unchanged. The application does not reinterpret options or rewrite
business failures. If execution ends without valid feedback, a native tool guardrail
returns partial/failure feedback using only confirmed work from that invocation;
it does not invent route, price, result-count, or next-step facts.

- `completedTask` and `summary` explain the outcome.
- `findings` carries relevant verified route/date, count, filter, comparison,
  and price facts. It excludes raw card arrays and private implementation data.
- `limitations` explains unresolved parts and uncertainty that affect the answer.
- `missingInformation` lists genuine blockers; known details are reused.
- `nextStep` gives one useful grounded suggestion or is null.
- `presentation` describes the task's result presentation for the Manager's
  wording, including the per-person note. Old results or a stale `showFlight`
  value alone do not justify it. Client visibility is independently controlled
  by the existing shared Flight flags and results.

The prompt covers partial success, searches with no matches, unavailable options,
and unsuccessful price intelligence. Flight must preserve useful completed work,
report uncertainty honestly, and avoid asking again for dates it already knows.
These decisions belong to Flight's reasoning.

## Direct SDK tool boundary

`src/agents/manager/specialists/flight.ts` registers `FlightManagerAgent.asTool()`.
The singleton input builder passes the scoped subtask through the SDK. The SDK's
default output extraction serializes `result.finalOutput` directly. No application
outcome recorder or custom Flight output extractor is needed, and no specialist
usage metadata is generated for the UI.

Native input/output guardrails capture an invocation baseline, preserve valid
feedback, and provide controlled feedback when execution is interrupted. They
prevent reopening failed Flight work in the same user turn; a fresh user turn can
try again. One shared model-call policy retries only the unfinished request at
25s/50s/75s, never the whole Flight task. Existing Flight tools, context, sessions,
and suggestion lifecycle are unchanged.

## Manager and application responsibilities

The Manager reads the feedback and writes the user response: useful findings,
practical limitations, and a question or next step when needed. Its prompt
prevents disclosure of agents, tools, internal identifiers, errors, and JSON
field names. It writes the per-person price note when Flight requests the
corresponding presentation.

The client renders flight cards solely from shared `showFlight`, `searchResults`,
and per-contract `display` flags, not from response text, agent identity, or
presentation feedback. The application uses no render references/tags or output
composition finalizer. It does not rebuild the Flight reply, repair date
questions, or append Flight prose.
Standalone Flight instructions retain their direct-user audience; the Manager
instructions are appended only on `FlightManagerAgent`.

## Verification

Integration tests drive the real SDK with mocked models. They verify that rich
Flight feedback reaches the Manager unchanged, that shared context cannot
rewrite it, that UI card data stays outside the feedback, and that the Manager's
text is preserved. They do not establish live model reasoning or answer quality;
those need a separate model smoke test.

SDK pattern: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools).
