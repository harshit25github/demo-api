# Flight Agent Date Handling: Multi-Turn Integration

> **Superseded:** Current implementation resolver feedback ko context mein persist nahi karta. Updated stateless flow aur integration steps [Flight Date Handling: Stateless Implementation](./flight-date-context-implementation.md) mein hain.

Yeh date-specific integration guide current prod-compatible Flight context ke according updated hai.

Last verified: 2026-08-04

Full context reference: [flight-agent-context-flow.md](./flight-agent-context-flow.md)

## 1. Simple Flow

```text
Request start
  -> prod Flight context hydrate
  -> user timezone se fresh clock initialize
  -> existing exact search date se dateIntent hydrate when needed
  -> dynamic prompt gets clock + compact dateIntent
  -> agent date meaning ko structured payload banata hai
  -> resolve_flight_date calculates ISO date/range
  -> flight_search or price_prediction_tool runs
  -> dateIntent and actual search dates next turn ke liye preserved
```

Agent natural language samajhta hai. Resolver raw user text parse nahi karta.

## 2. Context Placement

Base prod search dates:

```js
appContext.flight = {
  tripType: 'oneway',
  outboundDate: null,
  inboundDate: '',
  segments: [
    { date: '', origin: '', destination: '' },
  ],
  // Other exact prod fields...
};
```

Date intelligence separate namespace mein:

```js
appContext.flightDate = {
  clock: {
    localDate: '2026-08-04',
    localDateTime: '2026-08-04T15:30:00+05:30',
    timeZone: 'Asia/Kolkata',
  },
  dateIntent: undefined,
  routing: {
    pricePredictionStatus: null,
    priceFallbackDate: null,
    fallbackSearchAttempted: false,
  },
};
```

Important:

- `flight.clock` use nahi hota.
- `flight.dateIntent` use nahi hota.
- `flight.dateRouting` use nahi hota.
- Root `lastSearch` durable source nahi hai.
- Actual searched date `flight.outboundDate`, `flight.inboundDate`, aur `flight.segments` mein hoti hai.

## 3. New Chat Initialization

New chat mein manually date fields initialize mat karo.

```js
import { createProdFlightContext } from './src/index.ts';

const context = {
  flight: createProdFlightContext(),
};
```

Runner har turn ye call karta hai:

```js
prepareFlightAgentTurnContext(appContext, {
  requestId,
  sessionId,
});

prepareFlightDateContextForTurn(appContext, {
  now,
  timeZone,
  existingSearch: getFlightSearchState(appContext),
});
```

## 4. Timezone

Timezone hardcode nahi honi chahiye.

```js
await runFlightAgent({
  input,
  sessionId,
  context,
  timeZone: userProfile.timeZone,
});
```

If caller timezone nahi deta, `createFlightTurnClock()` environment/default timezone use karta hai. Production mein user/device timezone explicitly pass karna better hai.

Clock har turn fresh hoti hai. Old clock next turn se blindly copy nahi hoti.

## 5. Resolver Input

Agent `resolve_flight_date` ko structured semantics deta hai:

```json
{
  "kind": "weekend",
  "relation": "next",
  "offset": null,
  "weekday": null,
  "month": null,
  "year": null,
  "exactDate": null,
  "rangeStart": null,
  "rangeEnd": null,
  "tripDurationDays": null
}
```

Tool call:

```js
const result = resolveFlightDateIntent(input, {
  clock: appContext.flightDate.clock,
  existingSearch: getFlightSearchState(appContext),
});

appContext.flightDate.dateIntent = result;
```

No raw user text, regex NLP, ya manual tool-call history required hai.

## 6. Resolver Output

Example:

```json
{
  "status": "RESOLVED",
  "kind": "weekend",
  "range": {
    "startDate": "2026-08-15",
    "endDate": "2026-08-16"
  },
  "searchDate": "2026-08-15",
  "returnDate": null,
  "priceFallbackDate": "2026-08-15",
  "timeZone": "Asia/Kolkata",
  "assumptionLabel": "Next weekend from Aug 15 to Aug 16; searching Aug 15.",
  "state": "pending",
  "stale": false
}
```

Difference:

- `clock` batata hai abhi local date/time kya hai.
- `dateIntent` batata hai user ki travel timing resolve hoke kya bani.

## 7. Date Policies

| User intent | Resolved range | Search date |
|---|---|---|
| `next week` | Next Monday to Sunday | Monday |
| `this weekend` | Upcoming Saturday/Sunday | Saturday |
| `next weekend` | Following weekend | Saturday |
| `next month` | Full next month | First day |
| month-only | Next valid occurrence of month | Earliest future day |
| weekday | Current/upcoming matching weekday | Resolved weekday |
| explicit range | Given start/end | Start date |

Search limit: 359 days.

Price prediction limit: 89 days.

## 8. Routing

### Normal vague search

```text
Find DEL to BOM next weekend
```

Expected chain:

```text
resolve_flight_date
  -> flight_search
  -> update_flight_suggested_questions
```

Price prediction call nahi hota.

### Explicit price intelligence

```text
Which date is cheaper next weekend from DEL to BOM?
```

Expected chain:

```text
resolve_flight_date
  -> price_prediction_tool
  -> optional flight_search only when search intent/fallback rules allow
  -> update_flight_suggested_questions
```

### Exact date

```text
Find DEL to BOM on 2026-08-20
```

Agent final ISO date directly `flight_search` ko de sakta hai. Resolver relative/vague calendar meaning ke liye hai.

## 9. Search Writes

Successful `flight_search` ke baad:

```js
appContext.flight.searchKey = freshSearchKey;
appContext.flight.outboundDate = input.onds[0].outbound_date;
appContext.flight.inboundDate = input.onds[0].return_date || '';
appContext.flight.segments = input.onds.map((segment) => ({
  date: segment.outbound_date,
  origin: segment.origin,
  destination: segment.destination,
}));
```

Then `markFlightDateIntentUsed()`:

- Matching pending intent ko `state: "used"` karta hai.
- Different explicit search date ho to exact intent create karta hai.
- Date state `appContext.flightDate.dateIntent` mein rehti hai.

## 10. Multi-Turn Flow

### Turn 1: Date first

User:

```text
next weekend
```

Context update:

```js
flightDate.dateIntent = {
  kind: 'weekend',
  searchDate: '2026-08-15',
  range: {
    startDate: '2026-08-15',
    endDate: '2026-08-16',
  },
  state: 'pending',
};
```

Route missing hai, so search nahi hota. Date intent preserved rehta hai.

### Turn 2: Route later

User:

```text
DEL to BOM
```

Runner fresh clock banata hai, old `dateIntent` preserve karta hai, then agent pending `searchDate` use karta hai.

```text
flight_search:
DEL -> BOM on 2026-08-15
```

Context after:

```js
flight.outboundDate = '2026-08-15';
flight.segments = [
  { date: '2026-08-15', origin: 'DEL', destination: 'BOM' },
];
flight.searchKey = 'fresh-search-key';
flightDate.dateIntent.state = 'used';
```

### Turn 3: Unrelated filter

User:

```text
non-stop only
```

Date and route preserved. `apply_filter` latest `flight.searchKey` use karta hai. Resolver call nahi hota.

### Turn 4: Explicit new date

User:

```text
change date to Aug 20
```

New date old weekend intent ko replace karti hai. Fresh search writes:

```js
flight.outboundDate = '2026-08-20';
flight.segments[0].date = '2026-08-20';
flightDate.dateIntent.kind = 'exact';
flightDate.dateIntent.searchDate = '2026-08-20';
```

## 11. Existing Search Hydration

If `flightDate.dateIntent` missing hai but prod Flight context mein valid exact search date hai:

```js
flight.outboundDate = '2026-08-20';
```

`prepareFlightDateContextForTurn()` exact durable intent hydrate kar sakta hai.

If old intent ka `searchDate` current local date se pehle hai, it becomes stale:

```js
{
  status: 'INVALID_INTENT',
  searchDate: null,
  state: 'stale',
  stale: true,
}
```

## 12. Price Prediction Context

Persistent field:

```js
flight.lastPricePrediction
```

Per-turn fallback guard:

```js
flightDate.routing = {
  pricePredictionStatus: null,
  priceFallbackDate: null,
  fallbackSearchAttempted: false,
};
```

`pricePredictionDateIntent` context mein persist nahi hota. Price tool call ke time derive hota hai:

```js
const dateIntent = buildPricePredictionDateIntent(
  appContext.flightDate.dateIntent,
  { clock: appContext.flightDate.clock },
);
```

Prediction failure user ko internal status ke form mein expose nahi hoti.

## 13. Suggested Questions

Final updater execution time par latest prod key read karta hai:

```js
appContext.flight.searchKey
```

- Key exists: exactly three LLM-provided suggestions store.
- Key missing/empty: `flight.suggestedQuestions = []`.
- Root stale `searchKey` considered nahi hota.
- Tool turn ka final function call hona chahiye.

## 14. Files To Copy Into Live Agent

Required date modules:

```text
src/agents/flight/date/calendar.ts
src/agents/flight/date/resolver.ts
src/shared/runtime/request-context.ts
src/agents/flight/date/prompt-context.ts
src/agents/flight/tools/resolve-date-tool.ts
```

Required context/routing integration:

```text
src/agents/flight/context/flight-context.ts
src/agents/flight/agent.ts
src/agents/flight/runner.ts
src/agents/gateway/runner.ts
src/agents/flight/tools/search-tool.ts
src/agents/flight/tools/price-prediction/tool.ts
src/agents/flight/tools/suggested-questions-tool.ts
src/agents/flight/tools/index.ts
```

Do not copy old root aliases as new durable state.

## 15. Verification

```powershell
npx tsx --test tests/unit/flight-agent-prod-context-schema.test.ts
npx tsx --test tests/unit/flight-agent-date-resolver.test.ts
npx tsx --test tests/integration/flight-agent-context-carry-forward.test.ts
npx tsx --test tests/unit/flight-agent-price-prediction.test.ts
npx tsx --test tests/unit/flight-agent-suggested-questions.test.ts
```

Full deterministic check:

```powershell
npm test
```

Last verified result:

```text
204 passed
0 failed
```
