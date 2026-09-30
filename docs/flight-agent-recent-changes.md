# Flight Agent Recent Changes

> **Date architecture update:** Is report ke stateful `context.flightDate` references historical hain. Current resolver request-local clock use karta hai aur context mutate nahi karta. See [Flight Date Handling: Stateless Implementation](./flight-date-context-implementation.md).

## 1. Short Overview

Recent update ka focus teen areas par hai:

1. Vague date ko samajhkar normal flight search continue karna.
2. Price Prediction ka failure user se hide karke search flow continue karna.
3. User-facing language mein `origin/destination` ko `departure location/arrival location` bolna.

Tool schema aur API payload ke field names change nahi hue hain. Local Flight context ab prod-compatible `context.flight` schema use karta hai; date intelligence separate `context.flightDate` mein rehti hai.

---

## 2. Old Flow vs New Flow

### Date Inference

**Old flow**

- `next week`, `next weekend` ya `next month` par agent exact date dobara pooch sakta tha.
- Vague date ko kabhi unnecessarily Price Prediction flow mein bheja jaata tha.
- Relative date ka result next turn tak reliably preserve nahi hota tha.

**New flow**

- Agent user language ko structured calendar intent mein convert karta hai.
- `resolve_flight_date` current local date/timezone se exact ISO range nikalta hai.
- Resolved result `context.flightDate.dateIntent` mein save hota hai.
- Normal search intent mein flow hota hai:

```text
resolve_flight_date -> flight_search -> update_flight_suggested_questions
```

- Explicit cheap/best-fare intent mein hi Price Prediction call hota hai.
- Route baad mein mile, tab bhi pehle resolve hua date intent reuse hota hai.
- User exact naya date de to purana vague date replace ho jaata hai.

Assume local date `2026-07-31` hai:

| User input | Resolved range | Search date |
|---|---|---|
| `next week` | Aug 3 to Aug 9 | Aug 3 |
| `next weekend` | Aug 8 to Aug 9 | Aug 8 |
| `next month` | Aug 1 to Aug 31 | Aug 1 |
| `August` | Next valid August range | First non-past date |

Round trip mein return date/duration available nahi ho, to agent sirf return timing poochta hai. Outbound date dobara nahi poochta.

### Price Prediction No-Result

**Old flow**

- User ko `NO_PREDICTIONS`, unsupported route ya prediction unavailable jaisi details dikh sakti thi.
- Usable date already hone ke baad bhi exact date dobara poochi ja sakti thi.

**New flow**

- Prediction ka non-success result internal rehta hai.
- Usable resolved date available ho to normal flight search ek baar run hota hai.
- Same turn mein fallback search repeat nahi ho sakta.
- Usable date nahi ho to agent sirf ye poochta hai:

```text
Please provide your expected travel date so I can pull up the best flight options for you.
```

- Agent price, cheapest date ya prediction result invent nahi karta.
- Final response guard bhi internal prediction failure text ko user tak jaane se rokta hai.

### Terminology

User-facing prompt wording:

| Before | After |
|---|---|
| origin | departure location |
| destination | arrival location |

Internal contracts same hain:

```ts
origin
destination
originCity
destinationCity
outbound_date
return_date
```

`departureLocation` ya `arrivalLocation` naam ka koi naya API/tool field add nahi hua.

---

## 3. Key Logic

### Immutable Turn Clock

[`flightDateTime.js`](../src/agents/flight/date/calendar.ts) har turn ke liye ye values banata hai:

```ts
{
  localDate: "2026-07-31",
  localDateTime: "2026-07-31T15:30:00+05:30",
  timeZone: "Asia/Kolkata"
}
```

Flight search window 359 days aur Price Prediction window 89 days hai.

### Structured Date Resolver

[`resolveFlightDateTool.js`](../src/agents/flight/tools/resolve-date-tool.ts) raw user text receive nahi karta. Agent clean structured payload deta hai:

