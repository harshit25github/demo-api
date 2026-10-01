/**
 * Generate docs/flight-suggested-questions-gap-analysis.xlsx — the tracking
 * register for the `update_flight_suggested_questions` production-vs-local gap.
 *
 * The gap rows are authored here because they are judgements, not data. The
 * Evidence sheet is the opposite: it is re-tallied from artifacts/ on every run,
 * so re-running this command after each fix step re-measures the call rate
 * instead of restating the numbers from when the analysis was written.
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
/** Tools that wipe context.flight.suggestedQuestions as a side effect. */
const CLEARING_TOOLS = ['flight_search', 'apply_filter'];

interface GapRow {
  id: string;
  layer: string;
  title: string;
  production: string;
  current: string;
  missing: string;
  impact: string;
  severity: 'High' | 'Medium' | 'Low';
  fix: string;
  step: string;
}

const GAPS: GapRow[] = [
  {
    id: 'G1',
    layer: 'A - Prompt authority',
    title: 'Per-turn mandate removed',
    production:
      'prompt.ts:427 "Use at the end of every Flight Agent turn"; :655 "Before final response, always update Flight suggested questions"; :171 stop rule "Perform only the mandatory final suggested-questions update, then respond".',
    current:
      'prompt.ts:137 "This is optional, best-effort enrichment"; :71 "Optional suggestion enrichment may run once"; agent.ts:229 repeats "Suggested questions are optional".',
    missing:
      'Any unconditional statement that the turn is not finished until the tool has run.',
    impact:
      '43% call rate across 201 recorded turns; 0% on read-only, prediction and no-tool turns.',
    severity: 'High',
    fix: 'Replace the optional framing in all three live locations with a required-final-step rule.',
    step: 'Step 3',
  },
  {
    id: 'G2',
    layer: 'A - Prompt authority',
    title: 'Approved tool-chain table absent',
    production:
      'prompt.ts:660-676 lists 15 chains, every one terminating in this tool, including "update_flight_suggested_questions alone for missing-info, clarification, source-option, or no-action responses".',
    current: 'FLIGHT_PROMPT contains no chain table at all.',
    missing:
      'Per-request-class sequencing that names the tool as the terminal step.',
    impact:
      'The three 0% measured rows map one-to-one onto the missing chains (contract read, prediction, no-tool).',
    severity: 'High',
    fix: 'Add a compact chain list ending in the tool; the standalone clarification case matters most (0/12 turns today).',
    step: 'Step 3',
  },
  {
    id: 'G3',
    layer: 'A - Prompt authority',
    title: 'Pre-response checklist gone',
    production:
      'prompt.ts:908 "Did I call update_flight_suggested_questions as the final tool call and avoid mentioning its result to the user?"',
    current: 'No checklist of any kind in the live prompt.',
    missing: 'A self-verification pass before the final output is emitted.',
    impact: 'No second chance for the model to notice the omission.',
    severity: 'Medium',
    fix: 'One checklist line in the "Final response and stopping" section.',
    step: 'Step 3',
  },
  {
    id: 'G4',
    layer: 'A - Prompt authority',
    title: 'A clause actively instructs the model to drop it',
    production: 'Turn budget was never traded against this tool.',
    current:
      'prompt.ts:143 "Search/filter/contract success outranks suggestion enrichment. Prioritize completing structured feedback within the turn budget over optional work."',
    missing:
      'Nothing - this is an added counter-incentive rather than an omission.',
    impact:
      'With maxTurns: 10 (config.ts:88) this is the first thing dropped under pressure.',
    severity: 'High',
    fix: 'Keep "never let it discard a successful result"; delete the optional-work / budget trade-off framing.',
    step: 'Step 3',
  },
  {
    id: 'G5',
    layer: 'A - Prompt authority',
    title: 'Manager-mode instructions de-escalate it',
    production:
      'The agent ended its turn in free text, so "final tool call before your final text response" was a coherent instruction.',
    current:
      'FlightManagerAgent sets outputType: flightManagerOutputSchema (agent.ts:250) so the turn ends by emitting JSON; manager-output.ts:38 says "Optional suggested-question work never changes a successful core outcome."',
    missing:
      'An ordering rule: tool call first, structured output second.',
    impact: 'Manager-path call rates of 43% (manager-flight-*) and 35% (manager-realistic-*).',
    severity: 'High',
    fix: 'State the ordering in FLIGHT_MANAGER_INSTRUCTIONS and drop the de-escalation sentence. Do NOT add a schema field - the consumer reads shared context, not Manager feedback.',
    step: 'Step 3',
  },
  {
    id: 'G6',
    layer: 'B - Tool definition',
    title: 'Tool description contradicts any mandate',
    production:
      'A "Required behavior" block: call it as the final tool call before the final text response.',
    current:
      'suggested-questions-tool.ts:84 "Best-effort enrichment after the user’s core Flight request is complete..."',
    missing:
      'Required/terminal framing in the text the model receives alongside the tool schema.',
    impact:
      'The description ships in the same payload as the prompt and will undercut G1.',
    severity: 'High',
    fix: 'Mirror the trip-planner sibling: "Call only after context capture and all planning tools, as the final tool call." (trip-planner/tools/context-tools.ts:205-206)',
    step: 'Step 2',
  },
  {
    id: 'G7',
    layer: 'B - Tool definition',
    title: 'Schema admits a payload that can only fail',
    production: '"Exactly 3" was prose only, same as here.',
    current:
      'suggested-questions-tool.ts:16-23 uses .array(z.string().min(1)).max(3) with no .min(3). The provider sees maxItems: 3 and no minimum, so a 1-2 item array is schema-valid, reaches execute, and is rejected with INVALID_SUGGESTED_QUESTIONS / retrySafe: false (:58-71). isEnabled (:91-96) then hides the tool for the rest of the turn.',
    missing: 'A schema that can express both valid states and nothing else.',
    impact:
      'Dead-end failure mode - one malformed draft and the turn stores nothing, with no retry path. Already exercised at flight-agent-recovery-loop.test.ts:315-317.',
    severity: 'Medium',
    fix: 'DECISION NEEDED. A plain .min(3) is wrong: the empty array is how "no active search, clear stale suggestions" is expressed (:41-47). Option (a) keep 0..3 plus a clearOnly discriminator; option (b) PREFERRED .min(3).max(3) like trip-planner (context-tools.ts:116-123) and move clearing into the Step 1 finalize. Also consider per-string .max(80).',
    step: 'Step 2',
  },
  {
    id: 'G8',
    layer: 'B - Tool definition',
    title: 'No phase gate; "at most once" is the only constraint',
    production:
      '"After it returns successfully, call no more tools", and never before core work.',
    current:
      'isEnabled dedupes by requestId only (suggested-questions-tool.ts:91-96). It does not require core work to be complete and does not stop later tool calls.',
    missing: 'A turn-phase gate.',
    impact: 'The tool can fire mid-turn; nothing guarantees it is last.',
    severity: 'Medium',
    fix: 'Mirror the trip-planner gate (context-tools.ts:209-216: contextCaptured && !suggestionsUpdated && attempts < 2), adapted to "core work complete".',
    step: 'Step 2',
  },
  {
    id: 'G9',
    layer: 'C - State / context',
    title: 'A skipped call silently keeps last turn’s suggestions',
    production:
      'The tool was mandatory and re-read searchKey at execution time, so every turn ended in a deliberate write.',
    current:
      'prepareFlightAgentTurnContext clears only when there is no searchKey (flight-context.ts:345-347). On a read-only turn with an active search and no tool call, the previous turn’s three strings persist verbatim.',
    missing:
      'An end-of-turn finalize. The sibling has exactly this: finalizeTripPlannerTurn clears when !turnState.suggestionsUpdated (trip-planner/context/lifecycle.ts:422-425); trip-planner/runner.ts:434 clears on error.',
    impact:
      'Silent staleness, invisible to tests - the lenient live assertions check suggestions.length === 3 (flight-agent-intelligence-deep-chats-live.ts:789-801), which passes on stale data.',
    severity: 'High',
    fix: 'Add a flight turn-finalize plus a per-turn suggestionsUpdated flag. Correct regardless of the mandate decision, so do it first.',
    step: 'Step 1',
  },
  {
    id: 'G10',
    layer: 'C - State / context',
    title: 'Mutation tools wipe without refill',
    production: 'Same clearing, but the mandated end-of-turn write always refilled.',
    current:
      'search-tool.ts:482 and filter/tool.ts:183 set suggestedQuestions = []; see the Evidence sheet for the count of turns that never refilled.',
    missing: 'The guaranteed refill, not the clearing.',
    impact:
      'Empty suggestion chips after a search or filter - the most user-visible symptom.',
    severity: 'High',
    fix: 'Keep the clearing (it is correct invalidation) and close the hole via G1/G8/G9.',
    step: 'Step 1',
  },
  {
    id: 'G11',
    layer: 'D - Execution flow',
    title: 'Zero enforcement anywhere in the run',
    production: 'Prompt-level only there too, but the prompt said "mandatory".',
    current:
      'toolChoice: ‘auto’ (config.ts:19-22); no output guardrail on the agent (agent.ts:234-240); no post-run inspection of toolCallLog in runner.ts:154-185; the max-turns recovery path deliberately excludes it from CORE_TOOLS (recovery-outcome.ts:6-10).',
    missing: 'Any mechanism that notices the omission.',
    impact: 'The prompt is the sole control, and it currently says "optional".',
    severity: 'Medium',
    fix: 'The G9 finalize is the enforcement point. Keep toolChoice: auto - forcing a specific tool would break the core tool loop.',
    step: 'Step 1',
  },
  {
    id: 'G12',
    layer: 'D - Verification',
    title: 'The test suite pins the gap open',
    production: 'n/a - this is local test debt.',
    current:
      'NON_CORE_TOOLS strips the tool before scoring, rationale "must never decide a pass or fail" (flight-agent-conversation-cases.ts:26-27,53). flight-gap-contracts.test.ts:59 is named for the absence. In the report harness none of the 17 expectedTools arrays include it and validateTurn compares tool sequences by exact string equality (flight-agent-session-complex-report-live.ts:434-440). The one script that requires the call (flight-agent-suggested-questions-variation-live.ts:146-148) has no npm script and is never run.',
    missing: 'Expectations that encode the mandate rather than its absence.',
    impact:
      'Restoring the mandate turns the report harness red on every turn before it turns anything green.',
    severity: 'High',
    fix: 'Flip the expectations as part of the change, not after it.',
    step: 'Step 4',
  },
  {
    id: 'G13',
    layer: 'D - Execution flow',
    title: 'No observability',
    production: 'n/a',
    current:
      '.debug/flight-prompt-traces is metadata-only (captureMode "safe"; 61 files, 3 with modelCalls, 0 tool-call records). flight_agent.response (runner.ts:170-176) logs nothing about suggestions.',
    missing: 'A per-turn record of whether the tool ran.',
    impact:
      'The call rate is unmeasurable in a running system; this gap was only visible by grepping recorded artifacts.',
    severity: 'Medium',
    fix: 'Log suggestionsUpdated and the suggestion count per turn.',
    step: 'Step 1',
  },
  {
    id: 'G14',
    layer: 'E - Docs',
    title: 'Docs still describe the mandate as live',
    production: 'n/a',
    current:
      'flight-agent-recent-changes.md:251, flight-agent-context-flow.md:429, flight-agent-date-handling-multiturn.md:390 and prompts/prompt-with-error.md:232 all state it runs last on every turn. No doc calls it optional.',
    missing: 'Agreement between the docs and the live prompt.',
    impact: 'Anyone reading the docs concludes the rule is already enforced.',
    severity: 'Low',
    fix: 'Docs become correct once G1-G3 land; add the chain list and note that FLIGHT_PROD_PROMPT_TEXT is dead text.',
    step: 'Step 5',
  },
];

