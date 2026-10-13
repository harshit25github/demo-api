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
  -> persist chat and specialist-owned application state
  -> SSE done
```

`OpenAIConversationsSession` owns model history. The JSON chat store owns UI messages, turn metadata, summary context, and Flight/Trip state needed on the next request. Summary extraction is disabled: its implementation remains available but is not imported or called by the chat workflow. Existing top-level summary payloads remain unchanged, with `summaryStatus: skipped`. Specialist-owned context is persisted in `runtimeContext.summaryContext` and restored directly; legacy summaries seed only older chats without that runtime snapshot. A request-local clock is shared with the nested agents. The chat API creates and persists a turn-level `traceId` and includes it in `turn.started`; SDK `withTrace` binds the Manager run to that ID.

The Manager call defaults to nonstream. Set `stream: true` in the `/api/chat/stream` JSON body to use SDK model streaming; the runner consumes all events and awaits completion before applying the existing final link sanitizer. In both modes the SSE endpoint emits the Manager's final answer as one `delta`, persists it and sends `done`, with no summary phase. This does not expose raw token deltas or specialist structured output to the client. Shared Flight context drives client cards independently of the response text; the API does not emit or write Manager-specific specialist-use/render metadata.

## Ownership and failure behavior

The SDK owns the agent loop, nested runs, structured specialist output, shared run context, cancellation, tracing, and default tool-error handling. Flight authors structured feedback for the Manager, including findings, limitations, missing details, a next step, and presentation; the SDK serializes it directly. The managed Trip singleton also uses native `outputType`: destinations, day slots, recommendations, notes, tables, question intents, limitations, and current formatting policies. Trip's extractor validates individual text fields and matching cached image assets, then finalizes its factual plan artifact and serializes the feedback once. The Manager owns friendly final markdown, preserving exact image URLs and planning scope rather than copying a completed Trip answer. Standalone Trip retains its text interface. Existing final link filtering and persistence remain application policy. See [Manager tools](manager-tool.md) for the tool boundary.

Trip full/new-destination plans replace the previous artifact. Same-destination patches merge only supplied days and non-null time blocks; `null` means unchanged, and an explicit free-time block removes an activity. Unchanged days/cards survive non-day changes, and unsuccessful or excluded feedback cannot erase a useful plan. The existing selective context reader exposes factual slots and recovers labeled legacy content; formatting policies come from the current prompt/brief, never old saved artifacts or retrieved pages.

No Manager turn-state object, per-request agent/tool rebuilding, outcome recorder, or render-reference finalizer is retained. The shared [model-call boundary](../src/shared/runtime/model-deadline.ts) uses one plain deadline config: 25s, 50s, then 75s, with at most three attempts per pending model request. It protects both nonstream and streamed requests, aborts timed-out attempts, discards late output, and never restarts the Manager or replays completed tools. SDK and HTTP retries are disabled for this managed path; standalone Flight retains its existing settings. These are model deadlines, not a whole-turn or business-tool timeout.

For streaming, each attempt's deadline covers opening and all event reads; chunks do not reset it. Recovery is allowed only before any event has been delivered. A failure after an event (including response metadata, not just visible text) stops cleanly without replay. `response_done` is completion, so trailing iterator cleanup cannot turn a successful response into a timeout. Client cancellation stops waiting and prevents further attempts. Remote cancellation/billing remains best effort. Native specialist tools keep their existing streaming configuration: a streamed Manager does not automatically make its nested Flight run stream. Both model-call modes use the same provider policy.

Flight's native tool guardrails pass valid structured feedback unchanged. If execution fails without valid feedback, they return schema-compatible partial/failure feedback grounded only in confirmed work from that invocation and block reopening Flight during the same user turn. An abort or terminal Manager error still follows the existing API error path. Existing Flight suggestion lifecycle and Trip context-capture/plan persistence are unchanged. New turns use SDK tracing as the primary diagnostic path; standalone specialist and Summary observability code is separate from this Manager path.

The Manager session is not automatically forwarded into `asTool()` runs. Each specialist receives the Manager's self-contained `{ input }` subtask and shared application state. Relevant state is exposed through dynamic instructions/tools; conversation meaning not stored there must be included by the Manager.

Run `npm run typecheck`, `npm run build`, and `npm test` for deterministic verification. The integration tests use mocked models through the real SDK Runner; live routing and answer quality require a separate model smoke test.

SDK references: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools), [running agents](https://openai.github.io/openai-agents-js/guides/running-agents/), and [multi-agent patterns](https://openai.github.io/openai-agents-js/guides/multi-agent/).
