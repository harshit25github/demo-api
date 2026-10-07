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
- Manager -> Flight subtask: Search for one-way flights from New York (NYC area airports) to Los Angeles (LAX area; include LAX/BUR/LGB/SNA/ONT if available) on October 20, 2026 for 1 adult in Economy. Return the available options and the lowest price if shown.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791359888573
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Acceptable deviations: none
- Manager output: ✈️ I found 3 one-way Economy flights for **1 adult** from **New York (NYC area)** to **Los Angeles (LA area)** on **Oct 20, 2026**. **Prices start at $149**. Note: Prices shown are per person. ℹ️ Do you want **LAX only**, or is it okay to include nearby airports like **BUR/ONT/SNA**?

## Turn 2

- User message: Show only nonstop morning departures under $220 with carry-on baggage.
- Expected intent: Apply four constraints to the current result set in one mutation.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: Stops, departure time, maximum price, and baggage are supported filters and do not change the search inputs.
- Expected state/context change: Keep the search key and activate stops, departureTime, price, and baggage filters.
- What we are validating: One compound apply_filter call, no unnecessary re-search, and complete filter stacking.
- Manager -> Flight subtask: On the current one-way search NYC→Los Angeles on 2026-10-20 (1 adult, Economy), filter results to: nonstop only; morning departures only; price under $220; and only options that include carry-on baggage (baggage-included filter as available on the results page). Preserve any other current settings. Report how many options remain and the lowest price among the matching options, or that none match.
- Actual tool(s): apply_filter -> getGeneratedContractsContext -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791359888573 -> search_demo-user_1791359888573
- Actual active filters: stops, departureTime, price, baggage
- Actual filter values: {"stops":["0"],"departureTime":["MORNING"],"price":[220],"baggage":["1"]}
- Classification: unexpected_failure
- Checks: expected tools apply_filter -> update_flight_suggested_questions, got apply_filter -> getGeneratedContractsContext -> update_flight_suggested_questions
- Acceptable deviations: none
- Manager output: ✅ I filtered to **nonstop + morning departures + under $220 + carry-on included**. There’s **1 flight** that matches, starting at **$199**.

## Tool coverage checklist

- [x] flight_search
- [x] getGeneratedContractsContext
- [x] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
