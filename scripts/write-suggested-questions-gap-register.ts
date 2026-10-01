/**
 * Generate docs/flight-suggested-questions-gap-analysis.xlsx — the tracking
 * register for the `update_flight_suggested_questions` production-vs-local gap.
 *
 * The gap rows are authored here because they are judgements, not data. The
 * Evidence sheet is the opposite: it is re-tallied from artifacts/ on every run,
 * so re-running this command after each fix step re-measures the call rate
 * instead of restating the numbers from when the analysis was written.
 *
 * Track progress here, not in the workbook: when a fix lands, change that gap's
 * `status` below and regenerate. The workbook is rewritten on every run, so
 * edits made in Excel are lost.
 *
 *   npm run gaps:suggested-questions
 *
 * Commit the generator and the workbook together: the generator is the diffable
 * source of truth, the workbook is what the team opens.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeWorkbook, type WorkbookSheet } from './lib/xlsx-workbook.js';

const SUGGESTED_TOOL = 'update_flight_suggested_questions';
/** Tools that replace the visible results the suggestions were written for. */
const RESULT_CHANGING_TOOLS = ['flight_search', 'apply_filter'];
/** The ten scripted Flight conversations, the set fix verification re-runs. */
const SCRIPTED_GROUP = 'flight-conversation-*';

/** See the Read Me sheet for what each value means. */
type Origin = 'Production regression' | 'Local-only' | 'Shared weakness';

interface GapRow {
  id: string;
  layer: string;
  title: string;
  origin: Origin;
  production: string;
  current: string;
  missing: string;
  impact: string;
  severity: 'High' | 'Medium' | 'Low';
  fix: string;
  step: string;
  /** The tracking field: update it when a fix lands. */
  status: string;
  /** What has to be true before the gap can be marked closed. */
  verify: string;
}

