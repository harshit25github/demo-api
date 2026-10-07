# Compound filters, replacements, removals, prediction, and route change

Focus: Filter stacking and replacement, current-option reasoning, prediction-to-search sequencing, and distinguishing a departure-location change from an airport filter.

Model policy: Manager=gpt-5.2, Flight=gpt-5.2, supporting=gpt-5.2; reasoning=low.

## Turn 1

- User message: Find one-way flights from New York to Los Angeles on October 20, 2026 for one adult in economy.
- Expected intent: Start a new exact-date one-way flight search.
- Expected tool(s): flight_search -> update_flight_suggested_questions
- Why that tool should be used: The route, exact date, passengers, trip type, and cabin are complete, so a new search is required without price prediction.
- Expected state/context change: Create a new search key, store three current options, and start with no active filters.
- What we are validating: Manager delegates a complete flight request once and Flight does not over-trigger prediction for an exact date.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791173500694
- Actual active filters: none
- Classification: stable
- Checks: none
- Manager output: ✈️ One-way economy flights from New York (NYC-area) to Los Angeles (LA-area) on **Oct 20, 2026** for **1 adult**: Note: Prices shown are per person.

## Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints to the current result set in one mutation.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Stops, departure time, maximum price, and baggage are supported filters and do not change the search inputs.
- Expected state/context change: Keep the search key and activate stops, departureTime, price, and baggage filters.
- What we are validating: One compound apply_filter call, no unnecessary re-search, and complete filter stacking.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173500694 -> search_demo-user_1791173500694
- Actual active filters: stops, departureTime, price, baggage
- Classification: stable
- Checks: none
- Manager output: ✈️ Filtered to **nonstop + morning departures + under $220 + carry-on included** — here’s what matches:

## Turn 3

- User message: Make it evening instead, drop the price cap, and remove the carry-on requirement.
- Expected intent: Replace one active filter and remove two others while preserving nonstop.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: This is an in-place filter update: evening replaces morning, while price and baggage are removed.
- Expected state/context change: Keep the search key with only stops and evening departure active.
- What we are validating: Indirect replacement wording and multi-filter removal without losing unrelated state.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173500694 -> search_demo-user_1791173500694
- Actual active filters: stops, departureTime
- Classification: stable
- Checks: none
- Manager output: ✈️ Updated filters to **nonstop only + evening departures**, with the **price cap removed** and **carry-on requirement removed** — there are **no matching flights**. Want me to **allow 1 stop** (keeping evening), or keep **nonstop** but allow **afternoon/night** departures?

## Turn 4

- User message: Remove the nonstop filter, show only Air China, and keep total trip duration under four hours.
- Expected intent: Remove stops and add airline plus total-duration constraints.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: All requested changes operate on the existing cards; evening departure remains unchanged because it was not removed.
- Expected state/context change: Keep the search key with evening departure, Air China, and maximum total duration active.
- What we are validating: Targeted removal, named-airline resolution, duration filtering, and preservation of an unmentioned active filter.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173500694 -> search_demo-user_1791173500694
- Actual active filters: departureTime, airline, totalDuration
- Classification: stable
- Checks: none
- Manager output: ✈️ With **nonstop removed**, filtered to **Air China only** and **total trip duration < 4 hours** (keeping the **evening** departure filter), there are **no matching flights** for **NYC → Los Angeles on Oct 20, 2026**. Which constraint should I relax: **airline**, **duration**, or **evening-only**?

## Turn 5

- User message: Which current option is cheapest, and why?
- Expected intent: Reason over current generated options without changing visibility or search state.
- Expected tool(s): getGeneratedContractsContext -> update_flight_suggested_questions
- Why that tool should be used: A current-option ranking requires fresh contract evidence, not a new search or another filter.
- Expected state/context change: Keep the search key and all active filters unchanged.
- What we are validating: Fresh contract retrieval, context reuse, and no state mutation for option reasoning.
- Actual tool(s): apply_filter -> getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173500694 -> search_demo-user_1791173500694
- Actual active filters: none
- Classification: unexpected_failure
- Checks: expected tools getGeneratedContractsContext -> update_flight_suggested_questions, got apply_filter -> getGeneratedContractsContext -> update_flight_suggested_questions; expected active filters departureTime, airline, totalDuration, got none
- Manager output: 💰 The **cheapest current option is Option 3 (Emirates) at $149**. Why it’s cheapest (vs the other two): it’s the least convenient—**2 stops**, **much longer total travel time (7h55)**, and a **very early departure (05:45)**—while the pricier options are **nonstop or 1 stop** and **much shorter (~2h10–2h35)**.

## Turn 6

- User message: Check for better travel dates between October 21 and October 28, then show flights on the strongest date with Air China still applied.
- Expected intent: Evaluate a flexible date window, search the strongest or bounded fallback date, then reapply the explicitly retained airline.
- Expected tool(s): price_prediction_tool -> flight_search -> apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The flexible bracket requires prediction before the requested search; the new search clears old filters, so only the explicitly retained Air China filter is reapplied.
- Expected state/context change: Create a new search key on an in-window date and leave only the Air China filter active.
- What we are validating: Prediction-to-search-to-filter ordering, bounded failure fallback, and selective filter carry-forward.
- Actual tool(s): price_prediction_tool -> flight_search -> apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173500694 -> search_demo-user_1791173616866
- Actual active filters: airline
- Classification: stable
- Checks: none
- Manager output: 🗓️ I couldn’t verify which date is “strongest” (cheapest/best) within **Oct 21–Oct 28, 2026**. ✈️ As a fallback, I searched **Oct 21, 2026** and applied **Air China only**—there’s **1 matching option**: Note: Prices shown are per person.

## Turn 7

- User message: Start the trip in Newark instead of New York, using the same date, passengers, and cabin. Keep Air China and remove every other filter.
- Expected intent: Change the departure endpoint, run a new search, and reapply only the requested airline filter.
- Expected tool(s): flight_search -> apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Starting in Newark changes the search route; it is not merely a departure-airport filter on the old New York search.
- Expected state/context change: Create a new search key for Newark to Los Angeles and keep only Air China active.
- What we are validating: Filter-looking route changes, reuse of prior date/passengers/cabin, and removal of stale filters after re-search.
- Actual tool(s): flight_search -> apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791173616866 -> search_demo-user_1791173646337
- Actual active filters: airline
- Classification: stable
- Checks: none
- Manager output: ✈️ Updated to **EWR → Los Angeles** on **Oct 21, 2026** for **1 adult, economy**, with **only Air China** kept (all other filters removed): Note: Prices shown are per person.

## Tool coverage checklist

- [x] flight_search
- [x] getGeneratedContractsContext
- [x] apply_filter
- [x] price_prediction_tool
- [x] update_flight_suggested_questions
