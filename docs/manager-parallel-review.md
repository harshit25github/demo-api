# Manager parallel Flight and Trip checks

The Manager now sends `parallelToolCalls: true`, and the production Runner permits two simultaneous function tools. Its prompt batches independent Flight and Trip requests, combines each specialist's work into one call per batch, waits for prerequisites, and lets independent work finish when the other task needs input or fails. Flight and Trip specialist settings, feedback schemas and render contracts are unchanged.

Current Flight tools write flight state and their tool log; Trip v2 writes the summary and plan. Native SDK `Agent.asTool()` keeps each subtask's `toolInput` separate while retaining shared application state. No context wrapper or merge layer was added.

## Real GPT-5.2 results

All three queries used the production Runner and actual Manager, Flight and Trip models. No specialist models or tool backends were replaced. Every response reported `gpt-5.2-2025-12-11`; all Manager requests enabled parallel calls.

| Query | Observed behavior |
| --- | --- |
| Delhi → Dubai flight search plus a separate two-day Rome food/history plan | Both specialists in one Manager batch; 11.56 seconds of overlap; both succeeded. Destinations, dates, party sizes and budgets stayed separate. |
| Earliest-arriving Delhi → Dubai option, then a first-afternoon plan around arrival | Flight first, then Trip in a later batch; no overlap. The arrival-airport warning was preserved, but timing confidence has the issue below. |
| Flights to Rome with no origin, plus a dated two-day Rome plan | Both specialists in one batch; 7.96 seconds of overlap. Flight asked for the missing origin without searching; Trip completed and saved the plan. |

Evidence: `tests/results/manager-parallel-2026-10-16T12-00-27-708Z.json`, containing queries, model receipts, scoped inputs, feedback, final answers, context, batches and intervals. There were 19 paid model requests and 14 accepted HTTP 204 trace exports.

- [Independent work trace](https://platform.openai.com/logs/trace?trace_id=trace_6fdbce0c6642431886c25a2abd4cb34b&api=traces)
- [Arrival-dependent work trace](https://platform.openai.com/logs/trace?trace_id=trace_40a59e4791584817b1f31d7a30eaf31e&api=traces)
- [Missing-origin work trace](https://platform.openai.com/logs/trace?trace_id=trace_1d957719ba7048019c06f28e17bc2393&api=traces)

## Verification and limits

Typecheck, build and all 411 deterministic tests pass. New barrier-based tests prove real SDK specialist execution overlaps through the production Runner, scoped inputs remain separate, Flight and Trip state survive persistence, one specialist's failure does not erase the other's success, and dependent work stays ordered.

All three live scheduling checks passed. Manual review confirms exact Trip card/day copying and visible flight warnings, with two remaining presentation/accuracy issues:

- The first response places the price note before its warning and next step, rather than at the end of its Flight portion.
- The configured Flight inventory is dummy data, including airport codes inconsistent with the searched route. The dependent response still calls a listing's 11:10 time a confirmed Dubai arrival despite its LAX airport. This does not establish a valid Dubai-local arrival or live travel accuracy; neither the dummy backend nor specialist behavior was changed here.

These checks are three fresh-session queries, not a statistical evaluation or live airline-inventory validation. Concurrent calls to the same specialist are excluded by prompt instructions; the Runner's limit is a global cap of two, not a per-specialist lock.

```powershell
$env:RUN_MANAGER_PARALLEL_LIVE='1'
npx tsx tests/live/manager-parallel-live.ts
```

For an offline check without API calls: `npx tsx tests/live/manager-parallel-live.ts --check`.
