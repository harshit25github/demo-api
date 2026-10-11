/**
 * Paid, Manager-only replay: the real Manager answers a real traveler message while
 * trip_planner_agent returns feedback recorded from a live trace. It checks whether the
 * Manager follows Trip's feedback without paying for a Trip run (about 2 model calls).
 *
 *   RUN_MANAGER_TRIP_LIVE=1 npx tsx tests/live/manager-trip-feedback-replay-live.ts --case turn1-failure --label baseline
 *
 * Every attempt is saved under artifacts/manager-trip-replay/ and never overwritten.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const TURN1 = 'My partner and I want a relaxed four-day food and history getaway next month. We have not picked a city yet. Could you suggest a few places in Europe, with photos? Our budget is about US$1,500 total for food and activities.';

/** The current guard's answer to discovery content that strays out of scope, as in the turn-1 trace. */
async function guardFailureFeedback(user: string) {
  const [{ prepareTripPlannerTurn, applyTripPlannerContextUpdate }, { sanitizeTripPlannerManagerOutput }, { tripFeedback }] = await Promise.all([
    import('../../src/agents/trip-planner/context/lifecycle.js'), import('../../src/agents/trip-planner/scope-policy.js'),
    import('../helpers/trip-manager.js'),
  ]);
  const state: any = { summaryContext: {}, tripPlanner: {} };
  prepareTripPlannerTurn({ context: state, input: user });
  applyTripPlannerContextUpdate(state, { baseRevision: 0, contextPatch: {
    pax: 2, duration_days: 4, budget: { total: 1500, currency: 'USD', per_person: false },
    tripType: { add: ['couple', 'relaxed', 'food', 'history'] }, date_hint: 'November 2026',
  } });
  const cards = [['LIS', 'Lisbon, Portugal'], ['SVQ', 'Seville, Spain'], ['PRG', 'Prague, Czechia']].map(([itemCode, title]) => {
    const imageUrl = `https://images.example.test/fallback-${itemCode.toLowerCase()}.jpg`;
    state.tripPlanner.placeImageCache = { ...state.tripPlanner.placeImageCache, [itemCode]: { itemCode, imageUrl } };
    return { itemCode, title, imageUrl, knownFor: 'Historic lanes and local food', weather: 'November: mild days', budget: 'Good value' };
  });
  cards[1].budget = 'Good value, though hotels near the cathedral cost more';
  const raw = tripFeedback(state, { destinationCards: cards, recommendation: 'Lisbon suits a relaxed food and history break',
    nextQuestions: [{ key: 'destination', purpose: 'Choose one city to plan' }] });
  return sanitizeTripPlannerManagerOutput(raw, state, []).output;
}

const TURN3 = 'Is anything special happening there while we are in town, like festivals, concerts or exhibitions? If something good is on, add it to the right day.';

/** The typed failure the Trip tool returns when the guard rejects a revision, as in live turn 3. */
async function rejectedRevisionFeedback(user: string) {
  const [{ prepareTripPlannerTurn, applyTripPlannerContextUpdate }, { tripPlannerFailureFeedback }] = await Promise.all([
    import('../../src/agents/trip-planner/context/lifecycle.js'), import('../../src/agents/trip-planner/scope-policy.js'),
  ]);
  const seville = {
    destination: { city: 'Seville', iata: 'SVQ' }, outbound_date: '2026-11-12', return_date: '2026-11-15', duration_days: 4,
    pax: 2, tripType: ['couple', 'relaxed', 'food', 'history'], budget: { total: 1500, currency: 'USD', per_person: false },
  };
  const state: any = { summaryContext: seville, tripPlanner: { lastPlanSnapshot: seville, lastPlanArtifact: { id: 'plan_4', days: [] } } };
  prepareTripPlannerTurn({ context: state, input: user });
  applyTripPlannerContextUpdate(state, { baseRevision: state.tripPlanner.turnState.baseRevision, contextPatch: null });
  return tripPlannerFailureFeedback(state);
}

/** Turns 1-2 of the real conversation as plain messages, so "there" resolves to Seville. */
async function realHistory() {
  const { readFile } = await import('node:fs/promises');
  const items: any[] = [];
  for (const turn of [1, 2]) {
    const record = JSON.parse(await readFile(path.join('artifacts', 'manager-trip-conversation-real', `turn-${turn}.json`), 'utf8'));
    items.push({ role: 'user', content: record.user });
    items.push({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: record.finalText }] });
  }
  return items;
}