const OPEN_DECISIONS: string[][] = [
  ['Topic', 'Detail', 'Owner / status'],
  [
    'Who renders the suggestions?',
    'context.flight.suggestedQuestions is persisted and emitted in the SSE done.flightContext payload (api/chat/orchestrator.ts:228), but public/ has zero references to "suggest" and the dashboard reads only showFlight and searchResults. The only reader today is the Flight agent’s own next-turn prompt (agent.ts:109-116), as anti-staleness input. Restoring the mandate buys production parity and correct state plus ~1 extra model call per turn, but no user-visible change until a renderer exists.',
    'Open - confirm the real consumer (presumably the CheapOair mobile client).',
  ],
  [
    'G7 schema shape',
    'Plain .min(3) breaks the empty-array clear path. Option (b) - exactly 3 at the schema level, clearing moved to the Step 1 finalize - is preferred.',
    'Open - decide before Step 2.',
  ],
  [
    'Dead reference prompt',
    'FLIGHT_PROD_PROMPT_TEXT (prompt.ts:148-995) carries all the mandatory language, is commented "Historical comparison reference only; never included in runtime instructions" (:147) and has zero references in src/, tests/ or scripts/. agent.ts:11 imports only FLIGHT_PROMPT. scripts/audit-session-prompts.ts:58 states the invariant: "FLIGHT_PROMPT is the single authoritative runtime prompt."',
    'Resolved - do not edit that string; every rule must land in the live prompt.',
  ],
];

