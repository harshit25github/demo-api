# Flight prompt strengthening — October 5, 2026

## Scope and evidence

The active `FLIGHT_PROMPT` was enhanced, not replaced with `FLIGHT_PROD_PROMPT_TEXT`. Existing recovery budgets, failure handling, Manager feedback, context priority, flexible-date intelligence, and final suggested-question ownership remain intact.

The registered Flight tools were inspected in `src/agents/flight/tools/index.ts`: `flight_search`, `getGeneratedContractsContext`, `apply_filter`, `price_prediction_tool`, and `update_flight_suggested_questions`. There is no callable date-resolution tool; examples use the request-local clock.

| Example focus | Evidence used |
| --- | --- |
| Separate city, code, and airport name | Production reference's mandatory location examples; current search schema/runtime inspection |
| Compound filter replacement/removal, retaining unrelated filters | Conversation 1 turns 2–4 in `manager-flight-complex-compound_filters_route_change-2026-10-05T04-30-43-761Z.json` |
| Read an empty filtered set without silently clearing filters | Failure in the first Conversation 1 run (`2026-10-05T04-14-18-262Z`), corrected behavior at turn 5 in the `04-30-43-761Z` report |
| Search rather than filter a changed departure endpoint | Conversation 1 turn 7 in `manager-flight-complex-compound_filters_route_change-2026-10-05T04-24-20-905Z.json`; context-carry-forward regressions |
| Read versus select; unavailable numbered options | `manager-flight-search_filter_options-2026-09-30T20-42-28-136Z.json`, turns 3–4; generated-contract regression tests |
| Flexible windows, duration-preserving return windows, no-data limits | Conversation 1 turn 6 in the `04-24-20-905Z` report; `manager-flight-prediction_and_recovery-2026-09-30T21-04-30-703Z.json`; prediction/date unit tests |
| Suggested questions last, grounded and bounded recovery | Conversation 1 tool order and suggested-question regression tests; missing-suggestions observations in earlier Manager reports |
| Reset plus additions; source-array names; maximum-only constraints | Existing `flight-gap-contracts`, filter-normalization, and search/filter-flow regressions |

These are deliberately compact policy demonstrations based on those patterns, not claims that every exact example utterance previously passed a live model run. Example dates and returned-option identities are not facts about a future request.

## Supporting contract changes

Each search segment now exposes nullable `origin_iata`, `destination_iata`, `origin_airport_name`, and `destination_airport_name`. Names and codes remain separate through durable segments, resolved endpoint state, hydration, and date-only updates. Endpoint changes clear stale airport details; airport-code changes clear an unconfirmed old airport name. Confirmed airport codes take precedence over generic metropolitan codes for prediction context.

Existing schema/recovery validation rejects malformed supplied IATA values and names containing their supplied code before mutating search state. There is no new orchestration wrapper or model-output rewriting handler. Legacy direct callers may omit the new nullable fields; new model instructions use the separated contract.

## Verification boundary

`tests/integration/manager-flight-fewshot-payloads.test.ts` runs seven turns through the production Manager runner and SDK-native Flight specialist with scripted models and real tools. SDK tool events verify exact inputs, sequence, results, final suggestions placement, and filter/endpoint state across persistence. It exercises all five tools, including prediction's no-data fallback. It does **not** establish live model intent quality or live airline inventory; search/filter services still return sample data.

`tests/unit/flight-prompt-fewshots.test.ts` checks tool-example coverage, a bounded example word count, clean payload validation, airport-code priority, raw hydration, and stale-metadata clearing. Existing context/recovery/filter/suggestions regressions remain part of the full suite.

Offline checks after the hydration, airport-name, feedback/history, airport-group, and clause-fidelity prompt fixes: `npm run typecheck` passed; `npm run build` passed; `npm test` passed 343/343, with no skips. The new state edge cases were first reproduced as failing tests, then passed after the targeted fixes.

## Accepted focused live verification

The existing key became available again. The latest focused run, `manager-flight-complex-normalization_fewshots-2026-10-05T12-23-58-584Z.json` (and its Markdown companion), completed all eight turns through the production Manager -> SDK-native Flight path. Manager, Flight, and supporting configuration were pinned/guarded to GPT-5.2 with low reasoning. Every registered Flight tool was observed at least once, with no missing coverage or unexpected checks. SDK nested tool events captured arguments/results; no occurrence or ordering was inferred from application logs.

| Turn | Verified behavior |
| --- | --- |
| 1 | Delhi/DEL and New York City/NYC separated in a single exact-date search; unknown airport names null |
| 2-3 | One compound filter call, then replacement/removal preserving nonstop and the search key |
| 4 | Fresh read of an empty filtered set without resetting filters or inventing an option |
| 5 | Reset plus airline alternatives and a 90-minute layover cap in one call; historical used actions carried by Manager and excluded from new suggestions |
| 6 | Historical note survives the inspection follow-up; read -> select identified option 1 without changing core search/filter state |
| 7 | Implicit flexible bracket -> prediction with exact bounds -> one October 21 fallback search -> Air Canada filter -> final suggestions; partial feedback with nextStep=null, no invented winning date or manual-comparison workaround |
| 8 | London/LHR/airport name separated, date/passengers/cabin retained, stale NYC details replaced, new search before explicitly retained airline filtering |

This review rejected prior machine-green reports where full feedback still offered date-by-date searches or lost used-action history. Those artifacts remain as debugging evidence. New York/New York City and London Heathrow/London Heathrow Airport were adjudicated as acceptable name aliases; the checker still rejects city/code concatenation. Only the latest run above is accepted for this focused gate.

The fixes remain prompt intelligence: compact post-reset suggestions and fallback examples, a final-turn history exclusion instruction, and self-contained Manager subtask guidance. No production orchestration wrapper, automatic CTA generator, or hardcoded handler was added. Existing recovery, Manager ownership, and presentation contracts remain intact.

This is orchestration/payload verification, not live inventory or forecast-quality validation: search/filter return repository sample data, and this run's prediction adapter returned NO_PREDICTIONS. Successful prediction/date selection remains covered by deterministic contracts, not proven by this no-data live run. The originally requested five-conversation live suite is not yet complete and is a separate remaining validation gate; do not claim all five passed.

## Sequential five-conversation verification

Conversation 1 is accepted in `manager-flight-complex-compound_filters_route_change-2026-10-05T12-39-11-337Z.json`: all seven turns completed, all five tools were exercised, and exact filter values/search-key transitions were verified. The empty-result read preserved constraints; flexible-date fallback did not re-offer the failed date lookup; the Newark endpoint change started a new search before explicitly retaining Air China. One rejected final suggestion draft was corrected once without repeating business tools, an acceptable existing recovery path.

Conversation 2's initial airport-group check stopped at turn 3 because broadening BUR-only left no explicit group in state. Closer inspection established a representation difference: the complete LA departure source and every original departure already belong to the requested group, so unrestricted departures and explicitly selecting every airport are equivalent here. The checker now accepts that case only with both complete-source and original-result membership evidence; subset, unknown-source, missing-airport, and outside-group cases remain failures. No production behavior was changed to satisfy a representational assertion.

A real issue appeared in the next Conversation 2 run (`13-15-29-360Z`): Manager paraphrased "allow one stop" as "allow up to 1 stop (exclude 2+ stops)". The removal word caused the stop constraint to disappear even though the supplied code was correct. Manager and Flight now preserve operation-clause fidelity, with a small positive one-stop payload example and airport-group replacement contrast. No runtime handler was added. Conversation 2 must complete re-test before Conversation 3 begins.
