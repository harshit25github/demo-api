# Five complex Manager + Flight conversations

These are scenario definitions, not execution results. Run one conversation at a time through the production Manager runner, inspect every tool input/result, fix unexpected failures, and rerun that conversation before proceeding.

Use the existing API key, GPT-5.2 for every model call, and low reasoning. The clock is fixed to October 5, 2026 in Asia/Kolkata for reproducible relative-date behavior.

Current registered Flight tools: `flight_search`, `getGeneratedContractsContext`, `apply_filter`, `price_prediction_tool`, `update_flight_suggested_questions`.

There is no registered date-resolution tool. Relative timing is resolved through prompt intelligence and the immutable request clock. Search/filter records currently come from the fixture backend; these scenarios test orchestration and state, while price-prediction success depends on configured prediction data.

## Conversation 1: Compound filters, replacements, removals, prediction, and route change

Focus: Filter stacking and replacement, current-option reasoning, prediction-to-search sequencing, and distinguishing a departure-location change from an airport filter.

### Turn 1

- User message: Find one-way flights from New York to Los Angeles on October 20, 2026 for one adult in economy.
- Expected intent: Start a new exact-date one-way flight search.
- Expected tool(s): `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: The route, exact date, passengers, trip type, and cabin are complete, so a new search is required without price prediction.
- Expected state/context change: Create a new search key, store three current options, and start with no active filters.
- What we are validating: Manager delegates a complete flight request once and Flight does not over-trigger prediction for an exact date.
- Expected active filter values: `{}`

### Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints to the current result set in one mutation.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Stops, departure time, maximum price, and baggage are supported filters and do not change the search inputs.
- Expected state/context change: Keep the search key and activate stops, departureTime, price, and baggage filters.
- What we are validating: One compound apply_filter call, no unnecessary re-search, and complete filter stacking.
- Expected active filter values: `{"stops":["0"],"departureTime":["MORNING"],"price":[220],"baggage":["1"]}`

### Turn 3

- User message: Make it evening instead, drop the price cap, and remove the carry-on requirement.
- Expected intent: Replace one active filter and remove two others while preserving nonstop.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: This is an in-place filter update: evening replaces morning, while price and baggage are removed.
- Expected state/context change: Keep the search key with only stops and evening departure active.
- What we are validating: Indirect replacement wording and multi-filter removal without losing unrelated state.
- Expected active filter values: `{"stops":["0"],"departureTime":["EVENING"]}`

### Turn 4

- User message: Remove the nonstop filter, show only Air China, and keep total trip duration under four hours.
- Expected intent: Remove stops and add airline plus total-duration constraints.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: All requested changes operate on the existing cards; evening departure remains unchanged because it was not removed.
- Expected state/context change: Keep the search key with evening departure, Air China, and maximum total duration active.
- What we are validating: Targeted removal, named-airline resolution, duration filtering, and preservation of an unmentioned active filter.
- Expected active filter values: `{"departureTime":["EVENING"],"airline":["CA"],"totalDuration":[240]}`

### Turn 5

- User message: Which current option is cheapest, and why?
- Expected intent: Reason over current generated options without changing visibility or search state.
- Expected tool(s): `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: A current-option ranking requires fresh contract evidence, not a new search or another filter.
- Expected state/context change: Keep the search key and all active filters unchanged.
- What we are validating: Fresh contract retrieval, context reuse, and no state mutation for option reasoning.
- Expected active filter values: `{"departureTime":["EVENING"],"airline":["CA"],"totalDuration":[240]}`

### Turn 6

