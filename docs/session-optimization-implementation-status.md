# Session optimization implementation status

Implementation checks: **2026-09-09**. Token measurements: **2026-09-08**. SDK: **0.17.0**. Runtime models are unchanged.

Core usage instrumentation, source projections, legacy-history projection, configuration, measurement tooling and compaction plumbing are implemented. The application defaults to `observe`, so candidate projections are measured without changing model-facing history. Compaction remains disabled. The full six-phase rollout is **not complete**: live behavior, cost/latency, real compaction continuity and prompt cleanup still require evidence.

## Measured benefit

These are **provider-counted input tokens for a complete Flight model request**, including its actual dynamic instructions and tool schemas. Both sides use the same synthetic context and fixed clock. The installed OpenAI provider serializes the requests; the benchmark does not estimate tokens from characters.

| Tool | Results | Scripted turns | Before | After projection | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| flight_search | 3 | 1 | 20,682 | 20,185 | 2.4% |
| flight_search | 20 | 1 | 23,483 | 20,185 | 14.0% |
| flight_search | 100 | 1 | 36,681 | 20,185 | 45.0% |
| flight_search | 20 | 5 | 39,646 | 23,156 | 41.6% |
| flight_search | 20 | 20 | 100,270 | 34,310 | 65.8% |
| flight_search | 20 | 50 | 221,518 | 56,618 | 74.4% |
| apply_filter | 3 | 1 | 20,135 | 19,580 | 2.8% |
| apply_filter | 20 | 1 | 22,936 | 19,580 | 14.6% |
| apply_filter | 100 | 1 | 36,134 | 19,580 | 45.8% |
| apply_filter | 20 | 5 | 37,335 | 20,555 | 44.9% |
| apply_filter | 20 | 20 | 91,344 | 24,224 | 73.5% |
| apply_filter | 20 | 50 | 199,362 | 31,562 | 84.2% |

The 3-result, 1-turn rows use the current dummy tool data. Larger rows repeat/scale dummy results and scripted history; they are not production traffic or generated multi-turn conversations. The history fixtures deliberately contain repeated search/filter outputs to measure that specific workload. Do not generalize their percentages to chats with little tool output.

Projection saves about 2-3% on the current short dummy case. It helps much more when full result arrays accumulate. A substantial instruction/tool-schema prefix remains after projection; session optimization does not remove that fixed input.

**This does not prove lower full-turn cost or latency.** Generated output, cache behavior, extra contract retrieval, Summary extraction and the first request after compaction must be included in a live paired evaluation. A model's physical context-window limit is unchanged.

Credit use in this implementation: **30 token-count endpoint requests, zero generated-model requests** (6 initial probes and 24 final fixed-fixture measurements). No full paid long-conversation suite was launched. Token-count requests are separate provider requests; zero generated responses is not an invoice-cost claim.

## Implemented changes

| Area | Implementation and evidence |
| --- | --- |
| Usage | [Model usage collector](../src/shared/observability/model-usage.ts) records agent, effective model, diagnostic sequence, response/request IDs, reported input/output/cache/reasoning details, tool calls, compaction events and timings. Every main-chat run and its separate Summary share a collector. Standalone runner results also expose internal usage. |
| Retries | SDK attempts are observed at the model boundary. The application's default client also records HTTP attempts, including OpenAI-client internal retries. Retry behavior is preserved. Missing failed-attempt usage makes aggregates/cost incomplete; it is never counted as zero. A caller-supplied custom OpenAI client keeps its existing transport; wrap that client's fetch with `observeOpenAIFetch` to obtain HTTP-attempt coverage. An empty transport-attempt list means it was not observed. |
| Cost | [Dated standard-rate token estimator](../src/shared/observability/token-cost.ts) distinguishes input, cached input and output. It does not bill reasoning twice. Unknown models, missing usage, other service tiers and unsupported long-context bands yield unavailable estimates. Hosted-tool fees are excluded; complete invoice cost remains unavailable. |
| Persistence/API | Optional `turns[].usage` is persisted internally, including failure paths. [GET chat projection](../src/api/chat/server.ts) omits it from the existing public response. Old records remain readable. Existing SSE fields and runtime data are preserved. |
| Search/filter output | [Versioned projector](../src/agents/flight/tools/model-output.ts) removes full flight arrays and redundant API payloads only from recognized successful model outputs. Runtime results, option catalogs, API payloads and contract inspection remain intact. Actual search option count is now 3 for the 3-result fixture. |
| Legacy history | [Composed input filter](../src/agents/gateway/history-policy.ts) changes only paired search/filter result bodies on SDK-owned clones. It preserves envelope identity, order, tool arguments, messages, date evidence, errors, unknown data and compaction markers. |
| Compaction | [Dedicated main-chat runner](../src/agents/gateway/runner.ts) and [compatibility policy](../src/shared/config/compaction-policy.ts) preserve Conversations storage and existing settings. All reachable models require live evidence before the runner can enable compaction. The validation list is intentionally empty. Standalone Trip Planner receives no compaction setting. |
| Measurement | [Benchmark](../scripts/benchmark-session-optimization.ts), [provider request capture](../scripts/capture-model-request.ts) and fixed 5/20/50-turn fixtures produce metadata-only JSON/Markdown reports. No paid request is added to the normal application path or `npm test`. |