const GAPS: GapRow[] = [
  {
    id: 'G1',
    layer: 'A - Prompt authority',
    title: 'Per-turn mandate removed',
    origin: 'Production regression',
    production:
      'Mandatory on every turn. FLIGHT_PROD_PROMPT_TEXT states it in the stop rule (prompt.ts:171 "Perform only the mandatory final suggested-questions update, then respond"), the tools intro (:173), the tool section (:427 "Use at the end of every Flight Agent turn", :431 "call this tool as the final tool call"), the routing tail (:655 "Before final response, always update Flight suggested questions"), the chain table (:660-676), the checklist (:908) and the dynamic block (:987). The Production Map sheet lists each one beside its local equivalent.',
    current:
      'FLIGHT_PROMPT calls it "optional, best-effort enrichment" (prompt.ts:137) and says "Optional suggestion enrichment may run once" (:71). The dynamic instructions repeat "Suggested questions are optional" (agent.ts:229). Committed HEAD carries the same wording.',
    missing:
      'Any unconditional statement that the turn is not finished until the tool has run.',
    impact:
      'At analysis (2026-10-01): Flight called it on 84 of 114 turns that ran flight_search or apply_filter, and on 2 of 72 turns that ran neither; 86 of 186 Flight turns overall. Current numbers are on the Evidence sheet.',
    severity: 'High',
    fix: 'Replace the optional framing in all three live locations (prompt.ts:71, prompt.ts:137, agent.ts:229) with a required-final-step rule. Keep "never retry it or let its failure discard a result".',
    step: 'Step 3',
    status: 'Open',
    verify:
      'Evidence: the "Ran neither" row reaches 100% on a fresh run of the scripted conversations.',
  },
  {
    id: 'G2',
    layer: 'A - Prompt authority',
    title: 'Approved tool-chain table absent',
    origin: 'Production regression',
    production:
      'prompt.ts:660-676 lists 15 approved chains, each ending in this tool, including "update_flight_suggested_questions alone for missing-info, clarification, source-option, or no-action responses" (:662).',
    current:
      'FLIGHT_PROMPT has no chain table; the tool section only says to run it "after the core request is complete" (prompt.ts:137).',
    missing:
      'Per-request-class sequencing that names the tool as the terminal step, including turns that need no core tool.',
    impact:
      'At analysis: contract reads 1 of 46, price prediction 0 of 11, Flight turns with no core tool 0 of 13 - the request classes the missing chains covered.',
    severity: 'High',
    fix: 'Port a compact chain list adapted to the five registered tools. Do not copy the six chains that name resolve_flight_date: the tool is not registered (tools/index.ts:59-65) and flight-agent-price-prediction.test.ts:596 asserts FLIGHT_PROMPT never mentions it. Local ranking reads without selecting (prompt.ts:112), so production’s read-then-select chain becomes read only. The standalone chain matters most. The Chain Map sheet gives the adapted list.',
    step: 'Step 3',
    status: 'Open',
    verify:
      'Evidence: the getGeneratedContractsContext, price_prediction_tool and (no tool) rows reach 100%.',
  },
  {
    id: 'G3',
    layer: 'A - Prompt authority',
    title: 'Pre-response checklist gone',
    origin: 'Production regression',
    production:
      'prompt.ts:908 "Did I call update_flight_suggested_questions as the final tool call and avoid mentioning its result to the user?"',
    current: 'No checklist of any kind in FLIGHT_PROMPT.',
    missing: 'A self-verification pass before the final output is emitted.',
    impact: 'No second chance for the model to notice the omission.',
    severity: 'Medium',
    fix: 'One checklist line in the "Final response and stopping" section.',
    step: 'Step 3',
    status: 'Open',
    verify: 'A prompt unit test asserts the checklist line.',
  },
  {
    id: 'G4',
    layer: 'A - Prompt authority',
    title: 'A clause tells the model to drop it under budget pressure',
    origin: 'Local-only',
    production: 'The turn budget was never traded against this tool.',
    current:
      'prompt.ts:143 "Search/filter/contract success outranks suggestion enrichment. Prioritize completing structured feedback within the turn budget over optional work."',
    missing:
      'Nothing - this is an added counter-incentive rather than an omission.',
    impact:
      'With maxTurns 10 (config.ts:88) this is the first work dropped under pressure.',
    severity: 'High',
    fix: 'Keep "never let it discard a successful result"; delete the optional-work and turn-budget trade-off.',
    step: 'Step 3',
    status: 'Open',
    verify:
      'A prompt unit test asserts the trade-off is gone; the max-turns recovery test (flight-agent-recovery-loop.test.ts:425) still preserves core results.',
  },
  {
    id: 'G5',
    layer: 'A - Prompt authority',
    title: 'Manager mode de-escalates it and sets no order',
    origin: 'Production regression',
    production:
      'The agent ended its turn in free text, so "call this tool as the final tool call before your final text response" (prompt.ts:431) was a coherent instruction.',
    current:
      'FlightManagerAgent sets outputType: flightManagerOutputSchema (agent.ts:250), so the turn ends by emitting structured output, and manager-output.ts:38 says "Optional suggested-question work never changes a successful core outcome." All chat API traffic takes this path (manager-orchestrator/runner.ts), and so did every recorded artifact, including the scripted conversations.',
    missing:
      'An ordering rule: tool call first, structured output second.',
    impact:
      'At analysis: 86 of 186 Flight turns, all on the Manager path (45% for manager-flight-*, 38% for manager-realistic-*). There is no standalone-runner evidence to compare against.',
    severity: 'High',
    fix: 'State the ordering in FLIGHT_MANAGER_INSTRUCTIONS and drop the de-escalation sentence. Do NOT add a schema field - the consumer reads shared context, not Manager feedback.',
    step: 'Step 3',
    status: 'Open',
    verify: 'Evidence: every Manager-path Flight turn calls the tool.',
  },
  {
    id: 'G6',
    layer: 'B - Tool definition',
    title: 'Tool description contradicts any mandate',
    origin: 'Production regression',
    production:
      'The tool section’s "Required behavior": call it as the final tool call before the final text response, at most once, then no more tools (prompt.ts:429-433).',
    current:
      'UpdateFlightSuggestedQuestionsTool description (suggested-questions-tool.ts:94): "Best-effort enrichment after the user’s core Flight request is complete..."',
    missing:
      'Required, terminal framing in the text the model receives alongside the tool schema.',
    impact:
      'The description ships in the same payload as the prompt and will undercut G1.',
    severity: 'High',
    fix: 'Mirror the Trip Planner sibling: "Call only after context capture and all planning tools, as the final tool call." (trip-planner/tools/context-tools.ts:205-206)',
    step: 'Step 2',
    status: 'Open',
    verify: 'A unit test asserts the description calls it the final tool call.',
  },
  {
    id: 'G7',
    layer: 'B - Tool definition',
    title: 'Schema admits payloads that can only fail',
    origin: 'Shared weakness',
    production: '"Exactly 3" was prose only, same as here.',
    current:
      'updateFlightSuggestedQuestionsSchema (suggested-questions-tool.ts:26-33) is .array(z.string().min(1)).max(3) with no .min(3). A 1-2 item array, or an empty array while a search key exists, is schema-valid, reaches execute and is rejected with INVALID_SUGGESTED_QUESTIONS and retrySafe: false (:59-81). isEnabled (:101-106) then hides the tool for the rest of the request.',
    missing: 'A schema that can express the valid states and nothing else.',
    impact:
      'A dead end: one malformed draft and the turn stores nothing, with no retry path. Not seen in any recorded turn; exercised by flight-agent-recovery-loop.test.ts:315-330.',
    severity: 'Medium',
    fix: 'DECISION NEEDED. A plain .min(3) is wrong while the empty array is how "no active search, clear stale suggestions" is expressed (:46-57). Option (a): keep 0..3 plus a clearOnly discriminator. Option (b), PREFERRED: .min(3).max(3) like Trip Planner (context-tools.ts:116-123), with clearing moved into the Step 1 finalize. Also consider a per-string .max(80).',
    step: 'Step 2',
    status: 'Open',
    verify:
      'Unit tests: the schema rejects 1-2 items before execute, and the no-search path still clears.',
  },
  {
    id: 'G8',
    layer: 'B - Tool definition',
    title: 'No phase gate and no retry; "at most once" is the only constraint',
    origin: 'Shared weakness',
    production:
      'Phase rules lived in the prompt: never before core work, and "After it returns successfully, call no more tools" (prompt.ts:433).',
    current:
      'isEnabled (suggested-questions-tool.ts:101-106) hides the tool once it has run for the current requestId, whether the call succeeded or failed. Nothing stops later tool calls, and a rejected draft cannot be retried.',
    missing:
      'A per-turn gate that allows one retry after a rejected draft and reopens the tool when results change after it ran.',
    impact:
      'One bad draft ends the turn with no suggestions. A search or filter after the call leaves new results with suggestions written for the old ones (HEAD) or none (working tree).',
    severity: 'Medium',
    fix: 'Gate on per-run turn state: at most two attempts, closed once written, reopened when flight_search or apply_filter runs after the write. Unlike Trip Planner (context-tools.ts:209-216), Flight has no mandatory first step, so "core work complete" cannot be computed - do not gate on it, and do not disable core tools after the write.',
    step: 'Step 2',
    status: 'Open',
    verify:
      'Unit tests: a rejected draft can be retried once, and a search after the write reopens the tool.',
  },
  {
    id: 'G9',
    layer: 'C - State / context',
    title: 'A skipped call keeps the previous turn’s suggestions',
    origin: 'Shared weakness',
    production:
      'Every turn ended in a deliberate write: the tool was mandatory and re-read searchKey at execution time (prompt.ts:437-441).',
    current:
      'Committed HEAD never clears suggestions outside the tool, so a skipped call ships the previous turn’s strings even after a new search. The working tree adds a turn-start clear only when there is no search key (flight-context.ts:345-347, uncommitted), so with an active search a skipped read-only turn still ships the previous strings. An uncommitted, untested draft adds finalizeFlightSuggestedQuestions (suggested-questions-tool.ts:150-166), called from runner.ts:170 and :197 and from manager/specialists/flight.ts:24-32. On the Manager path it does not run when the nested Flight run throws, because customOutputExtractor is skipped.',
    missing:
      'A turn-end finalize on every path plus a per-turn written flag. Trip Planner has both: finalizeTripPlannerTurn clears when !turnState.suggestionsUpdated (trip-planner/context/lifecycle.ts:423-425), and trip-planner/runner.ts:434 clears on error.',
    impact:
      'Silent staleness, invisible to tests: the deep-chats live check only asserts suggestions.length === 3 (flight-agent-intelligence-deep-chats-live.ts:798), which stale data passes.',
    severity: 'High',
    fix: 'Keep the finalize, cover the Manager error path, and add tests. First decide whether a skipped read-only turn should clear or keep its suggestions: clearing turns stale-but-same-search suggestions into none, so land Step 1 with or just before Steps 2-3.',
    step: 'Step 1',
    status: 'Open - uncommitted draft in working tree, untested',
    verify:
      'Unit tests: with an active search and no tool call, no previous strings survive the turn; the finalize also runs when Flight throws on the Manager path.',
  },
  {
    id: 'G10',
    layer: 'C - State / context',
    title: 'Search and filter invalidate suggestions, but nothing guarantees a refill',
    origin: 'Local-only',
    production:
      'The mandated end-of-turn write replaced the suggestions whenever results changed.',
    current:
      'The working tree adds clearing to flight_search (search-tool.ts:482) and apply_filter (filter/tool.ts:183), both uncommitted; committed HEAD does not clear there. Either way nothing guarantees a refresh: the Evidence sheet counts the search/filter turns that ended without one.',
    missing: 'The guaranteed refill, not the clearing.',
    impact:
      'At analysis: 30 of 114 result-changing Flight turns ended without a refresh. With the working-tree code they ship no suggestions; with HEAD they ship suggestions written for the previous results - the most user-visible symptom.',
    severity: 'High',
    fix: 'Keep the clearing (it is correct invalidation) and close the hole through G1, G6, G8 and G9.',
    step: 'Step 1',
    status: 'Open - the clearing is uncommitted working-tree code',
    verify: 'Evidence: "Search/filter turns with no refresh" reaches 0.',
  },
  {
    id: 'G11',
    layer: 'D - Execution flow',
    title: 'Zero enforcement anywhere in the run',
    origin: 'Shared weakness',
    production: 'Prompt-level only there too, but the prompt said mandatory.',
    current:
      'toolChoice: auto (config.ts:19-22); no output guardrail on the Flight agent (agent.ts:234-251); the max-turns recovery path deliberately leaves the tool out of CORE_TOOLS (recovery-outcome.ts:6-10). The only post-run hook is the uncommitted finalize draft (G9).',
    missing: 'Any mechanism that notices the omission.',
    impact: 'The prompt is the sole control, and it currently says optional.',
    severity: 'Medium',
    fix: 'Make the G9 finalize the enforcement point. Keep toolChoice: auto - forcing a specific tool would break the core tool loop.',
    step: 'Step 1',
    status: 'Open - uncommitted draft in working tree, untested',
    verify: 'Covered by the G9 tests.',
  },
  {
    id: 'G12',
    layer: 'D - Verification',
    title: 'The test suite pins the gap open',
    origin: 'Local-only',
    production: 'n/a - this is local test debt.',
    current:
      'flight-agent-price-prediction.test.ts:609-612 asserts FLIGHT_PROMPT contains "optional, best-effort", and :596 asserts it never names resolve_flight_date. NON_CORE_TOOLS strips the tool before scoring because it "must never decide a pass or fail" (flight-agent-conversation-cases.ts:26-27, 53). The untracked flight-gap-contracts.test.ts:59 is named for its absence. In the report harness none of the 17 expectedTools arrays include it, and validateTurn compares tool sequences by exact string equality (flight-agent-session-complex-report-live.ts:435-442). The one live script that requires the call (flight-agent-suggested-questions-variation-live.ts:146-148) has no npm script and is never run.',
    missing: 'Expectations that encode the mandate rather than its absence.',
    impact:
      'Restoring the mandate turns the unit suite and the report harness red before it turns anything green.',
    severity: 'High',
    fix: 'Flip the expectations in the same change as Step 3, not after it.',
    step: 'Step 4',
    status: 'Open',
    verify:
      'npm test passes with the mandate in place, and the report harness expects the tool on every turn.',
  },
  {
    id: 'G13',
    layer: 'D - Execution flow',
    title: 'No observability',
    origin: 'Shared weakness',
    production: 'n/a',
    current:
      '.debug/flight-prompt-traces is metadata-only (61 files, no tool-call records). The uncommitted draft logs suggestedQuestionCount and staleSuggestionsCleared in flight_agent.response (runner.ts:172-183), but only in the standalone runner. The Manager path, which carries every chat API turn and every recorded artifact, logs nothing about suggestions.',
    missing:
      'A per-turn record of whether the tool ran, on the path production traffic takes.',
    impact:
      'The call rate is unmeasurable in a running system; this gap was only visible by grepping recorded artifacts.',
    severity: 'Medium',
    fix: 'Log whether suggestions were written or cleared, and how many, from the Manager-path finalize as well as the standalone runner.',
    step: 'Step 1',
    status: 'Open - uncommitted draft logs only on the standalone path',
    verify: 'A Manager-path Flight turn emits the log line.',
  },
  {
    id: 'G14',
    layer: 'E - Docs',
    title: 'Docs still describe the mandate as live',
    origin: 'Local-only',
    production: 'n/a',
    current:
      'flight-agent-recent-changes.md:251, flight-agent-context-flow.md:429, flight-agent-date-handling-multiturn.md:390 and prompts/prompt-with-error.md:232 all say it runs last on every turn. No doc calls it optional.',
    missing: 'Agreement between the docs and the live prompt.',
    impact: 'Anyone reading the docs concludes the rule is already enforced.',
    severity: 'Low',
    fix: 'The docs become correct once Step 3 lands; add the chain list and note that FLIGHT_PROD_PROMPT_TEXT is reference text that never reaches the model.',
    step: 'Step 5',
    status: 'Open',
    verify: 'Doc review against the shipped prompt.',
  },
  {
    id: 'G15',
    layer: 'A - Prompt authority',
    title: 'Suggestion-quality rules dropped',
    origin: 'Production regression',
    production:
      'Suggestions are user-side actions "shown under You might ask" (prompt.ts:454), with no assistant-style wording such as "Would you like", "Do you want" or "Should I" (:456). They never ask to add or change departure location, arrival location, travel or return dates, with block examples (:458-460). The reply never mentions the tool, its output or the suggestions (:445, :725). Intents rotate across cabin, passengers, trip type, filters and result reasoning (:472).',
    current:
      'FLIGHT_PROMPT keeps a condensed subset (prompt.ts:139): three distinct, context-aware suggestions; no completed or failed action; no active filter; no mandatory route or date fields; never the same three; vary intent. agent.ts:209-210 covers active filters. The voice rule, the never-mention rule and the block examples are gone.',
    missing:
      'The user-voice rule, the assistant-style ban, the never-mention rule and the block examples.',
    impact:
      'Once the call rate rises, assistant-voice suggestions can reach the UI, and a standalone reply can mention them. The deep-chats live check still asserts the voice and mandatory-field rules the prompt no longer states (flight-agent-intelligence-deep-chats-live.ts:803-804).',
    severity: 'Medium',
    fix: 'Restore a compact content block of four or five lines in the tool section, worded for both standalone and Manager mode.',
    step: 'Step 3',
    status: 'Open',
    verify:
      'A prompt unit test asserts the rules, and the deep-chats live check passes.',
  },
  {
    id: 'G16',
    layer: 'B - Tool definition',
    title: 'Content rules are enforced only by the prompt',
    origin: 'Shared weakness',
    production:
      'Prompt-only there too: "a tool call with the exact same suggestedQuestions array as Previous suggested questions is invalid" (prompt.ts:990) was never checked in code.',
    current:
      'updateFlightSuggestedQuestions stores any three non-empty strings (suggested-questions-tool.ts:68-88), including an exact repeat of the previous set or assistant-voice text.',
    missing:
      'Code-level validation. Trip Planner has it: validateTripPlannerSuggestedQuestions checks against the previous set, and a failure returns INVALID_SUGGESTIONS with "retry once" (trip-planner/context/lifecycle.ts:368-385).',
    impact: 'The anti-repeat and voice rules depend on sampling.',
    severity: 'Low',
    fix: 'Optional: a small validator for exact repeats of the previous set, assistant-style openers, mandatory-field wording and length, returning a retryable failure under the G8 gate.',
    step: 'Step 2',
    status: 'Open',
    verify: 'Unit tests for each rejected case and for the retry.',
  },
  {
    id: 'G17',
    layer: 'C - State / context',
    title: 'The once-per-request gate spans the whole Manager turn',
    origin: 'Local-only',
    production:
      'One agent turn was one request, so "at most once per turn" and "at most once per request" meant the same thing.',
    current:
      'The Manager sets one requestId for the whole Manager turn and prepares Flight context once (manager-orchestrator/runner.ts:107, :115). isEnabled (suggested-questions-tool.ts:101-106) and the draft finalize key on that id, so a second flight_agent call in the same Manager turn finds the tool hidden, even after a new search cleared the suggestions.',
    missing:
      'Turn state for each Flight run. Trip Planner resets its turnState at the start of every turn (trip-planner/context/lifecycle.ts:151-175).',
    impact:
      'Latent: no recorded turn lists more than one Flight subtask or Flight result. When it happens, the second Flight run cannot refresh suggestions.',
    severity: 'Low',
    fix: 'Reset a Flight turn state at the start of every Flight run, on both the Manager and standalone paths, and gate on it instead of the requestId.',
    step: 'Step 2',
    status: 'Open',
    verify:
      'Integration test: two Flight calls in one Manager turn both refresh suggestions.',
  },
  {
    id: 'G18',
    layer: 'C - State / context',
    title: '"Active search" is not tied to the signal the tool uses',
    origin: 'Production regression',
    production:
      'The dynamic prompt stated "Active search exists: yes" (prompt.ts:920) and bound the rule to it: three suggestions when yes, an empty array when no (:987, :994). A clarification turn with a search key still got three (:449).',
    current:
      'The dynamic prompt shows only "Hydrated search key present (not validated)" (agent.ts:189), and FLIGHT_PROMPT says apply_filter needs "a valid active search, not merely a hydrated search key" (prompt.ts:67). The rule itself says "When called with an active search" (:139). The tool decides on any non-empty searchKey string (suggested-questions-tool.ts:46-57).',
    missing:
      'One unambiguous binding to the tool’s own signal, including a search created earlier in the same turn.',
    impact:
      'The model can judge that no active search exists and send an empty array while a key is present; the tool rejects it and hides itself (G7). Latent: not seen in recorded turns.',
    severity: 'Low',
    fix: 'One sentence: if a search key exists after this turn’s tools, pass exactly three suggestions; otherwise pass an empty array. Say that clarification turns with a search key also get three.',
    step: 'Step 3',
    status: 'Open',
    verify:
      'Scripted test: a hydrated key plus a clarification turn stores three suggestions.',
  },
];

