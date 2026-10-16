# Manager conversational prompt review

The active path is `ManagerAgent` → `buildManagerInstructions`; the SDK session supplies conversation history. Only the prompt's conversational guidance and examples changed in production.

## Findings and changes

- The old guidance anchored replies on “I found”, “I've updated” and “Here are”. The replacement asks for specific, integrated acknowledgements, varied wording and natural contractions, without an acknowledgement on every turn.
- History handling concentrated on delegation. The added guidance connects relevant, explicitly shared budgets, destinations, dates, travelers, pace and interests to verified outcomes, while respecting corrections and avoiding invented familiarity.
- Proactivity now means one useful specialist-supported next step, offered as a future choice. It cannot authorize extra work or imply unsupported capabilities.
- Reply length follows the request within the existing Flight and Trip contracts. Meaningful icon guidance remains; redundant recaps and repeated findings are discouraged.
- A destination example invented food/history interests and unsupported suitability claims. It now states the hypothetical evidence explicitly. Four additional examples cover clarification, correction, a budget concern and a gentler itinerary.

Routing, tool registration, specialist prompts, feedback schemas, output contracts, exact copied Trip content, price notes, dynamic context assembly and unsupported-topic rules are unchanged.

## Validation

- Typecheck and build pass; all 409 deterministic tests pass.
- A source comparison confirms the routing/tool/feedback/output sections, presentation/unsupported rules and dynamic prompt assembly are unchanged.
- Three controlled conversations exercise nine turns: pending Flight preferences and a date correction; Trip budget and pace through edits; zero results, a declined suggestion and an unsupported seat request. All nine turns passed the initial automated checks. Manual review then caught a misleading seat-related fallback offer, so the final prompt explicitly keeps capability boundaries in friendly offers and the seat assertion was strengthened.
- The controlled harness runs the real GPT-5.2 Manager, session, specialist adapters and final sanitization, with scripted specialist model outputs and Flight state effects. These checks isolate Manager behavior; they do not verify live flight inventory.
- A separate real Manager → Trip conversation exercises a three-day Kyoto plan and two edits with both models pinned to GPT-5.2. It uses local session history and placeholder photos, with no current-hours research.
- The final traced Trip run completed three turns, nine actual GPT-5.2 responses and 29 automated checks; seven trace exports returned HTTP 204. All seven rendered days and the single card match feedback exactly. Manual review still found a 26-word lead against the 25-word target, four source findings compressed into three sentences, and an optional follow-up supplied by Trip after a free-afternoon request. These are limits of this result, despite passing the automated checks.
- Repeated concern/boundary checks exposed a stale zero-result answer without a fresh Flight call and an invented extra relaxation offer. The final tone guidance now explicitly operates after required delegation and uses only this turn's supplied nextStep. Earlier failing reports remain in `tests/results/`; the harness also accepts city codes and natural negative phrasing rather than demanding one wording.
- The final focused concern/boundary rerun passed all three turns and its checks: fresh Flight inspection after zero matches, no repeated declined suggestion, and a seat-help decline with a supported contextual offer. It made five actual GPT-5.2 requests. Evidence: `tests/results/manager-conversation-2026-10-16T11-51-15-173Z.json`.
- A real Manager → Flight turn produced five successful Flight GPT-5.2 model responses, a successful search/filter/suggestions flow and final structured feedback. Trace `trace_8d340eea2f8a42ab87103969110d0d8c` uploaded successfully (four HTTP 204 trace exports). The smoke stopped after a recovered suggestions-validation error, so it does not establish a full real-Flight multi-turn pass. The dummy results also contained mismatched airports that Flight did not flag; that remains a specialist/data limitation, with no specialist behavior changed here.
- A direct Responses retrieval independently confirmed a completed GPT-5.2 response from `api.openai.com` in project `proj_Vc2wUEJfSDbktx5ucKmheZm7`.

Paid checks reject requests for any model other than `gpt-5.2`; successful response receipts identify `gpt-5.2-2025-12-11`. JSON reports in ignored `tests/results/` retain transcripts, delegation inputs, feedback, checks, model receipts and usage.

```powershell
$env:RUN_MANAGER_CONVERSATION_LIVE='1'
npx tsx tests/live/manager-conversation-live.ts --trace
```

Use `--case=zero_matches_concern_and_boundary` to repeat only that conversation. For offline fixture validation, run with `--check-fixtures` instead.

The first checks disabled hosted tracing, so they created no Agents SDK dashboard rows. The final runs enable tracing and flush exports; their local reports record trace IDs. Dashboard visibility depends on viewing the project associated with the configured key.

The real Trip trace for the initial plan is `trace_092f8fdd94414ad3b0bde3d976a36ac5`; its follow-up edits are `trace_a9f9a21c602943c688d3d2d28c43d8b3` and `trace_225756545cdc49d1acc8cc1d30f7b8e7`. The user confirmed finding the platform logs.

The registered Flight search tool in this checkout unconditionally builds dummy flights (`src/agents/flight/tools/search-tool.ts`). Actual Flight model/tool smoke checks therefore exercise the configured local runtime, not real airline inventory or current fare accuracy.

This is bounded smoke coverage, including manual prose review. It does not establish statistical quality, current attraction hours, HTTP/SSE behavior or remote-session persistence.
