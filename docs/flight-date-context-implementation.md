# Flight Date Handling: Stateless Implementation

## 1. Current Architecture

Flight date handling ab **stateless resolver** approach use karta hai.

```text
request starts
-> request-local clock create hota hai
-> dynamic instructions ko clock + existing searched dates milti hain
-> Agent user ki date language ko structured intent mein classify karta hai
-> vague/relative date par resolve_flight_date call hota hai
-> resolver ISO date/range feedback return karta hai
-> Agent wahi feedback flight_search ya price_prediction_tool ko pass karta hai
-> sirf successful business tools durable context update karte hain
```

Important boundary:

- Resolver language parse nahi karta.
- Resolver raw user text accept nahi karta.
- Resolver context update nahi karta.
- Resolver output ko search/prediction explicit payload mein dena hota hai.
- Multi-turn unresolved date flow SDK session history par depend karta hai.

## 2. Durable Aur Request-Local State

### Durable `context.flight`

Date flow existing production-compatible fields use karta hai:

```js
context.flight = {
  tripType: 'oneway',
  outboundDate: null,
  inboundDate: '',
  segments: [{ date: '', origin: '', destination: '' }],
  searchKey: '',
  lastPricePrediction: null,
  // remaining prod-compatible Flight fields
};
```

Durable meaning:

- `outboundDate`: actual searched outbound date.
- `inboundDate`: actual searched return date.
- `segments`: actual searched route/date segments.
- `tripType`: actual current trip type.
- `searchKey`: successful search ka active locator.
- `lastPricePrediction`: latest prediction tool result.

### Request-local clock

Clock `context.flight` ya `context.flightDate` mein store nahi hota. Runner durable state aur clock ko current request ke liye explicitly wrap karta hai:

```js
{
  state: appContext,
  runtime: {
    clock: {
      localDate: '2026-08-04',
      localDateTime: '2026-08-04T15:30:00+05:30',
      timeZone: 'Asia/Kolkata'
    }
  }
}
```

Har request/turn par naya wrapper aur clock banta hai. Runner response/persistence mein sirf `appContext` return karta hai, isliye runtime clock durable JSON/session state ka part nahi banta.

### Removed state

Current implementation mein ye fields nahi hain:

- `context.flightDate`
- `dateIntent`
- `dateRouting`
- `pricePredictionDateIntent`
- `priceFallbackDate`
- `fallbackSearchAttempted`
- `state`, `stale`, `usedAtRequestId`, `resolvedFromDate`

## 3. First Turn Hydration

Standalone entry: `runFlightAgent()` in `src/agents/flight/runner.ts`.

Manager entry: `runGatewayAgent()` / `runGatewayAgentTextStream()` in `src/agents/manager-orchestrator/runner.ts` and `streaming.ts`.

Sequence:

1. `hydrateFlightAgentContext()` or `ensureFlightRuntimeContext()` prod-compatible `context.flight` banata/hydrate karta hai.
2. `prepareFlightAgentTurnContext()` request ID, session ID, and current message set karta hai.
3. `createFlightTurnClock()` caller ke `now` and IANA `timeZone` se immutable clock banata hai.
4. `createFlightRequestContext()` durable `appContext` aur request-only clock ko ek runtime wrapper mein rakhta hai.
5. `buildFlightAgentInstructions()` wrapper se durable state aur clock separately read karke dynamic instructions build karta hai.
6. Agent configured `maxTurns` ke saath isi request wrapper par run hota hai; response mein durable `appContext` hi return hota hai.

Example:

```js
const context = hydrateFlightAgentContext({});

prepareFlightAgentTurnContext(context, {
  requestId: 'req_001',
  sessionId: 'chat_001',
});

const clock = createFlightTurnClock({
  now: new Date('2026-08-04T10:00:00.000Z'),
  timeZone: 'Asia/Kolkata',
});

const requestContext = createFlightRequestContext(context, clock);
```

`requestContext.runtime.clock` current request ke liye hai. Clock durable `context.flight` ya session state ko mutate nahi karta.

## 4. Subsequent Turns

Actual searched dates `context.flight` se hydrate hote hain. Vague resolver feedback durable context mein save nahi hota.

Therefore:

- `next month` -> resolver output -> later `DEL to BOM` works only when prior tool result SDK session history mein replay hota hai.
- `price prediction` -> later `search that one` works from prior tool output/session history and `lastPricePrediction`.
- Existing completed search ke baad route change actual `outboundDate`/`inboundDate` reuse kar sakta hai.
- New explicit date older conversational date preference ko override karta hai.

