# Flight Agent Date Context Flow

> Historical trace note: Is report ke captured payloads old stateful date context par based hain. Current implementation mein resolver stateless hai aur `context.flightDate` exist nahi karta. Current integration ke liye [Flight Date Handling: Stateless Implementation](./flight-date-context-implementation.md) follow karein.

## 1. Overview

Ye report do date-focused Flight Agent flows explain karti hai:

1. Vague date, jaise `next weekend`, ko resolve karke flight search.
2. Cheapest date prediction ke baad selected date par flight search.

Live trace `gpt-5.5` par fixed clock ke saath run hua. Koi Flight business logic change nahi ki gayi.

```json
{
  "localDate": "2026-07-31",
  "localDateTime": "2026-07-31T15:30:00+05:30",
  "timeZone": "Asia/Kolkata",
  "predictionWindow": "2026-07-31 to 2026-10-28",
  "flightSearchWindow": "2026-07-31 to 2027-07-25"
}
```

Evidence:

- `tests/results/flight-agent-two-flow-debug-latest.json`
- `tests/live/flight-agent-two-flow-debug-live.ts`
- Focused tests: **65 passed, 0 failed**

## 2. Date Context Fields

| Context field | Meaning | Lifecycle |
|---|---|---|
| `flight.clock` | Relative date calculation ka local clock | Har turn fresh |
| `flight.dateIntent` | User date phrase ka resolved, durable form | Unrelated turns me preserved |
| `flight.pricePredictionDateIntent` | Prediction window and requested-range adapter | Har turn reset, prediction par rebuild |
| `flight.lastPricePrediction` | Latest predicted dates | Follow-up turns me preserved |
| `flight.dateRouting` | Same-turn prediction/fallback guard | Har turn reset |
| `lastSearch` | Actually searched date and route | Successful search ke baad update |
| `flight.searchKey` | Active flight results locator | Successful search ke baad update |

Typical `dateIntent`:

```json
{
  "status": "RESOLVED",
  "kind": "weekend",
  "range": {
    "startDate": "2026-08-08",
    "endDate": "2026-08-09"
  },
  "searchDate": "2026-08-08",
  "returnDate": null,
  "priceFallbackDate": "2026-08-08",
  "timeZone": "Asia/Kolkata",
  "resolvedFromDate": "2026-07-31",
  "state": "pending",
  "stale": false
}
```

Important:

- `dateIntent.searchDate` vague range ka normal-search default hai.
- `lastPricePrediction.cheapestDates[0]` actual predicted selected date hai.
- Prediction flow me ye dates different ho sakti hain.

## 3. Common Date Lifecycle

```text
User message
  -> runFlightAgent
  -> existing context hydrate/merge
  -> prepareFlightAgentTurnContext
       -> current message set
       -> local clock create
       -> dateRouting reset
       -> existing dateIntent preserve/stale check
       -> pricePredictionDateIntent reset
  -> dynamic prompt gets clock + existing search + dateIntent
  -> Agent decides normal search vs price intelligence
  -> resolve_flight_date for vague timing
  -> flight_search OR price_prediction_tool
  -> suggested-question updater runs last
```

Main functions:

| Function | Responsibility |
|---|---|
| `prepareFlightAgentTurnContext` | Per-turn Flight date state prepare karta hai |
| `prepareFlightDateTurn` | Clock, stale-date check, and routing reset |
| `buildFlightAgentInstructions` | Date context dynamic prompt me inject karta hai |
| `resolveFlightDateIntent` | Structured date semantics ko ISO dates me convert karta hai |
| `PricePredictionTool.execute` | Prediction date adapter/result store karta hai |
| `markFlightDateIntentUsed` | Date intent ko actual searched date ke saath align karta hai |

---

# Scenario 1: Vague Date to Flight Search

## 4. Request and Route

```text
User: Find flights from JFK to Delhi next weekend
```

Actual tool route:

```text
resolve_flight_date
-> flight_search
-> update_flight_suggested_questions
```

`price_prediction_tool` call nahi hua because user ne cheapest/best fare nahi poocha.

## 5. Turn Context Preparation

Initial date state empty thi:

```json
{
  "searchKey": null,
  "lastSearch": null,
  "flight.dateIntent": null,
  "flight.lastPricePrediction": null
}
```

Preparation ke baad:

```json
{
  "requestId": "flight-flow-debug-vague-search-turn-1",
  "sessionId": "flight-flow-debug-vague-search",
  "flight": {
    "currentUserMessage": "Find flights from JFK to Delhi next weekend",
    "clock": {
      "localDate": "2026-07-31",
      "localDateTime": "2026-07-31T15:30:00+05:30",
      "timeZone": "Asia/Kolkata"
    },
    "dateIntent": null,
    "dateRouting": {
      "pricePredictionStatus": null,
      "priceFallbackDate": null,
      "fallbackSearchAttempted": false
    }
  }
}
```