const OPEN_DECISIONS: string[][] = [
  ['Topic', 'Detail', 'Owner / status'],
  [
    'Who renders the suggestions?',
    'context.flight.suggestedQuestions is persisted with the chat’s runtime context (api/chat/orchestrator.ts:191) and emitted in the SSE done.flightContext payload (:228). public/chat-dashboard reads flightContext for showFlight and searchResults but has zero references to suggestions. The only in-repo reader is the Flight agent’s own next-turn prompt (agent.ts:109-116, 212-214), as anti-repeat input. Restoring the mandate buys production parity and correct state plus about one extra model call per Flight turn, but no user-visible change until a renderer exists.',
    'Open - confirm the real consumer (presumably the CheapOair mobile client).',
  ],
  [
    'G7 schema shape',
    'A plain .min(3) breaks the empty-array clear path. Option (b) - exactly 3 at the schema level, clearing moved to the Step 1 finalize - is preferred.',
    'Open - decide before Step 2.',
  ],
  [
    'Dead reference prompt',
    'FLIGHT_PROD_PROMPT_TEXT (prompt.ts:148-995) carries all the mandatory language. It is commented "Historical comparison reference only; never included in runtime instructions" (:147), exists only in the uncommitted working tree, and no runtime or test code imports it: agent.ts:11 imports only FLIGHT_PROMPT. Lines 914-995 are a captured production dynamic block. scripts/audit-session-prompts.ts:58 states the invariant: "FLIGHT_PROMPT is the single authoritative runtime prompt."',
    'Resolved - do not edit that string; every rule must land in the live prompt.',
  ],
  [
    'Skip policy on read-only turns',
    'When Flight skips the tool on a turn that ran no search or filter, the previous suggestions still describe the same results. Clearing them, as the draft finalize and Trip Planner do, removes any risk of suggesting what the user just did, but leaves no suggestions on most read-only turns until Steps 2-3 raise the call rate. Keeping them leaves suggestions that can repeat the action just taken.',
    'Open - decide before Step 1. Recommended: clear, shipped together with Steps 2-3.',
  ],
  [
    'Turns where Flight never runs',
    'When the Manager answers without calling flight_agent, nothing touches context.flight.suggestedQuestions, and the previous Flight suggestions go out again in done.flightContext (api/chat/orchestrator.ts:228). They still describe the active search, but not the latest exchange. The Evidence sheet counts these turns separately.',
    'Open - product decision.',
  ],
  [
    'Uncommitted Step 1 draft',
    'suggested-questions-tool.ts (writtenRequestIds, finalizeFlightSuggestedQuestions), runner.ts and manager/specialists/flight.ts were edited at 15:31-15:32 on 2026-10-01, after this register was first committed. The draft is uncommitted and untested. Known holes: no finalize when the nested Flight run throws on the Manager path, and logging only in the standalone runner.',
    'Open - keep it as the Step 1 starting point or discard it. It is not approved work.',
  ],
  [
    'G16 scope',
    'Production never validated suggestion content in code, so a validator goes beyond parity. It matches Trip Planner, which validates and allows one retry.',
    'Open - decide before Step 2.',
  ],
];

