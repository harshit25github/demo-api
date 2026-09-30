# Trip Planner Agent Integration Guide

Ye document current Trip Planner implementation ko explain karta hai: agent ka scope,
context lifecycle, dynamic prompt, tools, integration points, debugging, aur production
safeguards.

> **Scope note:** VAST Images tool pehle se available hai, isliye uski integration
> details is document mein intentionally skip ki gayi hain.

---

## 1. Agent Overview

### Trip Planner kya karta hai?

Trip Planner ek mobile-first travel planning agent hai. Iski main responsibilities:

- Destination ideas dena.
- Day-wise itinerary banana aur refine karna.
- Places, attractions, food, aur activities suggest karna.
- User ke dates, duration, pax, budget, interests, aur pace ko use karna.
- Existing itinerary mein focused changes karna.
- Current information ke liye zarurat par hosted web search use karna.
- Har turn ke baad planner context aur exactly 3 suggested questions maintain karna.

Agent ka model currently `gpt-5.2` hai. Default configuration:

```js
{
  model: 'gpt-5.2',
  maxTurns: 8,
  timeoutMs: 120_000,
  modelSettings: {
    toolChoice: 'auto',
    parallelToolCalls: false,
    reasoning: { effort: 'low' },
    text: { verbosity: 'low' }
  }
}
```

Configuration source:
`src/agents/trip-planner/agent.ts`

### Agent kya own karta hai?

Agent khud:

1. User ke natural-language message ko samajhta hai.
2. Existing `summaryContext` ke saath latest message merge karne ke liye structured
   payload banata hai.
3. Required planning tools select karta hai.
4. Response mode follow karta hai: discovery, full plan, ya patch.
5. Final response se pehle exactly 3 relevant suggested questions banata hai.

Tools raw user text ka meaning infer nahi karte. Tools sirf structured payload validate,
store, ya return karte hain.

### Strictly out of scope

Trip Planner ko in topics ko handle, recommend, persist, ya suggest nahi karna chahiye:

- Hotels ya accommodation.
- Cars ya vehicles.
- Commute ya local transport.
- Cab, taxi, metro, transit, ya getting-around guidance.
- Airport transfers.
- Rentals.
- Bus/train booking, schedules, routes, ya tickets.

Mixed request mein sirf itinerary-related in-scope part answer hota hai. Purely excluded
request ke liye deterministic fallback hai:

```text
I can help with day-wise itineraries, places, food, activities,
trip pace, and budget-friendly planning.
```

Scope policy:
`src/agents/trip-planner/scope-policy.ts`

---

## 2. End-to-End Flow

### High-level flow

```text
User message
  |
  v
Load/create app context and bounded session
  |
  v
Hydrate + normalize summaryContext
  |
  v
prepareTripPlannerTurn()
  - stores current user message
  - classifies request scope
  - starts revision-aware turn state
  - creates provisional planning brief
  |
  v
Dynamic prompt: phase=context_capture
  |
  v
update_trip_planner_context (mandatory first tool)
  - agent sends structured changes
  - tool validates and merges changes
  - old values are preserved
  - dynamic planning brief is refreshed
  |
  v
Dynamic prompt is evaluated again: phase=planning
  |
  v
Optional planning tools
  - validate_trip_date
  - web_search
  - get_trip_planner_context_details
  - existing image tool when required
  |
  v
update_trip_planner_suggested_questions (mandatory last tool)
  |
  v
Agent produces final user-facing response
  |
  v
Scope guardrail -> no-link sanitizer
  |
  v
finalizeTripPlannerTurn()
  - clears stale suggestions if update failed
  - tracks asked questions
  - stores last plan artifact
  - returns final summaryContext + revision
```

### Important ordering

Normal completed Trip Planner turn ka expected order:

```text
update_trip_planner_context
-> optional planning tools
-> update_trip_planner_suggested_questions
-> final text
```

`update_trip_planner_context` first hona mandatory hai.  
`update_trip_planner_suggested_questions` final tool call hona mandatory hai.

### Standalone runner lifecycle

`runTripPlannerAgent()`:

1. Stable `sessionId` ke basis par session/context load karta hai.
2. Incoming `context.summaryContext` aur direct `summaryContext` merge karta hai.
3. `prepareTripPlannerTurn()` call karta hai.
4. Agent ko streaming mode mein run karta hai.
5. Tool calls ko execution order mein capture karta hai.
6. Final output par scope aur no-link guardrails apply karta hai.
7. `finalizeTripPlannerTurn()` call karta hai.
8. Updated `context`, `summaryContext`, debug data, aur response return karta hai.