```ts
{
  kind: "weekend",
  relation: "next",
  offset: null,
  weekday: null,
  month: null,
  year: null,
  exactDate: null,
  rangeStart: null,
  rangeEnd: null,
  tripDurationDays: null
}
```

[`flightDateResolver.js`](../src/agents/flight/date/resolver.ts) calendar calculation, range validation, search date, return date aur fallback marker handle karta hai.

### Context Carry-Forward

[`flightContext.js`](../src/agents/flight/context/flight-context.ts) existing search data preserve karta hai. Date state yahan rehti hai:

```ts
context.flightDate.clock
context.flightDate.dateIntent
context.flightDate.routing
```

`dateIntent` route, cabin, passenger ya filter-only turn par preserve hota hai. Successful search ke baad state `used` mark hoti hai.

### Failure Privacy

[`pricePredictionFailureResponse.js`](../src/agents/flight/tools/price-prediction/failure-response.ts) final output check karta hai:

- Fallback search successful: normal search confirmation.
- Search possible nahi: expected travel date question.
- Internal prediction status/message user ko nahi dikhaya jaata.

Ye guard direct runner aur Gateway runner dono mein final response send hone se pehle apply hota hai.

---

## 4. Relevant Files Changed

| File | Responsibility |
|---|---|
| `src/agents/flight/prompt.ts` | Static routing, failure privacy aur terminology rules |
| `src/agents/flight/agent.ts` | Dynamic clock, date state aur routing instructions |
| `src/agents/flight/date/calendar.ts` | Shared clock/date windows |
| `src/agents/flight/date/resolver.ts` | Deterministic calendar resolution and one-time fallback state |
| `src/agents/flight/tools/resolve-date-tool.ts` | Structured date-resolution tool |
| `src/agents/flight/context/flight-context.ts` | Search/date context carry-forward |
| `src/agents/flight/tools/index.ts` | Resolver tool registration and order |
| `src/agents/flight/tools/price-prediction/tool.ts` | Current-turn prediction result recording |
| `src/agents/flight/tools/search-tool.ts` | One-time fallback protection and resolved-state update |
| `src/agents/flight/tools/price-prediction/failure-response.ts` | Final user-facing failure guard |
| `src/agents/flight/runner.ts` | Turn clock preparation and final guard |
| `src/agents/gateway/runner.ts` | Gateway/stream path final guard |
| `src/agents/flight/tools/price-prediction/service.ts` | Resolved range ko prediction window se map karna |

Focused tests:

- `tests/unit/flight-agent-date-resolver.test.ts`
- `tests/unit/flight-agent-price-prediction.test.ts`
- `tests/unit/flight-agent-location-terminology.test.ts`
- `tests/live/flight-agent-price-prediction-routing-live.ts`
- `tests/live/flight-agent-date-price-accuracy-live.ts`

---

## 5. Before/After Examples

### Normal Vague-Date Search

**User:** `Find DEL to BOM next weekend`

**Before:** `What exact date would you like to travel?`

**After:** `Found one-way economy options from DEL to BOM for Aug 8, the start of next weekend. Note: Prices shown are per person.`

### Date Before Route

**User:** `next month`  
**Agent:** asks only for missing departure and arrival locations.  
**User:** `DEL to BOM`

**After:** Agent reuses the saved next-month range and searches its selected date. Exact date dobara nahi poochta.

### Prediction Has No Data

**User:** `Which date is cheaper next weekend from DEL to BOM?`

**Before:** `Price prediction is unavailable for this route.`

**After:** Resolved weekend date usable hai to normal flight search ek baar continue hota hai. User ko prediction failure nahi dikhaya jaata.

### No Usable Date

**User:** `Which date is cheapest from DEL to BOM?`

**After:** `Please provide your expected travel date so I can pull up the best flight options for you.`

### Location Labels

**Before:** `Please share your origin and destination.`

**After:** `Please share your departure location and arrival location.`

---

## 6. How To Test

Deterministic tests:

```powershell
npx tsx --test tests/unit/flight-agent-date-resolver.test.ts
npm run test:flight:price-prediction
npx tsx --test tests/unit/flight-agent-location-terminology.test.ts
```

Live routing tests:

```powershell
npm run test:flight:price-prediction-live
npm run test:flight:date-price-accuracy
```

Live tests OpenAI API usage karte hain. Verify:

- Normal vague date par `price_prediction_tool` call na ho.
- Tool sequence `resolve_flight_date -> flight_search` ho.
- Price intent par prediction call ho.
- Prediction no-result text final response mein na ho.
- Fallback search maximum ek baar ho.
- Suggested-question updater final tool ho.
- Tool payloads mein internal `origin/destination` fields hi hon.

---

## 7. Original Source Code Integration Guide

### Step 1: Prompt Compare Karo

Production ke Flight Agent system prompt aur dynamic prompt builder ko compare karo:

- Local static prompt: `src/agents/flight/prompt.ts`
- Local dynamic prompt: `buildFlightAgentInstructions()` in `src/agents/flight/agent.ts`

Copy these rules:

- Normal vague timing -> resolver, then search.
- Explicit cheapest/best/fare intelligence -> Price Prediction.
- Non-success prediction details private.
- User-facing departure/arrival terminology.
- Resolved date assumption final confirmation mein naturally mention karna.

### Step 2: Date Modules Port Karo

Copy/adapt:

- `flightDateTime.js`
- `flightDateResolver.js`
- `tools/resolveFlightDateTool.js`

Production tool registry mein `resolve_flight_date` ko `flight_search` se pehle register karo.

### Step 3: Turn Lifecycle Wire Karo

Har Flight Agent turn ke start par:

```ts
prepareFlightDateTurn(context, {
  now,
  timeZone,
  requestId,
  existingSearch
});
```

Same shared context object model instructions aur tools dono ko milna chahiye.

### Step 4: Tool Hooks Port Karo

- Price Prediction result ke baad `recordPricePredictionForTurn()` call karo.
- Flight search se pehle `claimPricePredictionFallbackSearch()` call karo.
- Successful search ke baad resolved date intent ko `used` mark karo.
- Existing `context.flightDate.dateIntent` ko unrelated turns par preserve karo.

Production ka real search API aur real prediction repository replace mat karo. Local dummy `flightSearchTool` ya dummy client ko full copy nahi karna; sirf lifecycle hooks adapt karne hain.

### Step 5: Final Failure Guard Add Karo

`sanitizePricePredictionFailureResponse()` ko final response user ko commit/send karne se pehle run karo.

Direct aur Gateway/streaming dono execution paths cover hone chahiye. Internal status logging allowed hai, user-facing text mein nahi.

### Step 6: Internal Fields Rename Mat Karo

In fields ko unchanged rakho:

```ts
origin
destination
originCity
destinationCity
onds
outbound_date
return_date
trip_type
```

`departure location` aur `arrival location` sirf prompt/display terminology hai.

### Step 7: Regression Run Karo

Minimum production verification:

1. Exact-date flight search.
2. Next week/weekend/month and named-month search.
3. Date-first, route-later multi-turn flow.
4. Explicit cheap-date prediction success.
5. `NO_PREDICTIONS`, empty result and tool error.
6. Round-trip without return timing.
7. Existing route/date context carry-forward.
8. Tool/API schema snapshot confirming internal names unchanged.

## Integration Checklist

- [ ] Current date/time/timezone dynamic prompt mein visible hai.
- [ ] Resolver raw user text receive nahi karta.
- [ ] Normal vague search Price Prediction mein nahi jaata.
- [ ] Prediction failure user ko expose nahi hota.
- [ ] Fallback search ek turn mein sirf once hota hai.
- [ ] Existing date intent next turn mein preserve hota hai.
- [ ] User-facing wording departure/arrival location hai.
- [ ] Internal schemas aur API payloads unchanged hain.