SDK findings resolved during implementation:

1. Conversations wire tool outputs can omit a tool name. SDK 0.17.0 sets the replayed result name to `callId`; the history policy resolves the authoritative name from the paired function call.
2. Explicit agent models take precedence over runner defaults in this installed SDK. Handoff tests verify GPT-5.5 / GPT-5.2 resolution and settings merges.
3. The Conversations adapter assigns persistence IDs and normalizes metadata itself. Application projection preserves the SDK-owned marker exactly; tests compare replay with the actual stored marker. Encrypted contents survive. The application does not promise that the SDK preserves every original wire field, such as `created_by`.
4. Compaction appends a boundary to the same Conversations store. The SDK replays the latest boundary and suffix; old physical rows can remain stored/fetched. No history-fetch latency reduction is claimed.
5. OpenAI's HTTP client can retry within the first SDK model invocation. Final SDK response totals alone cannot establish complete failed-attempt cost.

## Verification

Deterministic tests cover original/runtime data preservation, source-output modes, idempotence, unknown/error outputs, paired legacy replay without duplicate persistence, model/settings precedence, streaming through two synthetic compaction boundaries, handoffs in both directions, session-wrapper restart, rollback, Summary aggregation, internal HTTP retries, aborted streams, context-limit failures and public usage omission.

Tests: [unit tests](../tests/unit/session-optimization.test.ts), [SDK integration](../tests/integration/session-optimization-sdk.test.ts), [actual tool integration](../tests/integration/session-optimization-tools.test.ts). Existing date, routing, filter, price, suggestion, chat and retry regression suites also remain enabled.

Final verification on 2026-09-09: **272 tests passed, 0 failed** (baseline: 257 tests; 15 new tests). `npm run typecheck`, `npm test`, and `npm run build` all passed. No generated-model API calls were included in those checks.

## Commands

```powershell
# Local deterministic tests: no provider calls
npm run test:session-optimization
npm run typecheck
npm test
npm run build

# Capture complete requests and measure bytes locally: no provider calls
npm run benchmark:session-optimization

# Existing configured key; at most 6 count requests, no generation, no retries
npm run benchmark:session-optimization:count

# Full fixed-fixture counter matrix: at most 24 count requests, no generation
npm run benchmark:session-optimization:count -- --long-count
```

Reports are overwritten under ignored `tests/results/session-optimization/benchmark.json` and `benchmark.md`. The committed table above records this verified run. Any provider error stops further live counting; no automatic retry or model change occurs.

## Configuration and rollout

```dotenv
SESSION_OPTIMIZATION_MODE=observe
SESSION_COMPACTION_ENABLED=false
SESSION_COMPACTION_THRESHOLD_TOKENS=50000
```

No `.env` or credential values were changed. Configuration is validated at startup. Restart the application after changing flags.

- `off`: stop new source/history projections.
- `observe`: compute candidate size differences and keep original model payloads. This is the default while live behavior is unverified.
- `enforce`: apply source and legacy-history projections to controlled evaluation chats. Local and token-count tests pass; deployment-wide enabling still requires the live release gates.
- Compaction requires both the enabled flag and evidence for **every** reachable model/Responses combination in `validatedCompactionModels`. Setting the flag alone currently logs a metadata-only disabled reason. A valid threshold must leave output headroom for every validated model.

Rollback stops future transformations. It does not reconstruct omitted old payloads or reverse previous compaction. Continue replaying existing compaction markers, keep the same conversation ID, and retrieve current full flight details from runtime/contract tools. Do not clear the conversation.

## Remaining work before the complete plan can be closed

1. Run paired real main-chat behavioral evaluations, including date-before-route, roundtrip ranges plus later duration, search/filter in one turn, option references after unrelated turns, corrections, handoffs, Summary failure and restart. Include Summary and all tool continuations in usage/cost.
2. Validate real server-side compaction on every reachable model. Cross two genuine compaction boundaries and exercise both Flight/Trip Planner handoff directions before adding compatibility evidence. Mocked opaque markers establish SDK plumbing, not model memory quality.
3. Run the three-repetition, 5/20/50-turn comparison from the plan with an explicit request/cost cap and sufficient account quota. The implemented 5/20/50-turn fixtures are request-count benchmarks; a paid generation/behavior harness for that full matrix is still to be added. Confirm cost/latency gates before broad `enforce` rollout.
4. Complete the static-prompt rule-equivalence inventory and measure actual prefix-cache reuse. No prompt wording, model, reasoning setting, suggestion tool, Summary frequency or cache-retention control has been changed without that evidence.

These items remain unchecked in the plan. The measured input reduction justifies controlled evaluation of projections; it does not justify silently enabling unverified compaction or asserting a production cost reduction.
