# Manager agent implementation

The chat entry point runs a Manager Agent by default. Set `ORCHESTRATION_MODE=handoff` before starting the server to use the previous Gateway handoff path. The switch is read during process startup for Runner trace names, so restart the process after changing it.

The Manager owns the top-level `OpenAIConversationsSession` and final answer. Each turn creates a fresh Manager and four named tools. Flight and Trip tools call their existing specialists through `agent.asTool()` with the same request context, explicit nested turn limits, model input observation, and the existing retry settings. Nested runs have no separate conversation session. The shared application context and compact tool result carry relevant state back to the Manager. The Manager's model has `parallelToolCalls: false`; shared mutable Flight and Trip state currently makes concurrent calls unsafe.

The two CheapOair specialists are still routing smoke tests with no policy or page source. Their Manager tools return `CAPABILITY_NOT_IMPLEMENTED` without spending a nested model call. Connecting real sources is separate work; the Manager must report those portions as unavailable meanwhile.

## Result boundary

The specialist-to-Manager result contains `status`, a short `summary`, and only when useful: `userRelevantData`, `missingInformation`, `recovery`, or `renderRef`. Tool-call history, raw search results, and the full Trip itinerary stay out of this model input. Trip Planner output is scope and link checked, stored for the current turn, and inserted into the final response once through `[[render:REF]]`. If the Manager omits a render reference, the server composes the remaining compact results with the saved artifact. Flight cards continue to render from the persisted Flight context and an explicit `renderFlightOptions` flag.

The chat API buffers the Manager's raw final text until render references and link checks are complete, then sends the final text in its SSE `delta` event. This delays the first text delta for long specialist runs. The existing `status`, `summary.started`, and `done` events remain. Per-turn usage and tracing remain in observability, rather than the Manager tool result.

## Recovery and validation

Nested tool exceptions become structured failures. A completed Flight core tool is retained as a partial result if later nested work fails. A top-level max-turn error returns completed specialist work when possible. The existing model retry policy applies to the Manager and nested SDK runners; retry of a whole Manager turn is restricted to the existing no-output timeout path and resumes its SDK state.

Deterministic tests cover the real nested `asTool()` boundary with a mock model, shared context, scoped input, compact large-output extraction, unavailable tools, render pass-through, stream finalization, max-turn partial recovery, and chat/SSE metadata persistence. A live model evaluation is still needed to measure routing accuracy, latency, and token cost for single and mixed requests before removing the handoff rollback.

SDK references: [agents as tools](https://openai.github.io/openai-agents-js/guides/tools/#4-agents-as-tools), [composition patterns](https://openai.github.io/openai-agents-js/guides/agents/#composition-patterns), and [multi-agent guide](https://openai.github.io/openai-agents-js/guides/multi-agent/).
