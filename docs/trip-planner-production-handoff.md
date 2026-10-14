# Trip Planner: local implementation handoff

This document explains how the local Trip Planner works today, so it can be integrated into the production codebase. It describes behavior; it does not prescribe a production architecture. Production keeps its own request handling and its own context schema. Section 7 says what must be reproduced and what must be mapped.

- Source: local repo at commit `c4c160c` (the same `src/` is on `origin/main` at `725b943`). Paths below are relative to that repo root. Line numbers may drift; function names are stable.
- Sample values in Sections 4 and 6 were produced by running the real lifecycle functions and tools locally (no model calls), not written by hand.
- For context lifecycle and schema questions this document supersedes `docs/trip-planner-migration.md`, which assumes the local initialization code is copied.

---

## 0. Summary

- Trip runs as a nested agent tool, `trip_planner_agent`, called by the Manager agent. It receives a short subtask string written by the Manager and one shared, mutable per-request state object. It never sees conversation history.
- All Trip data lives in two places on that state object: `summaryContext` (the trip facts, also read by the Manager) and `tripPlanner` (Trip's internal state). Both paths are hard-coded in the Trip module (Section 5.8).
- Every Trip invocation follows the same sequence:
  1. `prepareTripPlannerTurn` resets the per-turn state.
  2. The model must call `update_trip_planner_context` first; it is the only function tool visible.
  3. Planning tools unlock: `get_trip_planner_context_details`, `get_place_images_batch`, and the hosted `web_search`.
  4. `update_trip_planner_suggested_questions` is the mandatory last tool.
  5. The model returns typed planning facts. The application validates them, stores the plan (`finalizeTripPlannerTurn`), and hands JSON to the Manager.
- Reading the core context is not a tool call. The current trip facts are rendered into the prompt on every model call (`<trip_state>`, `<turn_plan>`). `get_trip_planner_context_details` reads only bulky saved data (the last plan, saved places, events) on demand.
- Storing completed work is not a tool call either. The application writes the plan after it validates the model's final output.
- Of Trip's data, only `summaryContext` and seven `tripPlanner` fields are persisted between turns.

---

## 1. Components

| File | Symbol | Role |
|---|---|---|
| `src/agents/manager/specialists/trip-planner.ts` | `tripPlannerAgentAsTool`, `agent_start` hook | Registers Trip as the Manager tool `trip_planner_agent`; prepares the turn; validates and finalizes the output |
| `src/agents/trip-planner/agent.ts` | `TripPlannerManagerAgent`, `buildTripPlannerDynamicContext` | The Manager-mode agent; the per-model-call dynamic prompt |
| `src/agents/trip-planner/config.ts` | `tripPlannerAgentConfig` | Model `gpt-5.2`, `maxTurns` 8 (`TRIP_PLANNER_MAX_TURNS`), reasoning `low`, verbosity `low`, `parallelToolCalls: false` |
| `src/agents/trip-planner/prompt.ts` | `TRIP_PLANNER` | Base prompt: planning rules and tool rules |
| `src/agents/trip-planner/manager-output.ts` | `tripPlannerFeedbackSchema`, `tripPlannerManagerOutputSchema`, `TRIP_PHASE_RULES`, `getTripPlannerFormattingRules`, `TRIP_PLANNER_MANAGER_INSTRUCTIONS` | Output contract and formatting rules |
| `src/agents/trip-planner/context/lifecycle.ts` | `prepareTripPlannerTurn`, `applyTripPlannerContextUpdate`, `applyTripPlannerSuggestedQuestionsUpdate`, `finalizeTripPlannerTurn`, `refreshTripPlannerPlanningBrief` | Turn lifecycle and the logic behind the two update tools |
| `src/agents/trip-planner/context/store.ts` | `ensureTripPlannerState`, revision helpers, `invalidateTripPlannerKnowledge`, `setTripPlannerLastPlanArtifact`, `getTripPlannerContextDetails`, `withTripPlannerSessionLock` | State storage, the plan artifact, and the logic behind the details tool |
| `src/agents/trip-planner/context/summary-context.ts` | `createTripPlannerSummaryContext`, `mergeTripPlannerSummaryContext` | The trip-facts shape and its merge rules |
| `src/agents/trip-planner/context/planning-brief.ts` | `buildTripPlannerPlanningBrief` | Derives render mode, tool strategy, question intents and pacing from state |
| `src/agents/trip-planner/context/serializer.ts` | `buildTripPlannerCompactContext` | Renders `<trip_state>` and `<turn_plan>` |
| `src/agents/trip-planner/tools/context-tools.ts` | `UpdateTripPlannerContextTool`, `GetTripPlannerContextDetailsTool`, `UpdateTripPlannerSuggestedQuestionsTool` | The context tools |
| `src/agents/trip-planner/tools/image-tool.ts` | `GetPlaceImagesBatchTool` | Image lookup with a cache (dummy URLs locally) |
| `src/agents/trip-planner/tools/index.ts` | `tripPlannerTools`, `TripPlannerWebSearchTool` | Tool list; hosted `web_search` (`searchContextSize: 'medium'`) |
| `src/agents/trip-planner/tools/runtime.ts` | `getTripPlannerContext`, `getTripPlannerState`, `recordToolCall`, `TRIP_PLANNER_TOOL_NAMES` | Tool-side state access and the per-turn call record |
| `src/agents/trip-planner/scope-policy.ts` | `classifyTripPlannerScopeRequest`, `validateTripPlannerSuggestedQuestions`, `sanitizeTripPlannerManagerOutput`, `tripPlannerFailureFeedback` | Scope policy, suggestion validation, the output guard |
| `src/shared/runtime/request-context.ts` | `createRequestContext`, `getRequestState`, `getRequestClock`, `getScopedRequestText` | The run-context wrapper and its accessors |
| `src/shared/time/request-clock.ts` | `createRequestClock` | `{ localDate, localDateTime, timeZone }` for the turn |
| `src/agents/manager-orchestrator/agent.ts`, `runner.ts`, `manager-prompt.ts` | `ManagerAgent`, `mainChatRunner`, `runGatewayAgent`, `buildGatewayContext`, `buildManagerInstructions` | The Manager: local run entry and initialization |
| `src/api/chat/*` | `createChatServer`, `streamChatTurn`, `hydrateGatewayContext`, `snapshotGatewayContext`, `JsonChatStore` | Local HTTP API and persistence (local-only) |

---

## 2. Context model

### 2.1 Run context wrapper and state

```text
SDK RunContext.context ──► RequestContext (frozen) = { state, runtime: { clock } }
                                                      │
                                                      └─► state: one mutable object per request
```

- `createRequestContext(state, clock)` freezes the wrapper, not `state`. Everything mutates `state` in place.
- `getRequestState(runContext.context)` returns `state`. If the context is not wrapped, it returns the object as is. Every Trip function goes through it, so all Trip code sees the same object.
- `getRequestClock(runContext.context)` returns `{ localDate, localDateTime, timeZone }`, or `null` when the context is not wrapped.
- `getScopedRequestText(runContext, fallback)` returns `runContext.toolInput.input`, the Manager's subtask, trimmed. When that is absent or empty it returns `fallback`.

### 2.2 State keys Trip uses

| Key | Meaning | Trip reads | Trip writes |
|---|---|---|---|
| `requestId` | Unique id of this user turn | yes: `turnState.requestId`, duplicate checks, logs | no |
| `sessionId` | Stable id of the conversation | yes: lock key, logs | no |
| `currentUserMessage` | The whole user message | only as a fallback when there is no subtask | no |
| `summaryContext` | Trip facts for the conversation (Section 5.2) | yes | yes |
| `tripPlanner` | Trip's internal state (Sections 5.3 to 5.6) | yes | yes |

Trip does not read `flight`, `toolCallLog`, `flightSearchRuntime` or `flightRanThisTurn`. Those belong to Flight. Trip writes none of them.

### 2.3 Normalization: `summaryContext` is rewritten to the Trip shape

`ensureTripPlannerState(context)` in `store.ts` runs at the start of every lifecycle function and inside the context tools. It:

1. Replaces `context.summaryContext` with `createTripPlannerSummaryContext(context.summaryContext)`. That is a new object with exactly these 11 keys:
   - `pax`, `budget`, `origin`, `destination`, `tripType`
   - `outbound_date`, `return_date`, `duration_days`
   - `upcomingEvents`, `placesOfInterest`, `suggestedQuestions`

   Any other key is dropped. Strings are trimmed, IATA codes are upper-cased, non-positive numbers become `null`, and `tripType` and `suggestedQuestions` are de-duplicated.
2. Makes `context.tripPlanner` an object if it is not one.
3. Sets `tripPlanner.contextRevision` to `0` if it is not an integer.

This matters for production. If production's run state already uses the key `summaryContext` for other data, a Trip call drops that data (Section 7.7).

---

## 3. Context lifecycle

### 3.1 Local initialization through the chat API (local-specific)

```text
POST /api/chat/stream { message, chatId?, timeZone?, stream? }
  └─ src/api/chat/server.ts  createChatServer()
       ├─ no chatId → JsonChatStore.createChat(): chatId = randomUUID(),
       │              summaryContext = createEmptySummaryContext()   (legacy shape)
       │              runtimeContext = { flight: {}, tripPlanner: {}, flightSearchRuntime: null }
       ├─ store.acquireTurn(chatId)            per-chat busy lock (409 CHAT_BUSY)
       └─ streamChatTurn()                     src/api/chat/orchestrator.ts
            ├─ turnId = randomUUID(), requestId = randomUUID(), traceId = generateTraceId(), now = new Date()
            ├─ OpenAIConversationsSession → conversationId (saved on the chat; Manager history only)
            ├─ state = hydrateGatewayContext(chat.runtimeContext, chat.summaryContext)
            └─ runGatewayAgent({ input: message, requestId, traceId, sessionId: chat.chatId,
                                 context: state, session, signal, maxTurns, stream, now, timeZone })
                 src/agents/manager-orchestrator/runner.ts
                 ├─ buildGatewayContext(): state.requestId, state.sessionId, state.currentUserMessage = message;
                 │                         state.tripPlanner made an object; Flight-only preparation
                 ├─ clock = createRequestClock({ now, timeZone }); requestContext = createRequestContext(state, clock)
                 └─ mainChatRunner.run(ManagerAgent, message, { context: requestContext, maxTurns: 12, session, signal })
```

`hydrateGatewayContext` (`src/api/chat/context-hydration.ts`) works like this:

1. It clones `runtimeContext` and runs `ensureFlightRuntimeContext`, which is Flight's initializer and creates `flight` and `toolCallLog`.
2. It sets `summaryContext` from `runtimeContext.summaryContext` when present. Otherwise (a new chat, or a chat from before runtime snapshots) it seeds it from the legacy chat summary through `tripPlannerSummary`:
   - `pax` comes from `passengerData.total`.
   - `budget`, `origin`, `destination`, `tripType`, the dates and `duration_days` are copied.
   - `placesOfInterest` is copied from the legacy summary.
   - `upcomingEvents` and `suggestedQuestions` start empty.
3. It sets `tripPlanner = runtimeContext.tripPlanner || {}`.

`mainChatRunner` is `new Runner({ modelProvider: modelDeadlineProvider, modelSettings: { retry: { maxRetries: 0 } }, toolExecution: { maxFunctionToolConcurrency: 1 }, workflowName: 'travel-manager' })`. The Manager model settings include `parallelToolCalls: false`.

Where each runtime value comes from in the local API:

| Value | Created by | Stored on | Trip uses it for |
|---|---|---|---|
| `requestId` | `streamChatTurn`: `randomUUID()` per user turn (`runGatewayAgent` defaults to `randomUUID()`) | `state.requestId` | `turnState.requestId`, per-request duplicate checks, logs |
| `sessionId` | `chat.chatId` from `JsonChatStore.createChat` (`runGatewayAgent` defaults to `'default'`) | `state.sessionId` | Lock key in `withTripPlannerSessionLock`, logs |
| `currentUserMessage` | The request body's `message` | `state.currentUserMessage` | Fallback input only |
| clock | `createRequestClock({ now, timeZone })`; time zone from the request body, else the server's | `requestContext.runtime.clock` | The `<turn_clock>` line: `today=YYYY-MM-DD\|time_zone=…` |
| `traceId`, `turnId`, `conversationId` | `streamChatTurn` | Chat record and SDK trace | Not used by Trip |

### 3.2 Local initialization through the standalone runner (local-only)

`runTripPlannerAgent` in `src/agents/trip-planner/runner.ts` runs Trip without the Manager, using a different agent and output contract:

- It keeps an in-memory `Map` of contexts keyed by `sessionId` (default `'trip-planner-default'`) and merges any incoming `context` and `summaryContext`.
- It sets `requestId` and `sessionId` and calls `prepareTripPlannerTurn` directly. There is no `toolInput`.
- It runs `TripPlannerAgent`: text output with the standalone presentation prompt, and a bounded `MemorySession` for history. Under `NODE_ENV=production` it requires `configureTripPlannerSessionFactory`.
- It validates text with `sanitizeTripPlannerOutput` and calls `finalizeTripPlannerTurn({ output })`.

The Manager path does not use any of this. Do not use it as the production model.

### 3.3 What Trip requires, independent of how the request arrives

| # | Requirement |
|---|---|
| R1 | One mutable state object per request, the same object for the Manager run and the nested Trip run, reachable as `getRequestState(runContext.context)` |
| R2 | A request clock at `runContext.context.runtime.clock` (`localDate`, `timeZone`). Without it the prompt says `today=unknown` and relative dates stay vague |
| R3 | `state.requestId`, unique per user turn, and `state.sessionId`, stable per conversation |
| R4 | `state.summaryContext`: the conversation's trip facts in the Trip shape (Section 5.2), restored from storage |
| R5 | `state.tripPlanner`: the seven durable Trip fields (Section 5.3) restored from storage, or `{}` for a new conversation |
| R6 | The Manager's subtask as tool input `{ input }`. `state.currentUserMessage` is only a fallback |
| R7 | After the run, success or failure: persist `summaryContext` and the durable `tripPlanner` fields |
| R8 | Specialist tools run one at a time; Trip keeps its whole turn on the shared object |

### 3.4 How context reaches Trip and its tools

1. The Manager calls `trip_planner_agent` with `{ "input": "<subtask>" }`. That is the default `asTool` parameter schema; `inputBuilder: ({ params }) => params.input`.
2. Inside the SDK's `Agent.asTool` (`@openai/agents` 0.18.0), a function `inputBuilder` makes the SDK fork the Manager's `RunContext` with `_forkWithToolInput(params)`. The fork's `.context` is the same `RequestContext` object; `_cloneSharedState` copies the reference. The fork's `.toolInput` is `{ input }`. The SDK then runs `Runner.run(TripPlannerManagerAgent, input, { context: fork, maxTurns: 8 })`.
3. Order inside the nested run, verified in `@openai/agents-core` (`runner/turnPreparation.js` `prepareTurn`, then `prepareAgentArtifacts`): the `agent_start` hook fires before the instructions and the tool list are built. So `prepareTripPlannerTurn` always runs before the prompt or any `isEnabled` reads state.
4. The instructions are a function, re-evaluated on every model call of the nested run:
   ```ts
   instructions: (runContext) =>
     `${TRIP_PLANNER}\n\n${buildTripPlannerDynamicContext(runContext)}\n\n${TRIP_PLANNER_MANAGER_INSTRUCTIONS}`
   ```
   `buildTripPlannerDynamicContext` reads `summaryContext` and `tripPlanner`, rebuilds the planning brief, stores it on `tripPlanner.planningBrief`, and returns `<turn_clock>`, `<trip_state>`, `<turn_plan>` and `<turn_rules>`.
5. Tools reach state through `getTripPlannerContext(runContext)`, which is `getRequestState(runContext.context)`, and `getTripPlannerState(runContext)`, which is its `tripPlanner`. This applies to both `execute(input, runContext)` and `isEnabled({ runContext })`.
6. The SDK applies `isEnabled` only to function tools. The hosted `web_search` is always listed; only the prompt limits when it is used.

### 3.5 Turn start: `prepareTripPlannerTurn` (`lifecycle.ts`)

It is called from the `agent_start` hook in `src/agents/manager/specialists/trip-planner.ts`, only when `runContext.toolInput` exists:

```ts
TripPlannerManagerAgent.on('agent_start', (runContext) => {
  if (!runContext.toolInput) return;
  const context = getRequestState(runContext.context);
  prepareTripPlannerTurn({
    context,
    input: getScopedRequestText(runContext, context.currentUserMessage),
    requestId: context.requestId,
  });
});
```

| Field | Set to |
|---|---|
| `summaryContext` | A normalized copy (Section 2.3) |
| `tripPlanner.currentUserMessage` | The scoped subtask |
| `tripPlanner.scopeClassification` | `classifyTripPlannerScopeRequest(subtask)`: `{ mode: 'in_scope' \| 'mixed' \| 'excluded', categories }` |
| `tripPlanner.latestContextPatch` | `{}` |
| `tripPlanner.latestPreferenceSignals` | `{ positive: [], negative: [] }` |
| `tripPlanner.previousSuggestedQuestions` | A copy of `summaryContext.suggestedQuestions` |
| `tripPlanner.currentTurnToolCalls` | `[]` |
| `tripPlanner.turnState` | `{ requestId, baseRevision: contextRevision, contextCaptured: false, contextCaptureAttempts: 0, suggestionsUpdated: false, suggestionAttempts: 0 }` |
| `tripPlanner.planningBrief` | `refreshTripPlannerPlanningBrief(context)` |

The excluded scope covers accommodation, vehicles, local transport, airport transfers, rentals, and bus or train travel (`PROHIBITED_PATTERNS` in `scope-policy.ts`).

### 3.6 During the turn: two phases

| Phase | `<turn_plan>` shows | Model must |
|---|---|---|
| `context_capture` (until capture succeeds) | `phase=context_capture`, `required_first_tool=update_trip_planner_context`, `previous_suggestions=…` | Call `update_trip_planner_context` first, interpreting the subtask itself |
| `planning` (after capture) | `scope`, `changed`, `completed`, `render`, `format`, `cards`/`season`/`budget` policies, `pace`, `day_shape`, `patch`, `questions`, `tools`, `previous_suggestions` | Follow `tools=`; build the plan; call `update_trip_planner_suggested_questions` last; return typed facts |

Function tool visibility (`isEnabled`):

| Tool | Visible when |
|---|---|
| `update_trip_planner_context` | `!turnState.contextCaptured && contextCaptureAttempts < 2` |
| `get_place_images_batch` | Captured, scope not `excluded`, `planningBrief.toolStrategy.images.action` is `call` or `call_after_selecting_suggestions` |
| `get_trip_planner_context_details` | Captured, scope not `excluded`, `planningBrief.toolStrategy.contextDetails.action` is `call` or `agent_decides` |
| `update_trip_planner_suggested_questions` | Captured, `!suggestionsUpdated`, `suggestionAttempts < 2` |
| `web_search` (hosted) | Always |

Tool lists observed with `TripPlannerManagerAgent.getAllTools()` during the trace in Section 6:

| Moment | Visible tools |
|---|---|
| After prepare | `update_trip_planner_context`, `web_search` |
| After capture, new plan | `get_place_images_batch`, `web_search`, `update_trip_planner_suggested_questions` |
| After capture, revising a saved plan | `web_search`, `get_trip_planner_context_details`, `update_trip_planner_suggested_questions` |
| After suggestions are stored | `get_place_images_batch` (its action is still `call`), `web_search` |

Every function tool records `{ tool, input, status, output }` into `tripPlanner.currentTurnToolCalls` (`recordToolCall`) and logs `trip_planner.tool_called`. The details tool records only `{ ok, status, revision, detailSections }` as its output. The output guard reads this record (Section 3.7).

### 3.7 Turn end: output extractor (`specialists/trip-planner.ts`)

The model's final output must match `tripPlannerFeedbackSchema`; the SDK enforces this through `outputType`:

```ts
{ status: 'success' | 'partial' | 'needs_input' | 'failure',
  mode: 'discovery_cards' | 'compact_full' | 'compact_patch' | 'answer',
  destinationCards: { itemCode /*AAA*/, title, imageUrl | null, knownFor, weather, budget }[] /* ≤3 */,
  itineraryDays: { day, title | null, morning | null, afternoon | null, evening | null }[],
  recommendation: string | null,
  notes: { kind: 'fit' | 'assumption' | 'season' | 'change' | 'fact' | 'capability', text, sourceName | null }[],
  tables: { kind: 'budget' | 'comparison', title | null, columns /*2-3*/, rows: { cells, recommended }[] }[],
  nextQuestions: { key /*question intent*/, purpose }[] /* ≤2 */,
  limitations: string[] }
```

`customOutputExtractor(result)` runs four steps:

1. `sanitizeTripPlannerManagerOutput(result.finalOutput, state, result.newItems)`.
2. If that throws, it logs `trip_planner.feedback_rejected` and uses `tripPlannerFailureFeedback(state)` with `storePlanArtifact: false`.
3. `finalizeTripPlannerTurn({ context: state, feedback, responseMode: feedback.mode, storePlanArtifact })`.
4. It returns `JSON.stringify(feedback)` as the tool result the Manager sees. That is `tripPlannerManagerOutputSchema`: the findings plus `formattingRules`.

**Checks in `sanitizeTripPlannerManagerOutput` (`scope-policy.ts`)**

*Field cleaning and scope*
- `recommendation`, `notes` and `limitations` that mention an excluded topic are dropped.
- Every other text field is scope-checked, link-stripped, and has `**` and `Anchor N:` labels removed.
- Card markers, headings or code fences in a fact throw.
- An excluded-topic fact in plan content, or an excluded-scope request, turns the whole result into `status: 'failure'` with a capability note, and the plan is not stored.

*Images*
- A card's `imageUrl` must equal `tripPlanner.placeImageCache[itemCode].imageUrl` and be http(s).
- `null` is allowed only when nothing is cached for that code.
- Otherwise the guard throws. Duplicate `itemCode`s also throw.

*Mode and shape*
- `mode` must equal `planningBrief.responseStrategy.renderMode`, unless it is `answer`; otherwise it throws.
- `answer` and `discovery_cards` must not contain days; otherwise it throws.
- `discovery_cards` needs 3 cards; if not, a limitation is added.
- `compact_full` needs exactly `effectiveDurationDays` sequential days with every block, and exactly 1 card; if not, a limitation is added.
- `compact_patch` may contain at most `maxPatchDaySections` unique days, and only the requested `day_N`. Cards in a patch are not allowed unless visuals were requested. Either violation throws.
- Table, season-note and question limits (`maxQuestions`, `questionPriority`, already-asked keys) are enforced; a violation throws.
- A successful discovery with cards must ask exactly `min(1, maxQuestions)` questions: the destination choice, unless it was already asked.

*Missing work* (each adds a limitation and turns `success` into `partial`)
- Context capture did not succeed.
- Images were required but `get_place_images_batch` never returned `ok` (not checked for `answer` mode).
- `contextDetails` was `call` but the details tool never succeeded.
- A `fact` note has a `sourceName` but no hosted `web_search` call completed in `result.newItems`. The note is removed.

*Formatting rules*
- `formattingRules` comes from `getTripPlannerFormattingRules`: the phase's fixed rules plus the brief's context-dependent values. The model never writes them.
- `storePlanArtifact` is true only when nothing is missing and the status is neither `failure` nor `needs_input`.

**Writes in `finalizeTripPlannerTurn` (`lifecycle.ts`)**
- If `turnState.suggestionsUpdated` is false, it clears `summaryContext.suggestedQuestions` to `[]`. Old chips never survive a turn that did not refresh them.
- It adds each `nextQuestions[].key` and its canonical aliases to `tripPlanner.askedQuestionKeys`. For example, `traveler_count` → `party`, `budget_basis` → `budget`, `travel_dates_or_duration` → `dates` + `duration`.
- If `storePlanArtifact` is true and the scope is not `excluded`, it calls `setTripPlannerLastPlanArtifact` (Section 5.4). That writes `tripPlanner.lastPlanArtifact` and `tripPlanner.lastPlanSnapshot`.
- Failure, `needs_input` and `answer` results never overwrite a saved plan.

**Failure path.** If the nested run throws (for example when it exceeds max turns or a model call fails), the extractor and `finalizeTripPlannerTurn` do not run:
- No plan is stored, and the previous plan is kept.
- Chips are not cleared. The new chips remain if the suggestions tool already ran; otherwise the previous turn's chips remain.
- Changes already applied by the capture tool stay.
- The Manager receives the SDK's default error text: `An error occurred while running the tool. Please try again. Error: …`.

### 3.8 Preservation and return

- Everything mutates the same `state` object, and `runGatewayAgent` returns it as `result.context`.
- `snapshotGatewayContext(state)` (`context-hydration.ts`) builds:
  ```ts
  {
    summaryContext,                          // whole
    flight,
    tripPlanner: <only DURABLE_TRIP_PLANNER_FIELDS>,
    flightSearchRuntime,
  }
  ```
  The durable fields are `contextRevision`, `dateHint`, `preferenceSignals`, `askedQuestionKeys`, `placeImageCache`, `lastPlanArtifact` and `lastPlanSnapshot`.
- `streamChatTurn` saves the snapshot as `chat.runtimeContext` after a successful turn. In its catch block it also saves the partially updated state of a failed turn.
- What the local client receives:
  - SSE `done` carries `finalText`, `summaryContext` and `flightContext`. That `summaryContext` is the **legacy chat summary, not Trip's**, so Trip's chips are not in the SSE stream.
  - Trip's state is available from `GET /api/chats/:id` at `chat.runtimeContext.summaryContext` and `chat.runtimeContext.tripPlanner`.
  - The local dashboard does not render Trip chips.
- On the next turn, `hydrateGatewayContext` restores `runtimeContext.summaryContext` and `runtimeContext.tripPlanner`.

### 3.9 Local initialization, Trip requirements and runtime-only state

| Local initialization (do not copy as is) | Required by Trip (reproduce) | Runtime-only (exists during a turn; never persisted) |
|---|---|---|
| HTTP route, chat store and busy lock, SSE events, dashboard | Per-request state object reachable through `getRequestState` (R1) | `RequestContext` wrapper and clock |
| `createEmptySummaryContext` legacy shape; legacy seeding in `hydrateGatewayContext` | Clock in `runtime.clock` (R2) | `tripPlanner.currentUserMessage`, `scopeClassification`, `latestContextPatch`, `latestPreferenceSignals`, `previousSuggestedQuestions`, `currentTurnToolCalls`, `turnState`, `planningBrief` |
| `buildGatewayContext` (Flight preparation and suggestion bookkeeping); only its three assignments matter to Trip | `requestId`, `sessionId` on state (R3) | `tripPlanner.lastContextUpdateRequestId/Result`, `lastSuggestionsUpdateRequestId/Result` (one request) |
| `runGatewayAgent` defaults (`sessionId: 'default'`) | Trip-shaped `summaryContext` restored (R4) | `RunContext.toolInput` |
| Standalone runner, its in-memory maps and `MemorySession` | Durable `tripPlanner` fields restored (R5) | |
| `OpenAIConversationsSession` (Manager history; Trip never sees it) | Subtask as `{ input }` (R6); persistence after the run (R7); serial tools (R8) | |

---

## 4. The context tools

### 4.0 The actual read and update pattern

The pattern "read current context, do the task, update context with what was learned or completed" maps to the local implementation like this:

| Pattern step | Local mechanism | When |
|---|---|---|
| Read current context | Prompt injection. `buildTripPlannerDynamicContext` renders `<trip_state>` (non-empty `summaryContext` fields, `date_hint`, counts of saved places and events, cached image, `last_plan` id) and `<turn_plan>` | Every model call |
| Update with what the latest message says | `update_trip_planner_context`, **first** | Every Trip invocation, before any planning |
| Read detailed saved context | `get_trip_planner_context_details` | After capture, only when `tools=` says `contextDetails:call` or `contextDetails:agent_decides` |
| Do the task | `get_place_images_batch`, `web_search`, model reasoning | Planning phase |
| Update with completed work | `update_trip_planner_suggested_questions` (chips, **last** tool) and `finalizeTripPlannerTurn` (application: plan artifact, asked-question keys) | End of the invocation |

Capture comes first, not last, for a reason. The planning brief (render mode, tools, questions, pacing) is computed from the merged state, so the latest changes must be stored before the plan is decided. After a successful capture the model rereads the refreshed `<trip_state>` and `<turn_plan>`.

### 4.1 `update_trip_planner_context`

**Purpose.** The model turns the latest subtask into structured changes and stores them. The tool validates and merges; it never parses user text.

**Tool description (model-visible):** "Store a structured Trip Planner context patch prepared by the agent. Call this before planning or any other tool, even when the patch is null. This tool validates and persists values; it never interprets raw user text."

**When it is called.** It is the mandatory first tool of every Trip invocation, even when nothing changed (`contextPatch: null`). It is visible only until capture succeeds, and at most two counted attempts are allowed.

**Input** (`tripPlannerContextUpdateInputSchema`, `strict: true`. Every key is `.nullish()`, so the model sends every key and uses `null` for "unchanged"):

```ts
{
  baseRevision: number,            // int ≥ 0; must equal turnState.baseRevision (the trip_state revision at turn start)
  contextPatch: {                  // or null when nothing changed
    pax: number | null,                                    // int > 0
    budget: { total: number|null, amount: number|null /* both > 0 */, currency: string|null /* 3 chars */, per_person: boolean|null } | null,
    origin: { city: string|null /* ≤80 */, iata: string|null /* 3 letters */ } | null,
    destination: { city, iata } | null,
    outbound_date: string | null,                          // YYYY-MM-DD
    return_date: string | null,                            // YYYY-MM-DD
    duration_days: number | null,                          // int > 0
    tripType: { add: string[] | null, remove: string[] | null } | null,   // ≤10 each, 1–40 chars
    date_hint: string | null,      // 1–80 chars; a vague date phrase the user gave; never invented
  } | null,
  clearFields: ('pax'|'budget'|'origin'|'destination'|'outbound_date'|'return_date'|'duration_days'|'tripType'|'date_hint')[] | null
}
```

**Processing.** `execute` first checks whether capture already happened. If so, it returns `ALREADY_UPDATED` without changes. Otherwise it runs `applyTripPlannerContextUpdate(state, input)` inside `withTripPlannerSessionLock`:

1. Duplicate check. If `tripPlanner.lastContextUpdateRequestId === requestId`, it returns the saved result with status `ALREADY_UPDATED` and does nothing else (see caveat C1).
2. It increments `turnState.contextCaptureAttempts`.
3. It requires `input.baseRevision === turnState.baseRevision`. Otherwise it returns `REVISION_CONFLICT` and applies nothing.
4. It merges the non-null `contextPatch` values into `summaryContext` using `mergeTripPlannerSummaryContext`:

   | Field | Merge rule |
   |---|---|
   | `pax`, `duration_days` | A positive number replaces the stored value |
   | `outbound_date`, `return_date` | A non-empty value replaces the stored value |
   | `budget` | Each provided sub-field replaces: numbers greater than 0, a non-empty currency, a boolean `per_person`. `per_person: true` without `total` resets `total` to `null` |
   | `origin`, `destination` | A different `city` replaces the whole endpoint (`{ city, iata or null }`); otherwise provided parts fill in and the rest is kept |
   | `tripType.add` | Merged. Adding a journey type (`oneway`, `roundtrip`, `multicity`), a party type (`solo`, `couple`, `family`, `friends`, `business`) or a pace (`relaxed`, `balanced`, `fast-paced`) replaces the existing value of that category; other values accumulate |
   | `tripType.remove` | Removes matching values, ignoring case |
   | Excluded-topic values in `add` or `remove` | Not stored; reported in `rejectedFields` as `tripType.add` or `tripType.remove` |

5. It applies `clearFields`:
   - `budget` becomes all `null`.
   - An endpoint becomes `{ city: null, iata: null }`.
   - `tripType` becomes `[]`.
   - Scalar fields become `null`.
   - `date_hint` clears `tripPlanner.dateHint`.
6. It updates `tripPlanner.dateHint`. A `date_hint` value is stored trimmed. An `outbound_date` without a `date_hint` clears the hint.
7. It invalidates stale knowledge (`invalidateTripPlannerKnowledge`):
   - When the destination city or IATA changes: `upcomingEvents` and `placesOfInterest` become `[]`, `lastPlanArtifact` becomes `null`, and `placeImageCache` keeps only the new destination's entry. `lastPlanSnapshot` is kept, so the brief knows the destination changed.
   - When only the dates change: `upcomingEvents` becomes `[]`.
8. It records the turn's changes:
   - `latestContextPatch`: the accepted values, plus `tripType` adds and `date_hint`, plus cleared fields as `null`.
   - `latestPreferenceSignals`: `{ positive: adds, negative: removes }`.
   - `preferenceSignals`: merged; the latest signal wins.
9. It sets `turnState.contextCaptured = true`. It increments `contextRevision` only if any field changed. It refreshes `planningBrief` and saves the duplicate-check record.

**Output** (also recorded in `currentTurnToolCalls`):

```ts
{ ok: boolean, status, revision: number, changedFields: string[], rejectedFields: string[],
  responseMode?: 'discovery_cards' | 'compact_full' | 'compact_patch', messageForAgent: string }
```

| Status | `ok` | Meaning |
|---|---|---|
| `SUCCESS` | true | Applied; nothing rejected |
| `PARTIAL` | true | Applied; some `tripType` values rejected (excluded topics) |
| `ALREADY_UPDATED` | true | Capture already done in this invocation, or the same `requestId` already captured (C1) |
| `REVISION_CONFLICT` | false | Stale `baseRevision`; nothing applied; counts as an attempt; `messageForAgent` says to retry with the current revision |
| (schema error) | n/a | Invalid input never reaches `execute`. The SDK returns `An error occurred while running the tool. Please try again. Error: InvalidToolInputError: …`. It does not count as an attempt |

After two counted attempts without success, the tool is hidden. Capture stays incomplete, so the planning tools and the suggestions tool stay hidden too. The output guard adds "The requested trip preferences could not be saved." and the plan is not stored.

**Reads.** `summaryContext`; `tripPlanner.turnState`, `contextRevision`, `dateHint`, `preferenceSignals`, `placeImageCache`, `lastContextUpdateRequestId`/`Result`; `state.requestId`; `state.sessionId` (lock).

**Writes.**
- `summaryContext`: `pax`, `budget`, `origin`, `destination`, `tripType`, the dates and `duration_days`; and, on invalidation, `upcomingEvents` and `placesOfInterest`.
- `tripPlanner`:
  - change tracking: `dateHint`, `latestContextPatch`, `latestPreferenceSignals`, `preferenceSignals`
  - turn status: `turnState.contextCaptured`, `turnState.contextCaptureAttempts`, `contextRevision`, `planningBrief`
  - on invalidation: `lastPlanArtifact`, `placeImageCache`
  - duplicate-check records: `lastContextUpdateRequestId`, `lastContextUpdateResult`
  - call record: `currentTurnToolCalls`

**How the prompt instructs it**

- `prompt.ts`, *Agent-Owned Context Capture*:
  - "When `turn_plan.phase=context_capture`, the first action must be `update_trip_planner_context`; do not plan or call another tool first."
  - "You own natural-language understanding … the tool does not parse user text."
  - "Send only explicitly stated or clearly implied values. Preserve every field not changed."
  - "Use `contextPatch=null` when no context changed; use `clearFields` only for explicit removal."
  - "Put exact dates in `outbound_date` and `return_date` only when they resolve to YYYY-MM-DD. Put vague timing in `date_hint`; never invent a date."
  - "For a city, provide its bare name … and its three-letter code: the matching `image_cache` code when one exists, otherwise a city or airport code only when confident, else null."
  - Interpretation examples: "2 ppl" → `pax: 2`; "with wife" → `pax: 2` and `couple`; "make it chill" → `relaxed`; "not costly" → `budget-conscious`. Store only canonical values.
  - "After success, reread refreshed `trip_state` and `turn_plan` before planning …"
- `prompt.ts`, *Tool Rules*:
  - "Mandatory first tool in `context_capture`; pass numeric `trip_state revision` as baseRevision."
  - "Use null for contextPatch/clearFields when unchanged."
  - "After SUCCESS, PARTIAL, or ALREADY_UPDATED, continue from refreshed state without another capture call."
- `<turn_rules>` (`agent.ts`): "If phase=context_capture, call update_trip_planner_context before any planning, other tool, or final output." and "If phase=planning, never call update_trip_planner_context again."
- `TRIP_PLANNER_MANAGER_INSTRUCTIONS`: "initially only context capture is visible by design. Hidden planning tools do NOT mean photos or research are unsupported. After update_trip_planner_context succeeds, reread the refreshed turn_plan and use the newly available planning tools."

**Example** (from the Section 6 trace). The subtask is "Plan a relaxed 3-day trip to Rome for 2 of us next month, we love food", and today is 2026-10-14.

```json
// input
{ "baseRevision": 0,
  "contextPatch": { "pax": 2, "budget": null, "origin": null, "destination": { "city": "Rome", "iata": "ROM" },
    "outbound_date": null, "return_date": null, "duration_days": 3,
    "tripType": { "add": ["relaxed", "couple", "food"], "remove": null }, "date_hint": "November 2026" },
  "clearFields": null }
// output
{ "ok": true, "status": "SUCCESS", "revision": 1,
  "changedFields": ["pax", "destination", "duration_days", "tripType", "date_hint"], "rejectedFields": [],
  "responseMode": "compact_full",
  "messageForAgent": "Context capture is complete. Continue the trip-planning task using the refreshed trip_state, then update suggested questions last." }
```

### 4.2 `get_trip_planner_context_details`

**Purpose.** The prompt carries only counts and ids for bulky saved data. This tool returns compact records on demand: the last saved itinerary, saved places, and upcoming events. It is how Trip reads a saved plan before revising it.

**Tool description (model-visible):** "Read compact saved places, events, or the last itinerary when turn_plan says contextDetails:call, or with contextDetails:agent_decides before changing or referring to saved days. Never use for excluded-scope requests."

**When it is called.** Only after capture, when scope is not `excluded` and the planning brief's `toolStrategy.contextDetails` (`deriveToolStrategy` in `planning-brief.ts`) is one of these:

| Action | Condition | Model behavior |
|---|---|---|
| `call` with `sections` | Any of: saved places exist and the subtask mentions known, saved, recommended, available or all places or attractions (`places`); saved events exist and it mentions known, saved, available, upcoming or all events (`events`); a saved plan exists and it mentions the previous, current, existing or last plan or itinerary, or "day N" (`last_plan`) | Required. The guard adds a limitation if it was not called |
| `agent_decides` with `['last_plan']` | A saved plan exists and none of the above matched | Call it for `last_plan` before changing or referring to saved days |
| `not_needed` | No saved plan and no matching sections | Hidden |

**Input** (`strict: true`):

```ts
{ sections: ('places' | 'events' | 'last_plan')[],   // 1–3; only what is needed now
  query: string | null,                              // ≤100 chars
  limit: number | null }                             // int 1–10; default 5
```

**Behavior** (`getTripPlannerContextDetails` in `store.ts`):

- `limit` is clamped to 1–10 and defaults to 5.
- `query` filters by a case-insensitive substring over each record's JSON.
- `places` returns `summaryContext.placesOfInterest`, filtered and limited, as `{ placeName ≤100, description ≤180 }`.
- `events` returns `summaryContext.upcomingEvents` as `{ name ≤100, date ≤40, description ≤180 }`.
- `last_plan` returns `tripPlanner.lastPlanArtifact` as `{ id, revision, responseMode, days, destinationCards, recommendation, notes, tables, limitations, legacyContent?, content ≤2000 }`, or `null` when there is no saved plan:
  - Days pass through `recoverDayBlocks`, so older text-only days get `morning`, `afternoon` and `evening` too.
  - A query containing "day N" returns only day N and leaves the facts unfiltered. Any other query filters days and facts by substring.

**Output:**

```ts
{ ok: true, status: 'SUCCESS', revision: number, destination: { city, iata },
  details: { places?: [...], events?: [...], lastPlan?: {...} | null } }
```

Invalid input, for example `sections: []` or `limit: 50`, gets the SDK schema error text and never reaches `execute`.

**Reads.** `summaryContext.placesOfInterest`, `summaryContext.upcomingEvents`, `summaryContext.destination`; `tripPlanner.lastPlanArtifact`, `tripPlanner.contextRevision`.

**Writes.** No trip data. It appends `{ tool, input, status, output: { ok, status, revision, detailSections } }` to `tripPlanner.currentTurnToolCalls`, which the guard uses to confirm a required read happened. It also normalizes state through `ensureTripPlannerState` (Section 2.3).

**How the prompt instructs it**

- `prompt.ts`, *Use Existing Trip Context First*:
  - "Fetch saved places, events, or the prior plan when `turn_plan.tools` says `contextDetails:call`. With `contextDetails:agent_decides`, read the prior plan before changing or referring to its days. Never invent saved contents from counts."
  - "Read context before deciding which details are missing; its non-null fields are already-known facts."
- `prompt.ts`, *Tool Rules*:
  - "Call for `contextDetails:call` with exactly the listed sections. With `contextDetails:agent_decides`, call it for last_plan before changing or referring to saved days. Limit at most ten."
  - "Use only records for the current destination and revision. Never read for excluded scope or merely because a section count is non-zero."
- `TRIP_PLANNER_MANAGER_INSTRUCTIONS`: "Perform required selective context retrieval, and any web_search the request needs, before finalizing."

**Example** (Section 6, turn 2: "make day 2 lighter and skip the Colosseum"):

```json
// input
{ "sections": ["last_plan"], "query": "day 2", "limit": null }
// output (content shortened)
{ "ok": true, "status": "SUCCESS", "revision": 2, "destination": { "city": "Rome", "iata": "ROM" },
  "details": { "lastPlan": { "id": "plan_2", "revision": 2, "responseMode": "compact_full",
    "days": [{ "day": 2, "title": "Ancient Rome", "content": "{…}", "morning": "Colosseum visit",
               "afternoon": "Long lunch and rest", "evening": "Trastevere food stroll" }],
    "destinationCards": [{ "itemCode": "ROM", "title": "Rome, Italy", "imageUrl": "https://images.example.test/rome.jpg",
      "knownFor": "Ancient history and trattoria food", "weather": "Mild and cooler in November", "budget": "Moderate cost tier" }],
    "recommendation": "Rome suits a relaxed food-focused couple trip",
    "notes": [{ "kind": "assumption", "text": "November 2026 assumed from next month", "sourceName": null }],
    "tables": [], "limitations": [], "content": "{\"destinationCards\":[…],\"days\":[…]}" } } }
```

### 4.3 Related: `update_trip_planner_suggested_questions`

This is the mandatory last tool and stores the UI chips for this turn.

**Input**
```ts
{ baseRevision: number /* current contextRevision */, suggestedQuestions: string[] /* exactly 3, ≤80 chars */ }
```

**Validation** (`validateTripPlannerSuggestedQuestions`) requires:
- exactly 3 suggestions, each 3–8 words;
- no assistant-style openers ("would you like…");
- no excluded topics;
- none repeated from `previousSuggestedQuestions`;
- no duplicates among the three.

**Statuses**
- `SUCCESS` writes `summaryContext.suggestedQuestions`, increments `contextRevision` if the chips changed, and sets `turnState.suggestionsUpdated`.
- `INVALID_SUGGESTIONS` returns `issues`; the model gets one retry, because the tool is visible while `suggestionAttempts < 2`.
- `REVISION_CONFLICT` means `baseRevision` is not the current revision.
- `CONTEXT_NOT_CAPTURED` means the tool was called before capture.
- `ALREADY_UPDATED` has the same duplicate-check caveat as the context tool (C1).

If it never succeeds, `finalizeTripPlannerTurn` clears the chips.

### 4.4 Related: the application stores the completed plan

`setTripPlannerLastPlanArtifact` (`store.ts`) is called from `finalizeTripPlannerTurn` and is not a tool. It stores the validated facts as `tripPlanner.lastPlanArtifact` (shape in Section 5.4) and sets `tripPlanner.lastPlanSnapshot = { destination }`.

- A `compact_patch` for the same destination merges into the previous artifact:
  - days are matched by day number, and a `null` block keeps the previous block;
  - cards and the recommendation are kept when not supplied;
  - notes and tables are replaced per `kind`.
- Full and discovery results replace the artifact.
- Nothing is stored when the result has no days, no cards and nothing to merge, or when the result is a failure, `needs_input` or `answer`. The previous artifact survives in those cases.

---

## 5. Context schema mapping

The tables below give the meaning of every field so production can map it onto its existing structure. The last column says what production needs, not where to put it.

### 5.1 Request and runtime values

| Local field | Meaning | Read/write usage | Production needs equivalent of |
|---|---|---|---|
| `state.requestId` | Unique id for one user turn | R: `prepareTripPlannerTurn` → `turnState.requestId`; per-request duplicate checks; logs | A per-turn id from the production request (generated or forwarded) |
| `state.sessionId` | Stable id for the conversation | R: lock key, logs | The production conversation or session id |
| `state.currentUserMessage` | The full user message for the turn | R: fallback when the Manager supplies no subtask | The production request's user message |
| `runtime.clock.localDate`, `timeZone` | The traveler's local date and time zone for this turn | R: `<turn_clock>`; all relative dates resolve from it | The request time and the traveler's time zone (request header or body, or a profile) |
| `RunContext.toolInput.input` | The Manager's scoped Trip subtask | R: `getScopedRequestText` | The Manager's tool-call argument (SDK-provided) |

### 5.2 Trip facts (`state.summaryContext`)

These are shared conversation facts. Trip reads them into `<trip_state>`, writes them through `update_trip_planner_context`, and the Manager reads some of them for routing.

| Local field | Meaning | Read/write usage | Production needs equivalent of |
|---|---|---|---|
| `pax` | Total travelers (int > 0) | R: prompt, brief (`traveler_count` question, party label). W: context tool | Traveler count. Locally, legacy chats map `passengerData.total` to `pax` |
| `budget.amount`, `budget.total`, `budget.currency`, `budget.per_person` | Trip budget: an amount, an explicit total, an ISO currency, and whether the amount is per person | R: prompt `budget=CUR amount\|basis\|daily_reference`, brief (basis, daily reference, questions). W: context tool | Stored trip budget with currency and per-person or total basis |
| `origin.city`, `origin.iata` | Where the traveler departs from | R: prompt, brief (a known origin makes day 1 light). W: context tool | Trip origin (city and code) |
| `destination.city`, `destination.iata` | The chosen destination; the code is a 3-letter city or airport code | R: prompt, brief (discovery vs plan, image code, destination change), Manager prompt. W: context tool; a change invalidates saved plan, places, events and images | The trip's chosen destination |
| `tripType[]` | Durable preference signals: journey type, party type, pace and interests (for example `relaxed`, `couple`, `food`, `budget-conscious`) | R: prompt, brief (pace, party, interests). W: context tool (`add`/`remove` with category replacement) | Trip preferences or tags. If production splits journey type, party and interests, map each category |
| `outbound_date`, `return_date` | Exact trip dates, YYYY-MM-DD | R: prompt, brief (duration, date conflicts, light last day), Manager prompt. W: context tool; a change clears events | Trip start and end dates |
| `duration_days` | Trip length in days | R: prompt, brief (`effective_days`; defaults to 4 when unknown). W: context tool | Trip duration |
| `upcomingEvents[]` | Saved events for the destination | R: prompt (count), details tool `events`. W: cleared on destination or date change. Not written by any Trip tool | Saved events, if production has them; otherwise empty |
| `placesOfInterest[]` (`{ placeName, description }`) | Saved places for the destination | R: prompt (count), details tool `places`. W: cleared on destination change. Not written by any Trip tool | Saved places, if production has them; otherwise empty |
| `suggestedQuestions[]` | The three UI chips from the last Trip turn | R: `prepareTripPlannerTurn` copies them to `previousSuggestedQuestions`. W: suggestions tool; cleared by `finalizeTripPlannerTurn` when not refreshed | Wherever production stores and returns follow-up chips for the client |

### 5.3 Durable Trip state (`state.tripPlanner`, persisted between turns)

| Local field | Meaning | Read/write usage | Production needs equivalent of |
|---|---|---|---|
| `contextRevision` | Version counter of Trip context; incremented when facts or chips change | R: `<trip_state revision=N>`, `baseRevision` checks, plan `id`/`revision`, details output. W: context and suggestions tools | A per-conversation Trip revision number |
| `dateHint` | Vague timing the traveler gave, such as "November 2026" | R: prompt `date_hint=` line. A `date_hint` captured this turn also counts as completed `dates` in `completed=` and as a `dates_or_duration` patch target. It does not satisfy the brief's missing-dates check, which looks only at exact dates and duration. W: context tool (`date_hint`, `clearFields`, exact dates) | A stored vague-timing phrase |
| `preferenceSignals` | Accumulated `{ positive[], negative[] }` preferences | R: brief (preferences count as known, which suppresses the `interests` question). W: context tool | Liked and disliked preferences across turns |
| `askedQuestionKeys[]` | Question intents already asked (`destination`, `dates`, `duration`, `party`, `budget`, `interests`, `pace`, plus aliases) | R: brief (never ask again), guard. W: `finalizeTripPlannerTurn` | Questions already asked in the conversation |
| `placeImageCache` | `{ [itemCode]: { itemCode, imageUrl, isFallback, cached } }` from the image tool | R: prompt `image_asset`/`image_cache`, brief (`reuse`), guard (card URL must match). W: image tool; pruned on destination change | Cached destination images keyed by city code |
| `lastPlanArtifact` | The last validated plan (Section 5.4) | R: prompt `last_plan=`, brief (`contextDetails`), details tool, patch merge, Manager prompt ("Previous trip plan available"). W: `finalizeTripPlannerTurn`; cleared on destination change | The current saved itinerary for the conversation |
| `lastPlanSnapshot` | `{ destination }` of the last stored plan, kept even when a destination change clears the artifact | R: brief: patch vs full plan, `destinationChanged`. W: `setTripPlannerLastPlanArtifact` | The destination the saved itinerary was made for |

### 5.4 `lastPlanArtifact` shape

```ts
{ id: `plan_${contextRevision}`, revision: number,
  destination: { city, iata },
  responseMode: 'discovery_cards' | 'compact_full' | 'compact_patch',
  days: { day, title, content /* JSON of the blocks */, morning, afternoon, evening, legacyContent? }[],
  destinationCards: TripCard[], recommendation: string | null,
  notes: TripNote[], tables: TripTable[], limitations: string[],
  content: string,          // JSON of facts + days (≤ 12,000 chars); duplicates the structured fields
  legacyContent?: string }  // only for artifacts migrated from older text plans
```

A discovery turn also stores an artifact: three cards, no days, and an empty destination. Selecting one of the cards on the next turn counts as a destination change. The capture clears the discovery artifact and keeps only the chosen city's cached image, so the next render is `compact_full` with `images:reuse` (verified in Section 6).

### 5.5 Per-turn Trip state (rebuilt by `prepareTripPlannerTurn`; never persisted)

| Local field | Meaning | Read/write usage | Production needs equivalent of |
|---|---|---|---|
| `currentUserMessage` | The scoped subtask Trip is working on | R: brief (wording such as "day N", "full plan", "photos"), prompt | Nothing to store; set per invocation |
| `scopeClassification` | `{ mode, categories }` for the subtask | R: tool visibility, prompt `scope=`, brief, guard (excluded → failure), artifact storage | Nothing to store |
| `latestContextPatch` | Changes accepted in this turn | R: prompt `changed=`/`completed=`, brief (merge, patch targets) | Nothing to store |
| `latestPreferenceSignals` | Preferences added or removed in this turn | R: brief | Nothing to store |
| `previousSuggestedQuestions` | Chips shown before this turn | R: prompt `previous_suggestions=`, suggestion validator (no repeats) | Nothing to store; copied from `summaryContext.suggestedQuestions` |
| `currentTurnToolCalls` | Tool calls of this invocation | R: guard (images and details actually done) | Nothing to store |
| `turnState` | `{ requestId, baseRevision, contextCaptured, contextCaptureAttempts, suggestionsUpdated, suggestionAttempts }` | R: tool visibility, revision check, finalize (chip clearing) | Nothing to store |
| `planningBrief` | Derived plan for this turn: `responseStrategy` (render mode and limits), `toolStrategy`, `derivedConstraints`, question intents | R: prompt `<turn_plan>`, tool visibility, `getTripPlannerFormattingRules`, guard | Nothing to store; recomputed from state |

### 5.6 Per-request records (never persisted)

| Local field | Meaning | Usage |
|---|---|---|
| `lastContextUpdateRequestId`, `lastContextUpdateResult` | The last successful capture in this request | Duplicate check in `applyTripPlannerContextUpdate` (C1) |
| `lastSuggestionsUpdateRequestId`, `lastSuggestionsUpdateResult` | The last successful chip update in this request | Duplicate check in `applyTripPlannerSuggestedQuestionsUpdate` (C1) |

### 5.7 How the planning brief decides the turn

`buildTripPlannerPlanningBrief(summaryContext + latestContextPatch, tripPlanner, subtask)` decides:

**Render mode**
- No destination → `discovery_cards`.
- `lastPlanSnapshot` destination differs from the current destination → `compact_full` (a new destination).
- `lastPlanSnapshot` exists and the subtask does not ask for a full, complete, whole, entire, new or fresh plan or itinerary, "start over", "from scratch" or "re-plan" → `compact_patch`.
- Otherwise → `compact_full`.

**Images**
- In a patch without photo or visual wording → `not_needed`.
- No destination → `call_after_selecting_suggestions`.
- A destination without a resolvable code → `resolve_code_before_call`.
- A cached image for the code → `reuse`.
- Otherwise → `call`.

**Questions**
- Missing high-impact details minus already-asked keys.
- Discovery allows only `destination`. A patch allows at most 1. A full plan allows 2 when more than one is missing, otherwise 1.

**Constraints**
- `effective_days`: `duration_days`, else the date range, else 4.
- Pace caps: relaxed 2, balanced 3, fast-paced 4 main activities per day.
- Light first and last days when the origin or return date is known.
- A daily budget reference.

### 5.8 Where the paths are hard-coded

| Path | Accessed in |
|---|---|
| `state.summaryContext` | `ensureTripPlannerState` (rewrites it), `prepareTripPlannerTurn`, `applyTripPlannerContextUpdate`, `applyTripPlannerSuggestedQuestionsUpdate`, `finalizeTripPlannerTurn`, `refreshTripPlannerPlanningBrief`, `clearTripPlannerSummaryFields`, `invalidateTripPlannerKnowledge`, `setTripPlannerLastPlanArtifact`, `getTripPlannerContextDetails`, `buildTripPlannerDynamicContext`, `buildManagerInstructions` (Manager) |
| `state.tripPlanner` | `ensureTripPlannerState`, all lifecycle and store functions above, `buildTripPlannerDynamicContext`, `getTripPlannerContext`/`getTripPlannerState` (every tool and `isEnabled`), `sanitizeTripPlannerManagerOutput`, `getTripPlannerFormattingRules`, `buildManagerInstructions` (`lastPlanArtifact.id`) |
| `state.requestId`, `state.sessionId`, `state.currentUserMessage` | `agent_start` hook, `applyTripPlannerContextUpdate`, `applyTripPlannerSuggestedQuestionsUpdate`, `withTripPlannerSessionLock`, `recordToolCall` (logs) |

---

## 6. End-to-end trace

The values below come from running the real functions and tools (`hydrateGatewayContext`, `buildGatewayContext`, `prepareTripPlannerTurn`, tool `invoke`, `sanitizeTripPlannerManagerOutput`, `finalizeTripPlannerTurn`, `snapshotGatewayContext`) with a scripted model side. Request time: 2026-10-14, Asia/Kolkata.

### Turn 1: "Plan a relaxed 3-day trip to Rome for 2 of us next month, we love food"

| # | Where | What happens | State afterwards |
|---|---|---|---|
| 1 | `server.ts` → `JsonChatStore.createChat` | New chat; `chatId` created | `runtimeContext = { flight: {}, tripPlanner: {}, flightSearchRuntime: null }` |
| 2 | `orchestrator.ts` `streamChatTurn` | `requestId`, `traceId`, `turnId`; Manager conversation session | n/a |
| 3 | `context-hydration.ts` `hydrateGatewayContext` | Clone, Flight init, Trip summary seeded from the empty legacy summary | Keys: `flight`, `tripPlanner`, `flightSearchRuntime`, `toolCallLog`, `summaryContext` (all 11 Trip keys empty or null) |
| 4 | `runner.ts` `buildGatewayContext` → `createRequestClock` → `createRequestContext` | Runtime values set; wrapper built | `requestId: 'req-1'`, `sessionId: 'chat-1'`, `currentUserMessage: '<message>'`, `tripPlanner: {}` |
| 5 | `mainChatRunner.run(ManagerAgent)`; `buildManagerInstructions` | Manager prompt shows "Previous trip plan available: no"; Manager calls `trip_planner_agent({ input })` | n/a |
| 6 | SDK fork → `agent_start` → `prepareTripPlannerTurn` | Turn reset | `turnState { requestId: 'req-1', baseRevision: 0, contextCaptured: false, … }`, `scopeClassification { mode: 'in_scope' }` |
| 7 | Trip model call 1 | Prompt below; tools: `update_trip_planner_context`, `web_search` | n/a |
| 8 | `update_trip_planner_context` (Section 4.1) | Patch merged | `summaryContext`: `pax 2`, `destination Rome/ROM`, `duration_days 3`, `tripType [relaxed, couple, food]`; `tripPlanner`: `dateHint 'November 2026'`, `contextRevision 1`, `contextCaptured: true`, `preferenceSignals.positive [relaxed, couple, food]` |
| 9 | Trip model call 2 | Planning prompt below; tools: `get_place_images_batch`, `web_search`, `update_trip_planner_suggested_questions` | n/a |
| 10 | `get_place_images_batch({ itemCodes: ['ROM'] })` | Image looked up and cached | `placeImageCache.ROM = { itemCode: 'ROM', imageUrl: 'https://images.example.test/rome.jpg', isFallback: false, cached: false }` |
| 11 | No `web_search` | Nothing time-sensitive was requested | n/a |
| 12 | `update_trip_planner_suggested_questions` | Three chips stored | `summaryContext.suggestedQuestions` set; `contextRevision 2`; `suggestionsUpdated: true` |
| 13 | Final typed output → `sanitizeTripPlannerManagerOutput` | Passes; `formattingRules` attached (`maxBodyWords 350`, `questionPriority ['budget']`, `cardPolicy 'render_once'`, …) | `storePlanArtifact: true` |
| 14 | `finalizeTripPlannerTurn` | Plan stored | `lastPlanArtifact.id 'plan_2'`, 3 days; `lastPlanSnapshot { destination: Rome/ROM }`; `askedQuestionKeys ['budget']` |
| 15 | Manager composes the reply; `runGatewayAgent` link-sanitizes it; `snapshotGatewayContext` | Persisted | `runtimeContext.tripPlanner` keys: `contextRevision`, `dateHint`, `preferenceSignals`, `askedQuestionKeys`, `placeImageCache`, `lastPlanArtifact`, `lastPlanSnapshot` |

Prompt at step 7 (`<turn_rules>` omitted):

```text
<turn_clock>
today=2026-10-14|time_zone=Asia/Kolkata
</turn_clock>

<trip_state revision=0>
knowledge=places:0,events:0
last_plan=none
</trip_state>

<turn_plan>
phase=context_capture
required_first_tool=update_trip_planner_context
context_payload=only_explicit_or_clearly_implied_user_changes
unchanged_fields=preserve
</turn_plan>
```

Prompt at step 9:

```text
<trip_state revision=1>
destination=ROM|Rome
duration_days=3
pax=2
tripType=relaxed,couple,food
date_hint=November 2026
knowledge=places:0,events:0
last_plan=none
</trip_state>

<turn_plan>
phase=planning
scope=in_scope
changed=pax,destination,duration_days,tripType,date_hint
completed=traveler_count,destination,duration,dates,relaxed,pace,couple,party,food
render=compact_full|target_words:300|max_words:350
format=effective_days:3|block_words:18|max_patch_days:0|max_questions:1
cards=render_once|season=one_relevant_trip_season_note|budget=compact_two_column_table
pace=relaxed|max_anchors:2|max_areas:1
day_shape=first:standard|last:standard
patch=party,destination,dates_or_duration,pace,preferences,food
questions=budget
tools=images:call|codes=ROM,contextDetails:not_needed,webSearch:agent_decides,suggested_questions:always_last
</turn_plan>
```

### Turn 2: "Make day 2 lighter, skip the Colosseum"

| # | Where | What happens | State afterwards |
|---|---|---|---|
| 1 | `hydrateGatewayContext` | `runtimeContext.summaryContext` and the durable `tripPlanner` restored | `last_plan=plan_2`, `image_cache=ROM` |
| 2 | Manager → `trip_planner_agent({ input: 'For the Rome plan, make day 2 lighter and skip the Colosseum' })` | Subtask names the destination and the day | n/a |
| 3 | `prepareTripPlannerTurn` | Turn reset | `previousSuggestedQuestions` = turn 1 chips; `baseRevision 2` |
| 4 | `update_trip_planner_context({ baseRevision: 2, contextPatch: null, clearFields: null })` | Nothing changed | Output `{ status: 'SUCCESS', revision: 2, changedFields: [], responseMode: 'compact_patch' }`; revision not incremented |
| 5 | Planning prompt | `render=compact_patch\|target_words:130\|max_words:160`, `format=…\|max_patch_days:1\|max_questions:0`, `patch=day_2`, `questions=none`, `tools=images:not_needed,contextDetails:call\|sections=last_plan,…`; tools: `web_search`, `get_trip_planner_context_details`, `update_trip_planner_suggested_questions` | n/a |
| 6 | `get_trip_planner_context_details({ sections: ['last_plan'], query: 'day 2' })` (Section 4.2) | Saved day 2 returned | `currentTurnToolCalls` holds the capture and the details read |
| 7 | Suggestions stored; model returns `compact_patch` facts: day 2 `{ title: 'Easy Ancient Rome', morning: 'Slow breakfast and a Monti walk', afternoon: null, evening: null }` plus a `change` note | The guard passes; it enforces ≤1 day, only `day_2`, no cards, no questions | `contextRevision 3` |
| 8 | `finalizeTripPlannerTurn` → `setTripPlannerLastPlanArtifact` | Same destination, so the patch merges into the saved plan | `lastPlanArtifact.id 'plan_3'`: day 2 has the new title and morning and keeps its afternoon and evening; days 1 and 3 and the card are unchanged; notes now hold the earlier `assumption` and the new `change` |

### Edge cases seen in the same run

- **Stale revision.** `baseRevision: 0` when the turn started at 2 returns `{ ok: false, status: 'REVISION_CONFLICT', revision: 2, rejectedFields: ['baseRevision'] }`. Nothing is applied.
- **Destination change plus an excluded preference.** `{ destination: Paris/PAR, tripType: { add: ['hotel stays'] } }` returns `{ ok: true, status: 'PARTIAL', revision: 3, changedFields: ['destination'], rejectedFields: ['tripType.add'] }`. Afterwards:
  - `lastPlanArtifact: null` and `placeImageCache: {}` (no PAR image yet).
  - `lastPlanSnapshot` still says Rome, so the next plan renders as `compact_full`.
  - Visible tools: `get_place_images_batch`, `web_search`, `update_trip_planner_suggested_questions`.
- **Discovery, then selection.**
  - The subtask "Suggest relaxed food destinations in Europe for 4 days" with no destination gives `render=discovery_cards` and `images:call_after_selecting_suggestions`.
  - One image batch for ROM, PAR and LON, then three cards and one destination question, stores an artifact with 3 cards, 0 days and destination `{ city: null, iata: null }`.
  - The next subtask "Plan the first one, Rome" is captured with `destination: Rome/ROM`. It returns `SUCCESS` with `changedFields: ['destination']` and `responseMode: 'compact_full'`, the artifact becomes `null`, and `placeImageCache` keeps only `ROM`.
  - The new `turn_plan` shows `render=compact_full` and `tools=images:reuse|codes=ROM,…`.

---

## 7. Production integration guidance

### 7.1 Required Trip behavior

Production must reproduce these behaviors. The Trip module in Section 1 implements all of them.

1. **Per-invocation preparation.** Each `trip_planner_agent` call starts with `prepareTripPlannerTurn` on the scoped subtask, before the prompt or tools are evaluated.
2. **Phase gating in code.** Capture comes first and only once. The planning tools appear only after capture, and suggestions come last. There are attempt caps, and only the prompt restricts the hosted `web_search`.
3. **State rendered into the prompt** on every model call: `<turn_clock>`, `<trip_state>`, `<turn_plan>`, `<turn_rules>`.
4. **Planning decisions derived from state** (`buildTripPlannerPlanningBrief`): render mode, tool strategy, question intents, pacing and duration.
5. **Typed output and application-side validation** (`sanitizeTripPlannerManagerOutput`). The application attaches formatting rules; the model never writes them.
6. **Finalize.**
   - Clear chips that were not refreshed.
   - Record asked-question keys.
   - Store or merge the plan only for useful, in-scope results.
   - Never erase a saved plan on a failure.
7. **Revision checks** on both update tools.
8. **Invalidation** of saved plan, places, events and images on a destination change, and of events on a date change.
9. **Scope policy.** Excluded topics are never stored as preferences, chips or facts.
10. **Persistence** of `summaryContext` and the seven durable `tripPlanner` fields between turns, including after failed turns.

### 7.2 Required context reads

| Read | Source meaning | By | When |
|---|---|---|---|
| Trip facts | Section 5.2 | `buildTripPlannerDynamicContext`, brief, context tool | Every model call; capture |
| Durable Trip state | Section 5.3 | Prompt, brief, guard, details tool | Every model call; planning |
| Saved itinerary, places, events | `lastPlanArtifact`, `placesOfInterest`, `upcomingEvents` | `get_trip_planner_context_details` | Planning, when `contextDetails` is `call` or `agent_decides` |
| Turn clock | Request time and traveler time zone | `buildTripPlannerDynamicContext` (`<turn_clock>` line) | Every model call |
| Identifiers | `requestId`, `sessionId` | Lifecycle, lock, logs | Every invocation |
| Manager routing state | `summaryContext` origin, destination, dates, duration; `lastPlanArtifact.id` | `buildManagerInstructions` | Every Manager model call, if production's Manager uses the same prompt |

### 7.3 Required context updates

| Update | Written by | When |
|---|---|---|
| Changes to trip facts and preferences; `dateHint`; invalidation | `update_trip_planner_context` → `applyTripPlannerContextUpdate` | First tool of every invocation |
| `placeImageCache` | `get_place_images_batch` | Planning, when images are `call` or `call_after_selecting_suggestions` |
| `summaryContext.suggestedQuestions`, `contextRevision` | `update_trip_planner_suggested_questions` | Last tool of every invocation |
| `lastPlanArtifact`, `lastPlanSnapshot`, `askedQuestionKeys`; chips cleared if not refreshed | `finalizeTripPlannerTurn` (application) | After the output passes the guard |
| Persist Trip facts and durable fields | Production persistence (local: `snapshotGatewayContext`) | After the run, success or failure |

### 7.4 Where the two context tools fit

```text
prepareTripPlannerTurn ─► [prompt: trip_state + turn_plan(phase=context_capture)]
  ─► update_trip_planner_context            (writes what the subtask changed; unlocks planning)
  ─► [prompt: refreshed trip_state + turn_plan(phase=planning, tools=…)]
  ─► get_trip_planner_context_details       (only if tools says contextDetails:call / agent_decides)
  ─► get_place_images_batch / web_search    (as tools says / when a current fact is needed)
  ─► update_trip_planner_suggested_questions (mandatory last)
  ─► typed facts ─► sanitize ─► finalizeTripPlannerTurn (stores the plan) ─► JSON to the Manager
```

### 7.5 Local-only: do NOT copy

- **Local API infrastructure:** `src/api/chat/*`, including `JsonChatStore` and `data/chats.json`, the per-chat busy lock, the SSE writer and events, and the dashboard.
- **Local initialization:**
  - `createEmptySummaryContext` (legacy chat-summary shape), and the legacy seeding and Flight hydration in `hydrateGatewayContext`.
  - `buildGatewayContext` as a whole. Its Flight preparation and Flight suggestion bookkeeping are Flight's. Only `requestId`, `sessionId` and `currentUserMessage` matter to Trip.
  - The `runGatewayAgent` defaults, including `sessionId: 'default'`.
- **Standalone Trip:**
  - The runner `runTripPlannerAgent`, its in-memory context map, `BoundedTripPlannerMemorySession` and `configureTripPlannerSessionFactory`.
  - The text agent `TripPlannerAgent` and `TRIP_PLANNER_STANDALONE_PRESENTATION`.
  - `sanitizeTripPlannerOutput`, `sanitizeTripPlannerFinalOutput` and its `DISCOVERY_CARD_COPY` fallback.
  - The `ObservedModelProvider` usage collection.
- **Placeholders and legacy helpers:**
  - The dummy image URLs in `GetPlaceImagesBatchTool` (`images.example.test`).
  - The unused legacy helper `updateTripPlannerSuggestedQuestions` in `context-tools.ts`. The tool uses `applyTripPlannerSuggestedQuestionsUpdate`.
  - Test helpers and fake models.

### 7.6 Adapting to production's API-request initialization

Production receives the API request first. For each request, before running the Manager:

1. Take a unique per-turn id from the request, or generate one, as `requestId`. Take production's conversation id as `sessionId`. Take the user's message as `currentUserMessage`.
2. Build the Trip-shaped `summaryContext` (Section 5.2) from production's stored trip data, wherever production keeps it. For a new conversation, use empty values: `null` scalars, `{ city: null, iata: null }` endpoints, empty arrays.
3. Restore the seven durable `tripPlanner` fields (Section 5.3) from wherever production persists Trip state, or use `{}`.
4. Create the clock from the request time and the traveler's time zone with `createRequestClock({ now, timeZone })`, and wrap the state with `createRequestContext(state, clock)`.
5. Run the Manager with `context: requestContext` and serial tool execution: `toolExecution: { maxFunctionToolConcurrency: 1 }` and `parallelToolCalls: false`.
6. After the run, on success and on failure:
   - Read `state.summaryContext` and the seven durable `tripPlanner` fields and store them in production's own schema.
   - Return `summaryContext.suggestedQuestions` to the client as Trip's chips.

### 7.7 Preserving production's existing schema

- Trip reads and writes `state.summaryContext` and `state.tripPlanner` by fixed paths (Section 5.8). Production does not have to store data under those names.
- Locally, the mapping happens at the boundary. `hydrateGatewayContext` builds the Trip-shaped object from the stored record (for example, legacy `passengerData.total` becomes `pax`), and `snapshotGatewayContext` selects what to save.
- Production can map the same way from its own fields before the run and back after it, without changing its persisted schema.
- The alternative is to change every access point in Section 5.8.
- **Check before integrating.** `ensureTripPlannerState` replaces `state.summaryContext` with the 11-key Trip object during every Trip call (Section 2.3). If production's run state uses the key `summaryContext` for anything else, such as a passenger breakdown or Flight data, that data is dropped from the run state while Trip runs.
- Field semantics are listed in Section 5. Mapping by meaning matters more than mapping by name. For example, production may store pace, party type and interests separately, while local keeps them all in `tripType[]`.

### 7.8 Known caveats in the local implementation

| # | Caveat | Effect |
|---|---|---|
| C1 | Per-request duplicate checks (`lastContextUpdateRequestId`, `lastSuggestionsUpdateRequestId`) fire when the Manager calls Trip **twice in the same request** | Reproduced locally. On the second call, capture returns `ALREADY_UPDATED`, the new values are not applied, `contextCaptured` stays false and the planning tools stay hidden. The suggestions check returns `ALREADY_UPDATED` without setting `suggestionsUpdated`, so finalize clears the first call's chips (3 → 0). Within a single call the checks are unreachable, because the tool wrappers and `isEnabled` stop repeats first |
| C2 | The hosted `web_search` is visible during `context_capture` | Only the prompt makes capture come first |
| C3 | `get_place_images_batch` returns dummy URLs | Production needs a real image source that keeps the `placeImageCache` contract, because the guard compares card URLs with the cache |
| C4 | `lastPlanArtifact.content` duplicates the structured facts | The details tool returns it (≤2,000 chars) alongside the structured fields |
| C5 | `withTripPlannerSessionLock` locks within one process only | Production running several instances needs its own per-conversation serialization if one conversation can run concurrently |
| C6 | No Trip tool writes `placesOfInterest` or `upcomingEvents` | In the local Manager flow they come only from legacy chat summaries (summary extraction is disabled), so the `places` and `events` sections are usually empty |
| C7 | The local SSE `done` event does not carry Trip's chips | They are only in `runtimeContext.summaryContext.suggestedQuestions` |
| C8 | If the nested Trip run throws, finalize does not run | Changes already applied by the capture tool stay and are persisted with the failed turn. Chips are not cleared. The previous plan is kept (Section 3.7) |

### 7.9 Verification checklist

These local deterministic tests exercise the behavior above without model calls:

| Test file | Covers |
|---|---|
| `tests/unit/trip-planner-agent.test.ts` | Brief rules, tools, invalidation |
| `tests/unit/trip-planner-manager-output.test.ts` | Output guard |
| `tests/unit/trip-planner-structured-store.test.ts` | Artifact merge |
| `tests/integration/manager-trip-output.test.ts` | Manager-mode Trip output and the saved artifact |
| `tests/integration/manager-specialist-registration.test.ts` | Manager to Trip through the SDK with a fake model |
| `tests/integration/chat-api.test.ts` | Persistence of the durable fields |

Expected values from the Section 6 trace:

1. After prepare, the only visible function tool is `update_trip_planner_context`.
2. After capture of a new plan: `get_place_images_batch` and `update_trip_planner_suggested_questions`. For a revision of a saved plan: `get_trip_planner_context_details` and `update_trip_planner_suggested_questions`.
3. Revisions in turn 1: capture 0 → 1, suggestions 1 → 2, plan id `plan_2`.
4. A capture with `contextPatch: null` keeps the revision unchanged. A day-2 patch merges into the saved plan, and its `null` blocks keep the saved blocks.
5. A destination change clears the artifact, prunes the image cache to the new destination's entry, keeps `lastPlanSnapshot`, and the next render is `compact_full`.
6. Only the seven durable `tripPlanner` fields are persisted.