- User message: Check for better travel dates between October 21 and October 28, then show flights on the strongest date with Air China still applied.
- Expected intent: Evaluate a flexible date window, search the strongest or bounded fallback date, then reapply the explicitly retained airline.
- Expected tool(s): `price_prediction_tool` → `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The flexible bracket requires prediction before the requested search; the new search clears old filters, so only the explicitly retained Air China filter is reapplied.
- Expected state/context change: Create a new search key on an in-window date and leave only the Air China filter active.
- What we are validating: Prediction-to-search-to-filter ordering, bounded failure fallback, and selective filter carry-forward.
- Expected active filter values: `{"airline":["CA"]}`

### Turn 7

- User message: Start the trip in Newark instead of New York, using the same date, passengers, and cabin. Keep Air China and remove every other filter.
- Expected intent: Change the departure endpoint, run a new search, and reapply only the requested airline filter.
- Expected tool(s): `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Starting in Newark changes the search route; it is not merely a departure-airport filter on the old New York search.
- Expected state/context change: Create a new search key for Newark to Los Angeles and keep only Air China active.
- What we are validating: Filter-looking route changes, reuse of prior date/passengers/cabin, and removal of stale filters after re-search.
- Expected active filter values: `{"airline":["CA"]}`

### Planned tool coverage checklist

Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.

- [x] `flight_search` — turns 1, 6, 7
- [x] `getGeneratedContractsContext` — turn 5
- [x] `apply_filter` — turns 2, 3, 4, 6, 7
- [x] `price_prediction_tool` — turn 6
- [x] `update_flight_suggested_questions` — turns 1, 2, 3, 4, 5, 6, 7

Run this conversation:

```powershell
$env:RUN_MANAGER_FLIGHT_LIVE='1'
npx tsx tests/live/manager-flight-five-chats-live.ts --chat compound_filters_route_change
```

## Conversation 2: Round-trip airport, layover, duration, and destination changes

Focus: Round-trip context retention, airport and layover filters, compound removals, filter-then-read sequencing, flexible-date search, and destination changes.

### Turn 1

- User message: Find round-trip business-class flights from Los Angeles to New York, leaving October 30, 2026 and returning November 6, 2026, for two adults.
- Expected intent: Start a complete exact-date round-trip search.
- Expected tool(s): `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: Both route endpoints, both dates, passenger count, trip type, and cabin are known.
- Expected state/context change: Create a round-trip search with no active filters.
- What we are validating: Round-trip payload assembly and Manager-to-Flight context handoff.
- Expected active filter values: `{}`

### Turn 2

- User message: Use Burbank departures, arrive at Newark, allow one stop, require checked baggage, and keep layovers under two hours.
- Expected intent: Apply departure airport, arrival airport, stops, baggage, and layover-duration filters together.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: These constrain existing results and should be one filter call even if the combination has no matches.
- Expected state/context change: Keep the search key and activate five filter categories.
- What we are validating: Full compound airport/filter payload and correct zero-result state retention.
- Expected active filter values: `{"departureAirport":["BUR"],"arrivalAirport":["EWR"],"stops":["2"],"baggage":["0"],"layoverDuration":[120]}`

### Turn 3

- User message: Remove Newark and checked baggage. Allow any Los Angeles-area departure airport, require a Dubai or Amsterdam layover, and arrive in the evening.
- Expected intent: Remove two filters, broaden one airport filter, and add layover-airport plus arrival-time constraints.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The search inputs are unchanged; all operations belong in one state-aware filter update.
- Expected state/context change: Preserve one stop and layover duration, replace departure-airport scope, remove arrival airport and baggage, and add layover airport plus evening arrival.
- What we are validating: Multiple removals/additions, named airport-group resolution, alternative layover airports, and active-filter preservation.
- Expected active filter values: `{"departureAirport":["LAX","BUR","ONT","SNA"],"stops":["2"],"layoverDuration":[120],"layoverAirport":["DXB","AMS"],"arrivalTime":["EVENING"]}`

### Turn 4

- User message: Make arrival morning instead, cap total duration at three hours, and remove both the layover-airport restriction and the layover-duration limit.
- Expected intent: Replace arrival time, add total duration, and remove two layover filters.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: This changes only filters and must preserve the departure-airport and one-stop constraints.
- Expected state/context change: Keep departureAirport, stops, morning arrival, and totalDuration filters.
- What we are validating: Changing an applied filter and removing multiple related filters in one call.
- Expected active filter values: `{"departureAirport":["LAX","BUR","ONT","SNA"],"stops":["2"],"arrivalTime":["MORNING"],"totalDuration":[180]}`

### Turn 5

- User message: Remove the one-stop filter too. Which options remain, and which is shortest?
- Expected intent: Remove stops, then inspect the newly filtered current result set.
- Expected tool(s): `apply_filter` → `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: The filter mutation must finish before current-option facts and ranking are read.
- Expected state/context change: Keep the same search key with departureAirport, morning arrival, and total duration active.
- What we are validating: Filter-then-read sequencing and no re-search for current-result reasoning.
- Expected active filter values: `{"departureAirport":["LAX","BUR","ONT","SNA"],"arrivalTime":["MORNING"],"totalDuration":[180]}`