Source:
`src/agents/trip-planner/runner.ts`

---

## 3. Prompt Structure

### Base prompt

Static Trip Planner prompt:

```js
TRIP_PLANNER
```

Location:
`src/agents/flight/prompt.ts`

Base prompt define karta hai:

- Agent identity aur scope.
- Context-capture ownership.
- Planning intelligence.
- Mobile response limits.
- Cards format.
- Full itinerary aur patch format.
- Tool ordering.
- Current-information rules.
- No-link rules.
- Suggested-question rules.
- Privacy aur hidden-state guardrails.

### Dynamic prompt

Dynamic instructions builder:

```js
buildTripPlannerInstructions(runContext)
```

Internally:

```js
TRIP_PLANNER + buildTripPlannerDynamicContext(runContext)
```

Location:
`src/agents/trip-planner/agent.ts`

`Agent` registration:

```js
export const TripPlannerAgent = new Agent({
  name: 'Trip Planner Agent',
  instructions: buildTripPlannerInstructions,
  model: tripPlannerAgentConfig.model,
  modelSettings: tripPlannerAgentConfig.modelSettings,
  tools: tripPlannerTools
});
```

Instructions function har model step par current `RunContext` se dynamic state banata hai.
Isliye first context tool ke baad updated state next model step mein visible hoti hai.

### Response modes

Response mode deterministic planning brief se decide hota hai:

| Condition | Render mode | Expected output |
|---|---|---|
| Destination missing | `discovery_cards` | Exactly 3 destination cards |
| New destination / normal plan | `compact_full` | Complete compact itinerary |
| Existing plan + adjustment | `compact_patch` | Sirf changed days/sections |

Limits:

- `discovery_cards`: max 90 prose words.
- `compact_full`: max 350 prose words.
- `compact_patch`: max 160 prose words.
- Full plan mein har day ke Morning/Afternoon/Evening blocks required hain.
- Patch response unchanged itinerary repeat nahi karta.

### No-link rules

Final Trip Planner response mein allowed nahi hai:

- Raw `http://`, `https://`, ya `www` URLs.
- Markdown links.
- HTML anchor links.
- Web-search citation links.
- Bare domains.

Current source ko plain name se mention kiya ja sakta hai, jaise:

```text
According to the official tourism board...
```

Image URL ki only exception exact `:::cards` block ke `image:` field mein hai.

Implementation:

- `src/shared/text/link-sanitizer.ts`
- `src/agents/trip-planner/scope-policy.ts`

### Image/card rules

VAST Images integration details is document mein skip hain. Response contract phir bhi
important hai:

```text
:::cards
[CARD]
title: City, Country
image: tool-returned URL
known_for: Short description
weather: Relevant grounded/general note
budget: Grounded tier or unavailable
[/CARD]
:::cards
```

Rules:

- Opening aur closing marker exactly `:::cards`.
- All cards ek hi block mein.
- Discovery mein exactly 3 cards.
- Full itinerary mein destination card maximum once.
- Card data ko prose destination summary mein duplicate nahi karna.
- Patch response mein card normally omit hota hai.

### Suggested-question rules

- Exactly 3 suggestions.
- Har suggestion 3-8 words.
- User-side action wording.
- Previous suggestions ka exact stale repeat nahi.
- Same turn mein completed action repeat nahi.
- Known fields ko dobara provide/change karne ki suggestion nahi.
- Excluded-scope topic kabhi nahi.
- Tool final tool call hota hai.

---

## 4. Dynamic Prompt and Context Injection

### Dynamic context kaun banata hai?

Primary serializer:

```js
buildTripPlannerCompactContext()
```

Location:
`src/agents/trip-planner/context/serializer.ts`

Planning decisions:

```js
buildTripPlannerPlanningBrief()
```

Location:
`src/agents/trip-planner/context/summary-context.ts`

### Actual production summary context schema

```ts
type TripPlannerSummaryContext = {
  pax: number | null;

  budget: {
    total: number | null;
    amount: number | null;
    currency: string | null;
    per_person: boolean | null;
  };

  origin: {
    city: string | null;
    iata: string | null;
  };

  destination: {
    city: string | null;
    iata: string | null;
  };

  tripType: string[];

  outbound_date: string | null;
  return_date: string | null;
  duration_days: number | null;

  upcomingEvents: any[];

  placesOfInterest: {
    placeName: string | null;
    description: string | null;
  }[];

  suggestedQuestions: string[];
};
```

Normalization:

```js
createTripPlannerSummaryContext(value)
```

### Prompt mein kaunse fields inline jaate hain?

Compact `<trip_state>` mein:

| Field | Reason |
|---|---|
| `revision` | Safe optimistic context updates |
| `origin` | Existing departure context preserve karna |
| `destination` | Plan/discovery mode decide karna |
| `outbound_date`, `return_date` | Date-aware itinerary |
| `duration_days` | Number of itinerary days |
| `pax` | Party-size personalization |
| compact `budget` | Cost tier, basis, daily reference |
| `tripType` | Journey, party, pace, interests |
| internal `date_hint` | Unresolved phrase, e.g. `next month` |
| place/event counts | Detail availability signal |
| cached image reference | Duplicate image calls avoid karna |
| `last_plan` reference | Patch continuity |

### Planning phase mein additional compact values

`<turn_plan>` mein:

- Scope: `in_scope`, `mixed`, ya `excluded`.
- Latest changed fields.
- Current turn ke completed intent categories.
- Render mode aur word limits.
- Card, season, aur budget policies.
- Pace aur day-shape constraints.
- Patch targets.
- Allowed question priorities.
- Per-tool action: `call`, `reuse`, ya `not_needed`.
- Previous 3 suggestions.

### Kya inject nahi hota?

Token efficiency ke liye prompt mein ye full data inject nahi hota:

- Full `summaryContext` JSON.
- Full `upcomingEvents` array.
- Full `placesOfInterest` array.
- Full previous itinerary.
- Historic tool outputs.
- Full tool-call history.
- Request/session metadata.
- Large caches.

Large sections ke liye sirf count/reference inline hota hai. Zarurat par
`get_trip_planner_context_details` use hota hai.

Current token estimate:

```js
estimateTripPlannerContextTokens(text)
```

Ye rough `characters / 4` estimate use karta hai. Production target approximately
800 dynamic-context tokens se neeche rakhna chahiye.

### Internal Trip Planner state

`context.tripPlanner` public summary schema ka part nahi hai. Ismein orchestration state
stored hoti hai, jaise:

- `contextRevision`
- `currentUserMessage`
- `dateHint`
- `latestContextPatch`
- `latestPreferenceSignals`
- `preferenceSignals`
- `scopeClassification`
- `planningBrief`
- `turnState`
- `previousSuggestedQuestions`
- `dateValidationState`
- `placeImageCache`
- `lastPlanArtifact`
- `lastPlanSnapshot`
- `askedQuestionKeys`
- current-turn tool records

Client/UI ko normally `context.summaryContext` consume karna chahiye. Internal state ko
model-visible full JSON ke form mein expose nahi karna chahiye.

---

## 5. Tool Documentation

VAST Images tool intentionally omitted hai.

### 5.1 `update_trip_planner_context`

**Purpose:** Latest user message ko agent ke prepared structured patch ke through
context mein merge karna.

**Trigger:** Har Trip Planner turn ka mandatory first tool, jab
`phase=context_capture`.

**Input schema:**

```ts
{
  baseRevision: number;
  contextPatch?: {
    pax?: number | null;
    budget?: {
      total?: number | null;
      amount?: number | null;
      currency?: string | null;
      per_person?: boolean | null;
    } | null;
    origin?: {
      city?: string | null;
      iata?: string | null;
    } | null;
    destination?: {
      city?: string | null;
      iata?: string | null;
    } | null;
    outbound_date?: string | null; // YYYY-MM-DD
    return_date?: string | null;   // YYYY-MM-DD
    duration_days?: number | null;
    tripType?: {
      add?: string[] | null;
      remove?: string[] | null;
    } | null;
    date_hint?: string | null;
  } | null;
  clearFields?: (
    | "pax"
    | "budget"
    | "origin"
    | "destination"
    | "outbound_date"
    | "return_date"
    | "duration_days"
    | "tripType"
    | "date_hint"
  )[] | null;
}
```

**Output shape:**

```ts
{
  ok: boolean;
  status:
    | "SUCCESS"
    | "PARTIAL"
    | "ALREADY_UPDATED"
    | "REVISION_CONFLICT";
  revision: number;
  changedFields: string[];
  rejectedFields: string[];
  responseMode?: string;
  messageForAgent: string;
}
```

**Reads:**

- Current context revision.
- Existing `summaryContext`.
- Current turn/request id.

**Updates:**

- Supported `summaryContext` fields.
- Internal `dateHint`.
- Preference signals.
- Context revision.
- Fresh planning brief.
- Destination/date-sensitive cached state.

**Example call:**

```json
{
  "baseRevision": 4,
  "contextPatch": {
    "pax": 2,
    "tripType": {
      "add": ["couple", "relaxed"]
    }
  },
  "clearFields": null
}
```

**Example response:**

