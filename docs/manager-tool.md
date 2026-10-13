# Manager tools

The Manager owns the conversation and final answer. One exported `ManagerAgent` is configured at module load with two direct `Agent.asTool()` registrations: `flight_agent` and `trip_planner_agent`. Each request runs that same agent with its own session and shared application context. There is no application tool that invokes either agent tool again.

```text
User -> Manager -> Flight or Trip Planner agent tool -> Manager -> User
```

## Tool boundary

The tools are exported singletons from [manager/tools.ts](../src/agents/manager/tools.ts). Each tool accepts a scoped `{ input }` subtask. The SDK's `inputBuilder` passes that text to the nested agent and makes it available as `RunContext.toolInput`; Flight's filter parser uses it instead of the whole mixed user request. Trip's `agent_start` hook prepares its existing specialist lifecycle from the current run context, without closing over a Manager turn object.

Flight's SDK `outputType` contains agent-authored status, completed work, summary, findings, limitations, missing information, next step, and presentation. The SDK serializes that feedback directly; there is no outcome recorder. Flight cards stay in application state. Managed Trip's SDK `outputType` contains planning facts and trusted formatting rules, not a finished answer. Its extractor validates typed `finalOutput`, scope/link checks each text field, verifies image URLs against matching cached assets, and finalizes the factual plan artifact before serializing JSON once. It never link-sanitizes the whole JSON or creates a render reference. The Manager composes friendly markdown without adding activities, photos, current facts or questions. Standalone Trip remains text-only.

The shared model provider protects streamed and nonstream model requests using the plain 25s/50s/75s deadline config, at most three attempts. A streamed request can retry only before emitting any event; after that it fails cleanly without replay. It does not restart a specialist or the Manager conversation. Flight's native input/output guardrails preserve valid feedback and turn unusable exception output into controlled partial/failure feedback based on confirmed work from the current invocation. After that failure, Flight cannot reopen during the same user turn. Client aborts and terminal Manager failures follow the existing API error path without replaying completed work.

The Manager Runner caps local function-tool concurrency at one because both specialists can update the same request context. This is an application-state safety choice, not an SDK requirement for using `asTool()`. Specialist models and settings are declared on the agents themselves. The SDK shares request context, cancellation, tracing, and usage through the nested run. It does not automatically forward the Manager's session/history; the Manager supplies a self-contained subtask and specialist instructions/tools read relevant shared state.

## Application presentation

The runner returns the Manager's final text, subject only to the existing link policy. There is no Manager turn-state factory, per-request agent/tool construction, output finalizer, specialist-use recorder, render tag, or text-derived card decision.

Flight's presentation feedback guides the Manager's wording and per-person price note, not UI visibility. The dashboard uses `flightContext.showFlight`, `searchResults`, and each contract's `display` flag. On completion it clears prior card DOM and renders the current shared state. On history reload it uses the persisted runtime state and attaches the current listing to the latest completed assistant message. Cards are not selected from final text, agent name, or specialist metadata. The Manager renders Trip facts once using paired `:::cards` blocks and Day/Morning/Afternoon/Evening markdown; patches omit unchanged blocks. Dummy Trip image URLs and the dashboard's plain-text Trip presentation are separate frontend limitations, unchanged by this backend contract.

Only Flight and Trip tools are registered. The Manager declines unsupported policy, selected-booking, seat, payment, and page-workflow requests according to its prompt. Flight-result filters and new searches remain Flight work even when the user is on another page.

See [manager-acceptance.test.ts](../tests/integration/manager-acceptance.test.ts) for Manager flows, [chat-api.test.ts](../tests/integration/chat-api.test.ts) for session/persistence/SSE and dashboard wiring, and [flight-contract-client.test.ts](../tests/integration/flight-contract-client.test.ts) for shared-state visibility. The SDK pattern is documented in [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools) and [agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/).
