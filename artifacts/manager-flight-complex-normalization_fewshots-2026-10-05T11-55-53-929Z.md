# Separated location payloads and stateful tool-intelligence replay

Focus: Actual Manager -> Flight payloads, all five tools, empty-state inspection, mixed reset/add, flexible-date fallback, and endpoint changes.

Model policy: Manager=gpt-5.2, Flight=gpt-5.2, supporting=gpt-5.2; reasoning=low.

## Turn 1

- User message: Find one-way flights from Delhi DEL to New York NYC on October 20, 2026 for one adult in economy.
- Expected intent: Search an exact date with city names and IATA constraints separated.
- Expected tool(s): flight_search -> update_flight_suggested_questions
- Why that tool should be used: Complete exact-date search inputs require one search, not prediction; code constraints belong in dedicated fields.
- Expected state/context change: Create a Delhi/DEL -> New York/NYC search without combined name values or active filters.
- What we are validating: Live normalization, nullable airport names, Manager delegation, and no unnecessary prediction.
- Manager -> Flight subtask: Search one-way flights from Delhi (DEL) to New York City (NYC area airports) on 2026-10-20 for 1 adult, cabin: economy. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791201360822
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Manager output: ✈️ Here are the available one-way economy flights for **1 adult** from **Delhi (DEL)** to **New York City (NYC)** on **Oct 20, 2026**: Note: Prices shown are per person.

## Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints in one mutation of the existing results.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Stops, departure time, maximum price, and baggage do not change core search inputs.
- Expected state/context change: Keep the search key with nonstop, morning, maximum price, and carry-on filters.
- What we are validating: Compound filter payloads, stacking, and no redundant search.
- Manager -> Flight subtask: On the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy), apply filters: nonstop only; departure time morning only; price under $220; and only show options that include carry-on baggage. Return the filtered options (or report if none match) while preserving these filters.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201360822
- Actual active filters: stops, departureTime, price, baggage
- Actual filter values: {"stops":["0"],"departureTime":["MORNING"],"price":[220],"baggage":["1"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ I filtered to **nonstop + morning departures + under $220 + carry-on included**. There’s **1 matching option**:

## Turn 3

- User message: Make it evening instead, drop the price cap, and remove the carry-on requirement.
- Expected intent: Replace departure time and remove two filters while retaining nonstop.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Indirect wording changes the current filters, not the route or travel date.
- Expected state/context change: Preserve the search key with nonstop and evening only, leaving zero fixture matches.
- What we are validating: Replacement rather than union, selective removal, and empty-result feedback.
- Manager -> Flight subtask: Update the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy) filters as follows: change departure time filter to EVENING only (replacing morning); remove the price cap filter; remove the carry-on baggage requirement; keep nonstop-only filter active. Show the updated matching options.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201360822
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ Updated filters to **evening departures only + nonstop only** (and removed the **$220 cap** and **carry-on requirement**). There are **no matching flights** with those filters. 🔄 Want to (a) allow **1 stop**, or (b) expand to **afternoon+evening** to see options?

## Turn 4

- User message: Which current option is cheapest, and why?
- Expected intent: Read the current empty filtered set without changing state.
- Expected tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Why that tool should be used: Ranking requires fresh generated records; an empty result does not authorize removing filters.
- Expected state/context change: Keep core search, filters, and the empty set unchanged.
- What we are validating: Read-only ranking, no unfiltered fallback, and no invented recommendation.
- Manager -> Flight subtask: Inspect the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy) with the currently active filters (nonstop only + evening departures only). Report what the cheapest current option is; if there are no current options, state that clearly.
- Actual tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201360822
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: There isn’t a “cheapest” **current** option right now because your active filters (**nonstop only + evening departures only**) leave **0 matching flights**. If you relax either **nonstop** (allow 1 stop) or **evening-only** (expand the time window), I can tell you which option is cheapest among the results.

## Turn 5

- User message: Clear all filters and use only Air Canada or Emirates, with a layover under 90 minutes.
- Expected intent: Reset and add named-airline plus layover-duration constraints in one call.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The mixed reset/add request operates on existing inventory and requires both outcomes.
- Expected state/context change: Keep the search key with Air Canada/Emirates and maximum layover duration only.
- What we are validating: Clause-local reset/add semantics, source-array name resolution, and duration units.
- Manager -> Flight subtask: On the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy), clear all active filters. Then apply filters: airlines only Air Canada or Emirates; layover duration under 90 minutes. Show the matching options (or report if none).
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201360822
- Actual active filters: airline, layoverDuration
- Actual filter values: {"airline":["AC","AC+","EK"],"layoverDuration":[90]}
- Classification: stable
- Checks: none
- Manager output: ✈️ Cleared all filters, then limited results to **Air Canada or Emirates** with a **layover under 90 minutes**. There’s **1 matching option**:

## Turn 6

- User message: Show the cheapest current option.
- Expected intent: Read to identify the cheapest current option, then select it for display.
- Expected tool(s): getGeneratedContractsContext -> getGeneratedContractsContext -> update_flight_suggested_questions
- Why that tool should be used: The option has not been ranked in this state; fresh read evidence must precede selection.
- Expected state/context change: Select the identified current option without clearing filters or searching again.
- What we are validating: Read -> select mode ownership and evidence-backed indexing.
- Manager -> Flight subtask: From the current DEL→NYC one-way search on 2026-10-20 (1 adult, economy) with active filters (Air Canada or Emirates only; layover < 90 minutes), identify the cheapest current option and display it (or confirm if only one option exists). Preserve current filters.
- Actual tool(s): getGeneratedContractsContext -> getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201360822
- Actual active filters: airline, layoverDuration
- Actual filter values: {"airline":["AC","AC+","EK"],"layoverDuration":[90]}
- Classification: stable
- Checks: none
- Manager output: ✈️ The **cheapest current option** (and the only one matching your filters) is **Option 1 (Air Canada) — $199**:

## Turn 7

- User message: Find flights between October 21 and October 28, keeping only Air Canada.
- Expected intent: Infer date intelligence from a flexible window, then search and retain the requested airline.
- Expected tool(s): price_prediction_tool -> flight_search -> apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Implicit flexibility requires prediction first; after no-data feedback, requested results permit one disclosed in-window fallback search.
- Expected state/context change: Search October 21 with Delhi/DEL -> New York/NYC preserved and Air Canada only; drop unrequested old layover limit.
- What we are validating: Implicit prediction intent, exact bounds, honest fallback, separated endpoint carry-forward, and serial search/filter sequencing.
- Manager -> Flight subtask: Search one-way flights DEL→NYC for 1 adult in economy across the date range 2026-10-21 through 2026-10-28 (inclusive). Airline filter: Air Canada only. Show available options (or the cheapest per day if supported), and keep results constrained to Air Canada.
- Actual tool(s): price_prediction_tool -> flight_search -> apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201360822 -> search_demo-user_1791201484406
- Actual active filters: airline
- Actual filter values: {"airline":["AC","AC+"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ I can’t pull a cheapest-by-day view across **Oct 21–Oct 28, 2026** right now. I did search **Oct 21, 2026** and kept **Air Canada only**—there’s **1 matching option**: Note: Prices shown are per person. Would you like me to run **separate searches for Oct 22–Oct 28** as well (still Air Canada only), or are there 1–2 dates you want to prioritize?

## Turn 8

- User message: Same date, passengers and cabin, but fly to London Heathrow Airport (LHR) instead; keep Air Canada.
- Expected intent: Change destination and run a new search with separated city/code/airport name.
- Expected tool(s): flight_search -> apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The destination route changes; this is not an airport filter on the previous New York results.
- Expected state/context change: Create Delhi/DEL -> London/LHR search, retain October 21 and passenger/cabin values, and apply Air Canada.
- What we are validating: Production airport-name example, clearing stale NYC metadata, contextual date reuse, and no unnecessary prediction.
- Manager -> Flight subtask: Start a new one-way flight search for 1 adult in economy from Delhi (DEL) to London Heathrow (LHR) on 2026-10-21. Apply airline filter: Air Canada only. Show available options.
- Actual tool(s): flight_search -> apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791201484406 -> search_demo-user_1791201508710
- Actual active filters: airline
- Actual filter values: {"airline":["AC","AC+"]}
- Classification: unexpected_failure
- Checks: payload onds.0.destination_airport_name: expected "London Heathrow Airport", got "London Heathrow"
- Manager output: ✈️ Updated to **DEL → London Heathrow (LHR)** on **Oct 21, 2026**, **1 adult**, **economy**, **Air Canada only**. There’s **1 matching option**: Note: Prices shown are per person.

## Tool coverage checklist

- [x] flight_search
- [x] getGeneratedContractsContext
- [x] apply_filter
- [x] price_prediction_tool
- [x] update_flight_suggested_questions