const CASES: Record<string, { user: string; feedback: () => any; history?: () => Promise<any[]>; knownPlaces?: RegExp }> = {
  'turn3-rejected': { user: TURN3, feedback: () => rejectedRevisionFeedback(TURN3), history: realHistory, knownPlaces: /^(?:Seville|Spain)$/i },
  'turn1-guard-failure': { user: TURN1, feedback: () => guardFailureFeedback(TURN1) },
  // Recorded from trace_8269795fa3a143b19a686df8363531ae (turn 1, first attempt).
  'turn1-failure': {
    user: TURN1,
    feedback: () => ({
      status: 'failure', mode: 'answer', destinationCards: [], itineraryDays: [], recommendation: null,
      notes: [{ kind: 'capability', text: 'I can help with day-wise itineraries, places, food, activities, trip pace, and budget-friendly planning.', sourceName: null }],
      tables: [], nextQuestions: [],
      formattingRules: {
        maxBodyWords: 90, targetBodyWords: 75, maxIntroSentences: 1, maxTimeBlockWords: null, maxPatchDaySections: null,
        maxQuestions: 1, questionPriority: ['destination'], cardPolicy: 'exactly_3_cards', seasonPolicy: 'card_field_only',
        budgetPolicy: 'card_field_only', includeUnchangedContent: true, requiresAllTimeBlocks: false,
        patchTargets: ['party', 'budget', 'dates_or_duration', 'pace', 'preferences', 'food', 'activities'], patchPresentation: null,
        cardMarkdown: 'One paired :::cards block; each [CARD] has exactly title, image, known_for, weather, budget in that order, then [/CARD]. Keep image URLs unchanged; null means Photo unavailable. No Markdown images or other URLs.',
        dayMarkdown: 'Full: **Day N — Theme**, then 🌅 **Morning:**, ☀️ **Afternoon:**, 🌙 **Evening:**. Patch: only supplied changed days and non-null blocks; never repeat unchanged blocks. Plain facts become concise markdown, not extra activities.',
        tableMarkdown: 'Markdown pipe tables. Budget: exactly two columns. Comparison: at most three columns, short cells, ★ only on recommended rows. Render each table once.',
      },
      limitations: [],
    }),
  },
};

// Any place the Manager names when Trip supplied none was invented from memory.
const PLACES = /\b(?:Lisbon|Porto|Seville|Madrid|Barcelona|Valencia|Granada|Rome|Florence|Bologna|Naples|Venice|Milan|Paris|Lyon|Nice|Prague|Vienna|Budapest|Krak[oó]w|Warsaw|Berlin|Munich|Amsterdam|Brussels|Bruges|Copenhagen|Athens|Istanbul|Dubrovnik|Edinburgh|London|Dublin|Salzburg|Ljubljana|Tallinn|Portugal|Spain|Italy|France|Greece|Croatia|Mediterranean|Central Europe)\b/gi;

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

