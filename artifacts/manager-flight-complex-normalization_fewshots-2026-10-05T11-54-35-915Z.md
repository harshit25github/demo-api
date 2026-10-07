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
- Manager -> Flight subtask: Search one-way flights from Delhi (DEL) to New York City (NYC) on Oct 20, 2026 for 1 adult, economy cabin. Show available options.
- Actual tool(s): flight_search -> update_flight_suggested_questions
- Actual search key change: none -> search_demo-user_1791201284397
- Actual active filters: none
- Actual filter values: {}
- Classification: unexpected_failure
- Checks: payload onds.0.destination: expected "New York", got "New York City"
- Manager output: ✈️ Here are one-way economy flights for **1 adult** from **Delhi (DEL) → New York City (NYC)** on **Oct 20, 2026**: Note: Prices shown are per person.

## Tool coverage checklist

- [x] flight_search
- [ ] getGeneratedContractsContext
- [ ] apply_filter
- [ ] price_prediction_tool
- [x] update_flight_suggested_questions
