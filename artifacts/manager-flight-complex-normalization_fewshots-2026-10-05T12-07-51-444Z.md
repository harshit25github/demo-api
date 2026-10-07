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
- Manager -> Flight subtask: Search for one-way flights from Delhi (DEL) to New York City (NYC) on October 20, 2026 for 1 adult in Economy. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791202078385
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Manager output: ✈️ Here are the available one-way Economy flights for **1 adult** from **Delhi (DEL) → New York City (NYC)** on **Oct 20, 2026**: Note: Prices shown are per person.

## Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints in one mutation of the existing results.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Stops, departure time, maximum price, and baggage do not change core search inputs.
- Expected state/context change: Keep the search key with nonstop, morning, maximum price, and carry-on filters.
- What we are validating: Compound filter payloads, stacking, and no redundant search.
- Manager -> Flight subtask: On the current DEL → NYC one-way search for 2026-10-20 (1 adult, Economy), filter results to: nonstop only; morning departures only; price under $220; and options that include carry-on baggage. Show matching options (or report none), preserving all active filters.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202078385 -> search_demo-user_1791202078385
- Actual active filters: stops, departureTime, price, baggage
- Actual filter values: {"stops":["0"],"departureTime":["MORNING"],"price":[220],"baggage":["1"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ I filtered to **nonstop + morning departures + under $220 + carry-on included**. Here’s the **1** matching option:

## Turn 3

- User message: Make it evening instead, drop the price cap, and remove the carry-on requirement.
- Expected intent: Replace departure time and remove two filters while retaining nonstop.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Indirect wording changes the current filters, not the route or travel date.
- Expected state/context change: Preserve the search key with nonstop and evening only, leaving zero fixture matches.
- What we are validating: Replacement rather than union, selective removal, and empty-result feedback.
- Manager -> Flight subtask: On the current DEL → NYC one-way search for 2026-10-20 (1 adult, Economy), update filters: change time-of-day from morning to evening departures only; remove the price cap filter; remove the carry-on-included requirement. Keep the nonstop-only filter as currently active unless the user asked to remove it (they did not). Show the matching options.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202078385 -> search_demo-user_1791202078385
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ Updated filters to **evening departures** and removed the **price cap** and **carry-on requirement** (kept **nonstop only**). There are **no matching flights** with **nonstop + evening** for **DEL → NYC on Oct 20, 2026**. 🔄 Want to **allow 1 stop**, or keep nonstop and **open up to all departure times**?

## Turn 4

- User message: Which current option is cheapest, and why?
- Expected intent: Read the current empty filtered set without changing state.
- Expected tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Why that tool should be used: Ranking requires fresh generated records; an empty result does not authorize removing filters.
- Expected state/context change: Keep core search, filters, and the empty set unchanged.
- What we are validating: Read-only ranking, no unfiltered fallback, and no invented recommendation.
- Manager -> Flight subtask: Inspect the current options in the active DEL→NYC one-way search for 2026-10-20 (1 adult, Economy), preserving the currently active filters (nonstop only + evening departures only). Report which current option is cheapest; if there are no current options, report that clearly.
- Actual tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202078385 -> search_demo-user_1791202078385
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: There isn’t a “cheapest current option” because your **current filters (nonstop + evening departures)** leave **0 matching flights**—so there are no options to price-compare. If you tell me which to relax first (**allow 1 stop** or **remove evening-only**), I can show the cheapest option from the updated results.

## Turn 5

- User message: Clear all filters and use only Air Canada or Emirates, with a layover under 90 minutes.
- Expected intent: Reset and add named-airline plus layover-duration constraints in one call.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The mixed reset/add request operates on existing inventory and requires both outcomes.
- Expected state/context change: Keep the search key with Air Canada/Emirates and maximum layover duration only.
- What we are validating: Clause-local reset/add semantics, source-array name resolution, and duration units.
- Manager -> Flight subtask: On the current DEL → NYC one-way search for 2026-10-20 (1 adult, Economy), clear all existing filters. Then apply filters: airline only Air Canada or Emirates; layover duration under 90 minutes. Show matching options (or report none).
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202078385 -> search_demo-user_1791202078385
- Actual active filters: airline, layoverDuration
- Actual filter values: {"airline":["AC","AC+","EK"],"layoverDuration":[90]}
- Classification: unexpected_failure
- Checks: suggestions recycled the used-and-reset nonstop action on the unchanged trip
- Manager output: ✈️ Cleared all filters, then applied **Air Canada or Emirates only** + **layover under 90 minutes**. Here’s the **1** matching option:

## Tool coverage checklist

- [x] flight_search
- [x] getGeneratedContractsContext
- [x] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
