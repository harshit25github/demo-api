# Manager tools

How the Manager Agent calls specialist agents, and why there is one wrapper instead of none.

## Shape

The OpenAI Agents SDK's canonical "agents as tools" pattern is:

```ts
const specialistTool = specialist.asTool({ toolName, toolDescription });
const manager = new Agent({ tools: [specialistTool] });
```

We keep that shape — `asTool()` handles are built **once at module scope** and specialists are declared as data — but each one is wrapped by a single generic adapter, `createSpecialistTool`.

```
src/agents/manager/
  tools.ts               composition root + barrel (createManagerTools)
  specialist-tool.ts     THE adapter: SpecialistDefinition, readNestedOutcome
  turn-state.ts          ManagerTurnState, createManagerTurnState, recordOutcome
  output.ts              finalizeManagerOutput, buildManagerPartialFallback
  result-contract.ts     ManagerToolResult
  specialists/
    flight.ts            flightNested (asTool) + flightSpecialist + flightResult
    trip-planner.ts      tripNested (asTool) + tripPlannerSpecialist + tripPlannerResult
```

`createManagerTools(state)` is now just:

```ts
return [
  createSpecialistTool(state, flightSpecialist),
  createSpecialistTool(state, tripPlannerSpecialist),
];
```

## Why the wrapper exists

A raw `asTool()` handle dropped straight into the `tools` array was prototyped and measured live. Routing was correct 5/5 and context sharing worked — so the wrapper is **not** needed for routing, context propagation, or retry (retry comes from `runConfig.modelSettings.retry`, which plain `asTool()` supports).

It lost eight things that consumers depend on:

| Lost without the wrapper | Who needs it |
|---|---|
| `renderRef` / `[[render:ref]]` | keeps a 2000-word itinerary out of the Manager's context |
| `state.outcomes` | `specialistsUsed`, sent on the SSE `done` event |
| `renderFlightOptions` | the dashboard gates flight cards on it |
| the per-person price note | appended deterministically, not left to the model |
| `prepareTripPlannerTurn` / `finalizeTripPlannerTurn` | the "revise my plan" path needs `lastPlanArtifact` |
| `currentUserMessage` scope narrow | `apply_filter` parses filter intent from it |
| trip-planner link / scope sanitization | `assertNoLinks` |
| failure → contract mapping | see below |

Lifecycle hooks (`agent_tool_start` / `agent_tool_end`) were evaluated as a replacement and rejected: a throw inside `agent_tool_start` propagates as `hookError` and kills the whole run rather than degrading to one tool failure; the sibling-cancellation path returns *before* `emitFunctionToolEnd`, so a restore is not guaranteed; and hook return values are ignored, so they cannot shape what the model sees.

## SpecialistDefinition

```ts
interface SpecialistDefinition<TPending> {
  name: SpecialistName;
  description: string;
  nested: NestedSpecialist;        // module-level asTool() handle
  timeoutMs?: number;              // per-call; NEVER in runOptions (see below)
  scopeUserMessage?: boolean;      // narrow appContext.currentUserMessage
  capture(state, input): TPending; // watermarks, before anything runs
  before?(state, input, pending);  // side effects, inside the try
  after?(state, pending);          // cleanup, always runs
  toResult(state, input, outcome, pending): ManagerToolResult;
}
```

`customOutputExtractor` stays pure — `(result) => JSON.stringify(result.finalOutput ?? null)` — so all mapping happens in `toResult`, where success and failure land in the same place and the watermark closure is natural.

### The watermarks

`capture()` snapshots what `toResult` cannot recover afterwards:

- `logStart` — `toolCallLog.length`. The log is shared for the whole turn, so without this watermark `flightResult` could not tell which entries belong to *this* invocation.
- `priorSearchKey` — feeds the price-prediction guardrail and the `stateChanged` check that gates retryability.
- `priorPricePrediction` — compared by **identity**, so a stale success from an earlier turn is not mistaken for a fresh one.

### Timeouts

A specialist timeout goes in `definition.timeoutMs`, never in `runOptions`. A module-scope `AbortSignal.timeout(...)` starts counting **at import**, so it would abort every run once the process had been up that long. `createSpecialistTool` derives a fresh signal per call and combines it with the outer tool-call signal via `AbortSignal.any`.

The clone that carries the new signal uses property **descriptors**, not a spread: the SDK attaches the parent run config and the parent trace span to `details` as non-enumerable symbols, and a spread would silently drop both.

## Failure handling

`Agent.asTool()` accepts no `errorFunction`, so the SDK always installs `defaultToolErrorFunction`. That default **swallows the exception and returns a string**:

```
An error occurred while running the tool. Please try again. Error: <err.toString()>
```

So `nested.invoke()` resolves on failure rather than throwing. `readNestedOutcome` sniffs that prefix and recovers the real error name:

```ts
readNestedOutcome(raw)
// -> { ok: true, output }                               normal result
// -> { ok: false, code: 'MAX_TURNS', retryable: false } MaxTurnsExceededError
// -> { ok: false, code: 'ModelTimeoutError', retryable: true }
```

The sentinel is pinned by a test in `tests/integration/manager-agent-tools.test.ts`, so an SDK wording change fails loudly instead of silently rotting the recovery codes.

The SDK's "Please try again" string is consumed inside the adapter and never reaches the Manager model — it carries no contract fields and would push the model to retry work the `retryable` flag says not to.

On the flight path a failure is not automatically a failure for the user: `latestSuccessfulFlightCoreTool(appContext, logStart)` checks whether a core tool (`flight_search`, `apply_filter`, `getGeneratedContractsContext`) already landed, and if so reports `status: 'partial'` with the results and presentation intact.

## Out of scope topics

Only implemented specialists are registered. Policy and booking-page topics (seats, a selected booking's refund/baggage/fare benefits, general airline or CheapOair policy, page workflow) have **no tool**. The Manager declines them per the "Out of scope — decline, never answer from memory" section of `MANAGER_PROMPT`, which forbids stating, estimating or giving examples of any policy, fee, allowance, limit, rule or eligibility — with or without a hedge.

Filters on flight results (baggage-included, airline, stops, time, price, duration, layover) and starting or changing a search on any page remain `flight_agent` work.

This boundary has no downstream guardrail — an invented policy claim cannot be regex-detected in free text — so it is covered by `tests/live/manager-routing-live.ts`, which scores the 11 declining cases for fabricated figures (weights, currency amounts, piece allowances, dimensions, percentages, free-cancellation claims).

## Load-bearing invariants

- **`runConfig.modelProvider` must stay set** on both nested `asTool()` calls. `getInheritedAgentToolRunConfig` gates both `inheritedRunConfig.model` and `inheritedRunConfig.modelSettings` on `!overridesModelProvider`; drop it and the specialist silently inherits the Manager's model and reasoning effort instead of its own.
- **`parallelToolCalls: false`** (`src/agents/manager-orchestrator/config.ts`) is required: the `currentUserMessage` swap and its `finally` restore would race under parallel tool calls.
- **Every exit path goes through `recordOutcome`**, so if a specialist ran at all there is an entry in `state.outcomes` for the output pipeline and the max-turns fallback to build from.