const FIX_SEQUENCE: string[][] = [
  ['Step', 'Scope', 'Gaps', 'Why this order'],
  [
    'Step 0',
    'This Excel register + extract the shared XLSX writer into scripts/lib/xlsx-workbook.ts',
    '-',
    'Track the gaps before changing behaviour.',
  ],
  [
    'Step 0b',
    'Baseline: re-run the ten scripted conversations on the current prompt, then re-run this generator',
    '-',
    'No recorded artifact reflects the working-tree prompt, so later steps need a fresh baseline to compare against. Live runs cost API calls.',
  ],
  [
    'Step 1',
    'Deterministic state correctness: per-turn written flag, turn-end finalize on the success and error paths of both the standalone and Manager runs, per-turn logging on the Manager path',
    'G9, G10, G11, G13',
    'Correct on its own merits: after this, a skipped call can no longer ship stale data. Decide the read-only skip policy first. Shipped alone it leaves no suggestions on most read-only turns, so land it with or just before Steps 2-3.',
  ],
  [
    'Step 2',
    'Tool contract: required-terminal description, schema decision, per-run gate with one retry, per-Flight-run turn state, optional content validator',
    'G6, G7, G8, G16, G17',
    'The tool description must stop contradicting the mandate before the prompt asserts it.',
  ],
  [
    'Step 3',
    'Prompt authority: mandate wording, stop rule, adapted chain list, checklist line, Manager-mode ordering, content rules, active-search binding',
    'G1, G2, G3, G4, G5, G15, G18',
    'Raises the call rate once the state layer is already safe.',
  ],
  [
    'Step 4',
    'Tests: flip flight-agent-price-prediction.test.ts:609-612, invert NON_CORE_TOOLS, rewrite the flight-gap-contracts case, add the tool to the 17 expectedTools arrays, add an npm script for the variation live check',
    'G12',
    'Must land with Step 3: the unit suite asserts the optional wording, and the report harness compares tool sequences by exact equality.',
  ],
  ['Step 5', 'Reconcile the four docs', 'G14', 'Last, once behaviour is settled.'],
];

