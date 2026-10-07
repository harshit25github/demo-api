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
runner.run(ManagerAgent, input, { context, session })
  Manager --calls tool flight_agent({ input: "<subtask>" })--> FlightManagerAgent (nested run)
  FlightManagerAgent returns structured JSON feedback to the Manager
  Manager writes the traveler reply
result.finalOutput -> Manager's final answer
context.flight -> client flight cards
```

Three things differ from the Gateway:
1. The Manager and its tool registrations are configured **once**, like the old Gateway. Each run supplies its own context and session.
2. Flight returns **JSON feedback**, not the final reply. The Manager always writes the reply.
3. Flight sees **only the subtask the Manager writes plus the shared context**, never the conversation history.

---

## Step 1: SDK version (Manager requirement)

This repo uses `@openai/agents` and `@openai/agents-openai` at `^0.18.0` ([package.json](../package.json)). The Manager depends on APIs that handoff-era code did not use:

- `Agent.asTool({ inputBuilder, customOutputExtractor, runOptions })`
- `new Runner({ toolExecution: { maxFunctionToolConcurrency } })`
- `RunContext.toolInput` on the nested run

If production is on an older version (this repo's handoff-era commit `0892aec` was on `^0.11.6`), upgrade first.

---

## Step 2: Register specialist tools once

| Copy this file | What it does | Depends on |
|---|---|---|
| [manager/specialists/flight.ts](../src/agents/manager/specialists/flight.ts) | `flightAgentAsTool`: direct `FlightManagerAgent.asTool()` registration | Step 3, existing Flight suggestion lifecycle |
| [manager/specialists/trip-planner.ts](../src/agents/manager/specialists/trip-planner.ts) | `tripPlannerAgentAsTool`: direct registration with existing Trip preparation/finalization | existing Trip lifecycle and output policy |
| [manager/tools.ts](../src/agents/manager/tools.ts) | Re-exports the two configured tools | specialist registrations |

**Edits while copying:**
- **[manager-orchestrator/agent.ts](../src/agents/manager-orchestrator/agent.ts):** if production has no real Trip Planner agent, register only `flightAgentAsTool`, and drop the `tripPlannerAgentAsTool` re-export from [manager/tools.ts](../src/agents/manager/tools.ts). The old Policy and Page dummy specialists are **not** registered; the Manager declines those topics through its prompt.
- **[specialists/flight.ts](../src/agents/manager/specialists/flight.ts)**, the `agent_start` hook: keep it only if production has the `update_flight_suggested_questions` tool. Otherwise delete it and the import.
- **`flightAgentConfig.maxTurns`:** add it to your Flight config if it isn't there. This repo uses `Number(process.env.FLIGHT_AGENT_MAX_TURNS || 10)` ([flight/config.ts:88](../src/agents/flight/config.ts#L88)).
  - **Check the production env value.** The Gateway-era default was 4, and this repo's `.env.example` still sets `FLIGHT_AGENT_MAX_TURNS=4`.
  - Inside the Manager, this budget covers only Flight's own nested run, and every tool call plus the final structured output costs one turn. A chain like prediction → search → filter → suggestions → final output needs 5.
  - With a limit of 4, that run stops early and becomes a failed tool call (see [Behavior to know](#behavior-to-know)).

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

The SDK's default output extraction serializes Flight's structured feedback. No application outcome recorder is required. Trip returns its actual sanitized content to the Manager, while its existing lifecycle persists the plan artifact for follow-ups. Neither specialist closes over Manager-specific per-turn state.

---

## Step 4: Replace the Gateway agent with the Manager agent

| Copy | Replaces in production |
|---|---|
| [manager-orchestrator/config.ts](../src/agents/manager-orchestrator/config.ts) (`gatewayAgentConfig`) | Your Gateway config. It has the same shape (`toolChoice: 'auto'`, `parallelToolCalls: false`); you can keep yours and only check the model. |
| [manager-orchestrator/agent.ts](../src/agents/manager-orchestrator/agent.ts) (`ManagerAgent`) | `GatewayAgent = Agent.create({ handoffs })` |

`ManagerAgent` is exported once at module scope. It uses `tools`, not `handoffs`, and its `instructions` is `buildManagerInstructions` from the Manager prompt file. Dynamic instructions still read each run's context; a singleton does not imply shared conversation state.

```ts
export const ManagerAgent = Agent.create({
  name: 'Manager Agent',
  instructions: buildManagerInstructions,
  model: gatewayAgentConfig.model,
  modelSettings: gatewayAgentConfig.modelSettings,
  tools: [flightAgentAsTool, tripPlannerAgentAsTool],
});
```

The SDK does not require a turn-state factory, tool factory, per-request agent rebuild, specialist recorder, render-reference map, or output-composition wrapper. These are removed. No additional turn-failure/recovery infrastructure is introduced.

**Delete from production:**
- `GatewayAgent`
- `gatewayHandoffs` and every `handoff(...)` call
- `recordGatewayHandoff` / `onHandoff`
- the dummy Trip/Policy/Page specialists

---

## Step 5: Replace the Gateway run call

Your existing context build and session stay. Swap the configured agent in the run call.

**Before (typical Gateway call):**

```ts
const result = await runner.run(GatewayAgent, input, { context: requestContext, maxTurns, session });
const output = result.finalOutput;        // written by FlightAgent after the handoff
```

**After.** See [manager-orchestrator/runner.ts](../src/agents/manager-orchestrator/runner.ts).

```ts
// Module level: one Runner. Specialists share one mutable context, so they must run one at a time.
export const mainChatRunner = new Runner({
  toolExecution: { maxFunctionToolConcurrency: 1 },
  workflowName: 'travel-manager',
});

