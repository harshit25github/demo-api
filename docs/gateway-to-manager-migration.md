# Gateway → Manager migration (agent swap only)

This guide replaces the production Gateway agent (handoffs) with the Manager agent (specialists as tools). It touches nothing else.

**Assumed already in production, and left alone:**
- context hydration and persistence
- the request-context wrapper (`createRequestContext` / `getRequestState`)
- the Flight agent and its domain tools
- the chat entry point

Context or wiring is changed only where the Manager itself requires it. Those places are marked **Manager requirement**.

Prompts are not copied here. See [Prompts to move](#prompts-to-move).

---

## What changes

**Before: Gateway with handoffs**

```text
runner.run(GatewayAgent, input, { context })
  GatewayAgent --handoff--> FlightAgent
  FlightAgent takes over and writes the traveler reply
```

**After: Manager with agents as tools**

```text
turn = createManagerTurnState(appContext, requestId)
runner.run(createManagerAgent(createManagerTools(turn)), input, { context })
  Manager --calls tool flight_agent({ input: "<subtask>" })--> FlightManagerAgent (nested run)
  FlightManagerAgent returns structured JSON feedback to the Manager
  Manager writes the traveler reply
finalizeManagerOutput(finalOutput, turn) -> { output, specialistsUsed, renderFlightOptions }
```

Three things differ from the Gateway:
1. The Manager is built **per turn**, because its tools hold that turn's outcomes.
2. Flight returns **JSON feedback**, not the final reply. The Manager always writes the reply.
3. Flight sees **only the subtask the Manager writes plus the shared context**, never the conversation history.

---

## Step 1: SDK version (Manager requirement)

This repo uses `@openai/agents` and `@openai/agents-openai` at `^0.18.0` ([package.json](../package.json)). The Manager depends on APIs that handoff-era code did not use:

- `Agent.asTool({ inputBuilder, customOutputExtractor, runOptions })`
- tool `outputGuardrails` (`defineToolOutputGuardrail`, `ToolGuardrailFunctionOutputFactory`)
- `new Runner({ toolExecution: { maxFunctionToolConcurrency } })`
- `RunContext.toolInput` on the nested run

If production is on an older version (this repo's handoff-era commit `0892aec` was on `^0.11.6`), upgrade first.

---

## Step 2: Copy the Manager tool layer (new files, copy as-is)

| Copy this file | What it does | Depends on |
|---|---|---|
| [manager/result-contract.ts](../src/agents/manager/result-contract.ts) | `ManagerToolResult`, the shape every specialist returns to the Manager | — |
| [manager/turn-state.ts](../src/agents/manager/turn-state.ts) | `createManagerTurnState`, `recordOutcome`: per-turn record of specialist outcomes | `FlightAppContext` type |
| [manager/specialist-result.ts](../src/agents/manager/specialist-result.ts) | Subtask input schema, the generic failure line, and the guardrail that masks and records a failed specialist call | your logger (`log`) |
| [manager/output.ts](../src/agents/manager/output.ts) | `finalizeManagerOutput`: composes the final text and computes `specialistsUsed` and `renderFlightOptions` | — |
| [manager/specialists/flight.ts](../src/agents/manager/specialists/flight.ts) | `createFlightTool`: registers Flight with `FlightManagerAgent.asTool()` as tool `flight_agent` | Step 3, `flightAgentConfig.maxTurns` |
| [manager/tools.ts](../src/agents/manager/tools.ts) | `createManagerTools(state)`: the Manager's tool list | the files above |

**Edits while copying:**
- **[manager/tools.ts](../src/agents/manager/tools.ts):** if production has no real Trip Planner agent, register only `createFlightTool(state)`. Remove the `trip-planner` import and re-export too. The old Policy and Page dummy specialists are **not** registered; the Manager declines those topics through its prompt.
- **[specialists/flight.ts:4](../src/agents/manager/specialists/flight.ts#L4) and [:16-23](../src/agents/manager/specialists/flight.ts#L16-L23)**, the `agent_start` hook: keep it only if production has the `update_flight_suggested_questions` tool. Otherwise delete it and the import.
- **`flightAgentConfig.maxTurns`:** add it to your Flight config if it isn't there. This repo uses `Number(process.env.FLIGHT_AGENT_MAX_TURNS || 10)` ([flight/config.ts:88](../src/agents/flight/config.ts#L88)).

---

## Step 3: Add `FlightManagerAgent` next to your Flight agent (Manager requirement)

Your existing `FlightAgent` stays as it is. Add a second agent that shares its definition but returns structured feedback.

**3a. Output schema.** Copy [flight/manager-output.ts:19-30](../src/agents/flight/manager-output.ts#L19-L30) (`flightManagerOutputSchema`) into your Flight module. Lines 32-61 of that file are the Manager-mode prompt; move them with the prompts.

**3b. The agent.** This is the pattern from [flight/agent.ts:268-285](../src/agents/flight/agent.ts#L268-L285). Pull your current Flight `Agent` options into a shared object, then build both agents from it:

```ts
const flightAgentDefinition = {
  name: 'FlightAgent',
  instructions: (runContext: RunContext<unknown>) => buildFlightAgentInstructions(runContext),
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: flightTools,                       // your production domain tools, unchanged
};

export const FlightAgent = new Agent(flightAgentDefinition);   // standalone, unchanged

export const FlightManagerAgent = new Agent({
  ...flightAgentDefinition,
  instructions: (runContext: RunContext<unknown>) =>
    `${buildFlightAgentInstructions(runContext)}\n\n${FLIGHT_MANAGER_INSTRUCTIONS}`,
  outputType: flightManagerOutputSchema,
});
```

`FlightManagerAgent` is what [specialists/flight.ts](../src/agents/manager/specialists/flight.ts) imports.

---

## Step 4: Replace the Gateway agent with the Manager agent

| Copy | Replaces in production |
|---|---|
| [manager-orchestrator/config.ts](../src/agents/manager-orchestrator/config.ts) (`gatewayAgentConfig`) | Your Gateway config. It has the same shape (`toolChoice: 'auto'`, `parallelToolCalls: false`); you can keep yours and only check the model. |
| [manager-orchestrator/agent.ts](../src/agents/manager-orchestrator/agent.ts) (`createManagerAgent(tools)`) | `GatewayAgent = Agent.create({ handoffs })` |

`createManagerAgent` is a **factory, called once per turn**. It uses `tools`, not `handoffs`, and its `instructions` is `buildManagerInstructions` from the Manager prompt file.

**Delete from production:**
- `GatewayAgent`
- `gatewayHandoffs` and every `handoff(...)` call
- `recordGatewayHandoff` / `onHandoff`
- the dummy Trip/Policy/Page specialists

---

## Step 5: Replace the Gateway run call

Your existing context build stays. Only the agent and the post-processing change.

**Before (typical Gateway call):**

```ts
const result = await runner.run(GatewayAgent, input, { context: requestContext, maxTurns, session });
const output = result.finalOutput;        // written by FlightAgent after the handoff
```

**After.** This is from [manager-orchestrator/runner.ts](../src/agents/manager-orchestrator/runner.ts): lines [62-66](../src/agents/manager-orchestrator/runner.ts#L62-L66) build the runner, [175-191](../src/agents/manager-orchestrator/runner.ts#L175-L191) run the turn, and [85](../src/agents/manager-orchestrator/runner.ts#L85) finalizes the output.

```ts
// Module level: one Runner. Specialists share one mutable context, so they must run one at a time.
export const mainChatRunner = new Runner({
  toolExecution: { maxFunctionToolConcurrency: 1 },
  workflowName: 'travel-manager',
});

// Per turn. appContext and requestContext are what you already build for the Gateway.
const managerTurn = createManagerTurnState(appContext, requestId);   // raw state, NOT the wrapper
const managerAgent = createManagerAgent(createManagerTools(managerTurn));

const result = await mainChatRunner.run(managerAgent, input, {
  context: requestContext,   // the wrapper, same as before
  maxTurns,
  session,                   // Manager only; Flight never receives it
  signal,
});

const { output, specialistsUsed, renderFlightOptions } =
  finalizeManagerOutput(String(result.finalOutput || ''), managerTurn);
```

**Notes:**
- `createManagerTurnState` takes the **raw** app state, because `finalizeManagerOutput` reads `appContext.flight`. `run(...)` takes the **wrapper**.
- `maxFunctionToolConcurrency: 1` is **required**, not a tuning knob.
- This repo also runs `sanitizeNoLinks` / `assertNoLinks` on `output` ([runner.ts:86-87](../src/agents/manager-orchestrator/runner.ts#L86-L87)). Keep whatever link handling production already applies to the Gateway output.

**If production has `update_flight_suggested_questions` (Manager requirement):** copy these three spots too.
- [runner.ts:120](../src/agents/manager-orchestrator/runner.ts#L120) captures the suggestions shown before the turn.
- [runner.ts:126-129](../src/agents/manager-orchestrator/runner.ts#L126-L129) calls `beginFlightSuggestionTurn(appContext, { flightRan: false, previousSuggestions })` before the run.
- [runner.ts:192-196](../src/agents/manager-orchestrator/runner.ts#L192-L196) calls `finalizeFlightSuggestedQuestions(appContext)` in a `finally` after the run.

This is needed because the Manager may answer a turn without calling Flight. A handoff always reached Flight once it was selected.

---

## Step 6: Reading the result at the call site (Manager requirement)

| Gateway era | Manager |
|---|---|
| Final agent was `FlightAgent`, so show cards | `finalAgentName` is always `'Manager Agent'`. Show cards when **`renderFlightOptions`** is true |
| `context.gatewaySelections` (from `onHandoff`) | **`specialistsUsed`** (for example `['flight_agent']`) |
| Flight's reply streamed token by token | The reply is composed **after** the run, so emit it as one chunk. [streaming.ts](../src/agents/manager-orchestrator/streaming.ts) is a one-chunk adapter if callers expect a stream |

The call-site reference is [api/chat/orchestrator.ts:151-169](../src/api/chat/orchestrator.ts#L151-L169).

---

## Step 7: One small change in existing code (Manager requirement, recommended)

With a handoff, Flight saw the whole user message. As a tool, it gets only the Manager's subtask. The filter tool parses filter wording from the user's text, so on a mixed message ("find flights to Dubai and plan my trip") it should read the subtask:

- Add `getScopedRequestText` ([request-context.ts:46-73](../src/shared/runtime/request-context.ts#L46-L73)) to your request-context file.
- In your filter tool, read `getScopedRequestText(context, appContext.currentUserMessage)` instead of `appContext.currentUserMessage` ([filter/tool.ts:67](../src/agents/flight/tools/filter/tool.ts#L67)).

**Check only, nothing to change if true:** every Flight tool and the Flight `instructions` builder read state through `getRequestState(runContext.context)`, never `runContext.context.flight` directly.

---

## Prompts to move

Move these separately; this guide does not copy them.

| Prompt | Location |
|---|---|
| Manager, static | [manager-prompt.ts:11-83](../src/agents/manager-orchestrator/manager-prompt.ts#L11-L83) `MANAGER_PROMPT` |
| Manager, dynamic state block and subtask-scope rules | [manager-prompt.ts:85-121](../src/agents/manager-orchestrator/manager-prompt.ts#L85-L121) `buildManagerInstructions`. This function **is** the Manager's `instructions`; move it whole |
| Flight, Manager-mode addendum | [manager-output.ts:32-61](../src/agents/flight/manager-output.ts#L32-L61) `FLIGHT_MANAGER_INSTRUCTIONS` |
| Flight tool description (routing text the Manager reads) | [specialists/flight.ts:13-14](../src/agents/manager/specialists/flight.ts#L13-L14) `FLIGHT_TOOL_DESCRIPTION` |
| Flight base and dynamic prompt | already in production; this repo's versions are [prompt.ts](../src/agents/flight/prompt.ts) and [agent.ts:203-266](../src/agents/flight/agent.ts#L203-L266) |

Two notes on these prompts:
- `MANAGER_PROMPT` names `trip_planner_agent` (line 17) and offers trip planning elsewhere. If you register only Flight, remove those references when you move the prompt.
- [manager-prompt.ts:124+](../src/agents/manager-orchestrator/manager-prompt.ts#L124) is the old Gateway prompt, kept for reference only. Don't move it.

---

## Not part of this migration

- Context hydration and persistence ([api/chat/context-hydration.ts](../src/api/chat/context-hydration.ts)), the Summary extractor, and the chat store: unchanged.
- [flight/runner.ts](../src/agents/flight/runner.ts) and [history-policy.ts](../src/agents/manager-orchestrator/history-policy.ts): standalone Flight path only.
- [output-guardrail.ts](../src/agents/manager-orchestrator/output-guardrail.ts): used only by Trip Planner.
- Trip Planner ([specialists/trip-planner.ts](../src/agents/manager/specialists/trip-planner.ts)): only if production has a real Trip Planner agent. It brings its own lifecycle dependencies.

---

## Verify

1. Typecheck the production build.
2. Run four smoke turns and check the result fields:

| Message | Expect |
|---|---|
| "Flights from Delhi to Dubai on Oct 20" | `specialistsUsed: ['flight_agent']`, `renderFlightOptions: true` |
| "Show nonstop only" (next turn) | Flight runs the filter; cards render; no new search |
| "What's your refund policy?" | No tool call; the Manager declines |
| "Find flights to Dubai and plan my trip" | The filter and search see only the flight part of the request |

3. Optional: port [tests/integration/sdk-agent-tool-contract.test.ts](../tests/integration/sdk-agent-tool-contract.test.ts). It pins how a failed Flight call reaches the Manager as one masked result.