Production requirement:

Use one reliable conversation mechanism, for example `MemorySession`, persistent SDK session storage, or Responses API conversation/previous-response state. Without replayed history, date-first route-later flow statelessly recover nahi ho sakta.

## 5. Date Resolver Tool

### Tool

`resolve_flight_date`

File: `src/agents/flight/tools/resolve-date-tool.ts`

### Input

```ts
{
  kind: "exact" | "weekday" | "week" | "weekend" |
        "month" | "range" | "flexible",
  relation: "this" | "next" | null,
  offset: number | null,
  weekday: "sunday" | "monday" | "tuesday" | "wednesday" |
           "thursday" | "friday" | "saturday" | null,
  month: number | null,
  year: number | null,
  exactDate: string | null,
  rangeStart: string | null,
  rangeEnd: string | null,
  tripDurationDays: number | null,
  tripType: "oneway" | "roundtrip" | null
}
```

Agent user message samajh kar payload banata hai. Tool ko raw message nahi milta.

### Output

```ts
{
  status: "RESOLVED" | "NEEDS_RETURN_TIMING" |
          "OUTSIDE_SEARCH_WINDOW" | "INVALID_INTENT",
  range: {
    startDate: string,
    endDate: string
  } | null,
  searchDate: string | null,
  returnDate: string | null,
  assumptionLabel: string
}
```

### Resolution rules

- `next week`: next Monday to Sunday; Monday is `searchDate`.
- `this weekend`: nearest upcoming Saturday/Sunday; Saturday is `searchDate`.
- `next weekend`: following Saturday/Sunday; Saturday is `searchDate`.
- `next month`: complete next calendar month; first day is `searchDate`.
- named month: next valid occurrence; past portion is clipped.
- weekday: `this` uses today if matching, otherwise upcoming weekday.
- explicit range: range is preserved; start is `searchDate`.
- flexible: today through today + 89 days.
- roundtrip + duration: `returnDate = searchDate + tripDurationDays`.
- roundtrip without duration/return offset: `NEEDS_RETURN_TIMING`.

## 6. Resolver Execution

`ResolveFlightDateTool.execute()` does only this:

```js
const requestContext = runContext.context;
const appContext = requestContext.state;
const flight = appContext.flight;

return resolveFlightDateIntent(input, {
  clock: requestContext.runtime.clock,
  existingSearch: {
    trip_type: flight.tripType,
    outbound_date: flight.outboundDate,
    return_date: flight.inboundDate,
  },
});
```

It does not:

- write a date intent;
- write routing state;
- append a resolver call to `toolCallLog`;
- modify search or prediction context.

## 7. Dynamic Prompt Hydration

Function: `buildFlightDateDynamicPromptContext()`

File: `src/agents/flight/date/prompt-context.ts`

It injects only:

- immutable `localDate`;
- immutable `localDateTime`;
- user IANA timezone;
- current 89-day prediction window;
- current 359-day flight-search window.

Existing actual dates and route come separately from `buildActiveSearchSummary()` using `context.flight`.

It does not inject resolver state, fallback markers, or date tool history.

## 8. Flight Search Flow

Normal vague search:

```text
User: JFK to Delhi next weekend
Agent -> resolve_flight_date
Resolver -> searchDate=2026-08-15, range=2026-08-15..2026-08-16
Agent -> flight_search(outbound_date=2026-08-15)
flight_search -> updates context.flight outboundDate, segments, searchKey
```

`FlightSearchTool` does not read resolver context. It accepts its existing structured ISO-date payload only.

After success, user-facing confirmation should naturally mention the inferred date assumption.

## 9. Price Prediction Flow

Explicit price-intelligence query:

```text
User: Cheapest date next month from JFK to DEL
Agent -> resolve_flight_date(kind=month, relation=next)
Resolver -> range=2026-09-01..2026-09-30
Agent -> price_prediction_tool(
  startDate=2026-09-01,
  endDate=2026-09-30,
  ...route/trip fields
)
```

`PricePredictionTool`:

- uses only explicit payload dates;
- uses request-local clock for validation/window limits;
- does not normalize from hidden date intent;
- stores only `context.flight.lastPricePrediction`;
- does not write date-routing state or tool-call history.

On success, Agent uses returned predictions/cheapest dates only.

On failure/no result:

- internal failure user ko expose nahi hota;
- same-turn user ne flight results bhi maange aur resolver gave usable `searchDate`, then one search allowed;
- otherwise Agent expected travel date asks naturally;
- no date-specific retry marker is stored;
- runner `maxTurns` and prompt's one-search rule loop protection provide karte hain.

## 10. Failure Response Guard

File: `src/agents/flight/tools/price-prediction/failure-response.ts`

Runner agent call se pehle request-local snapshots leta hai:

```js
const previousPricePrediction = appContext.flight.lastPricePrediction;
const previousSearchKey = appContext.flight.searchKey || null;
```

After run, guard checks:

- `lastPricePrediction` current turn mein new failure object bana ya nahi;
- `searchKey` current turn mein change hua ya nahi.

This prevents stale previous failures from rewriting unrelated responses without storing routing state.

## 11. Function Catalog

| Function | File | Responsibility |
|---|---|---|
| `runFlightAgent` | `runner.js` | Standalone request entry, context/session, clock, run, guard |
| `buildGatewayContext` | `gatewayRunner.js` | Gateway durable context hydration |
| `runGatewayAgent` / `runGatewayAgentTextStream` | `manager-orchestrator/runner.ts`, `streaming.ts` | Manager request clock and runtime wrapper creation |
| `ensureFlightRuntimeContext` | `flightContext.js` | Prod-compatible Flight context normalization |
| `prepareFlightAgentTurnContext` | `flightContext.js` | Request/session/current-message setup |
| `getFlightSearchState` | `flightContext.js` | Actual current route/date/trip state |
| `createFlightTurnClock` | `flightDateTime.js` | Timezone-safe local clock formatting |
| `createFlightRequestContext` | `flightRequestContext.js` | Durable state plus request-only runtime clock wrapper |
| `getFlightRequestState` | `flightRequestContext.js` | Wrapper se durable app context read karna |
| `getFlightRequestClock` | `flightRequestContext.js` | Wrapper se current request clock read karna |
| `resolveFlightDateIntent` | `flightDateResolver.js` | Pure deterministic calendar calculation |
| `ResolveFlightDateTool.execute` | `tools/resolveFlightDateTool.js` | Stateless resolver tool wrapper |
| `buildFlightDateDynamicPromptContext` | `flightDatePromptContext.js` | Compact clock/window hydration |
| `buildFlightAgentInstructions` | `agent.ts` | Dynamic Flight instructions |
| `FlightSearchTool.execute` | `tools/flightSearchTool.js` | Search with explicit ISO dates; durable search state |
| `getPricePrediction` | `tools/pricePredictionTool.js` | Explicit prediction payload validation/query/parsing |
| `PricePredictionTool.execute` | `tools/pricePredictionTool.js` | Request-clock validation and latest result storage |
| `sanitizePricePredictionFailureResponse` | `pricePredictionFailureResponse.js` | Current-turn private failure handling |

## 12. Integration Checklist

- Copy `flightDateTime.js` pure date helpers.
- Copy `flightDateResolver.js` pure resolver.
- Copy stateless `resolveFlightDateTool.js` and register before search/prediction tools.
- Add `flightRequestContext.js`; isme koi WeakMap ya persistent clock store nahi hai.
- Har runner mein `createFlightTurnClock()` once per request call karein.
- Durable `appContext` aur clock ko `createFlightRequestContext()` se wrap karke Agent SDK ko pass karein.
- Dynamic prompt/tools durable state ke liye `getFlightRequestState()` aur clock ke liye `getFlightRequestClock()` use karein.
- Pass the real user's IANA timezone; do not hardcode one global timezone.
- Update `flightDatePromptContext.js` dynamic hydration.
- Keep existing Flight context schema and actual searched date fields unchanged.
- Remove old `flightDate`, date intent, routing, fallback, and migration code.
- Remove search/prediction reads from resolver-created state.
- Ensure production session reliably replays prior user/tool messages.
- Keep price prediction input/output contract unchanged.
- Keep `maxTurns` configured.
- Run resolver, context, prediction, search, suggested-question, and full deterministic test suites.

## 13. Verified Tests

Current deterministic coverage includes:

- next week, this/next weekend, weekdays, next/named month;
- timezone and year boundary behavior;
- explicit ranges and relative offsets;
- roundtrip duration and missing return timing;
- 89-day prediction versus 359-day search limits;
- no resolver context mutation;
- explicit resolver -> search flow;
- explicit prediction ranges;
- private prediction failures;
- exact prod Flight context schema;
- all wider deterministic Flight and Trip Planner regressions.
