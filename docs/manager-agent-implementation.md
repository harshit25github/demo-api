# Manager agent implementation

The chat API runs one OpenAI Agents SDK Manager turn for each user message. The Manager owns the conversation and final answer. Its only specialist tools are Flight and Trip Planner, registered directly with `Agent.asTool()`. Policy, seat, selected-booking, payment, and page-workflow requests are out of scope until a grounded specialist exists.

## Request flow

```text
POST /api/chat/stream
  -> hydrate persisted Flight/Trip application state
  -> open the SDK OpenAIConversationsSession
  -> Runner.run(Manager, message, { context, session, signal, maxTurns })
  -> optional Flight and/or Trip Planner agent tools
  -> Manager finalOutput
  -> resolve Trip render references and apply final link filtering
  -> one final SSE delta
  -> Summary Extractor; persist chat, summary, and application state
  -> SSE done
```

`OpenAIConversationsSession` owns model history. The JSON chat store owns UI messages, turn metadata, summary context, and Flight/Trip state needed on the next request. A request-local clock is shared with the nested agents. The chat API creates and persists a turn-level `traceId` and includes it in `turn.started`; SDK `withTrace` binds the Manager run to that ID.

The production Manager call is nonstream. The SSE endpoint emits the composed answer as one `delta` after all specialist work finishes, then sends `summary.started` and `done`. `runGatewayAgentTextStream` remains a final-chunk compatibility adapter for callers of the earlier export; it is not the chat API's execution path.

## Ownership and failure behavior

The SDK owns the agent loop, nested runs, structured Flight output, shared run context, tool timeouts, cancellation, tool output guardrails, and tracing. Flight authors structured feedback for the Manager, including findings, limitations, missing details, a next step, and presentation. The Manager writes the traveler response. The application records feedback unchanged and handles Flight card data, exact Trip render content, Trip scope checks, final link filtering, and persistence. See [Manager tools](manager-tool.md) for the tool boundary.

A specialist execution failure becomes one generic tool result before the Manager sees it. Trip Planner has a per-call timeout; an abort or terminal Manager error is reported through the API error event. Completed specialist work is not replayed or converted into a synthetic final answer. New turns use SDK tracing as the primary diagnostic path; standalone specialist and Summary observability code is separate from this Manager path.

Run `npm run typecheck`, `npm run build`, and `npm test` for deterministic verification. The integration tests use mocked models through the real SDK Runner; live routing and answer quality require a separate model smoke test.

SDK references: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools), [running agents](https://openai.github.io/openai-agents-js/guides/running-agents/), and [multi-agent patterns](https://openai.github.io/openai-agents-js/guides/multi-agent/).