```json
{
  "ok": true,
  "status": "SUCCESS",
  "revision": 5,
  "changedFields": ["pax", "tripType"],
  "rejectedFields": [],
  "responseMode": "compact_patch",
  "messageForAgent": "Context capture is complete. Continue the trip-planning task using the refreshed trip_state, then update suggested questions last."
}
```

**Failure behavior:**

- Wrong revision: `REVISION_CONFLICT`; latest revision ke saath one retry.
- Excluded preference: field reject hota hai aur result `PARTIAL` ho sakta hai.
- Same request id dobara: `ALREADY_UPDATED`.
- Tool user text parse nahi karta.

---

### 5.2 `validate_trip_date`

**Purpose:** Exact date ya vague month/event intent ko validate karna aur batana ki web
search required hai ya optional.

**Trigger:** Sirf jab `turn_plan.tools.dateValidation` action `call` ho.

**Input schema:**

```ts
{
  candidateDate?: string | null; // Full YYYY-MM-DD only
  eventKeyword?: string | null;  // Month/event/destination wording
}
```

**Typical output statuses:**

- `valid_exact_date`
- `valid_month_range`
- `event_requires_search`
- `needs_clarification`

Common output fields:

```ts
{
  ok: boolean;
  status: string;
  feedback: "OK" | "SEARCH_OPTIONAL" | "SEARCH_REQUIRED";
  validatedDate?: string;
  startDate?: string;
  endDate?: string;
  searchQuery?: string;
  messageForAgent: string;
  cached: boolean;
  isDummy: true;
}
```

**Reads:**

- Prior `dateValidationState`.
- Current planning strategy.

**Updates:**

- `context.tripPlanner.dateValidationState`.
- Tool-call logs.

**Example call:**

```json
{
  "candidateDate": null,
  "eventKeyword": "Oktoberfest Munich"
}
```

**Example response:**

```json
{
  "ok": true,
  "status": "event_requires_search",
  "feedback": "SEARCH_REQUIRED",
  "searchQuery": "Oktoberfest Munich official dates and visitor information",
  "messageForAgent": "Call web_search once with searchQuery, then continue planning.",
  "cached": false,
  "isDummy": true
}
```

**Failure behavior:**

- Invalid exact date: `needs_clarification`.
- Ambiguous wording: general planning continue ya one focused date question.
- Same fingerprint: cached output reuse; duplicate call avoid hota hai.

---

### 5.3 `web_search`

**Purpose:** Fresh/current destination facts retrieve karna.

**Implementation:**

```js
webSearchTool({
  name: 'web_search',
  searchContextSize: 'medium',
  externalWebAccess: true
})
```

Ye OpenAI hosted tool hai, local custom API wrapper nahi.

**Trigger examples:**

- Current events/festivals.
- Temporary closures.
- Latest opening hours.
- Current admission prices.
- Reservation requirements.
- Weather/forecast-sensitive request.
- Current visa/advisory-style information.
- Newly opened places.

Generic itinerary, stable attractions, normal food/activity ideas, ya already grounded
facts ke liye web search nahi call hona chahiye.

**Input/output:**

Hosted tool ka wire schema OpenAI Agents SDK/provider manage karta hai. Agent ek focused
search query/action deta hai; SDK hosted search call aur result items return karta hai.
Application logs normalized tool name, input/action, aur status capture karte hain.

Conceptual example:

```json
{
  "query": "Paris official museum closures September 2026"
}
```

Conceptual successful result:

```json
{
  "status": "COMPLETED",
  "results": [
    {
      "sourceName": "Official museum website",
      "fact": "Current closure information"
    }
  ]
}
```

Actual hosted result provider-defined hota hai; application ko raw links user response
mein copy nahi karne chahiye.

**Reads:**

- Current model turn.
- `turn_plan.tools.webSearch`.
- Date validator feedback where applicable.

**Context updates:**

- Hosted call tool log mein record hota hai.
- Search result current response ko ground karta hai.
- Current implementation automatically `upcomingEvents` ya `placesOfInterest` persist
  nahi karta.

**Failure behavior:**

- Requested current fact confirm na ho to exact current detail invent nahi karni.
- Stable fallback dena hai.
- Relevant official source category name plain text mein mention ki ja sakti hai.
- Links expose nahi karne.

---

### 5.4 `get_trip_planner_context_details`

**Purpose:** Prompt mein inject na kiye gaye saved places, events, ya previous plan ko
on-demand compact form mein read karna.

**Trigger:** Sirf jab `turn_plan.tools.contextDetails` action `call` ho.

**Input schema:**