### Turn 6

- User message: Find stronger round-trip departure dates between November 1 and November 5, returning exactly seven days later, then show flights for the strongest date. Keep only morning arrival and total duration under three hours.
- Expected intent: Predict within a bounded round-trip window, search the strongest or fallback pair, then apply only two carried filters.
- Expected tool(s): `price_prediction_tool` → `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Flexible outbound timing plus a fixed stay requires round-trip prediction before search, and the new result set must be filtered afterward.
- Expected state/context change: Create a new search key and retain only arrivalTime and totalDuration filters.
- What we are validating: Round-trip prediction bounds/duration, serial dependency handling, and explicit filter carry-forward.
- Expected active filter values: `{"arrivalTime":["MORNING"],"totalDuration":[180]}`

### Turn 7

- User message: Keep those dates, passengers, and cabin, but fly to Boston instead. Do not keep any filters.
- Expected intent: Change the destination and run a clean new search using all other established search inputs.
- Expected tool(s): `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: Destination is a core search field; the explicit no-filters instruction means no apply_filter call is needed after the new search clears state.
- Expected state/context change: Create a Boston search key with no active filters.
- What we are validating: Route update versus filtering, round-trip context reuse, and clean filter reset through new-search semantics.
- Expected active filter values: `{}`

### Planned tool coverage checklist

Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.

- [x] `flight_search` — turns 1, 6, 7
- [x] `getGeneratedContractsContext` — turn 5
- [x] `apply_filter` — turns 2, 3, 4, 5, 6
- [x] `price_prediction_tool` — turn 6
- [x] `update_flight_suggested_questions` — turns 1, 2, 3, 4, 5, 6, 7

Run this conversation:

```powershell
$env:RUN_MANAGER_FLIGHT_LIVE='1'
npx tsx tests/live/manager-flight-five-chats-live.ts --chat roundtrip_airports_layovers
```

## Conversation 3: Missing route, relative flexibility, indirect removal, and route replacement

Focus: Pending flexible timing across clarification, implicit prediction, indirect filter references, airport filtering, and later departure-city change.

### Turn 1

- User message: I need to fly to Dubai any day next week, one adult in economy.
- Expected intent: Retain the flexible next-week window and ask only for the missing departure location.
- Expected tool(s): `update_flight_suggested_questions`
- Why that tool should be used: Prediction and search both require the missing route endpoint; no core tool can run safely yet.
- Expected state/context change: No search key; preserve the pending date window and known arrival/passenger/cabin context in feedback/session history.
- What we are validating: Manager/Flight clarification ownership, no premature tool call, and preservation of multi-turn flexible timing.
- Expected active filter values: `{}`

### Turn 2

