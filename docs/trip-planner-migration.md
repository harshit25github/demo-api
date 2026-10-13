# Trip Planner → Manager migration

This guide adds the Trip Planner to the Manager as the `trip_planner_agent` tool. It is the companion to [Gateway → Manager migration](gateway-to-manager-migration.md). Do that one first.

**Assumed already done:**
- The Manager runs with `flightAgentAsTool`, using the request-context wrapper (`createRequestContext` / `getRequestState` / `getScopedRequestText`) and the request clock.
- `@openai/agents` and `@openai/agents-openai` are at `^0.18.0` or newer ([package.json](../package.json)).
- Chat persistence stores `runtimeContext` between turns.

Prompts are not copied here. See [Prompts to move](#prompts-to-move).

---

## What changes

```text
runner.run(ManagerAgent, input, { context, session })
  Manager --trip_planner_agent({ input: "<Trip subtask>" })--> TripPlannerManagerAgent (nested run)
    agent_start hook        -> prepareTripPlannerTurn()
    tools, unlocked in order by isEnabled:
      1. update_trip_planner_context              (always first)
      2. get_place_images_batch | web_search | get_trip_planner_context_details
      3. update_trip_planner_suggested_questions  (always last)
    customOutputExtractor   -> sanitizeTripPlannerManagerOutput()
                            -> finalizeTripPlannerTurn()
                            -> JSON feedback to the Manager
  Manager renders cards and days as markdown and writes the reply
```

Four things to understand before you copy anything:
1. **Trip does not write the reply in Manager mode.** It returns typed planning facts: cards, days, notes, tables and question intents. The Manager turns them into markdown. Standalone Trip still returns text.
2. **The application owns the formatting rules.** The model writes only facts (`tripPlannerFeedbackSchema`). The extractor then attaches `formattingRules` for the current phase. Content from web search cannot change them.
3. **Tool order is enforced in code, not only in the prompt.** Each tool's `isEnabled` reads the per-turn state, so planning tools stay hidden until context is captured.
4. **Trip sees only the Manager's subtask plus shared state**, never the conversation history.

---

## Step 1: Copy the Trip Planner module

Copy [src/agents/trip-planner/](../src/agents/trip-planner/) as a folder.

| File | What it does |
|---|---|
| [agent.ts](../src/agents/trip-planner/agent.ts) | `TripPlannerManagerAgent` and the per-turn dynamic prompt (`buildTripPlannerDynamicContext`) |
| [config.ts](../src/agents/trip-planner/config.ts) | Model `gpt-5.2`, `maxTurns`, reasoning and verbosity |
| [prompt.ts](../src/agents/trip-planner/prompt.ts) | Base Trip prompt |
| [manager-output.ts](../src/agents/trip-planner/manager-output.ts) | Feedback schemas, `TRIP_PHASE_RULES`, `getTripPlannerFormattingRules`, `TRIP_PLANNER_MANAGER_INSTRUCTIONS` |
| [scope-policy.ts](../src/agents/trip-planner/scope-policy.ts) | Scope classification, suggestion validation, `sanitizeTripPlannerManagerOutput`, `tripPlannerFailureFeedback` |
| [context/lifecycle.ts](../src/agents/trip-planner/context/lifecycle.ts) | `prepareTripPlannerTurn`, context and suggestion updates, `finalizeTripPlannerTurn` |
| [context/store.ts](../src/agents/trip-planner/context/store.ts) | Revisions, stale-data invalidation, last plan artifact, session lock |
| [context/planning-brief.ts](../src/agents/trip-planner/context/planning-brief.ts) | Phase, render mode, tool strategy, question intents |
| [context/serializer.ts](../src/agents/trip-planner/context/serializer.ts), [context/summary-context.ts](../src/agents/trip-planner/context/summary-context.ts) | Compact prompt context and the `summaryContext` shape |
| [tools/](../src/agents/trip-planner/tools/) | The five tools and `recordToolCall` |

**Shared modules the folder imports:**

| Module | Used by |
|---|---|
| `shared/runtime/request-context.ts` | agent, tools, specialist registration |
| `shared/text/link-sanitizer.ts` | `scope-policy.ts` |
| `shared/travel/city-codes.ts` | `planning-brief.ts` |
| `shared/logging/logger.ts` | tools, specialist registration |

`runner.ts` and `session.ts` are the standalone Trip path. Manager mode does not import them. Skip them unless you also run Trip standalone. They pull in `flight/config.ts`, `shared/observability/model-usage.ts` and `shared/time/request-clock.ts`.

**Edits while copying:**
- **`get_place_images_batch`** ([tools/image-tool.ts](../src/agents/trip-planner/tools/image-tool.ts)) returns hardcoded dummy URLs. Connect it to your image provider. Keep the `placeImageCache` write: the extractor rejects any card whose `imageUrl` differs from the cached asset for its `itemCode`.
- **`withTripPlannerSessionLock`** ([context/store.ts:348](../src/agents/trip-planner/context/store.ts#L348)) is an in-memory `Map`. If production runs more than one instance and the same chat can reach two of them at once, replace it with a shared lock.
- **`web_search`** is the SDK's hosted `webSearchTool`, so the Trip model must run on the Responses API.

---

## Step 2: Keep the Manager variant of the agent

Both agents are defined in [agent.ts:63-80](../src/agents/trip-planner/agent.ts#L63-L80). Manager mode needs only `TripPlannerManagerAgent`:

```ts
export const TripPlannerManagerAgent = new Agent({
  ...tripPlannerAgentDefinition,
  instructions: (runContext) =>
    `${TRIP_PLANNER}\n\n${buildTripPlannerDynamicContext(runContext)}\n\n${TRIP_PLANNER_MANAGER_INSTRUCTIONS}`,
  outputType: tripPlannerFeedbackSchema,
});
```

- `instructions` must stay a function. It is rebuilt on every model call, and `turn_plan` changes after context capture succeeds.
- `outputType` is the facts-only schema. Do not use `tripPlannerManagerOutputSchema` here. That schema includes `formattingRules`, which the application adds after the model answers.
- Leave `timeoutMs` and `retry` out of the Trip `modelSettings`. Agent settings override the Runner's model-call deadline policy.

---

## Step 3: Keep the tool gating

These checks make tool order deterministic. Copy them unchanged.

| Tool | Enabled when |
|---|---|
| `update_trip_planner_context` | context not yet captured this turn, fewer than 2 attempts |
| `get_place_images_batch` | context captured, scope not `excluded`, `toolStrategy.images.action` is `call` or `call_after_selecting_suggestions` |
| `get_trip_planner_context_details` | context captured, scope not `excluded`, `toolStrategy.contextDetails.action` is `call` or `agent_decides` |
| `web_search` | always available; Trip decides when it needs current facts |
| `update_trip_planner_suggested_questions` | context captured, suggestions not yet stored, fewer than 2 attempts |

The two update tools also check `baseRevision`, which returns `REVISION_CONFLICT` on a mismatch. They are idempotent per `requestId` and return `ALREADY_UPDATED` on a repeat.

---

## Step 4: Register the tool

Copy [manager/specialists/trip-planner.ts](../src/agents/manager/specialists/trip-planner.ts). It has three parts.

**a) The `agent_start` hook prepares the turn.**

```ts
TripPlannerManagerAgent.on('agent_start', (runContext) => {
  if (!runContext.toolInput) return;          // standalone runs prepare themselves
  const context = getRequestState(runContext.context);
  prepareTripPlannerTurn({
    context,
    input: getScopedRequestText(runContext, context.currentUserMessage),
    requestId: context.requestId,
    sessionId: context.sessionId,
  });
});
```

`getScopedRequestText` reads the Manager's subtask, so on "find flights to Dubai and plan my trip" Trip sees only the Trip part. Do not also call `prepareTripPlannerTurn` from your own code; a second call resets the turn state.

**b) `asTool` passes the subtask and Trip's own turn budget.**

```ts
export const tripPlannerAgentAsTool = TripPlannerManagerAgent.asTool({
  toolName: 'trip_planner_agent',
  toolDescription: TRIP_PLANNER_TOOL_DESCRIPTION,
  inputBuilder: ({ params }) => params.input,
  runOptions: { maxTurns: tripPlannerAgentConfig.maxTurns },
  customOutputExtractor: /* c) */,
});
```

`maxTurns` defaults to 8 (`TRIP_PLANNER_MAX_TURNS`). A discovery turn takes context, then images, then suggestions, then the final output, which is already 4. Research and a suggestion retry add more, so don't set it below 8.

**c) `customOutputExtractor` guards the output, finalizes the turn and returns JSON.**

```ts
customOutputExtractor: (result) => {
  const context = getRequestState(result.runContext.context);
  let guarded;
  try {
    guarded = sanitizeTripPlannerManagerOutput(result.finalOutput, context, result.newItems);
  } catch (error) {
    log('warn', 'trip_planner.feedback_rejected', { requestId: context.requestId, reason: String(error) });
    guarded = { output: tripPlannerFailureFeedback(context), storePlanArtifact: false };
  }
  finalizeTripPlannerTurn({
    context, feedback: guarded.output,
    responseMode: guarded.output.mode, storePlanArtifact: guarded.storePlanArtifact,
  });
  return JSON.stringify(guarded.output);
},
```

What `sanitizeTripPlannerManagerOutput` checks:
- It scope-checks and link-strips **each text field separately**. Stripping links from the whole JSON would delete the card image URLs.
- Each card's `imageUrl` must match the cached asset for its `itemCode`.
- `mode` must match the phase's render mode, and the day count, patch scope, tables and question intents must follow the current rules.
- A `fact` note with a `sourceName` needs a completed `web_search` call in this run (`result.newItems`). Otherwise the note is dropped and a limitation is added.
- Missing required work downgrades `success` to `partial` and is reported as a `limitation`.

Never let the extractor throw. If it does, the SDK sends the Manager "An error occurred while running the tool. Please try again." The Manager then tends to call Trip again. The typed failure feedback avoids that.

`finalizeTripPlannerTurn` clears suggestions that were not updated this turn, records the asked question keys, and stores `lastPlanArtifact` only for useful, in-scope results. A full plan replaces the artifact. A same-destination patch merges only the supplied days and non-null time blocks.

---

## Step 5: Add the tool to the Manager

In [manager-orchestrator/agent.ts](../src/agents/manager-orchestrator/agent.ts):

```ts
tools: [flightAgentAsTool, tripPlannerAgentAsTool],
```

Check the Runner in [runner.ts:50-56](../src/agents/manager-orchestrator/runner.ts#L50-L56). You need **both** of these settings:
- `toolExecution: { maxFunctionToolConcurrency: 1 }` on the Runner
- `parallelToolCalls: false` in the Manager's `modelSettings`

Trip keeps its whole turn in the shared request context. Two specialists running at the same time would interleave that state.

---

## Step 6: Initialize Trip state for each turn

Add this to the code that builds the Manager's context (`buildGatewayContext`, [runner.ts:58-90](../src/agents/manager-orchestrator/runner.ts#L58-L90)), before `createRequestContext`:

```ts
appContext.tripPlanner =
  appContext.tripPlanner && typeof appContext.tripPlanner === 'object' ? appContext.tripPlanner : {};
appContext.tripPlanner.currentUserMessage = String(input || '');
```

`requestId` and `sessionId` must also be on the state. The idempotency checks and the session lock use them.

---

## Step 7: Persist Trip state between turns

Follow [context-hydration.ts:128-170](../src/api/chat/context-hydration.ts#L128-L170):

- **Hydrate:** restore `summaryContext` and `tripPlanner` from the saved runtime context. Only for older chats without a runtime snapshot, seed `summaryContext` from the legacy summary (`tripPlannerSummary`).
- **Snapshot:** save `summaryContext` and `tripPlanner`, but leave out the per-turn fields `currentUserMessage`, `turnState` and `planningBrief` (`durableTripPlannerState`). `prepareTripPlannerTurn` rebuilds them on every Trip call. Saved copies are stale and only make the stored record bigger.

Durable fields that follow-ups depend on:

| Field | Needed for |
|---|---|
| `summaryContext` (destination, dates, `duration_days`, `pax`, budget, `tripType`) | Not asking again for known facts |
| `summaryContext.suggestedQuestions` | Suggestion chips |
| `tripPlanner.contextRevision` | `baseRevision` checks |
| `tripPlanner.lastPlanArtifact` | "Change day 2" patches and `get_trip_planner_context_details` |
| `tripPlanner.placeImageCache` | Image reuse and the image URL check |
| `tripPlanner.askedQuestionKeys`, `preferenceSignals`, `dateHint` | Not asking a question twice; keeping preferences |

---

## Step 8: Client rendering

- Render `:::cards` … `:::cards` blocks in the Manager's reply as cards. Inside, each `[CARD]` … `[/CARD]` has `title`, `image`, `known_for`, `weather` and `budget`, in that order.
- Read suggestion chips from `context.summaryContext.suggestedQuestions`, not from the reply text.
- The final link sanitizer must keep card image URLs: `sanitizeNoLinks(text, { preserveCardImageUrls: true })` and `assertNoLinks(text, { allowCardImageUrls: true })`.

---

## Behavior to know

**1. The Manager can only render what Trip supplied.** When Trip returns `partial` or `failure`, the Manager mentions the limitation and does not fill gaps itself. A discovery turn with fewer than three cards is shown as an incomplete comparison.

**2. The first discovery turn always calls the image tool.** With `images: call_after_selecting_suggestions`, Trip fetches images for all three candidate cities before the traveler picks one. Your image provider gets one batch call per discovery turn. Later turns reuse the cache.

**3. Out-of-scope requests return a capability note.** Trip excludes accommodation, vehicles, local transport, airport transfers, rentals, and bus or train travel ([scope-policy.ts](../src/agents/trip-planner/scope-policy.ts)). When the Trip subtask asks only for these, the scope classifier sets `excluded`. Planning tools stay hidden, the extractor returns `failure` with the capability note, and no plan artifact is stored.

**4. `web_search` is Trip's own decision.** The Manager prompt tells the Manager not to ask for research. Current facts appear only as `fact` notes with a named source.

---

## Prompts to move

| Prompt | Location |
|---|---|
| Trip base prompt | [prompt.ts](../src/agents/trip-planner/prompt.ts), `TRIP_PLANNER` |
| Trip dynamic turn context and rules | [agent.ts](../src/agents/trip-planner/agent.ts), `buildTripPlannerDynamicContext` |
| Trip Manager-mode addendum | [manager-output.ts](../src/agents/trip-planner/manager-output.ts), `TRIP_PLANNER_MANAGER_INSTRUCTIONS` |
| Trip tool description (routing text the Manager reads) | [specialists/trip-planner.ts](../src/agents/manager/specialists/trip-planner.ts), `TRIP_PLANNER_TOOL_DESCRIPTION` |
| Manager: Trip sections | [manager-prompt.ts](../src/agents/manager-orchestrator/manager-prompt.ts): `## Trip destination references`, `## Trip: destination discovery versus planning`, `## trip_planner_agent`, `## Trip feedback`, `## Trip markdown`, and the examples `## Destination discovery and selection` and `## Trip could not complete` |
| Manager: dynamic Trip state | `buildManagerInstructions`: the "Current trip summary" and "Previous trip plan available" lines |

If production's Manager prompt was moved while Trip was not registered, those Trip references were removed then. Add them back now.

---

## Verify

1. Typecheck the production build.
2. Port and run these tests. None of them call a paid model:
   - [manager-trip-output.test.ts](../tests/integration/manager-trip-output.test.ts): extractor, sanitizer and plan-artifact behavior
   - [manager-specialist-registration.test.ts](../tests/integration/manager-specialist-registration.test.ts): tool wiring, using the fake Trip model in [tests/helpers/trip-manager.ts](../tests/helpers/trip-manager.ts)
   - [manager-agent-tools.test.ts](../tests/integration/manager-agent-tools.test.ts): the Manager registers exactly `flight_agent` and `trip_planner_agent`
3. Run four live smoke turns in one chat and check the tool log (`trip_planner.tool_called`) and the persisted context:

| Message | Expect |
|---|---|
| "Suggest a beach trip in December for 2 people" | Context → images (one batch) → suggestions; three cards with tool image URLs; one selection question |
| "The second one, 5 days" | Second displayed destination; `compact_full` with 5 days, each with morning/afternoon/evening; `lastPlanArtifact` stored |
| "Make day 2 more relaxed" | `get_trip_planner_context_details`; `compact_patch` with only day 2 |
| "Which hotel should I stay at there?" | No hotel suggestions; either the Manager declines without calling Trip, or Trip calls no planning tools and returns the capability note; `lastPlanArtifact` unchanged |
