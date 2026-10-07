# Manager agent implementation

The chat API runs one OpenAI Agents SDK Manager turn for each user message. `ManagerAgent` and its Flight/Trip Planner `Agent.asTool()` registrations are exported singletons configured once; each run receives its own context and session. The Manager owns the conversation and final answer. Policy, seat, selected-booking, payment, and page-workflow requests are out of scope until a grounded specialist exists.

## Request flow

```text
POST /api/chat/stream
  -> hydrate persisted Flight/Trip application state
  -> open the SDK OpenAIConversationsSession
  -> Runner.run(Manager, message, { context, session, signal, maxTurns })
  -> optional Flight and/or Trip Planner agent tools
  -> Manager finalOutput
  -> apply existing final link filtering (no render references or composition)
  -> one final SSE delta
  -> Summary Extractor; persist chat, summary, and application state
  -> SSE done
```

`OpenAIConversationsSession` owns model history. The JSON chat store owns UI messages, turn metadata, summary context, and Flight/Trip state needed on the next request. A request-local clock is shared with the nested agents. The chat API creates and persists a turn-level `traceId` and includes it in `turn.started`; SDK `withTrace` binds the Manager run to that ID.

The production Manager call is nonstream. The SSE endpoint emits the Manager's final answer as one `delta` after specialist work finishes, then sends `summary.started` and `done`. `runGatewayAgentTextStream` remains a final-chunk compatibility adapter for callers of the earlier export; it is not the chat API's execution path. Shared Flight context drives client cards independently of the response text; the API no longer emits or writes Manager-specific specialist-use/render metadata.

## Ownership and failure behavior

The SDK owns the agent loop, nested runs, structured Flight output, shared run context, cancellation, tracing, and default tool-error handling. Flight authors structured feedback for the Manager, including findings, limitations, missing details, a next step, and presentation; the SDK serializes it directly. Trip's existing scope/link policy and plan-artifact lifecycle remain in its tool registration, which returns the actual Trip content. The Manager writes the traveler response and includes the requested Trip content once. Existing final link filtering and persistence remain application policy. See [Manager tools](manager-tool.md) for the tool boundary.

No Manager turn-state object, per-request agent/tool rebuilding, outcome recorder, render-reference finalizer, Manager-specific tool-output guardrail, timeout-result adapter, or extra recovery infrastructure is required by the SDK or retained here. Specialist errors use SDK-default behavior; an abort or terminal Manager error is reported through the existing API error event. Completed specialist work is not replayed or converted into a synthetic final answer. Existing Flight suggestion lifecycle and Trip context-capture/plan persistence are preserved, not replaced by Manager orchestration. New turns use SDK tracing as the primary diagnostic path; standalone specialist and Summary observability code is separate from this Manager path.

The Manager session is not automatically forwarded into `asTool()` runs. Each specialist receives the Manager's self-contained `{ input }` subtask and shared application state. Relevant state is exposed through dynamic instructions/tools; conversation meaning not stored there must be included by the Manager.

Run `npm run typecheck`, `npm run build`, and `npm test` for deterministic verification. The integration tests use mocked models through the real SDK Runner; live routing and answer quality require a separate model smoke test.

SDK references: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools), [running agents](https://openai.github.io/openai-agents-js/guides/running-agents/), and [multi-agent patterns](https://openai.github.io/openai-agents-js/guides/multi-agent/).