- User message: Leaving from Delhi.
- Expected intent: Complete the retained flexible-window request, predict dates, and show flights.
- Expected tool(s): `price_prediction_tool` → `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: The missing route endpoint now completes the earlier search intent; the multi-date window requires prediction first.
- Expected state/context change: Create a Delhi-to-Dubai search key on an in-window strongest or fallback date.
- What we are validating: Self-contained Manager subtask reconstruction and completion of pending intent without re-asking for timing.
- Expected active filter values: `{}`

### Turn 3

- User message: Show only Emirates, one-stop flights arriving in the evening with layovers under three hours.
- Expected intent: Apply airline, stops, arrival-time, and layover-duration filters.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Every constraint is supported on the current search and belongs in one filter call.
- Expected state/context change: Keep the search key with four active filter categories.
- What we are validating: Compound filtering after a clarification-completed search.
- Expected active filter values: `{"airline":["EK"],"stops":["2"],"arrivalTime":["EVENING"],"layoverDuration":[180]}`

### Turn 4

- User message: Remove that airline, keep the other constraints, and make departure afternoon too.
- Expected intent: Resolve the indirect airline reference, remove it, and add departure time.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Only Emirates is active, so “that airline” is unambiguous and should not trigger a clarification or search.
- Expected state/context change: Remove airline while preserving stops, arrivalTime, and layoverDuration; add departureTime.
- What we are validating: Indirect reference resolution and targeted filter removal without context loss.
- Expected active filter values: `{"stops":["2"],"arrivalTime":["EVENING"],"layoverDuration":[180],"departureTime":["AFTERNOON"]}`

### Turn 5

- User message: Replace evening arrival with morning, remove the layover limit, and add Air Canada only.
- Expected intent: Replace arrival time, remove layover duration, and add a named airline.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The current route/date remain unchanged; this is another atomic filter-state update.
- Expected state/context change: Keep stops and afternoon departure; set morning arrival and Air Canada; remove layoverDuration.
- What we are validating: Replacement/removal/addition semantics across an existing multi-filter state.
- Expected active filter values: `{"stops":["2"],"departureTime":["AFTERNOON"],"arrivalTime":["MORNING"],"airline":["AC","AC+"]}`

### Turn 6

- User message: Use Delhi airport only for departure.
- Expected intent: Apply a departure-airport constraint to current results.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The route city is unchanged and the wording constrains the airport within the active result set.
- Expected state/context change: Add departureAirport while preserving the four existing filters.
- What we are validating: Airport filter selection without misclassifying it as a new city search.
- Expected active filter values: `{"stops":["2"],"departureTime":["AFTERNOON"],"arrivalTime":["MORNING"],"airline":["AC","AC+"],"departureAirport":["DEL"]}`

### Turn 7

- User message: Actually start in Mumbai instead, using the same date, passenger, and cabin. Keep only Air Canada and morning arrival.
- Expected intent: Change the departure city, start a new search, and selectively reapply two filters.
- Expected tool(s): `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Mumbai replaces the route endpoint; the old search and all unmentioned filters become stale.
- Expected state/context change: Create a Mumbai-to-Dubai search key with only airline and arrivalTime active.
- What we are validating: Route-change detection, prior date reuse, stale-filter clearing, and explicit carry-forward.
- Expected active filter values: `{"airline":["AC","AC+"],"arrivalTime":["MORNING"]}`

### Turn 8

- User message: Compare option 1 with option 2 from the current results.
- Expected intent: Read and compare two current options without changing cards or filters.
- Expected tool(s): `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: The request concerns generated contracts and should use fresh indexed context.
- Expected state/context change: Keep search key, route, date, and filters unchanged.
- What we are validating: Numbered-option context reuse through Manager and no redundant search/filter call.
- Expected active filter values: `{"airline":["AC","AC+"],"arrivalTime":["MORNING"]}`

### Planned tool coverage checklist

Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.

- [x] `flight_search` — turns 2, 7
- [x] `getGeneratedContractsContext` — turn 8
- [x] `apply_filter` — turns 3, 4, 5, 6, 7
- [x] `price_prediction_tool` — turn 2
- [x] `update_flight_suggested_questions` — turns 1, 2, 3, 4, 5, 6, 7, 8

Run this conversation:

```powershell
$env:RUN_MANAGER_FLIGHT_LIVE='1'
npx tsx tests/live/manager-flight-five-chats-live.ts --chat clarification_relative_context
```

## Conversation 4: Atomic reset-plus-add, result reasoning, advice-only prediction, and recommit

Focus: Broad compound filtering, atomic clear-and-add behavior, date advice without search, later exact-date search, and final option comparison.

### Turn 1

- User message: Find one-way flights from San Francisco to Tokyo on November 15, 2026 for one adult in economy.
- Expected intent: Start a new exact-date one-way search.
- Expected tool(s): `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: The request has all required search fields and no flexible date window.
- Expected state/context change: Create a search key with no filters.
- What we are validating: Baseline Manager-routed search and exact-date prediction boundary.
- Expected active filter values: `{}`

