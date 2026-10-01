# Flight Agent Context Flow

> **Architecture update (2026-08-04):** Date resolver ab stateless hai. `context.flightDate`, durable `dateIntent`, aur date-routing state remove ho chuke hain. Is document ke date-state sections historical hain; current source of truth [Flight Date Handling: Stateless Implementation](./flight-date-context-implementation.md) hai.

Yeh document current local/dummy Flight Agent ka **prod-compatible context flow** explain karta hai.

Last verified: 2026-08-04

## 1. Core Rule

Flight-owned production state sirf `appContext.flight` ke andar store hoti hai.

- `appContext.flight` exact prod schema follow karta hai.
- Date intelligence alag `appContext.flightDate` namespace mein rehti hai.
- `requestId` aur `sessionId` root level par sirf request tracing ke liye hain.
- Dummy filter runtime searchKey ke against external in-memory store mein rehta hai.
- Tool/API payload names, jaise `UID`, `onds`, `trip_type`, `originCity`, change nahi hue.

## 2. Exact Runtime Envelope

```js
{
  requestId: 'req_001',
  sessionId: 'session_001',

  flight: {
    pax: 1,
    uid: '',
    cntKey: '',
    deeplink: null,
    tripType: 'oneway',
    searchKey: '',
    cabinClass: 'economy',
    showFlight: false,
    inboundDate: '',
    redirectUrl: null,
    outboundDate: null,
    bookingStatus: null,

    segments: [
      {
        date: '',
        origin: '',
        destination: '',
      },
    ],

    passengerData: {
      total: 1,
      adults: 1,
      seniors: 0,
      children: 0,
      lapInfants: 0,
      seatInfants: 0,
      childrenAges: [],
    },

    searchResults: null,
    departAirports: [],
    resolvedOrigin: {
      userCity: null,
      airportIATA: null,
    },
    depLandAirports: [],
    resolvedDestination: {
      userCity: null,
      airportIATA: null,
    },

    directFlightOnly: false,
    totalResultsFound: 0,
    _awaitingWebSearch: false,
    suggestedQuestions: [],
    lastPricePrediction: null,

    airlineFilterOptions: null,
    layoverAirportFilterOptions: null,

    flight_estimated_cost_total: null,
    flight_estimated_cost_per_person: null,
  },

  flightDate: {
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
  },

  toolCallLog: [], // Local test/debug instrumentation only
}
```

`flightDate` request start se pehle required nahi hai. Runner har turn mein initialize karta hai.

## 3. First Turn Flow

### Direct Flight runner

```text
runFlightAgent()
  -> getFlightAgentContext()
  -> hydrateFlightAgentContext()
  -> prepareFlightAgentTurnContext()
  -> prepareFlightDateContextForTurn()
  -> buildFlightAgentInstructions()
  -> FlightAgent run
  -> tools mutate same appContext
  -> guarded output + appContext return
```

### Gateway runner

```text
runGatewayAgent() / runGatewayAgentTextStream()
  -> buildGatewayContext()
  -> ensureFlightRuntimeContext()
  -> prepareFlightAgentTurnContext()
  -> prepareFlightDateContextForTurn()
  -> Flight Agent handoff when selected
  -> tools mutate same appContext
  -> guarded output + appContext return
```

### New chat initialization

Use:

```js
import { createProdFlightContext } from './src/index.ts';

const appContext = {
  flight: createProdFlightContext(),
};
```

Runner ko manually `clock`, `dateIntent`, ya `routing` dene ki zarurat nahi hai.

## 4. Hydration And Merge

Main functions:

| Function | Responsibility |
|---|---|
| `createProdFlightContext()` | Exact 28-key Flight object create karta hai |
| `ensureFlightRuntimeContext()` | Existing/legacy input hydrate karke prod object banata hai |
| `hydrateFlightAgentContext()` | First load ke liye normalized app context return karta hai |
| `mergeFlightAgentContext()` | Existing context aur explicit incoming update merge karta hai |
| `getFlightSearchState()` | Prod fields ko tool-friendly search shape mein map karta hai |
| `setActiveFlightSearch()` | Successful search input ko prod Flight fields mein write karta hai |

### Merge rule

- New explicit value old value ko override karti hai.
- Incoming partial context missing field ko clear nahi karta.
- Existing route/date/passenger/cabin preserve hote hain jab user unhe change nahi karta.
- Nested `flight.searchKey` authoritative hai.
- Stale root `searchKey` ya `sid` nested Flight state ko override nahi karte.
- Explicit route change par stale resolved airport IATA clear hota hai.

Example:

```text
Existing:
DEL -> BOM, 2026-09-10, 2 adults, economy

Incoming partial update:
destination = Chicago

Final:
DEL -> Chicago, 2026-09-10, 2 adults, economy
```

## 5. Legacy Mapping

Legacy fields backward hydration ke liye read ho sakte hain, lekin final context mein store nahi hote.

| Legacy/local field | Prod owner |
|---|---|
| root `UID` / `uid` | `flight.uid` |
| root `searchKey` / `sid` | `flight.searchKey` |
| `lastSearch.onds` | `flight.segments` |
| `lastSearch.trip_type` | `flight.tripType` |
| `lastSearch.passengers` | `flight.passengerData` |
| `lastSearch.cabin_class` | `flight.cabinClass` |
| `flightResults` / `filteredFlightResults` | `flight.searchResults` |
| `DepartAirports` | `flight.departAirports` |
| `DepLandAirports` | `flight.depLandAirports` |
| root `suggestedQuestions` | `flight.suggestedQuestions` |
| nested `flight.clock` | `flightDate.clock` |
| nested `flight.dateIntent` | `flightDate.dateIntent` |
| nested `flight.dateRouting` | `flightDate.routing` |

Hydration ke baad legacy root aliases delete ho jate hain.

## 6. Search State Mapping

Prod context tool payload jaisa nahi hai. Isliye `getFlightSearchState()` adapter use hota hai.

Prod context:

```js
flight.segments
flight.tripType
flight.outboundDate
flight.inboundDate
flight.passengerData
flight.cabinClass
```

Adapter output:

```js
{
  onds: [
    {
      origin: 'DEL',
      destination: 'BOM',
      outbound_date: '2026-09-10',
      return_date: null,
    },
  ],
  origin: 'DEL',
  destination: 'BOM',
  outbound_date: '2026-09-10',
  return_date: null,
  trip_type: 'oneway',
  passengers: {
    adults: 1,
    children: 0,
    infants: 0,
  },
  cabin_class: 'economy',
}
```

Yeh adapter output context mein parallel `lastSearch` object ke roop mein persist nahi hota.

## 7. Date Context

Date state base prod Flight object se separate hai:

```js
flightDate: {
  clock: { localDate, localDateTime, timeZone },
  dateIntent: {
    status,
    kind,
    range,
    searchDate,
    returnDate,
    priceFallbackDate,
    assumptionLabel,
    state,
    stale,
  },
  routing: {
    pricePredictionStatus,
    priceFallbackDate,
    fallbackSearchAttempted,
  },
}
```

Lifecycle:

| Field | Lifecycle |
|---|---|
| `flightDate.clock` | Har turn fresh |
| `flightDate.dateIntent` | Multi-turn durable; new explicit date par replace |
| `flightDate.routing` | Har turn reset |
| `flight.lastPricePrediction` | Latest prediction result, durable |
| `flight.outboundDate/inboundDate` | Actual searched dates |

`pricePredictionDateIntent` persistent context field nahi hai. Price tool execution ke time `flightDate.dateIntent` se derive hota hai.

## 8. Dynamic Prompt

Dynamic instructions [agent.ts](../src/agents/flight/agent.ts) mein `buildFlightAgentInstructions()` banata hai.

Prompt ko milta hai:

- Local date, local datetime, timezone.
- Prediction and search windows.
- Compact durable date intent.
- Active search yes/no.
- Current result records yes/no.
- `buildActiveSearchSummary()` ka compact prod-field summary.
- Available airline, layover, departure airport, arrival airport options.
- Previous suggested questions.

Prompt ko nahi milta:

- Raw `searchKey` value.
- Raw UID value.
- Full search results/contracts.
- Filter runtime state.
- `toolCallLog`.
- Legacy root aliases.

## 9. Tool Context Ownership

| Tool | Reads | Writes |
|---|---|---|
| `resolve_flight_date` | `flightDate.clock`, mapped current search | `flightDate.dateIntent` |
| `flight_search` | `flight.uid`, final ISO search payload | Search fields, searchKey, results, airport/filter options |
| `apply_filter` | `flight.uid`, `flight.searchKey`, source options, results | Visible results, count, showFlight, directFlightOnly |
| `price_prediction_tool` | `flightDate`, route payload | `flight.lastPricePrediction`, `flightDate.routing` |
| `getGeneratedContractsContext` | `flight.searchResults`, mapped search state | No Flight context mutation |
| `update_flight_suggested_questions` | Latest `flight.searchKey`, suggestions shown at turn start | `flight.suggestedQuestions`; required last on every turn, see [flight-suggested-questions.md](flight-suggested-questions.md) |