const SKIP_SCENARIOS: string[][] = [
  ['Scenario', 'Measured evidence', 'Why the current agent skips it'],
  [
    'Informational question about current options',
    '0 of 11 turns called the tool',
    'No chain covers getGeneratedContractsContext, and no mutation tool ran, so the "when called with an active search" wording never clearly applies.',
  ],
  [
    'Price / date intelligence',
    '0 of 5 turns',
    'Same - prompt.ts:672-676 chains exist only in the dead reference text.',
  ],
  [
    'Clarification / missing-info turn with no tools',
    '0 of 12 turns',
    'Production had an explicit standalone chain for exactly this case; the local prompt has none.',
  ],
  ['Filter-only turn', 'skipped on 5 of 18 turns', 'Called opportunistically, not reliably.'],
  [
    'Under turn-budget pressure',
    'licensed by prompt.ts:143',
    'The prompt tells the model to prioritise structured feedback over "optional work".',
  ],
  [
    'Manager mode',
    '43% and 35% call rates',
    'The turn ends by emitting the structured output, and manager-output.ts:38 explicitly calls the work optional.',
  ],
  [
    'Non-deterministically, on identical input',
    'search_filter_options turn 2 "Show nonstop flights only" - called in manager-flight-five-chats-live.json, not called in the byte-identical -traced-live.json',
    'Nothing enforces it, so it is left to sampling.',
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
    'Step 1',
    'Deterministic state correctness: suggestionsUpdated flag, flight turn finalize on success and error paths, per-turn logging',
    'G9, G10, G11, G13',
    'Correct on its own merits and independent of the mandate decision. After this, a skipped call can no longer ship stale data.',
  ],
  [
    'Step 2',
    'Tool contract: required-terminal description, schema decision, isEnabled phase gate',
    'G6, G7, G8',
    'The tool description must stop contradicting the mandate before the prompt asserts it.',
  ],
  [
    'Step 3',
    'Prompt authority: mandate wording, stop rule, chain list, checklist line, Manager-mode ordering',
    'G1, G2, G3, G4, G5',
    'Raises the call rate once the state layer is already safe.',
  ],
  [
    'Step 4',
    'Tests: invert NON_CORE_TOOLS, rewrite flight-gap-contracts case, add the tool to the 17 expectedTools arrays, add the missing npm script',
    'G12',
    'Must land with Step 3 - the report harness compares tool sequences by exact equality and would otherwise fail every turn.',
  ],
  ['Step 5', 'Reconcile the four docs', 'G14', 'Last, once behaviour is settled.'],
];