```ts
{
  sections: ("places" | "events" | "last_plan")[]; // 1-3
  query?: string | null;                            // max 100 chars
  limit?: number | null;                            // 1-10
}
```

**Output schema:**

```ts
{
  ok: true;
  status: "SUCCESS";
  revision: number;
  destination: {
    city: string | null;
    iata: string | null;
  };
  details: {
    places?: {
      placeName: string | null;
      description: string | null;
    }[];
    events?: {
      name?: string;
      date?: string;
      description?: string;
    }[];
    lastPlan?: {
      id: string;
      revision: number;
      responseMode: string | null;
      days: object[];
      content: string;
    } | null;
  };
}
```

**Reads:**

- `summaryContext.placesOfInterest`
- `summaryContext.upcomingEvents`
- `context.tripPlanner.lastPlanArtifact`
- Current destination/revision

**Updates:**

- Summary context mutate nahi hota.
- Sirf tool-call logs update hote hain.

**Example call:**

```json
{
  "sections": ["last_plan"],
  "query": "day 3",
  "limit": 1
}
```

**Example response:**

```json
{
  "ok": true,
  "status": "SUCCESS",
  "revision": 7,
  "destination": {
    "city": "Paris",
    "iata": "PAR"
  },
  "details": {
    "lastPlan": {
      "id": "plan_7",
      "revision": 7,
      "responseMode": "compact_full",
      "days": [
        {
          "day": 3,
          "title": "Montmartre and local food",
          "content": "Compact saved day content"
        }
      ],
      "content": "Compact saved itinerary"
    }
  }
}
```

**Failure behavior:**

- Missing data par requested array empty ya `lastPlan: null`.
- Limit server-side 1-10 clamp hota hai.
- Excluded-scope request mein tool disabled hai.

---

### 5.5 `update_trip_planner_suggested_questions`

**Purpose:** Exactly 3 validated UI follow-up actions store karna.

**Trigger:** Context capture aur saare planning tools ke baad mandatory final tool call.

**Input schema:**

```ts
{
  baseRevision: number;
  suggestedQuestions: [string, string, string];
}
```

**Output schema:**

```ts
{
  ok: boolean;
  status:
    | "SUCCESS"
    | "ALREADY_UPDATED"
    | "INVALID_SUGGESTIONS"
    | "REVISION_CONFLICT"
    | "CONTEXT_NOT_CAPTURED";
  revision: number;
  changedFields: string[];
  rejectedFields: string[];
  issues?: string[];
  messageForAgent: string;
}
```

**Reads:**

- Current revision.
- Previous suggestions.
- Turn context-captured state.

**Updates:**

```js
context.summaryContext.suggestedQuestions
```

Successful change par revision increment hota hai.

**Example call:**

```json
{
  "baseRevision": 5,
  "suggestedQuestions": [
    "Add local food places",
    "Make day three lighter",
    "Show budget friendly activities"
  ]
}
```

**Example response:**

```json
{
  "ok": true,
  "status": "SUCCESS",
  "revision": 6,
  "changedFields": ["suggestedQuestions"],
  "rejectedFields": [],
  "messageForAgent": "Suggested questions are stored. Call no more tools and return the final user response."
}
```

**Failure behavior:**

- 3 se kam/zyada: reject.
- 3-8 words ke bahar: reject.
- Assistant-style wording: reject.
- Duplicate/stale suggestion: reject.
- Excluded-scope intent: entire suggestion update reject.
- `INVALID_SUGGESTIONS` par agent one corrected attempt kar sakta hai.
- Update missing/fail ho to finalizer old suggestions clear karta hai.

---

## 6. Context Update Flow

### Context hydration priority

Standalone runner mein context merge order:

```text
stored session app context
-> incoming context.summaryContext
-> direct summaryContext argument
```

Later non-empty explicit value existing value ko override kar sakta hai. Missing value old
state preserve karta hai.

### Agent owns interpretation

Example:

```text
User: "2 ppl with wife, make it chill"
```

Agent structured payload:

```json
{
  "baseRevision": 2,
  "contextPatch": {
    "pax": 2,
    "tripType": {
      "add": ["couple", "relaxed"]
    }
  },
  "clearFields": null
}
```

Tool ko raw message nahi milta. Tool:

- Regex se `2 ppl` parse nahi karta.
- `wife` ka meaning infer nahi karta.
- `chill` ko keyword map nahi karta.
- Sirf structured values validate aur merge karta hai.

### Preservation rules

- User sirf preference change kare to destination/dates/pax preserved rehte hain.
- User destination change kare to dates/pax/budget preserved rehte hain.
- New city aane par old unmatched IATA retain nahi hota.
- `tripType` journey/party/pace categories mein new value old category value replace kar
  sakti hai.