// Per request: keep the existing context and session preparation.
const result = await mainChatRunner.run(ManagerAgent, input, {
  context: requestContext,   // the wrapper, same as before
  maxTurns,
  session,                   // Manager only; Flight never receives it
  signal,
});

const output = String(result.finalOutput ?? '');
```

**Notes:**
- `run(...)` takes the same request-context wrapper as before. There is no additional Manager state object.
- `maxFunctionToolConcurrency: 1` is retained to protect this application's shared mutable specialist state. It is not an SDK prerequisite for `asTool()` or singleton agents.
- This repo still applies `sanitizeNoLinks` / `assertNoLinks` to the Manager's final text. Keep the existing output policy, not a new composition pipeline.

**If production has `update_flight_suggested_questions` (Manager requirement):** copy these three spots too.
- [runner.ts:81](../src/agents/manager-orchestrator/runner.ts#L81) captures the suggestions shown before the turn.
- [runner.ts:87-90](../src/agents/manager-orchestrator/runner.ts#L87-L90) calls `beginFlightSuggestionTurn(appContext, { flightRan: false, previousSuggestions })` before the run.
- [runner.ts:136-140](../src/agents/manager-orchestrator/runner.ts#L136-L140) calls `finalizeFlightSuggestedQuestions(appContext)` in a `finally` after the run.

This is needed because the Manager may answer a turn without calling Flight. A handoff always reached Flight once it was selected.

---

## Step 6: Reading the result at the call site (Manager requirement)

| Gateway era | Manager |
|---|---|
| Final agent was `FlightAgent`, so show cards | Use shared `flightContext.showFlight`, results, and per-contract `display`; final text and agent identity do not control cards |
| `context.gatewaySelections` (from `onHandoff`) | No production specialist tracking; tests/scripts may inspect SDK `result.newItems` |
| Flight wrote the final reply after a handoff | Manager writes the final reply; [streaming.ts](../src/agents/manager-orchestrator/streaming.ts) retains the existing one-chunk compatibility adapter |

The call site is [api/chat/orchestrator.ts](../src/api/chat/orchestrator.ts). It sends final text and shared Flight context without Manager-specific `specialistsUsed` or `renderFlightOptions` fields. Existing optional historical schema fields remain for compatibility but are not newly written.

The dashboard clears old card DOM and renders current shared state at completion. On reload it restores `runtimeContext.flight` and attaches the current visible listing to the latest completed assistant message. It does not inspect response text, agent name, or prior specialist metadata. The Manager emits no special render tags. Trip content passes through the Manager once with its native formatting, rather than being inserted by a finalizer.

---

## Step 7: One small change in existing code (Manager requirement, recommended)

With a handoff, Flight saw the whole user message. As a tool, it gets only the Manager's subtask. The filter tool parses filter wording from the user's text, so on a mixed message ("find flights to Dubai and plan my trip") it should read the subtask:

- Add `getScopedRequestText` ([request-context.ts:46-73](../src/shared/runtime/request-context.ts#L46-L73)) to your request-context file.
- In your filter tool, read `getScopedRequestText(context, appContext.currentUserMessage)` instead of `appContext.currentUserMessage` ([filter/tool.ts:67](../src/agents/flight/tools/filter/tool.ts#L67)).

**Check only, nothing to change if true:** every Flight tool and the Flight `instructions` builder read state through `getRequestState(runContext.context)`, never `runContext.context.flight` directly.

---

## Behavior to know

None of these break anything, and none show up in mocked tests. They are differences from the Gateway that you'll see with a real model.

**1. A failed Flight call reaches the Manager as raw SDK text.**

A failure inside Flight's nested run does not throw out of the Manager run. Examples: Flight hits its own `maxTurns`, a model call times out, or the structured output is invalid. The SDK turns the failure into the tool's result, using its default text: `An error occurred while running the tool. Please try again. Error: <error>`. That has two consequences:
- "Please try again" can lead the Manager to call `flight_agent` again, which repeats the whole Flight run (twice the latency and cost).
- Your application logs nothing; the failure is visible only in SDK traces.

The Manager prompt keeps internal details out of the reply, so this is not a correctness bug.

If you want masking and logging back, attach one output guardrail to the configured tool. It needs no per-turn state, so `ManagerAgent` stays configured once. This compiles against the SDK version in this repo:

```ts
import { defineToolOutputGuardrail, ToolGuardrailFunctionOutputFactory } from '@openai/agents';