async function main() {
  if (process.env.RUN_MANAGER_TRIP_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
    throw new Error('Set RUN_MANAGER_TRIP_LIVE=1 with OPENAI_API_KEY for this paid replay.');
  }
  const caseId = arg('--case') || 'turn1-guard-failure';
  const scenario = CASES[caseId];
  if (!scenario) throw new Error(`Unknown --case. Use one of: ${Object.keys(CASES).join(', ')}`);
  process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';

  const [{ tool, getGlobalTraceProvider, withCustomSpan }, { ManagerAgent }, { mainChatRunner, runGatewayAgent }, { tripPlannerAgentAsTool }, { pinManagerLiveModels }] = await Promise.all([
    import('@openai/agents'), import('../../src/agents/manager-orchestrator/agent.js'),
    import('../../src/agents/manager-orchestrator/runner.js'), import('../../src/agents/manager/specialists/trip-planner.js'),
    import('./manager-live-model-policy.js'),
  ]);
  pinManagerLiveModels();
  const feedback = await scenario.feedback();

  const subtasks: string[] = [];
  const recordedTrip = tool({
    name: tripPlannerAgentAsTool.name,
    description: tripPlannerAgentAsTool.description,
    parameters: z.object({ input: z.string() }),
    // Visible in the trace inside trip_planner_agent, so a replay is never mistaken for a real Trip run.
    execute: async ({ input }) => withCustomSpan(async () => { subtasks.push(input); return JSON.stringify(feedback); },
      { data: { name: 'Trip stubbed: recorded feedback (replay test)', data: { caseId } } }),
  });
  const manager = ManagerAgent.clone({ tools: [ManagerAgent.tools[0], recordedTrip] });
  const runner = { run: (_agent: unknown, input: any, options: any) => mainChatRunner.run(manager, input, options) };

  const startedAt = new Date().toISOString();
  const { MemorySession } = await import('@openai/agents');
  const session = scenario.history ? new MemorySession({ initialItems: await scenario.history() }) : undefined;
  const result = await runGatewayAgent({
    input: scenario.user, context: {}, requestId: `replay-${caseId}`, sessionId: `replay-${caseId}`,
    timeZone: 'Asia/Kolkata', maxTurns: 6, runner: runner as any, session,
  });
  await getGlobalTraceProvider().forceFlush();
  const final = result.output;

  const issues: string[] = [];
  if (subtasks.length !== 1) issues.push(`Manager called trip_planner_agent ${subtasks.length} times; expected once with no retry.`);
  // The app shows cards and photos; the Manager talks about the trip, never the machinery.
  const internal = final.match(/\b(?:cards?|photos?|images?|pictures?|render\w*|format\w*|generat\w*|tools?|system|errors?|failures?|working again|load\w*)\b/gi);
  if (internal) issues.push(`Manager talked about internal mechanics: ${[...new Set(internal.map((word) => word.toLowerCase()))].join(', ')}.`);
  if (feedback.status === 'failure') {
    const invented = [...new Set(final.match(PLACES) || [])].filter((place) => !scenario.knownPlaces?.test(place));
    if (invented.length) issues.push(`Manager named places Trip never supplied: ${invented.join(', ')}.`);
    const venues = final.match(/\b(?:Teatro|Maestranza|CaixaForum|Cartuja|Alc[aá]zar|SEFF|Film Festival|Museum|Museo)\b/gi);
    if (venues) issues.push(`Manager named venues or events Trip never supplied: ${[...new Set(venues)].join(', ')}.`);
    const cause = final.match(/\b(?:couldn['’]t|could not|can['’]t|cannot|unable to|wasn['’]t able to|not able to)\s+(?:verify|confirm|find|reliably)\b/i);
    if (cause) issues.push(`Manager guessed a cause Trip never reported: "${cause[0]}".`);
    const ask = final.match(/\bif you(?:['’]d| would) like\b|\btell me (?:the|which|what|your|more)\b/i);
    if (ask) issues.push(`Manager asked for more details: "${ask[0]}".`);
    if (final.split(/\s+/).filter(Boolean).length > 45) issues.push(`Failure reply is ${final.split(/\s+/).filter(Boolean).length} words; expected a brief apology.`);
    if (/:::cards|\[CARD\]/.test(final)) issues.push('Manager rendered cards Trip never supplied.');
    if (/\?/.test(final)) issues.push('Manager asked a question although Trip supplied no question intent.');
    const conditional = final.match(/\b(?:once|if|when) you (?:tell|share|give|provide|let me know)\b|\btell me one thing\b|\blet me know (?:which|when|what|your)\b/i);
    if (conditional) issues.push(`Manager made a conditional ask: "${conditional[0]}".`);
    const photoCause = final.split(/(?<=[.!?])\s+|\n+/).find((sentence) => /\b(?:photo|image|picture|card)s?\b/i.test(sentence)
      && /\b(?:load|pull|embed|links?|retry|unavailable|photo-style|web-sourced)\b/i.test(sentence));
    if (photoCause) issues.push(`Manager invented a photo/card cause that Trip never reported: "${photoCause.trim()}"`);
    if (!/\b(?:couldn['’]t|could not|can['’]t|cannot|unable|wasn['’]t able|not able)\b/i.test(final)) issues.push('Manager did not say the request could not be completed.');
  }

  const record = { caseId, label: arg('--label'), startedAt, traceId: result.traceId, feedback, subtasks, final, issues };
  const directory = path.resolve('artifacts', 'manager-trip-replay');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${caseId}-${arg('--label') || 'run'}-${startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...record, file }, null, 2));
  if (issues.length) process.exitCode = 1;
}

await main();