## 6. Date Resolution

Agent ne `next weekend` ko structured semantics me convert kiya:

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

Resolver calculation:

```text
Current date: Friday, Jul 31
Nearest weekend: Aug 1-2
Next weekend: Aug 8-9
Selected search date: Aug 8
```

Stored `flight.dateIntent`:

```json
{
  "status": "RESOLVED",
  "kind": "weekend",
  "range": {
    "startDate": "2026-08-08",
    "endDate": "2026-08-09"
  },
  "searchDate": "2026-08-08",
  "returnDate": null,
  "priceFallbackDate": "2026-08-08",
  "timeZone": "Asia/Kolkata",
  "resolvedFromDate": "2026-07-31",
  "state": "pending"
}
```

Usable `searchDate` mil gayi, so Agent ne exact date dobara nahi poochi.

## 7. Flight Search and Final Date State

Search payload:

```json
{
  "onds": [
    {
      "origin": "JFK",
      "destination": "Delhi",
      "outbound_date": "2026-08-08",
      "return_date": null
    }
  ],
  "trip_type": "oneway",
  "passengers": {
    "adults": 1,
    "children": 0,
    "infants": 0
  },
  "cabin_class": "economy"
}
```

Search ke baad:

```json
{
  "searchKey": "search_debug-user-vague_1785738554701",
  "lastSearch": {
    "onds": [
      {
        "origin": "JFK",
        "destination": "Delhi",
        "outbound_date": "2026-08-08",
        "return_date": null
      }
    ],
    "trip_type": "oneway"
  },
  "flight.dateIntent": {
    "kind": "weekend",
    "searchDate": "2026-08-08",
    "state": "used",
    "usedAtRequestId": "flight-flow-debug-vague-search-turn-1"
  }
}
```

`markFlightDateIntentUsed` ne intent ko `used` mark kiya because actual search resolved date par hui.

Final response:

```text
I found one-way economy options from JFK to Delhi for Aug 8, the first day of next weekend. Note: Prices shown are per person.
```

---

# Scenario 2: Price Prediction to Flight Search

## 8. Turn 1: Cheapest Date Request

```text
User: What is the cheapest date to fly from JFK to Delhi next month?
```

Actual route:

```text
resolve_flight_date
-> price_prediction_tool
-> update_flight_suggested_questions
```

`cheapest date` explicit price-intelligence intent hai, isliye prediction correctly triggered hui.

## 9. Resolve Next Month

Resolver payload:

```json
{
  "kind": "month",
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

Resolved `dateIntent`:

```json
{
  "kind": "month",
  "range": {
    "startDate": "2026-08-01",
    "endDate": "2026-08-31"
  },
  "searchDate": "2026-08-01",
  "priceFallbackDate": "2026-08-04",
  "state": "pending"
}
```

- Aug 1 is normal-search default.
- Aug 4 is non-predicted fallback.
- Successful predicted winner abhi decide nahi hua.

## 10. Price Prediction Context

Tool payload full 89-day window use karta hai:

```json
{
  "originCity": "JFK",
  "destinationCity": "DEL",
  "startDate": "2026-07-31",
  "endDate": "2026-10-28",
  "tripType": "oneway",
  "returnStartDate": null,
  "returnEndDate": null,
  "tripDuration": null,
  "tripDurationFlexibility": null
}
```

Derived preference context:

```json
{
  "predictionWindow": {
    "startDate": "2026-07-31",
    "endDate": "2026-10-28"
  },
  "requestedRange": {
    "startDate": "2026-08-01",
    "endDate": "2026-08-31"
  },
  "effectiveRange": {
    "startDate": "2026-08-01",
    "endDate": "2026-08-31"
  },
  "fallbackDate": "2026-08-04"
}
```

Tool full window fetch karta hai, phir August preference ke andar dates rank karta hai.

Prediction result stored in `flight.lastPricePrediction`:

```json
{
  "status": "SUCCESS",
  "route": {
    "originCity": "JFK",
    "destinationCity": "DEL"
  },
  "predictionCount": 31,
  "cheapestDates": [
    { "departureDate": "2026-08-12" },
    { "departureDate": "2026-08-19" },
    { "departureDate": "2026-08-25" },
    { "departureDate": "2026-08-05" },
    { "departureDate": "2026-08-28" }
  ]
}
```

Turn 1 final response:

```text
Aug 12, 2026 looks strongest for your JFK to Delhi trip.