const READ_ME: string[][] = [
  ['Topic', 'Detail'],
  [
    'What this is',
    'Tracking register for the update_flight_suggested_questions gap between production (FLIGHT_PROD_PROMPT_TEXT, src/agents/flight/prompt.ts:148-995, reference text that never reaches the model) and the local Flight Agent (FLIGHT_PROMPT, the dynamic instructions in agent.ts, the tool, and both runners).',
  ],
  [
    'Sheets',
    'Gap Register: one row per gap. Evidence: call rates measured from artifacts/. Skip Scenarios: when the current agent skips the tool. Production Map: where production states the mandate, beside the local equivalent. Chain Map: production’s 15 tool chains mapped to the five registered local tools. Fix Sequence: the order to close the gaps. Open Decisions: choices to make before development.',
  ],
  [
    'How to update',
    'Edit scripts/write-suggested-questions-gap-register.ts, then run npm run gaps:suggested-questions. The generator rewrites this workbook, so edits made here are lost. When a fix lands, change that gap’s status in the generator and commit the generator and the workbook together.',
  ],
  [
    'Line numbers',
    'file:line references point at the working tree on 2026-10-01, including uncommitted changes. Symbol names are given where lines are likely to move.',
  ],
  [
    'Measurements',
    'The Evidence sheet and the measured Skip Scenarios rows are re-tallied from artifacts/ on every run. Text marked "At analysis" quotes the numbers from 2026-10-01.',
  ],
  [
    'Origin',
    'Production regression: production stated the rule and the local agent dropped or contradicted it. Local-only: introduced locally. Shared weakness: production had the same code or wording, but its per-turn mandate masked it.',
  ],
  [
    'Uncommitted work',
    'G9, G10, G11 and G13 refer to code that exists only in the uncommitted working tree; see Open Decisions. Nothing in this register is approved for implementation yet.',
  ],
];

const PRODUCTION_MAP: string[][] = [
  ['Production location (prompt.ts)', 'What production says', 'Local equivalent', 'Gaps'],
  [
    ':171 - decision process, Stop',
    '"Once the request is satisfied or clarification is required, stop task-tool calls. Perform only the mandatory final suggested-questions update, then respond."',
    'prompt.ts:71 "stop core tool calls. Optional suggestion enrichment may run once before final feedback."',
    'G1',
  ],
  [
    ':173 - tools intro',
    '"Do NOT chain tools unnecessarily, except approved flight task chains and the required final update_flight_suggested_questions context update."',
    'None.',
    'G1, G2',
  ],
  [
    ':426-449 - tool section E',
    'Use at the end of every turn; final tool call before the text response; at most once; no tools after it; reads the latest searchKey at execution time; three suggestions with a key, an empty array without; never mention it; clarification turns still call it.',
    'prompt.ts:135-139 "optional, best-effort enrichment"; at most once; three with an active search, an empty array without.',
    'G1, G6, G18',
  ],
  [
    ':450-481 - suggestion rules',
    'User-side "You might ask" voice; no assistant-style wording; no mandatory-field suggestions, with block examples; no failed or just-completed action; never the same three; rotate intents; no active filter, including one applied this turn.',
    'prompt.ts:139 keeps a condensed subset; agent.ts:209-210 covers active filters.',
    'G15',
  ],
  [
    ':655-659 - end of the routing procedure',
    '"Before final response, always update Flight suggested questions." Call it as the final tool call; it re-checks the latest searchKey; do not expose its result.',
    'None.',
    'G1',
  ],
  [
    ':660-676 - approved chains',
    '15 chains, every one ending in the tool, including the tool alone for missing-info, clarification, source-option and no-action responses.',
    'None. See the Chain Map sheet.',
    'G2',
  ],
  [
    ':725 - communication style',
    '"After update_flight_suggested_questions, do not mention suggested questions."',
    'None.',
    'G15',
  ],
  [
    ':908 - final checklist',
    '"Did I call update_flight_suggested_questions as the final tool call and avoid mentioning its result to the user?"',
    'None.',
    'G3',
  ],
  [
    ':914-995 - captured dynamic block',
    '"Active search exists: yes" (:920); the mandate restated at the very end of the prompt (:987-988); compare against previous suggestions and never resend the same three (:989-990); mandatory-field guard (:993); an empty array when there is no active search (:994).',
    'agent.ts:189 "Hydrated search key present (not validated)"; agent.ts:212-214 lists previous suggestions; agent.ts:229 "Suggested questions are optional."',
    'G1, G18',
  ],
];