### Search tool writes

```text
flight.searchKey
flight.tripType
flight.cabinClass
flight.outboundDate
flight.inboundDate
flight.segments
flight.passengerData
flight.pax
flight.resolvedOrigin
flight.resolvedDestination
flight.searchResults
flight.showFlight
flight.bookingStatus
flight.totalResultsFound
flight.directFlightOnly
flight.airlineFilterOptions
flight.layoverAirportFilterOptions
flight.departAirports
flight.depLandAirports
```

### Filter runtime

Dummy-only active filter state `flightSearchRuntimeStore.js` mein searchKey ke against store hoti hai:

```js
{
  sourceFlights,
  visibleFlights,
  appliedFilters,
  finalFilterPayload,
  lastApplyFilterPayload,
  feedback,
}
```

Yeh state:

- `context.flight` ka part nahi hai.
- Dynamic prompt mein inject nahi hoti.
- Real integration mein remote Apply Filter/search service own kar sakti hai.

## 10. Second And Later Turns

### Direct runner

`sessionId` se process-local context load hota hai. Incoming partial context ho to `mergeFlightAgentContext()` existing state ke upar explicit changes merge karta hai.

### Gateway runner

Gateway process-local Flight store use nahi karta. Caller ko previous returned `context` next turn mein pass karna hota hai.

Every later turn:

```text
existing context load
  -> exact prod Flight shape normalize
  -> explicit incoming fields merge
  -> fresh clock create
  -> durable dateIntent preserve/stale check
  -> routing reset
  -> dynamic prompt build
  -> agent/tools execute
  -> same mutated context return
```

## 11. Multi-Turn Example

### Turn 1

User:

```text
DEL to BOM next weekend
```

Flow:

```text
resolve_flight_date
  -> flightDate.dateIntent.searchDate = 2026-08-15

flight_search
  -> flight.segments = DEL -> BOM
  -> flight.outboundDate = 2026-08-15
  -> flight.searchKey = fresh key
  -> flight.searchResults = current cards

update_flight_suggested_questions
  -> exactly 3 questions stored
```

### Turn 2

User:

```text
non-stop only
```

Flow:

```text
route/date/passengers/cabin preserved
  -> apply_filter uses latest flight.searchKey
  -> filtered cards replace flight.searchResults
  -> flight.directFlightOnly = true
  -> suggested questions update last
```

No root `lastSearch`, root `sid`, ya `filteredFlightResults` create nahi hota.

## 12. Final Context And Return

Both runners final response ke saath same mutated `appContext` return karte hain.

```js
const result = await runFlightAgent({
  input,
  sessionId,
  context: previousContext,
  timeZone: userTimeZone,
});

const nextContext = result.context;
```

Current normalized search chahiye to:

```js
import { getFlightSearchState } from './src/index.ts';

const searchCriteria = getFlightSearchState(result.context);
```

## 13. Main Files

| File | Purpose |
|---|---|
| `flightContext.js` | Prod schema, hydration, merge, search mapping |
| `flightRequestContext.js` | Durable state ko request-only clock ke saath wrap/unwrap karta hai; clock persist nahi hota |
| `flightDatePromptContext.js` | Compact date dynamic prompt |
| `flightSearchRuntimeStore.js` | Dummy search/filter runtime outside context |
| `agent.ts` | Dynamic Flight instructions |
| `runner.js` | Direct session/context lifecycle |
| `gatewayRunner.js` | Gateway context preparation |
| `tools/flightSearchTool.js` | Search context writes |
| `tools/applyFilterTool.js` | Filter reads/writes |
| `tools/resolveFlightDateTool.js` | Structured date resolution |
| `tools/pricePredictionTool.js` | Prediction result write |
| `tools/getGeneratedContractsContextTool.js` | Current result reasoning |
| `tools/updateFlightSuggestedQuestionsTool.js` | Suggested question persistence |

## 14. Validation

Focused schema test:

```powershell
npx tsx --test tests/unit/flight-agent-prod-context-schema.test.ts
```

Full deterministic suite:

```powershell
npm test
```

Last result:

```text
204 tests
204 passed
0 failed
```

Validated points:

- Exact 28 prod Flight keys and defaults.
- Date state base Flight schema se separate.
- Search/filter ke baad no extra Flight keys.
- Legacy aliases hydrate hoke remove hote hain.
- Latest nested searchKey authoritative hai.
- Route change stale resolved airport code preserve nahi karta.
- Existing date/search/filter/suggestion behavior passes.
