# Round-trip airport, layover, duration, and destination changes

Focus: Round-trip context retention, airport and layover filters, compound removals, filter-then-read sequencing, flexible-date search, and destination changes.

Model policy: Manager=gpt-5.2, Flight=gpt-5.2, supporting=gpt-5.2; reasoning=low.

## Turn 1

- User message: Find round-trip business-class flights from Los Angeles to New York, leaving October 30, 2026 and returning November 6, 2026, for two adults.
- Expected intent: Start a complete exact-date round-trip search.
- Expected tool(s): flight_search -> update_flight_suggested_questions
- Why that tool should be used: Both route endpoints, both dates, passenger count, trip type, and cabin are known.
- Expected state/context change: Create a round-trip search with no active filters.
- What we are validating: Round-trip payload assembly and Manager-to-Flight context handoff.
- Manager -> Flight subtask: Search for round-trip business-class flights for 2 adults from Los Angeles (any LAX-area airports if applicable; default LAX) to New York (NYC area airports) departing Oct 30, 2026 and returning Nov 6, 2026. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791206138501
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Manager output: ✈️ Here are the round-trip **business-class** flight options for **2 adults** from **Los Angeles (LAX metro)** to **New York (NYC metro)**, departing **Oct 30, 2026** and returning **Nov 6, 2026**: Note: Prices shown are per person.

## Turn 2

- User message: Use Burbank departures, arrive at Newark, allow one stop, require checked baggage, and keep layovers under two hours.
- Expected intent: Apply departure airport, arrival airport, stops, baggage, and layover-duration filters together.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: These constrain existing results and should be one filter call even if the combination has no matches.
- Expected state/context change: Keep the search key and activate five filter categories.
- What we are validating: Full compound airport/filter payload and correct zero-result state retention.
- Manager -> Flight subtask: On the current LAX-metro → NYC-metro round-trip search (business, 2 adults; depart 2026-10-30 return 2026-11-06), apply filters: departure airport BUR (Burbank) only; arrival airport EWR (Newark) only; allow up to 1 stop (exclude 2+ stops); require checked baggage included; and layovers < 2 hours on connections (both directions). Then show matching options.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791206138501 -> search_demo-user_1791206138501
- Actual active filters: departureAirport, arrivalAirport, baggage, layoverDuration
- Actual filter values: {"departureAirport":["BUR"],"arrivalAirport":["EWR"],"baggage":["0"],"layoverDuration":[120]}
- Classification: unexpected_failure
- Checks: expected active filters departureAirport, arrivalAirport, stops, baggage, layoverDuration, got departureAirport, arrivalAirport, baggage, layoverDuration; filter stops: expected ["2"], got []
- Manager output: ✈️ I applied your filters ( **BUR departures only + EWR arrivals only + checked baggage included + layovers < 2 hours** ), and **there are no matching round-trip business-class options** in the current results. ℹ️ Also: the **“allow one stop”** constraint didn’t successfully apply on my side, but even without it, the filters above already reduce results to zero. Which single filter should I relax first: **layovers < 2 hours**, **BUR-only**, **EWR-only**, or **checked-bag required**?

## Tool coverage checklist

- [x] flight_search
- [ ] getGeneratedContractsContext
- [x] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