### Turn 2

- User message: Show flights departing before 6am, arriving in the afternoon, with personal item only, two or more stops, and price under $175.
- Expected intent: Apply five supported filters in one call.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Time windows, baggage, stops, and maximum price all filter current options.
- Expected state/context change: Keep the search key with departureTime, arrivalTime, baggage, stops, and price active.
- What we are validating: Early-morning/afternoon normalization, multi-stop bucket, baggage code, and maximum-price handling.
- Expected active filter values: `{"departureTime":["EARLYMORNING"],"arrivalTime":["AFTERNOON"],"baggage":["2"],"stops":["3"],"price":[175]}`

### Turn 3

- User message: Which current option is the best value compared with the shortest one?
- Expected intent: Compare current generated options using fresh contract evidence.
- Expected tool(s): `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: Value and duration reasoning are about current options and must not mutate the search.
- Expected state/context change: Keep the search and all five filters unchanged.
- What we are validating: Current-result reasoning after compound filtering and no unnecessary search.
- Expected active filter values: `{"departureTime":["EARLYMORNING"],"arrivalTime":["AFTERNOON"],"baggage":["2"],"stops":["3"],"price":[175]}`

### Turn 4

- User message: Clear all filters, but in the same request show one-stop flights with checked baggage, a Dubai layover, and total duration under four hours.
- Expected intent: Atomically reset prior filters and apply four new constraints.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Mixed reset-plus-add must be one apply_filter call with reset plus the independent additions.
- Expected state/context change: Replace all old filters with stops, baggage, layoverAirport, and totalDuration.
- What we are validating: Atomic reset semantics and no one-filter-at-a-time loops.
- Expected active filter values: `{"stops":["2"],"baggage":["0"],"layoverAirport":["DXB"],"totalDuration":[240]}`

### Turn 5

- User message: Make it nonstop instead, remove the Dubai layover and checked bag, add carry-on, and arrive in the morning.
- Expected intent: Replace stops, remove two filters, and add baggage plus arrival time.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Every operation modifies the current filter state and should remain one atomic call.
- Expected state/context change: Keep totalDuration; set nonstop, carry-on, and morning arrival; remove layoverAirport and checked baggage.
- What we are validating: Cross-category replacement and exact removals after a reset-plus-add turn.
- Expected active filter values: `{"totalDuration":[240],"stops":["0"],"baggage":["1"],"arrivalTime":["MORNING"]}`

### Turn 6

- User message: I can travel any day from November 16 through November 23. Recommend stronger dates only; do not change my current search yet.
- Expected intent: Evaluate an implicit flexible date window for advice only.
- Expected tool(s): `price_prediction_tool` → `update_flight_suggested_questions`
- Why that tool should be used: The bounded window itself authorizes prediction, while the explicit instruction forbids a new flight search.
- Expected state/context change: Keep the existing search key and active filters unchanged while storing the prediction outcome.
- What we are validating: Flexible-window intent detection and advice-only no-search discipline.
- Expected active filter values: `{"totalDuration":[240],"stops":["0"],"baggage":["1"],"arrivalTime":["MORNING"]}`

### Turn 7

- User message: Now search November 20 instead, keeping nonstop, carry-on, morning arrival, and total duration under four hours.
- Expected intent: Change to an exact date, run a new search, then reapply four explicit filters.
- Expected tool(s): `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The exact date is a core search change; filters apply only after the new result state exists.
- Expected state/context change: Create a new search key for November 20 with the four named filters active.
- What we are validating: Search-before-filter sequencing and explicit filter carry-forward after advice-only prediction.
- Expected active filter values: `{"stops":["0"],"baggage":["1"],"arrivalTime":["MORNING"],"totalDuration":[240]}`