const CHAIN_MAP: string[][] = [
  ['#', 'Production chain (prompt.ts:660-676)', 'Local chain with the five registered tools', 'Port'],
  [
    '1',
    'update_flight_suggested_questions alone - missing-info, clarification, source-option or no-action responses',
    'update_flight_suggested_questions alone',
    'Yes - the most important row',
  ],
  [
    '2',
    'resolve_flight_date -> update_flight_suggested_questions - vague timing resolved, route or return timing still missing',
    'update_flight_suggested_questions alone: the local prompt derives date ranges from the turn clock',
    'Merge into 1',
  ],
  [
    '3',
    'flight_search -> update_flight_suggested_questions - search or search update',
    'Same',
    'Yes',
  ],
  [
    '4',
    'resolve_flight_date -> flight_search -> update_flight_suggested_questions - vague-date search',
    'flight_search -> update_flight_suggested_questions',
    'Merge into 3',
  ],
  [
    '5',
    'apply_filter -> update_flight_suggested_questions - filter only',
    'Same',
    'Yes',
  ],
  [
    '6',
    'getGeneratedContractsContext(read) -> update_flight_suggested_questions - informational current-option question',
    'Same',
    'Yes',
  ],
  [
    '7',
    'getGeneratedContractsContext(select) -> update_flight_suggested_questions - explicit indexed comparison',
    'getGeneratedContractsContext(select or show_all) -> update_flight_suggested_questions, for explicit display requests only; comparisons read (prompt.ts:112)',
    'Adapt',
  ],
  [
    '8',
    'getGeneratedContractsContext(read) -> getGeneratedContractsContext(select) -> update_flight_suggested_questions - cheapest, best, recommendation, generic comparison',
    'getGeneratedContractsContext(read) -> update_flight_suggested_questions: ranking reads without changing visibility (prompt.ts:112)',
    'Adapt - same local chain as 6',
  ],
  [
    '9',
    'flight_search -> apply_filter -> update_flight_suggested_questions - search plus filter',
    'Same; also covers apply_filter returning MISSING_SEARCH, then flight_search, then apply_filter (prompt.ts:123)',
    'Yes',
  ],
  [
    '10',
    'resolve_flight_date -> flight_search -> apply_filter -> update_flight_suggested_questions - vague-date search plus filter',
    'flight_search -> apply_filter -> update_flight_suggested_questions',
    'Merge into 9',
  ],
  [
    '11',
    'price_prediction_tool -> update_flight_suggested_questions - route-based date intelligence',
    'Same, after success or failure on advice-only requests',
    'Yes',
  ],
  [
    '12',
    'resolve_flight_date -> price_prediction_tool -> update_flight_suggested_questions - vague-date price intelligence',
    'price_prediction_tool -> update_flight_suggested_questions',
    'Merge into 11',
  ],
  [
    '13',
    'price_prediction_tool -> flight_search -> update_flight_suggested_questions - a successful prediction supplies the date and results were requested',
    'price_prediction_tool -> flight_search [-> apply_filter] -> update_flight_suggested_questions; also the single fallback search after a failed prediction (prompt.ts:102)',
    'Yes',
  ],
  [
    '14',
    'resolve_flight_date -> price_prediction_tool -> flight_search -> update_flight_suggested_questions',
    'price_prediction_tool -> flight_search -> update_flight_suggested_questions',
    'Merge into 13',
  ],
  [
    '15',
    'getGeneratedContractsContext -> price_prediction_tool -> update_flight_suggested_questions - price advice about a current option',
    'getGeneratedContractsContext(read) -> price_prediction_tool -> update_flight_suggested_questions (prompt.ts:95)',
    'Yes',
  ],
  [],
  [
    'Result',
    'Nine local chains: the tool alone; search; filter; search plus filter; contract read; contract select or show_all; prediction; prediction plus search; contract read plus prediction. Each ends in update_flight_suggested_questions, including after recovery retries.',
  ],
  [
    'Constraint',
    'Do not name resolve_flight_date in FLIGHT_PROMPT: it is not registered (tools/index.ts:59-65), and flight-agent-price-prediction.test.ts:596 asserts the name is absent.',
  ],
];

interface TurnRecord {
  rawTools?: unknown;
  flightTools?: unknown;
  actualTools?: unknown;
  specialistsUsed?: unknown;
}

interface TurnFact {
  group: string;
  /** Sorted core tools in the turn, or "(no tool)". */
  signature: string;
  called: boolean;
  /** flight_search or apply_filter replaced the results the suggestions described. */
  changedResults: boolean;
  /** False when the Manager answered without invoking Flight, which cannot skip anything. */
  flightRan: boolean;
  /** The turn ran Flight as a Manager tool rather than through the standalone runner. */
  managerPath: boolean;
}

interface Evidence {
  fileCount: number;
  facts: TurnFact[];
}

