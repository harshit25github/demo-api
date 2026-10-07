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
- Manager -> Flight subtask: Search for one-way flights from New York (NYC area) to Los Angeles (LAX area) on October 20, 2026 for 1 adult in economy. Return available options with prices/times and any notable stop counts.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791360353493
- Actual active filters: none
- Actual filter values: {}
- Classification: stable
- Checks: none
- Acceptable deviations: none
- Manager output: ✈️ I found **3 one-way economy** flight options for **New York (NYC area) → Los Angeles (LAX area)** on **Oct 20, 2026** for **1 adult**: **1 nonstop**, **1 one-stop**, and **1 two-stop**, with prices ranging **$149–$199**. ℹ️ Some options show **airport/time details that don’t fully align** with the NYC→LAX metro pairing, so please **verify the exact airports on the booking page** before choosing. Note: Prices shown are per person.

## Tool coverage checklist

- [x] flight_search
- [ ] getGeneratedContractsContext
- [ ] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
