# Manager tools

The Manager owns the conversation and final answer. Each chat turn creates a Manager with two direct `Agent.asTool()` registrations: `flight_agent` and `trip_planner_agent`. There is no application tool that invokes either agent tool again.

```text
User -> Manager -> Flight or Trip Planner agent tool -> Manager -> User
```

## Tool boundary

`createManagerTools()` builds both tools for the current turn. Each tool accepts a scoped `{ input }` subtask. The SDK's `inputBuilder` passes that text to the nested agent and makes it available as `RunContext.toolInput`; Flight's filter parser uses it instead of the whole mixed user request. Trip's builder prepares its turn state before the nested run.

Flight's SDK `outputType` contains agent-authored status, completed work, summary, findings, limitations, missing information, next step, and presentation. Its `customOutputExtractor` records and serializes that feedback unchanged. Flight cards stay in application state. Trip's extractor sanitizes and stores the full plan behind a `renderRef`, so the Manager sees the summary and reference rather than the plan body.

An SDK tool output guardrail permits structured feedback and replaces unexpected tool output with a generic failure message. This prevents the SDK's default nested-error text from entering the Manager's model input. The Trip tool uses the SDK function-tool timeout for its per-call budget. A client abort or top-level Manager failure ends the turn; it does not replay completed work.

The Manager Runner caps local function-tool concurrency at one because both specialists can update the same request context. Specialist models and settings are declared on the agents themselves. The SDK shares request context, cancellation, tracing, and usage through the nested run.

## Application presentation

`finalizeManagerOutput()` resolves each Trip render reference once, appends any omitted render, and honors Flight's presentation when visible card data exists. The Flight Agent decides what feedback and presentation its work supports; the Manager writes the user-facing response and any per-person price note. The finalizer does not rewrite Flight feedback or rebuild the response from it. Trip scope/link filtering and the final no-link check remain application policy.

Only Flight and Trip tools are registered. The Manager declines unsupported policy, selected-booking, seat, payment, and page-workflow requests according to its prompt. Flight-result filters and new searches remain Flight work even when the user is on another page.

See `tests/integration/manager-acceptance.test.ts` for mixed requests, scoped filter input, render placement, and failure behavior. The SDK pattern is documented in [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools) and [agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/).