function toolList(turn: TurnRecord): string[] | null {
  for (const candidate of [turn.rawTools, turn.flightTools, turn.actualTools]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return null;
}

function groupFor(fileName: string): string {
  if (fileName.startsWith('flight-conversation-')) return SCRIPTED_GROUP;
  if (fileName.startsWith('manager-flight-')) return 'manager-flight-*';
  return 'manager-realistic-*';
}

function collectTurns(parsed: unknown): TurnRecord[] {
  const turns: TurnRecord[] = [];
  const root = parsed as { turns?: unknown; conversations?: unknown };
  if (Array.isArray(root?.turns)) {
    turns.push(...(root.turns as TurnRecord[]));
  }
  if (Array.isArray(root?.conversations)) {
    for (const conversation of root.conversations as { turns?: unknown }[]) {
      if (Array.isArray(conversation?.turns)) {
        turns.push(...(conversation.turns as TurnRecord[]));
      }
    }
  }
  return turns;
}

async function collectEvidence(artifactsDir: string): Promise<Evidence> {
  const facts: TurnFact[] = [];
  let fileCount = 0;

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(artifactsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    entries = [];
  }

  for (const name of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(artifactsDir, name), 'utf8'));
    } catch {
      continue;
    }
    const turns = collectTurns(parsed);
    if (turns.length === 0) continue;
    fileCount += 1;

    for (const turn of turns) {
      const tools = toolList(turn);
      if (!tools) continue;
      const core = [...new Set(tools.filter((tool) => tool !== SUGGESTED_TOOL))].sort();
      const specialists = Array.isArray(turn.specialistsUsed) ? turn.specialistsUsed : null;
      facts.push({
        group: groupFor(name),
        signature: core.length > 0 ? core.join(' + ') : '(no tool)',
        called: tools.includes(SUGGESTED_TOOL),
        changedResults: core.some((tool) => RESULT_CHANGING_TOOLS.includes(tool)),
        // Standalone recordings have no specialist list; Flight is the only agent there.
        flightRan: specialists ? specialists.includes('flight_agent') : true,
        managerPath: specialists !== null,
      });
    }
  }

  return { fileCount, facts };
}

function countCalled(facts: TurnFact[]): number {
  return facts.filter((fact) => fact.called).length;
}

function countNoRefresh(facts: TurnFact[]): number {
  return facts.filter((fact) => fact.changedResults && !fact.called).length;
}

function rate(called: number, turns: number): string {
  return turns > 0 ? `${Math.round((100 * called) / turns)}%` : 'n/a';
}

function signatureTable(
  facts: TurnFact[],
  heading: string,
): (string | number)[][] {
  const bySignature = new Map<string, { turns: number; called: number }>();
  for (const fact of facts) {
    const row = bySignature.get(fact.signature) || { turns: 0, called: 0 };
    row.turns += 1;
    if (fact.called) row.called += 1;
    bySignature.set(fact.signature, row);
  }

  const rows: (string | number)[][] = [
    [heading],
    ['Core tools in the turn', 'Flight turns', 'Tool called', 'Rate'],
  ];
  for (const [signature, row] of [...bySignature.entries()].sort(
    (left, right) => right[1].turns - left[1].turns,
  )) {
    rows.push([signature, row.turns, row.called, rate(row.called, row.turns)]);
  }
  return rows;
}

function buildEvidenceSheet({ fileCount, facts }: Evidence): WorkbookSheet {
  const flightFacts = facts.filter((fact) => fact.flightRan);
  const changed = flightFacts.filter((fact) => fact.changedResults);
  const unchanged = flightFacts.filter((fact) => !fact.changedResults);
  const managerTurns = facts.filter((fact) => fact.managerPath).length;

  const rows: (string | number)[][] = [
    ['Evidence - re-tallied from artifacts/ on every run of this generator'],
    [`Generated: ${new Date().toISOString()}`],
    [`Artifact files with recorded turns: ${fileCount}`],
    [
      `Recorded turns: ${facts.length}. Turns where Flight ran: ${flightFacts.length}. Turns the Manager answered without Flight: ${facts.length - flightFacts.length} - excluded below, because Flight never ran and so could not skip the tool. Manager-path turns: ${managerTurns} of ${facts.length}.`,
    ],
    [
      'Method: for each Flight turn, read the tool list (rawTools, else flightTools, else actualTools) and check whether it contains ' +
        SUGGESTED_TOOL +
        '. "Search/filter turns with no refresh" counts turns where flight_search or apply_filter replaced the results and the tool was not called. With the working-tree code those turns end with no suggestions; with committed HEAD they keep suggestions written for the previous results.',
    ],
    [
      'At analysis (2026-10-01): the recordings come from two prompt eras (manager-flight-five-chats-* and manager-realistic-conversations from 2026-09-19, the rest from 2026-09-30 to 2026-10-01). None reflect the working-tree prompt edited at 14:28 on 2026-10-01, so capture a fresh baseline before Step 1.',
    ],
    [],
    ['Call rate by whether the turn changed the results'],
    ['Flight turns', 'Turns', 'Tool called', 'Rate'],
    [
      'Ran flight_search or apply_filter',
      changed.length,
      countCalled(changed),
      rate(countCalled(changed), changed.length),
    ],
    [
      'Ran neither',
      unchanged.length,
      countCalled(unchanged),
      rate(countCalled(unchanged), unchanged.length),
    ],
    [],
    ...signatureTable(flightFacts, 'Call rate by core-tool signature - all Flight turns'),
    [],
    ...signatureTable(
      flightFacts.filter((fact) => fact.group === SCRIPTED_GROUP),
      `Call rate by core-tool signature - ${SCRIPTED_GROUP} scripted conversations only (the set fix verification re-runs)`,
    ),
  ];

  rows.push([]);
  rows.push(['Call rate by artifact group']);
  rows.push([
    'Group',
    'Recorded turns',
    'Flight turns',
    'Tool called',
    'Rate',
    'Search/filter turns with no refresh',
  ]);

  const groups = [...new Set(facts.map((fact) => fact.group))].sort();
  for (const group of groups) {
    const inGroup = facts.filter((fact) => fact.group === group);
    const flightInGroup = inGroup.filter((fact) => fact.flightRan);
    rows.push([
      group,
      inGroup.length,
      flightInGroup.length,
      countCalled(flightInGroup),
      rate(countCalled(flightInGroup), flightInGroup.length),
      countNoRefresh(flightInGroup),
    ]);
  }
  rows.push([
    'TOTAL',
    facts.length,
    flightFacts.length,
    countCalled(flightFacts),
    rate(countCalled(flightFacts), flightFacts.length),
    countNoRefresh(flightFacts),
  ]);

  rows.push([]);
  rows.push(['Target after the fix']);
  rows.push([
    'Every core-tool signature row reaches 100%, including getGeneratedContractsContext, price_prediction_tool and (no tool), and "Search/filter turns with no refresh" reaches 0.',
  ]);

  return { name: 'Evidence', rows };
}

interface SkipScenario {
  scenario: string;
  /** Re-tallied from artifacts on every run; omit when no recording measures it. */
  measure?: (facts: TurnFact[]) => string;
  evidence?: string;
  why: string;
}

