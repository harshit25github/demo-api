# Manager tools

The Manager owns the conversation and final answer. One exported `ManagerAgent` is configured at module load with two direct `Agent.asTool()` registrations: `flight_agent` and `trip_planner_agent`. Each request runs that same agent with its own session and shared application context. There is no application tool that invokes either agent tool again.

```text
User -> Manager -> Flight or Trip Planner agent tool -> Manager -> User
```

## Tool boundary

The tools are exported singletons from [manager/tools.ts](../src/agents/manager/tools.ts). Each tool accepts a scoped `{ input }` subtask. The SDK's `inputBuilder` passes that text to the nested agent and makes it available as `RunContext.toolInput`; Flight's filter parser uses it instead of the whole mixed user request. Trip's `agent_start` hook prepares its existing specialist lifecycle from the current run context, without closing over a Manager turn object.

Flight's SDK `outputType` contains agent-authored status, completed work, summary, findings, limitations, missing information, next step, and presentation. The SDK serializes that feedback directly; there is no outcome recorder. Flight cards stay in application state. Trip's extractor applies the existing scope/link policy and finalizes its existing plan artifact, then returns the actual traveler-facing content to the Manager. It does not create a render reference.

The specialist registrations do not add Manager-specific output guardrails, timeout-result adapters, retries, or failure recovery. Existing SDK behavior and the chat API's terminal error handling remain in place. A client abort or top-level Manager failure does not replay completed work.

The Manager Runner caps local function-tool concurrency at one because both specialists can update the same request context. This is an application-state safety choice, not an SDK requirement for using `asTool()`. Specialist models and settings are declared on the agents themselves. The SDK shares request context, cancellation, tracing, and usage through the nested run. It does not automatically forward the Manager's session/history; the Manager supplies a self-contained subtask and specialist instructions/tools read relevant shared state.

## Application presentation

The runner returns the Manager's final text, subject only to the existing link policy. There is no Manager turn-state factory, per-request agent/tool construction, output finalizer, specialist-use recorder, render tag, or text-derived card decision.

Flight's presentation feedback guides the Manager's wording and per-person price note, not UI visibility. The dashboard uses `flightContext.showFlight`, `searchResults`, and each contract's `display` flag. On completion it clears prior card DOM and renders the current shared state. On history reload it uses the persisted runtime state and attaches the current listing to the latest completed assistant message. Cards are not selected from final text, agent name, or specialist metadata. Trip content is included once by the Manager with its native itinerary/card formatting preserved.

Only Flight and Trip tools are registered. The Manager declines unsupported policy, selected-booking, seat, payment, and page-workflow requests according to its prompt. Flight-result filters and new searches remain Flight work even when the user is on another page.

See [manager-acceptance.test.ts](../tests/integration/manager-acceptance.test.ts) for Manager flows, [chat-api.test.ts](../tests/integration/chat-api.test.ts) for session/persistence/SSE and dashboard wiring, and [flight-contract-client.test.ts](../tests/integration/flight-contract-client.test.ts) for shared-state visibility. The SDK pattern is documented in [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools) and [agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/).
