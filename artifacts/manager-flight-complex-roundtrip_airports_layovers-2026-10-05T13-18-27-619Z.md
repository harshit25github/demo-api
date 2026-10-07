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
- Manager -> Flight subtask: Search for round-trip business-class flights for 2 adults from Los Angeles (LAX area; include all LA airports if supported) to New York City (NYC area; include all NYC airports if supported). Depart 2026-10-30, return 2026-11-06. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791206315918
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Manager output: ✈️ Here are the available round-trip **business-class** flights for **2 adults** from the **Los Angeles area** to the **New York City area**, departing **Oct 30, 2026** and returning **Nov 6, 2026**: Note: Prices shown are per person.

## Turn 2

- User message: Use Burbank departures, arrive at Newark, allow one stop, require checked baggage, and keep layovers under two hours.
- Expected intent: Apply departure airport, arrival airport, stops, baggage, and layover-duration filters together.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: These constrain existing results and should be one filter call even if the combination has no matches.
- Expected state/context change: Keep the search key and activate five filter categories.
- What we are validating: Full compound airport/filter payload and correct zero-result state retention.
- Manager -> Flight subtask: On the current search (round-trip business class, 2 adults, depart 2026-10-30 return 2026-11-06, Los Angeles area → NYC area), apply filters: departure airport BUR (Burbank) only; arrival airport EWR (Newark) only; allow up to 1 stop (no 2+ stops); require checked baggage included; layovers under 2 hours on both outbound and return. Then show the matching options (or report if none match) without changing the dates or cabin.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791206315918 -> search_demo-user_1791206315918
- Actual active filters: departureAirport, arrivalAirport, stops, baggage, layoverDuration
- Actual filter values: {"departureAirport":["BUR"],"arrivalAirport":["EWR"],"stops":["2"],"baggage":["0"],"layoverDuration":[120]}
- Classification: stable
- Checks: none
- Manager output: ✈️ I applied your filters ( **BUR departures**, **EWR arrivals**, **up to 1 stop**, **checked baggage included**, and **layovers under 2 hours** ), and there are **no matching business-class round-trip options** for **Oct 30–Nov 6, 2026**. 🔄 Tell me which single constraint you’d like to relax first (layover limit, checked-bag requirement, or the BUR/EWR-only airports), and I’ll re-filter.

## Turn 3

- User message: Remove Newark and checked baggage. Allow any Los Angeles-area departure airport, require a Dubai or Amsterdam layover, and arrive in the evening.
- Expected intent: Remove two filters, broaden one airport filter, and add layover-airport plus arrival-time constraints.
- Expected tool(s): apply_filter -> update_flight_suggested_questions
- Why that tool should be used: The search inputs are unchanged; all operations belong in one state-aware filter update.
- Expected state/context change: Preserve one stop and layover duration, replace departure-airport scope, remove arrival airport and baggage, and add layover airport plus evening arrival.
- What we are validating: Multiple removals/additions, named airport-group resolution, alternative layover airports, and active-filter preservation.
- Manager -> Flight subtask: On the current search (round-trip business class, 2 adults, depart 2026-10-30 return 2026-11-06, Los Angeles area → NYC area), update filters as follows: remove arrival-airport restriction to EWR (allow any NYC-area arrival airport); remove checked-baggage-included requirement; remove BUR-only departure restriction and allow any Los Angeles-area departure airport. Add new constraints: itinerary must have a layover in either Dubai (DXB) or Amsterdam (AMS) (at least one segment connection city matches DXB or AMS), and arrival into NYC must be in the evening (local arrival time). Keep the existing constraint of allowing up to 1 stop and layovers under 2 hours only if those are still active; if they are active from prior step, preserve them unless explicitly removed by the user. Then show matching options or report none.
- Actual tool(s): apply_filter -> update_flight_suggested_questions
- Actual search key change: search_demo-user_1791206315918 -> search_demo-user_1791206315918
- Actual active filters: stops, layoverDuration, layoverAirport, arrivalTime
- Actual filter values: {"stops":["2"],"layoverDuration":[120],"layoverAirport":["DXB","AMS"],"arrivalTime":["EVENING"]}
- Classification: unexpected_failure
- Checks: expected active filters departureAirport, stops, layoverDuration, layoverAirport, arrivalTime, got stops, layoverDuration, layoverAirport, arrivalTime; filter departureAirport: expected ["BUR","LAX","ONT","SNA"], got []
- Manager output: ✈️ Updated as requested: **any Los Angeles-area departure**, **no Newark requirement**, **no checked-bag requirement**, **layover in Dubai (DXB) or Amsterdam (AMS)**, and **evening arrival** (while keeping **≤1 stop** and **<2h layovers**).

## Tool coverage checklist

- [x] flight_search
- [ ] getGeneratedContractsContext
- [x] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