flightAgentAsTool.outputGuardrails = [defineToolOutputGuardrail({
  name: 'flight_agent_result',
  async run({ context, output }) {
    try {
      const parsed = JSON.parse(String(output));
      if (typeof parsed?.status === 'string' && typeof parsed?.summary === 'string') {
        return ToolGuardrailFunctionOutputFactory.allow();
      }
    } catch { /* not JSON: a failed nested run */ }
    log('warn', 'manager_agent.flight_result_rejected', {
      requestId: (getRequestState(context.context as object) as { requestId?: string }).requestId,
      rejected: String(output ?? '').slice(0, 300),
    });
    return ToolGuardrailFunctionOutputFactory.rejectContent(
      "I couldn't finish that part of your request right now.",
    );
  },
})];
```

**2. Cards follow shared state, not the turn.**

The client draws cards from `flight.showFlight`, the search results, and each option's `display` flag after every reply. That includes a turn the Manager answered without Flight. If your production UI decides card display per reply, switch it to read that state ([public/chat-dashboard/flightContracts.js:47-51](../public/chat-dashboard/flightContracts.js#L47-L51)).

**3. The Trip plan goes through the Manager's reply (only if you ship Trip Planner).**

Trip returns its full plan text, and the Manager must copy it into its answer. The Manager runs on `gpt-5.4-mini` with `verbosity: 'low'` ([manager-orchestrator/config.ts](../src/agents/manager-orchestrator/config.ts)), so check a live Trip conversation to confirm long itineraries and the `:::cards` block arrive intact.

---

## Prompts to move

Move these separately; this guide does not copy them.

| Prompt | Location |
|---|---|
| Manager, static | [manager-prompt.ts](../src/agents/manager-orchestrator/manager-prompt.ts), `MANAGER_PROMPT` |
| Manager, dynamic state block and subtask-scope rules | [manager-prompt.ts](../src/agents/manager-orchestrator/manager-prompt.ts), `buildManagerInstructions`. This function **is** the Manager's `instructions`; move it whole |
| Flight, Manager-mode addendum | [manager-output.ts](../src/agents/flight/manager-output.ts), `FLIGHT_MANAGER_INSTRUCTIONS` |
| Flight tool description (routing text the Manager reads) | [specialists/flight.ts](../src/agents/manager/specialists/flight.ts), `FLIGHT_TOOL_DESCRIPTION` |
| Flight base and dynamic prompt | existing [prompt.ts](../src/agents/flight/prompt.ts) and [agent.ts](../src/agents/flight/agent.ts), unchanged by this architecture simplification |

Notes on these prompts:
- `MANAGER_PROMPT` names `trip_planner_agent` and offers trip planning elsewhere. If you register only Flight, remove those references when you move the prompt.
- Rule 6 tells the Manager to include the Trip plan once in its own formatting. [manager-prompt.ts:85](../src/agents/manager-orchestrator/manager-prompt.ts#L85) still says "do not … repeat a large rendered itinerary", which the model could read as "leave it out". Reword one of them when you move the prompt.
- The old Gateway prompt in [manager-prompt.ts](../src/agents/manager-orchestrator/manager-prompt.ts) is kept for reference only. Don't move it.

---

## Not part of this migration

- Context hydration and persistence ([api/chat/context-hydration.ts](../src/api/chat/context-hydration.ts)), the Summary extractor, and the chat store: unchanged.
- [flight/runner.ts](../src/agents/flight/runner.ts) and [history-policy.ts](../src/agents/manager-orchestrator/history-policy.ts): standalone Flight path only.
- [output-guardrail.ts](../src/agents/manager-orchestrator/output-guardrail.ts): used only by Trip Planner.
- Trip Planner ([specialists/trip-planner.ts](../src/agents/manager/specialists/trip-planner.ts)): only if production has a real Trip Planner agent. It brings its own lifecycle dependencies.

---

## Verify

1. Typecheck the production build.
2. Run four smoke turns and inspect SDK calls plus shared context:

| Message | Expect |
|---|---|
| "Flights from Delhi to Dubai on Oct 20" | SDK `flight_agent` call; shared Flight results and `showFlight: true`; no render tag |
| "Show nonstop only" (next turn) | Flight runs the filter; cards render; no new search |
| "What's your refund policy?" | No tool call; the Manager declines |
| "Find flights to Dubai and plan my trip" | The filter and search see only the flight part of the request |

3. Run `npm run test:chat-api` and the deterministic client contract tests. Confirm sessions persist, SSE carries Flight context without Manager tracking fields, and current flags/results control card visibility. These checks do not require paid model calls.

4. Optional: port [tests/integration/sdk-agent-tool-contract.test.ts](../tests/integration/sdk-agent-tool-contract.test.ts) to pin the installed SDK's nested agent-tool behavior. Do not infer that a custom error-masking wrapper is required by the SDK.