Other promising dates:
- Aug 19, 2026
- Aug 25, 2026

Want me to search flights for Aug 12?
```

## 11. Critical Context Difference

Prediction ke baad:

```json
{
  "flight.dateIntent.searchDate": "2026-08-01",
  "flight.dateIntent.priceFallbackDate": "2026-08-04",
  "flight.lastPricePrediction.cheapestDates[0].departureDate": "2026-08-12"
}
```

Correct follow-up search date **Aug 12** hai. Aug 1 generic month start hai, aur Aug 4 sirf failure fallback hai.

## 12. Turn 2: Search Best One

```text
User: Search flights for the best one
```

New turn preparation:

```text
Preserved: flight.dateIntent
Preserved: flight.lastPricePrediction
Preserved: SDK MemorySession history
Reset: flight.pricePredictionDateIntent
Reset: flight.dateRouting
Refreshed: flight.clock
```

Actual search payload correctly used predicted winner:

```json
{
  "onds": [
    {
      "origin": "JFK",
      "destination": "DEL",
      "outbound_date": "2026-08-12",
      "return_date": null
    }
  ],
  "trip_type": "oneway",
  "passengers": {
    "adults": 1,
    "children": 0,
    "infants": 0
  },
  "cabin_class": "economy"
}
```

## 13. Date Context After Predicted-Date Search

Actual search date old month default se different thi. Isliye `markFlightDateIntentUsed` ne month intent ko exact date se replace kiya:

```json
{
  "before": {
    "kind": "month",
    "range": "2026-08-01 to 2026-08-31",
    "searchDate": "2026-08-01",
    "state": "pending"
  },
  "after": {
    "kind": "exact",
    "range": "2026-08-12 to 2026-08-12",
    "searchDate": "2026-08-12",
    "priceFallbackDate": "2026-08-12",
    "state": "used",
    "usedAtRequestId": "flight-flow-debug-prediction-search-turn-2"
  }
}
```

Final persisted state:

```json
{
  "searchKey": "search_debug-user-prediction_1785738585656",
  "lastSearch": {
    "onds": [
      {
        "origin": "JFK",
        "destination": "DEL",
        "outbound_date": "2026-08-12",
        "return_date": null
      }
    ],
    "trip_type": "oneway"
  },
  "flight.dateIntent": {
    "kind": "exact",
    "searchDate": "2026-08-12",
    "state": "used"
  }
}
```

Final response:

```text
I found one-way economy options from JFK to Delhi for Aug 12, the strongest predicted travel date. Note: Prices shown are per person.
```

---

## 14. Date Journey Summary

### Vague search

```text
next weekend
-> weekend range Aug 8-9
-> searchDate Aug 8
-> flight search Aug 8
-> dateIntent state=used
```

### Prediction then search

```text
cheapest date next month
-> month range Aug 1-31
-> prediction window Jul 31-Oct 28
-> August results ranked
-> selected prediction Aug 12
-> follow-up search Aug 12
-> dateIntent becomes exact Aug 12, state=used
```

## 15. Findings

### Working correctly

- Normal vague-date searches prediction tool ko call nahi karte.
- Relative dates local date/timezone se resolve hote hain.
- Usable date hint ke baad exact date dobara nahi poochi jati.
- Prediction full 89-day window use karti hai.
- User month preference separately intersect hoti hai.
- Follow-up search predicted winner use karta hai.
- Actual searched date `lastSearch` and `dateIntent` me persist hoti hai.

### Main risk

`lastPricePrediction` runtime context me stored hai, but dynamic prompt currently compact prediction summary inject nahi karta. Tested follow-up same `MemorySession` ki previous tool history se Aug 12 recover kar saka.

Stateless ya compacted session me `best one` ambiguous ho sakta hai.

Recommended future hardening, not implemented:

```text
Latest prediction: route=JFK-DEL;
selectedDate=2026-08-12;
alternates=2026-08-19,2026-08-25.
```

Is compact value ko dynamic prompt me inject karein, ya `flight.selectedPredictedDate` persist karein.

### Existing repository limitation

Current ClickHouse query placeholder hai. Is report ka prediction result controlled mock row se aaya. Date-context flow verified hai; real ClickHouse data integration nahi.

## 16. Final Result

| Check | Result |
|---|---|
| Vague date resolution | Pass |
| Timezone/current-date usage | Pass |
| Search vs prediction routing | Pass |
| Exact-date question avoidance | Pass |
| Predicted date follow-up | Pass, with session dependency risk |
| Actual searched-date persistence | Pass |
| Focused regression suite | 65/65 passed |

No date business logic fix was applied during this debug.