interface TurnRecord {
  rawTools?: unknown;
  flightTools?: unknown;
  actualTools?: unknown;
}

interface Tally {
  turns: number;
  called: number;
  clearedNotRefilled: number;
}

function toolList(turn: TurnRecord): string[] | null {
  for (const candidate of [turn.rawTools, turn.flightTools, turn.actualTools]) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return null;
}

function emptyTally(): Tally {
  return { turns: 0, called: 0, clearedNotRefilled: 0 };
}

function groupFor(fileName: string): string {
  if (fileName.startsWith('flight-conversation-')) return 'flight-conversation-*';
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

interface TurnFact {
  group: string;
  signature: string;
  called: boolean;
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
    ['Core tools in the turn', 'Turns', 'Tool called', 'Rate'],
  ];
  for (const [signature, row] of [...bySignature.entries()].sort(
    (left, right) => right[1].turns - left[1].turns,
  )) {
    rows.push([
      signature,
      row.turns,
      row.called,
      row.turns > 0 ? `${Math.round((100 * row.called) / row.turns)}%` : 'n/a',
    ]);
  }
  return rows;
}

async function buildEvidenceSheet(artifactsDir: string): Promise<WorkbookSheet> {
  const byGroup = new Map<string, Tally>();
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

    const group = groupFor(name);
    const tally = byGroup.get(group) || emptyTally();

    for (const turn of turns) {
      const tools = toolList(turn);
      if (!tools) continue;
      tally.turns += 1;
      const called = tools.includes(SUGGESTED_TOOL);
      if (called) tally.called += 1;
      if (!called && tools.some((tool) => CLEARING_TOOLS.includes(tool))) {
        tally.clearedNotRefilled += 1;
      }

      const core = [...new Set(tools.filter((tool) => tool !== SUGGESTED_TOOL))].sort();
      facts.push({
        group,
        signature: core.length > 0 ? core.join(' + ') : '(no tool)',
        called,
      });
    }

    byGroup.set(group, tally);
  }

  const rate = (called: number, turns: number) =>
    turns > 0 ? `${Math.round((100 * called) / turns)}%` : 'n/a';

  const rows: (string | number)[][] = [
    ['Evidence - re-tallied from artifacts/ on every run of this generator'],
    [`Generated: ${new Date().toISOString()}`],
    [`Artifact files with recorded turns: ${fileCount}`],
    [
      'Method: per recorded turn, read the tool list (rawTools, else flightTools, else actualTools) and check whether it contains ' +
        SUGGESTED_TOOL +
        '. "Cleared not refilled" counts turns where flight_search or apply_filter ran - both wipe suggestedQuestions - and the tool was not called.',
    ],
    [],
    ...signatureTable(facts, 'Call rate by core-tool signature - all recorded turns'),
    [],
    ...signatureTable(
      facts.filter((fact) => fact.group === 'flight-conversation-*'),
      'Call rate by core-tool signature - flight-conversation-* fixtures only (the set the fix verification re-runs)',
    ),
  ];

  rows.push([]);
  rows.push(['Call rate by artifact group']);
  rows.push(['Group', 'Turns', 'Tool called', 'Rate', 'Cleared not refilled']);

  let totalTurns = 0;
  let totalCalled = 0;
  let totalCleared = 0;
  for (const [group, tally] of byGroup) {
    totalTurns += tally.turns;
    totalCalled += tally.called;
    totalCleared += tally.clearedNotRefilled;
    rows.push([
      group,
      tally.turns,
      tally.called,
      rate(tally.called, tally.turns),
      tally.clearedNotRefilled,
    ]);
  }
  rows.push([
    'TOTAL',
    totalTurns,
    totalCalled,
    rate(totalCalled, totalTurns),
    totalCleared,
  ]);

  rows.push([]);
  rows.push(['Target after the fix']);
  rows.push([
    'Every core-tool signature row reaches 100%, including getGeneratedContractsContext, price_prediction_tool and (no tool) - the three that are effectively never called today - and "Cleared not refilled" reaches 0.',
  ]);

  return { name: 'Evidence', rows };
}