- Explicit `remove` only named preferences remove karta hai.
- Field clear sirf `clearFields` se hota hai.

### Stale-data invalidation

Destination change:

- `upcomingEvents = []`
- `placesOfInterest = []`
- `lastPlanArtifact = null`
- Old destination image cache remove
- Date validation state clear

Date change:

- `upcomingEvents = []`
- Date validation state clear

Ye behavior `invalidateTripPlannerKnowledge()` mein hai.

### Revision, lock, aur idempotency

- Har durable change `contextRevision` bump karta hai.
- Tool input mein `baseRevision` required hai.
- Wrong revision update reject karta hai.
- Per-session promise lock concurrent mutation serialize karta hai.
- Same request id ka repeat `ALREADY_UPDATED` return karta hai.

### Last plan artifact

Final successful in-scope response se:

```js
context.tripPlanner.lastPlanArtifact
```

banaya jata hai. Ismein compact content, parsed day sections, destination, response mode,
aur revision hota hai. Patch turn mein agent full old response prompt mein inject karne ke
bajay detail tool se required day read kar sakta hai.

### Current persistence boundary

Development standalone runner:

- App context process-local `Map` mein.
- Conversation `BoundedTripPlannerMemorySession` mein.

Production:

- `configureTripPlannerSessionFactory()` se persistent bounded session factory required.
- `summaryContext` aur relevant `context.tripPlanner` durable storage mein persist karna
  integration layer ki responsibility hai.
- Same `sessionId` consistently pass karna zaroori hai.

Important current limitation:

- Context updater `upcomingEvents` aur `placesOfInterest` accept nahi karta.
- Web search results automatically in arrays mein save nahi hote.
- Ye arrays incoming hydrated context ya kisi explicit trusted external enrichment flow se
  aane chahiye.

---

## 7. Suggested Questions Flow

### Turn sequence

```text
Agent completes context capture
-> optional planning tools
-> agent drafts 3 suggestions
-> update_trip_planner_suggested_questions
-> SUCCESS
-> final user-facing response
```

### Storage location

```js
context.summaryContext.suggestedQuestions
```

### Server-side validation

Validator:

```js
validateTripPlannerSuggestedQuestions()
```

Location:
`src/agents/trip-planner/scope-policy.ts`

Validation:

- Exactly 3 strings.
- Each 3-8 words.
- No duplicate.
- No exact previous suggestion.
- No assistant-style prefix, e.g. `Would you like`.
- No excluded-scope pattern.

### Excluded suggestions kaise block hoti hain?

Same centralized scope policy response, preferences, aur suggestions par use hoti hai.
Suggestion mein excluded category detect hone par complete update reject hota hai.

Allowed examples:

- `Add local food places`
- `Make day three lighter`
- `Show budget friendly activities`
- `Add family friendly places`
- `Make the itinerary adventurous`

Suggestions tool fallback questions generate nahi karta. Agent ko one corrected attempt
milta hai. Final failure par stale suggestions clear hoti hain.

---

## 8. Integration Guide

### Main files and responsibilities

| File | Responsibility |
|---|---|
| `instructions.js` | Static Trip Planner prompt |
| `tripPlannerAgent.js` | Agent config, dynamic instructions, tool registration |
| `tripPlannerRunner.js` | Standalone execution, streaming, logging, finalization |
| `tripPlannerContext.js` | Schema normalization, merge, planning brief |
| `tripPlannerContextSerializer.js` | Token-efficient dynamic context |
| `tripPlannerTurnLifecycle.js` | Prepare, structured updates, finalization |
| `tripPlannerContextStore.js` | Revision, invalidation, details, locks, plan artifact |
| `tripPlannerScopePolicy.js` | Scope and suggestion validators |
| `tripPlannerSession.js` | Bounded session memory |
| `tools/tripPlannerTools.js` | Tool schemas and tool wrappers |
| `linkSanitizer.js` | No-link output validation |
| `index.js` | Public exports |

### Standalone integration

```js
import {
  runTripPlannerAgent,
  clearTripPlannerSession,
} from './src/index.ts';

const sessionId = 'user-123-trip-planner';

const result = await runTripPlannerAgent({
  input: 'Make day 3 more relaxed',
  sessionId,
  requestId: crypto.randomUUID(),
  summaryContext: existingSummaryContext,
});

console.log(result.output);
console.log(result.context.summaryContext);
```

Use:

- Stable user/conversation-specific `sessionId`.
- Unique `requestId` per turn.
- Latest persisted `summaryContext` when available.
- Returned `result.context` ko next turn ke durable state ke liye persist karein.