/** Measure a scenario by the Flight turns whose core tools match `signature`. */
function signatureRate(signature: string) {
  return (facts: TurnFact[]): string => {
    const all = facts.filter((fact) => fact.flightRan && fact.signature === signature);
    const scripted = all.filter((fact) => fact.group === SCRIPTED_GROUP);
    return `All Flight turns: ${countCalled(all)} of ${all.length} called it. Scripted conversations: ${countCalled(scripted)} of ${scripted.length}.`;
  };
}

const SKIP_SCENARIOS: SkipScenario[] = [
  {
    scenario: 'Informational or ranking question about current options',
    measure: signatureRate('getGeneratedContractsContext'),
    why: 'No chain covers a contract read and no search or filter ran, so the "when called with an active search" wording never clearly applies.',
  },
  {
    scenario: 'Price / date intelligence',
    measure: signatureRate('price_prediction_tool'),
    why: 'The prediction chains exist only in FLIGHT_PROD_PROMPT_TEXT (prompt.ts:672-676).',
  },
  {
    scenario: 'Clarification, missing-info or source-option answer with no core tool',
    measure: signatureRate('(no tool)'),
    why: 'Production had a standalone chain for exactly this case (prompt.ts:662); the local prompt has none.',
  },
  {
    scenario: 'Filter-only turn',
    measure: signatureRate('apply_filter'),
    why: 'Called opportunistically, not reliably. The skips are spread across ordinary filter additions, not just resets.',
  },
  {
    scenario: 'Search turn (for comparison)',
    measure: signatureRate('flight_search'),
    why: 'The one case the model handles reliably: it treats the tool as a refresh after new results, not as the end of every turn.',
  },
  {
    scenario: 'Under turn-budget pressure',
    evidence: 'Licensed by prompt.ts:143.',
    why: 'The prompt tells the model to prioritise structured feedback over "optional work".',
  },
  {
    scenario: 'Manager mode',
    measure: (facts) =>
      `${facts.filter((fact) => fact.managerPath).length} of ${facts.length} recorded turns ran on the Manager path.`,
    why: 'The turn ends by emitting structured output, and manager-output.ts:38 explicitly calls the work optional.',
  },
  {
    scenario: 'Non-deterministically, on identical input',
    evidence:
      'search_filter_options turn 2, "Show nonstop flights only.": called in manager-flight-five-chats-live.json, not called in manager-flight-five-chats-traced-live.json.',
    why: 'Nothing enforces it, so it is left to sampling.',
  },
  {
    scenario: 'After a rejected draft',
    evidence:
      'Test-only: flight-agent-recovery-loop.test.ts:315-330. No recorded turn hit it.',
    why: 'isEnabled hides the tool for the rest of the request after any attempt, so a one- or two-item draft can never be corrected (G7, G8).',
  },
  {
    scenario: 'Second Flight call in one Manager turn',
    evidence:
      'Latent: no recorded turn lists more than one Flight subtask or Flight result.',
    why: 'One requestId covers the whole Manager turn, so the second Flight run finds the tool hidden, even after a new search cleared the suggestions (G17).',
  },
  {
    scenario: 'Hydrated but unvalidated search key',
    evidence: 'Latent: not seen in recorded turns.',
    why: 'The prompt separates a hydrated key from a valid active search. An empty array sent while a key exists is rejected, and the tool hides itself (G18, G7).',
  },
  {
    scenario: 'Run error or max turns',
    evidence: 'Not recorded separately.',
    why: 'The run ends before the tool is reached, and the max-turns recovery path leaves it out of CORE_TOOLS (recovery-outcome.ts:6-10).',
  },
  {
    scenario: 'Manager answers without calling Flight',
    measure: (facts) =>
      `${facts.filter((fact) => !fact.flightRan).length} of ${facts.length} recorded turns.`,
    why: 'Not a Flight skip, so the Evidence sheet excludes these turns. Nothing refreshes or clears the Flight suggestions, and the previous ones go out again (see Open Decisions).',
  },
];

function buildSkipScenariosSheet({ facts }: Evidence): WorkbookSheet {
  return {
    name: 'Skip Scenarios',
    rows: [
      ['Scenario', 'Evidence (measured rows are re-tallied on every run)', 'Why the current agent skips it'],
      ...SKIP_SCENARIOS.map((item) => [
        item.scenario,
        item.measure ? item.measure(facts) : item.evidence || '',
        item.why,
      ]),
    ],
  };
}

const registerSheet: WorkbookSheet = {
  name: 'Gap Register',
  rows: [
    [
      'ID',
      'Layer',
      'Gap',
      'Origin',
      'Production behavior',
      'Current behavior',
      'Missing rule / logic',
      'Impact',
      'Severity',
      'Recommended fix direction',
      'Step',
      'Status',
      'Verify by',
    ],
    ...GAPS.map((gap) => [
      gap.id,
      gap.layer,
      gap.title,
      gap.origin,
      gap.production,
      gap.current,
      gap.missing,
      gap.impact,
      gap.severity,
      gap.fix,
      gap.step,
      gap.status,
      gap.verify,
    ]),
  ],
};

const projectRoot = process.cwd();
const evidence = await collectEvidence(path.join(projectRoot, 'artifacts'));
const sheets: WorkbookSheet[] = [
  registerSheet,
  buildEvidenceSheet(evidence),
  buildSkipScenariosSheet(evidence),
  { name: 'Production Map', rows: PRODUCTION_MAP },
  { name: 'Chain Map', rows: CHAIN_MAP },
  { name: 'Fix Sequence', rows: FIX_SEQUENCE },
  { name: 'Open Decisions', rows: OPEN_DECISIONS },
  { name: 'Read Me', rows: READ_ME },
];

const outputPath = path.join(
  projectRoot,
  'docs',
  'flight-suggested-questions-gap-analysis.xlsx',
);
const written = await writeWorkbook(outputPath, sheets);

const flightFacts = evidence.facts.filter((fact) => fact.flightRan);
console.log(`Gap register written: ${written}`);
console.log(`Gaps tracked: ${GAPS.length}`);
console.log(
  `Flight turns: ${flightFacts.length} of ${evidence.facts.length} recorded; tool called on ${countCalled(flightFacts)}; search/filter turns with no refresh: ${countNoRefresh(flightFacts)}`,
);
for (const sheet of sheets) {
  console.log(`  ${sheet.name}: ${sheet.rows.length} rows`);
}