### Turn 8

- User message: Compare option 1 with the cheapest current option without changing which cards are shown.
- Expected intent: Read current contracts for an indexed-versus-ranked comparison.
- Expected tool(s): `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: The comparison requires fresh contract evidence in read mode and no search/filter mutation.
- Expected state/context change: Keep the current search, filters, and card visibility unchanged.
- What we are validating: Indexed reference plus open-ended ranking and non-mutating context retrieval.
- Expected active filter values: `{"stops":["0"],"baggage":["1"],"arrivalTime":["MORNING"],"totalDuration":[240]}`

### Planned tool coverage checklist

Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.

- [x] `flight_search` — turns 1, 7
- [x] `getGeneratedContractsContext` — turns 3, 8
- [x] `apply_filter` — turns 2, 4, 5, 7
- [x] `price_prediction_tool` — turn 6
- [x] `update_flight_suggested_questions` — turns 1, 2, 3, 4, 5, 6, 7, 8

Run this conversation:

```powershell
$env:RUN_MANAGER_FLIGHT_LIVE='1'
npx tsx tests/live/manager-flight-five-chats-live.ts --chat reset_prediction_recommit
```

## Conversation 5: Deep filter state, airline replacement, passenger/cabin search, and price advice

Focus: Dense filter accumulation, later replacements/removals, option detail selection, search-input changes with selected filter carry-forward, and round-trip date advice.

### Turn 1

- User message: Find round-trip flights from Delhi to Dubai, departing December 5, 2026 and returning December 12, 2026, for two adults in economy.
- Expected intent: Start a complete exact-date round-trip search.
- Expected tool(s): `flight_search` → `update_flight_suggested_questions`
- Why that tool should be used: All core search inputs are explicitly supplied.
- Expected state/context change: Create a Delhi-to-Dubai round-trip search with no filters.
- What we are validating: Baseline round-trip search and exact state initialization.
- Expected active filter values: `{}`

### Turn 2

- User message: Show nonstop evening departures under $250, total duration under three hours, with personal item only.
- Expected intent: Apply stops, departure time, price, total duration, and baggage filters.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: These are supported constraints on the active result set.
- Expected state/context change: Keep the search key with five active filter types.
- What we are validating: Dense compound filtering and correct retention even when the result set is empty.
- Expected active filter values: `{"stops":["0"],"departureTime":["EVENING"],"price":[250],"totalDuration":[180],"baggage":["2"]}`

### Turn 3

- User message: Make departure afternoon instead, allow one stop, replace personal item with checked baggage, remove the price cap, and show only Air China.
- Expected intent: Replace three filter values, remove price, and add airline while preserving total duration.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: No core search field changes; this is one multi-operation filter update.
- Expected state/context change: Keep departureTime, stops, baggage, totalDuration, and airline; remove price.
- What we are validating: Several simultaneous replacements plus removal and addition.
- Expected active filter values: `{"departureTime":["AFTERNOON"],"stops":["2"],"baggage":["0"],"totalDuration":[180],"airline":["CA"]}`

### Turn 4

- User message: Also require a Dubai layover under 60 minutes and arrival in the evening.
- Expected intent: Add layover airport, layover duration, and arrival time to existing filters.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: The new constraints narrow current results and should preserve every active filter.
- Expected state/context change: Add layoverAirport, layoverDuration, and arrivalTime to the five existing filter types.
- What we are validating: Later filter addition without dropping previously active constraints.
- Expected active filter values: `{"departureTime":["AFTERNOON"],"stops":["2"],"baggage":["0"],"totalDuration":[180],"airline":["CA"],"layoverAirport":["DXB"],"layoverDuration":[60],"arrivalTime":["EVENING"]}`

### Turn 5

- User message: Remove that airline and show Air Canada or Emirates instead; keep every other constraint.
- Expected intent: Remove the indirectly referenced Air China filter and replace it with two named airlines.
- Expected tool(s): `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Air China is the only active airline, so the indirect removal is resolvable and the alternatives are additions in the same category.
- Expected state/context change: Preserve seven non-airline filters and replace airline with Air Canada or Emirates.
- What we are validating: Indirect airline removal, multi-airline alternatives, and no loss of unrelated filters.
- Expected active filter values: `{"departureTime":["AFTERNOON"],"stops":["2"],"baggage":["0"],"totalDuration":[180],"airline":["AC","AC+","EK"],"layoverAirport":["DXB"],"layoverDuration":[60],"arrivalTime":["EVENING"]}`