### Full sample context

```js
const existingSummaryContext = {
  pax: 2,
  budget: {
    total: 2400,
    amount: 2400,
    currency: 'USD',
    per_person: false,
  },
  origin: { city: 'Delhi', iata: 'DEL' },
  destination: { city: 'Paris', iata: 'PAR' },
  tripType: ['roundtrip', 'couple', 'balanced', 'cultural', 'food'],
  outbound_date: '2026-09-10',
  return_date: '2026-09-14',
  duration_days: 5,
  upcomingEvents: [],
  placesOfInterest: [],
  suggestedQuestions: [],
};
```

### Tools registration

Tool array:

```js
tripPlannerTools
```

Registered in:

```js
new Agent({
  ...
  tools: tripPlannerTools
})
```

Tool order intentional hai:

1. Context updater.
2. Planning tools.
3. Suggested-question updater.

### Dynamic prompt attachment

```js
instructions: buildTripPlannerInstructions
```

Static prompt ko manually har request mein concatenate karne ki zarurat nahi. Dynamic
instruction function `RunContext` se latest state use karti hai.

### Session integration

Tests/dev ke liye default bounded in-memory session available hai. Production startup par:

```js
configureTripPlannerSessionFactory((sessionId) => {
  return yourPersistentBoundedSession(sessionId);
});
```

Persistent implementation ko:

- Recent 4 user/assistant turns retain karne chahiye.
- Historic paired tool calls/results replay nahi karne chahiye.
- Replayed history approximately 12,000 estimated tokens ke andar rakhni chahiye.

Existing OpenAI credential/config loading repo ke `config.js` flow se hi use karein; secret
ko logs ya documentation output mein expose na karein.

---

## 9. Debug and Run Guide

### Existing example

```powershell
npm run test:trip-planner:live
```

Custom input:

```powershell
node examples/test-trip-planner-agent.js "Plan a relaxed Rome trip"
```

Live commands OpenAI request karte hain. Existing configured environment required hai.

### Deterministic tests

```powershell
npm run test:trip-planner
npm run test:trip-planner:agent-owned-context
npm run test:link-sanitizer
```

### Focused live suites

```powershell
npm run test:trip-planner:agent-owned-context-live
npm run test:trip-planner:mobile-multiturn
npm run test:trip-planner:context-journey
npm run test:trip-planner:web-search
npm run test:trip-planner:context-web-search
```

### Important logs

Standalone runner compact logs:

```text
[SummaryContext][before]
[CurrentUserMessage]
trip_planner.dynamic_context
trip_planner.tool_called
[CurrentAgentResponse]
[LastAgent]
[ToolsCalled]
[WebSearchUsed]
[SummaryContext][after]
trip_planner.final_response
```

Logger secret-like keys redact karta hai:

```text
apiKey, authorization, token, secret -> [redacted]
```

### Debug object inspect karna

`runTripPlannerAgent()` return:

```js
result.debug
```

Useful fields:

```js
{
  inputSummaryContext,
  hydratedSummaryContext,
  inferredContextPatch,
  planningBrief,
  dynamicInstructions,
  toolsCalled,
  webSearchUsed,
  lastAgent,
  streamEventCount,
  summaryContextAfter,
  contextRevision,
  linkGuardrail,
  scopeGuardrail,
  suggestedQuestions,
  usage
}
```

### Per-turn verification checklist

1. `inputSummaryContext` expected old values show kar raha hai?
2. First tool `update_trip_planner_context` hai?
3. `inferredContextPatch` mein sirf latest user changes hain?
4. `summaryContextAfter` unchanged values preserve kar raha hai?
5. Planning mode expected `discovery_cards`, `compact_full`, ya `compact_patch` hai?
6. Web search sirf freshness request par call hua?
7. Last tool `update_trip_planner_suggested_questions` hai?
8. Exactly 3 relevant suggestions stored hain?
9. Scope guardrail unchanged hai?
10. Link guardrail ne unexpected content remove to nahi kiya?

### Tool ordering check

```js
const names = result.debug.toolsCalled.map((call) => call.tool);

console.assert(names[0] === 'update_trip_planner_context');
console.assert(
  names.at(-1) === 'update_trip_planner_suggested_questions'
);
```

### Context before/after check

```js
console.log({
  before: result.debug.inputSummaryContext,
  patch: result.debug.inferredContextPatch,
  after: result.debug.summaryContextAfter,
  revision: result.debug.contextRevision,
});
```

---

## 10. Risks and Safeguards

### 10.1 Large prompt