const registerSheet: WorkbookSheet = {
  name: 'Gap Register',
  rows: [
    [
      'ID',
      'Layer',
      'Gap',
      'Production behavior',
      'Current behavior',
      'Missing rule / logic',
      'Impact',
      'Severity',
      'Recommended fix direction',
      'Step',
      'Status',
    ],
    ...GAPS.map((gap) => [
      gap.id,
      gap.layer,
      gap.title,
      gap.production,
      gap.current,
      gap.missing,
      gap.impact,
      gap.severity,
      gap.fix,
      gap.step,
      'Open',
    ]),
  ],
};

const projectRoot = process.cwd();
const sheets: WorkbookSheet[] = [
  registerSheet,
  await buildEvidenceSheet(path.join(projectRoot, 'artifacts')),
  { name: 'Skip Scenarios', rows: SKIP_SCENARIOS },
  { name: 'Fix Sequence', rows: FIX_SEQUENCE },
  { name: 'Open Decisions', rows: OPEN_DECISIONS },
];

const outputPath = path.join(
  projectRoot,
  'docs',
  'flight-suggested-questions-gap-analysis.xlsx',
);
const written = await writeWorkbook(outputPath, sheets);

console.log(`Gap register written: ${written}`);
console.log(`Gaps tracked: ${GAPS.length}`);
for (const sheet of sheets) {
  console.log(`  ${sheet.name}: ${sheet.rows.length} rows`);
}