### Turn 6

- User message: Which current option is shortest? Show its details without starting another search.
- Expected intent: Read current contracts and select the recommended option for display if available.
- Expected tool(s): `getGeneratedContractsContext` → `update_flight_suggested_questions`
- Why that tool should be used: Current-option ranking requires a read. In the current backend fixture, the one-stop constraint combined with Air Canada or Emirates leaves no matching option, so there is nothing to select. Preserve the empty set and offer a relaxation without applying it.
- Expected state/context change: Keep the search key and all active filters; visibility may narrow only if an available option is explicitly shown.
- What we are validating: Current-result reasoning after deep filter state and no redundant search.
- Expected active filter values: `{"departureTime":["AFTERNOON"],"stops":["2"],"baggage":["0"],"totalDuration":[180],"airline":["AC","AC+","EK"],"layoverAirport":["DXB"],"layoverDuration":[60],"arrivalTime":["EVENING"]}`

### Turn 7

- User message: Change to business class for three adults, same route and dates. Keep one stop, afternoon departure, evening arrival, checked baggage, total duration under three hours, a Dubai layover under 60 minutes, but drop the airline restriction.
- Expected intent: Change passenger count and cabin, run a new search, then reapply seven explicitly retained filters without airline.
- Expected tool(s): `flight_search` → `apply_filter` → `update_flight_suggested_questions`
- Why that tool should be used: Passenger and cabin changes require a new search; the named constraints must be applied only after it succeeds.
- Expected state/context change: Create a new search key for three adults in business with seven non-airline filters active.
- What we are validating: Core search changes after deep filtering, search-before-filter ordering, and exact selective carry-forward.
- Expected active filter values: `{"stops":["2"],"departureTime":["AFTERNOON"],"arrivalTime":["EVENING"],"baggage":["0"],"totalDuration":[180],"layoverAirport":["DXB"],"layoverDuration":[60]}`

### Turn 8

- User message: For this route and seven-day stay, compare departures from December 8 through December 15 and recommend stronger date pairs only. Do not search yet.
- Expected intent: Use current round-trip context for advice-only date prediction across a new outbound window.
- Expected tool(s): `price_prediction_tool` → `update_flight_suggested_questions`
- Why that tool should be used: The route and trip duration are known, the new date bracket is flexible, and the user explicitly forbids a search.
- Expected state/context change: Keep the existing search key and all seven filters while storing the prediction result.
- What we are validating: Round-trip context reuse for prediction and no accidental search on an advice-only turn.
- Expected active filter values: `{"stops":["2"],"departureTime":["AFTERNOON"],"arrivalTime":["EVENING"],"baggage":["0"],"totalDuration":[180],"layoverAirport":["DXB"],"layoverDuration":[60]}`

### Planned tool coverage checklist

Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.

- [x] `flight_search` — turns 1, 7
- [x] `getGeneratedContractsContext` — turn 6
- [x] `apply_filter` — turns 2, 3, 4, 5, 7
- [x] `price_prediction_tool` — turn 8
- [x] `update_flight_suggested_questions` — turns 1, 2, 3, 4, 5, 6, 7, 8

Run this conversation:

```powershell
$env:RUN_MANAGER_FLIGHT_LIVE='1'
npx tsx tests/live/manager-flight-five-chats-live.ts --chat deep_filter_state_search_changes
```