**Risk:** Full context, arrays, old tool results, aur history inject karne se latency/token
cost badh sakta hai.

**Safeguards:**

- Compact serializer.
- Null/empty values omit.
- Full arrays ki jagah counts.
- Last plan ki jagah reference.
- On-demand context-detail tool.
- Bounded recent session history.
- Dynamic token estimate monitor.

### 10.2 Stale context

**Risk:** Destination/date change ke baad old events, places, image, ya itinerary reuse ho.

**Safeguards:**

- Destination/date change detection.
- `invalidateTripPlannerKnowledge()`.
- Last plan artifact destination/revision aware.
- Current `trip_state` ko authoritative maana jata hai.

### 10.3 Wrong overwrite

**Risk:** Latest short message old valid fields clear kar de.

**Safeguards:**

- Agent sends changed structured values only.
- Missing fields preserve hote hain.
- Clear sirf explicit `clearFields`.
- Revision checks.
- Per-session lock.
- Request idempotency.

### 10.4 Incorrect LLM extraction

**Risk:** Agent messy user input ko wrong structured value mein convert kare.

**Safeguards:**

- Prompt says explicit/clearly implied values only.
- Unknown IATA ko `null` rakhna.
- Vague date ko exact date invent karne ke bajay `date_hint` mein rakhna.
- Tool Zod validation.
- Before/patch/after debug visibility.
- Messy-input live regression suite.

### 10.5 Unnecessary tool calls

**Risk:** Same date/image/details baar-baar fetch hon.

**Safeguards:**

- `turn_plan.tools` per-tool action.
- `call`, `reuse`, `not_needed`.
- Date fingerprint cache.
- Image cache reference.
- Context detail only when detailed saved section requested.
- `parallelToolCalls: false`.

### 10.6 Current-info hallucination

**Risk:** Agent latest timings, closure, event, price, weather, ya advisory memory se
invent kare.

**Safeguards:**

- Freshness classifier.
- Date-validation-before-web sequence for event/date queries.
- Hosted web search as only current-fact evidence.
- Search unavailable ho to explicit unconfirmed fallback.
- No raw links in response.

### 10.7 Excluded-scope leakage

**Risk:** Prompt, response, `tripType`, ya suggestions mein excluded travel topics aa jayein.

**Safeguards:**

1. Static prompt prohibition.
2. Scope request classification.
3. Planning tools disabled for excluded requests.
4. `tripType` delta validation.
5. Suggested-question validation.
6. Final-output scope guardrail.
7. Deterministic safe fallback.

False-positive reduction ke liye word-boundary aur intent-aware patterns use hote hain,
taaki `business` ko `bus` ya normal phrase ko galat category na maana jaye.

### 10.8 Irrelevant/stale suggestions

**Risk:** Same suggestions repeat ho ya completed action dobara suggest ho.

**Safeguards:**

- Previous 3 suggestions dynamic prompt mein.
- Current completed intents dynamic prompt mein.
- Exact stale-repeat validation.
- Duplicate validation.
- One correction attempt.
- Failure par stale suggestions clear.

### 10.9 Session/process restart

**Risk:** In-memory context process restart par lose ho.

**Safeguards:**

- Production persistent session factory mandatory.
- Final returned context application storage mein persist karein.
- Stable `sessionId`.
- Incoming summary hydration on every request.

### 10.10 Context arrays not auto-enriched

**Risk:** Web search ke current event/place results next turn ke
`upcomingEvents`/`placesOfInterest` mein available na ho.

**Current behavior:** Web result response ko ground karta hai, but arrays automatically
persist nahi hoti.

**Integration safeguard:** Agar product ko durable event/place memory chahiye, trusted
application enrichment layer se exact sourced records hydrate karein. Existing context
tool ko raw web output parse karne ki responsibility na dein.

---

## Quick Integration Checklist

- [ ] Exact production `summaryContext` shape use ho raha hai.
- [ ] Stable `sessionId` aur unique `requestId` pass ho rahe hain.
- [ ] `TripPlannerAgent` ke tools `tripPlannerTools` se registered hain.
- [ ] Dynamic instructions `buildTripPlannerInstructions` se attached hain.
- [ ] First tool context updater aur last tool suggestions updater hai.
- [ ] Returned context next turn ke liye persist ho raha hai.
- [ ] Production persistent bounded session configured hai.
- [ ] Scope and no-link guardrails final output se pehle run ho rahe hain.
- [ ] Excluded topics response, context, aur suggestions mein absent hain.
- [ ] VAST Images ka existing integration unchanged hai.
- [ ] Deterministic aur relevant live regression suites pass hain.
