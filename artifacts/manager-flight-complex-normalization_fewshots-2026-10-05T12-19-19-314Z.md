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
- Manager -> Flight subtask: Search one-way flights from Delhi (DEL) to New York City (NYC) for Oct 20, 2026, 1 adult, economy cabin. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791202768486
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Manager output: ✈️ Here are 3 one-way economy options for **Delhi (DEL) → New York City (NYC)** on **Oct 20, 2026** (1 adult): Note: Prices shown are per person.

## Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints in one mutation of the existing results.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Stops, departure time, maximum price, and baggage do not change core search inputs.
- Expected state/context change: Keep the search key with nonstop, morning, maximum price, and carry-on filters.
- What we are validating: Compound filter payloads, stacking, and no redundant search.
- Manager -> Flight subtask: On the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy), apply filters: nonstop only; departure time morning only; price under $220; include carry-on baggage (baggage-included/carry-on). Preserve route/date/pax/cabin.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202768486 -> search_demo-user_1791202768486
- Actual active filters: stops, departureTime, price, baggage
- Actual filter values: {"stops":["0"],"departureTime":["MORNING"],"price":[220],"baggage":["1"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ Filtered to **nonstop + morning departures + under $220 + carry-on included** — **1 option** matches:

## Turn 3

- User message: Make it evening instead, drop the price cap, and remove the carry-on requirement.
- Expected intent: Replace departure time and remove two filters while retaining nonstop.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Indirect wording changes the current filters, not the route or travel date.
- Expected state/context change: Preserve the search key with nonstop and evening only, leaving zero fixture matches.
- What we are validating: Replacement rather than union, selective removal, and empty-result feedback.
- Manager -> Flight subtask: On the current DEL→NYC one-way search for 2026-10-20 (1 adult, economy), update filters: change departure time from morning to evening; remove/clear the price cap (<$220); remove/clear the carry-on baggage-included requirement. Keep nonstop-only filter as currently active (no request to remove it).
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202768486 -> search_demo-user_1791202768486
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ Updated your filters to **evening departures only + nonstop only**, and removed the **$220 price cap** and **carry-on requirement**. ℹ️ With **nonstop + evening** on Oct 20, 2026 (DEL→NYC), there are **no matching flights** right now. 🔄 Want to (a) keep **evening** and allow **1 stop**, or (b) keep **nonstop** and open up to **afternoon/evening**?

## Turn 4

- User message: Which current option is cheapest, and why?
- Expected intent: Read the current empty filtered set without changing state.
- Expected tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Why that tool should be used: Ranking requires fresh generated records; an empty result does not authorize removing filters.
- Expected state/context change: Keep core search, filters, and the empty set unchanged.
- What we are validating: Read-only ranking, no unfiltered fallback, and no invented recommendation.
- Manager -> Flight subtask: Inspect the current filtered results for DEL→NYC one-way on 2026-10-20 (1 adult, economy) with active filters: nonstop only + evening departures only. Report whether any options exist; if so, identify the cheapest current option and summarize key reasons it is cheapest (e.g., fewer perks, longer travel time/layover, less flexible fare, different arrival airport), without discussing booking-specific fare rules.
- Actual tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202768486 -> search_demo-user_1791202768486
- Actual active filters: stops, departureTime
- Actual filter values: {"stops":["0"],"departureTime":["EVENING"]}
- Classification: stable
- Checks: none
- Manager output: ✈️ There isn’t a “cheapest current option” right now because your **current filters (nonstop + evening departures)** leave **0 matching flights** for DEL→NYC on **Oct 20, 2026**. If you tell me which filter to relax—**allow 1 stop (keep evening)** or **expand the time window (keep nonstop)**—I can show the cheapest option and explain why it’s cheapest.

## Turn 5

- User message: Clear all filters and use only Air Canada or Emirates, with a layover under 90 minutes.
- Expected intent: Reset and add named-airline plus layover-duration constraints in one call.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The mixed reset/add request operates on existing inventory and requires both outcomes.
- Expected state/context change: Keep the search key with Air Canada/Emirates and maximum layover duration only.
- What we are validating: Clause-local reset/add semantics, source-array name resolution, and duration units.
- Manager -> Flight subtask: On the existing DEL→NYC one-way search for 2026-10-20 (1 adult, economy), clear all currently active filters (historically used/reversed actions; not active or pending constraints: nonstop, morning, evening, price cap <$220, carry-on requirement). Then apply new filters: airline only Air Canada OR Emirates; layover/connection time under 90 minutes. Show matching options.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791202768486 -> search_demo-user_1791202768486
- Actual active filters: airline, layoverDuration
- Actual filter values: {"airline":["AC","AC+","EK"],"layoverDuration":[90]}
- Classification: unexpected_failure
- Checks: suggestions recycled the used-and-reset nonstop action on the unchanged trip
- Manager output: ✈️ Cleared all filters, then limited results to **Air Canada or Emirates only** with a **layover ≤ 90 minutes**. **1 option** matches:

## Tool coverage checklist

- [x] flight_search
- [x] getGeneratedContractsContext
- [x] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
