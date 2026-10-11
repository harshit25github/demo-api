/**
 * Paid Manager -> Trip Planner conversation over the real HTTP/SSE path, run one turn at a time.
 *
 *   RUN_MANAGER_TRIP_LIVE=1 npx tsx tests/live/manager-trip-conversation-live.ts --turn 1
 *   RUN_MANAGER_TRIP_LIVE=1 npx tsx tests/live/manager-trip-conversation-live.ts --dir <run-dir> --turn 2
 *
 * Each turn writes turn-N.json (full evidence) and turn-N.md (the chain to review:
 * user -> Manager subtask -> Trip phase and turn_plan -> Trip tools and web searches ->
 * Trip feedback -> Manager answer -> checks). Running a turn that was already run
 * first restores the saved chat and pops the remote conversation items that the
 * earlier attempt added, so a fixed turn reruns from the same history.
 * Images are dummy URLs; browser rendering is not checked.
 */
import 'dotenv/config';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { tripPlannerManagerOutputSchema, type TripPlannerManagerOutput } from '../../src/agents/trip-planner/manager-output.js';
import { findTripPlannerScopeViolations } from '../../src/agents/trip-planner/scope-policy.js';
import { parseToolValue } from './manager-flight-evidence.js';

type Expectation = {
  mode: Array<TripPlannerManagerOutput['mode']>;
  cards?: number;
  days?: number[];
  webSearch: boolean;
  imageCalls: number;
  contextDetails?: boolean;
  budgetTable?: boolean;
};

const TURNS: Array<{ user: string; intent: string; expect: Expectation }> = [
  {
    user: 'My partner and I want a relaxed four-day food and history getaway next month. We have not picked a city yet. Could you suggest a few places in Europe, with photos? Our budget is about US$1,500 total for food and activities.',
    intent: 'Destination discovery with photos, a relative month, party, pace, interests and a total budget.',
    expect: { mode: ['discovery_cards'], cards: 3, days: [], webSearch: false, imageCalls: 1 },
  },
  {
    user: "Let's go with the second one. We'll arrive November 12 and leave November 15.",
    intent: 'Ordinal selection of a displayed card plus year-less exact dates; full plan.',
    expect: { mode: ['compact_full'], cards: 1, days: [1, 2, 3, 4], webSearch: false, imageCalls: 0 },
  },
  {
    user: 'Is anything special happening there while we are in town, like festivals, concerts or exhibitions? If something good is on, add it to the right day.',
    intent: 'Current events in the trip window; requires fresh research anchored to the resolved dates.',
    expect: { mode: ['compact_patch', 'answer'], webSearch: true, imageCalls: 0 },
  },
  {
    user: 'Day 2 feels a bit packed. Keep the morning as it is, swap the afternoon for free time to wander, and leave everything else unchanged.',
    intent: 'Single-day patch that must read the saved day and change only the afternoon.',
    expect: { mode: ['compact_patch'], days: [2], webSearch: false, imageCalls: 0, contextDetails: true },
  },
  {
    user: 'Can you make the food side more budget-friendly? We would rather keep meals cheap and save money for activities.',
    intent: 'Budget patch: compact budget table and at most one affected day, no research.',
    expect: { mode: ['compact_patch'], webSearch: false, imageCalls: 0, budgetTable: true },
  },
];

/** What the traveler said must survive the Manager's rewrite and Trip's capture. */
function persistedIssues(turn: number, summary: any, tripPlanner: any, firstTurnFinal: string): string[] {
  const issues: string[] = [];
  const types = (summary?.tripType || []).map((value: string) => value.toLowerCase());
  if (summary?.pax !== 2 || !types.includes('couple')) issues.push(`Party lost: pax=${summary?.pax}, tripType=[${types}] (traveler said "my partner and I").`);
  if (!types.includes('relaxed') || !types.some((value: string) => /food|culinar/.test(value)) || !types.some((value: string) => /histor|cultur/.test(value))) issues.push(`Pace/interests lost: tripType=[${types}].`);
  if (summary?.duration_days !== 4) issues.push(`duration_days=${summary?.duration_days}, expected 4.`);
  if ((summary?.budget?.total ?? summary?.budget?.amount) !== 1500 || summary?.budget?.currency !== 'USD') issues.push(`Budget lost: ${JSON.stringify(summary?.budget)}.`);
  if (turn === 1) {
    if (!/november 2026/i.test(String(tripPlanner?.dateHint || ''))) issues.push(`"next month" not resolved from the clock: date_hint=${tripPlanner?.dateHint}.`);
    if (summary?.destination?.city) issues.push('Discovery confirmed a destination prematurely.');
  } else {
    const second = (firstTurnFinal.match(/\[CARD\][\s\S]*?\[\/CARD\]/g) || [])[1]?.match(/^\s*title:\s*([^,\n]+)/m)?.[1]?.trim();
    if (!second || summary?.destination?.city !== second) issues.push(`Selected destination ${summary?.destination?.city}, but the second displayed card was ${second}.`);
    if (summary?.outbound_date !== '2026-11-12' || summary?.return_date !== '2026-11-15') issues.push(`Dates ${summary?.outbound_date}..${summary?.return_date}, expected 2026-11-12..2026-11-15.`);
    if (JSON.stringify(tripPlanner?.lastPlanArtifact?.days?.map((day: any) => day.day)) !== '[1,2,3,4]') issues.push('Saved plan does not hold days 1-4.');
  }
  return issues;
}

type Call = { callId: string; tool: string; input: any; output?: any; completed: boolean };
type ResponseMetric = {
  agent: 'manager' | 'trip' | 'other';
  model?: string;
  effort?: string;
  tools?: string[];
  tripContext?: Record<string, string | null>;
  managerState?: string | null;
  inputItems?: number;
  output?: any[];
  webSearches?: Array<{ status: string; query: string | null; action: any }>;
  usage?: any;
  httpStatus?: number;
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function parseEvents(raw: string) {
  return raw.replace(/\r\n/g, '\n').split('\n\n').flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1];
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!event) return [];
    try { return [{ event, data: data ? JSON.parse(data) : null }]; } catch { return [{ event, data }]; }
  });
}

function tag(text: string, name: string): string | null {
  return text.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[0] ?? null;
}

const CARD_BLOCK = /:::cards\s*\n[\s\S]*?\n:::cards/g;
function words(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Contract checks: every rule Trip hands the Manager must be visible in the answer. */
function contractIssues(trip: TripPlannerManagerOutput | null, final: string, expect: Expectation, evidence: any): string[] {
  const issues: string[] = [];
  if (!trip) return ['Trip did not return schema-valid structured feedback to the Manager.'];
  const rules = trip.formattingRules;
  if (!expect.mode.includes(trip.mode)) issues.push(`Trip mode ${trip.mode}, expected ${expect.mode.join(' or ')}.`);
  if (trip.status !== 'success') issues.push(`Trip status ${trip.status}: ${trip.limitations.join(' | ') || 'no limitation given'}`);

  // Cards: exact count, one paired block, field order, unchanged titles and image assets.
  const rendered = final.match(/\[CARD\][\s\S]*?\[\/CARD\]/g) || [];
  if (expect.cards !== undefined && trip.destinationCards.length !== expect.cards) issues.push(`Trip returned ${trip.destinationCards.length} cards, expected ${expect.cards}.`);
  if (rendered.length !== trip.destinationCards.length) issues.push(`Manager rendered ${rendered.length} cards for ${trip.destinationCards.length} supplied.`);
  if (trip.destinationCards.length && (final.match(CARD_BLOCK) || []).length !== 1) issues.push('Cards are not in exactly one paired :::cards block.');
  rendered.forEach((card, index) => {
    const keys = card.split('\n').flatMap((line) => line.match(/^\s*(title|image|known_for|weather|budget)\s*:/)?.[1] || []);
    if (keys.join() !== 'title,image,known_for,weather,budget') issues.push(`Card ${index + 1} fields are ${keys.join(',') || 'missing'}.`);
    const expected = trip.destinationCards[index];
    if (expected && card.match(/^\s*title:\s*(.+)$/m)?.[1]?.trim() !== expected.title) issues.push(`Card ${index + 1} title or order changed.`);
    if (expected && card.match(/^\s*image:\s*(.+)$/m)?.[1]?.trim() !== (expected.imageUrl ?? 'Photo unavailable')) issues.push(`Card ${index + 1} image changed.`);
  });
  const outsideCards = final.replace(CARD_BLOCK, '');
  if (/https?:\/\//.test(outsideCards) || /!\[[^\]]*\]\(/.test(final)) issues.push('A URL or Markdown image appears outside card image fields.');

  // Days: exactly the supplied days; full plans keep all three labelled blocks.
  const dayNumbers = [...final.matchAll(/^\s*(?:#{1,4}\s*)?(?:\*\*)?Day\s+(\d+)\b/gim)].map((match) => Number(match[1]));
  if (JSON.stringify(dayNumbers) !== JSON.stringify(trip.itineraryDays.map((day) => day.day))) issues.push(`Rendered days [${dayNumbers}] differ from supplied days [${trip.itineraryDays.map((day) => day.day)}].`);
  if (expect.days && JSON.stringify(trip.itineraryDays.map((day) => day.day)) !== JSON.stringify(expect.days)) issues.push(`Trip supplied days [${trip.itineraryDays.map((day) => day.day)}], expected [${expect.days}].`);
  const blockLabels = { morning: /🌅\s*\*\*Morning:\*\*/g, afternoon: /☀️\s*\*\*Afternoon:\*\*/g, evening: /🌙\s*\*\*Evening:\*\*/g };
  for (const [block, pattern] of Object.entries(blockLabels)) {
    const supplied = trip.itineraryDays.filter((day) => (day as any)[block] !== null).length;
    const shown = (final.match(pattern) || []).length;
    if (shown !== supplied) issues.push(`${block} blocks rendered ${shown} times for ${supplied} supplied non-null blocks.`);
  }

  // Questions: only the supplied intents, nothing appended.
  const prose = outsideCards.replace(/\|.*\|/g, ' ');
  const questions = (prose.match(/\?/g) || []).length;
  if (questions > trip.nextQuestions.length) issues.push(`Manager asked ${questions} questions; Trip supplied ${trip.nextQuestions.length} intents.`);
  if (trip.nextQuestions.length && questions === 0) issues.push('Manager dropped the supplied question intent.');

  // Tables, sources, limitations.
  for (const table of trip.tables) {
    const header = final.split('\n').find((line) => /^\s*\|/.test(line) && table.columns.every((column) => line.includes(column)));
    if (!header) issues.push(`Table "${table.title ?? table.kind}" was not rendered with its columns.`);
    else if (header.split('|').filter((cell) => cell.trim()).length !== table.columns.length) issues.push(`Table "${table.title ?? table.kind}" column count changed.`);
  }
  if (expect.budgetTable && !trip.tables.some((table) => table.kind === 'budget')) issues.push('Budget patch returned no budget table.');
  for (const note of trip.notes.filter((item) => item.sourceName)) {
    const parts = note.sourceName!.toLowerCase().match(/\p{L}+/gu) || [];
    const key = parts.find((part) => part.length > 3 && !['official', 'site', 'website'].includes(part)) || parts[0] || '';
    if (!final.toLowerCase().includes(key)) issues.push(`Sourced note from "${note.sourceName}" was not attributed in the answer.`);
  }
  for (const limitation of trip.limitations) {
    const keys = limitation.toLowerCase().match(/[a-z]{6,}/g) || [];
    if (keys.length && !keys.some((key) => final.toLowerCase().includes(key))) issues.push(`Limitation not carried: "${limitation}"`);
  }

  // Word policy: narrative prose outside cards, day blocks and tables.
  const narrative = outsideCards.split('\n').filter((line) => !/^\s*(\||(?:🌅|☀️|🌙)|(?:#{1,4}\s*)?\*\*Day\s+\d+)/u.test(line)).join('\n');
  evidence.narrativeWords = words(narrative);
  evidence.wordsOutsideCards = words(outsideCards);
  // The app shows cards and photos; the Manager talks about the trip, never the machinery.
  const machinery = narrative.match(/\b(?:cards?|photos?|images?|pictures?|render\w*|format\w*|generat\w*|tools?|system|errors?|failures?|working again|retry)\b/gi);
  if (machinery) issues.push(`Manager prose mentions internal mechanics: ${[...new Set(machinery.map((word) => word.toLowerCase()))].join(', ')}.`);
  const conditional = narrative.match(/\b(?:once|if|when) you (?:tell|share|give|provide|let me know)\b|\btell me one thing\b/i);
  if (conditional) issues.push(`Manager made a conditional offer: "${conditional[0]}".`);
  // The recommendation and every note are findings the traveler should see.
  const lowered = narrative.toLowerCase();
  for (const finding of [...(trip.recommendation ? [{ kind: 'recommendation', text: trip.recommendation }] : []), ...trip.notes]) {
    const keys = finding.text.toLowerCase().match(/\p{L}{6,}/gu) || [];
    if (keys.length && !keys.some((key) => lowered.includes(key))) issues.push(`Trip ${finding.kind} dropped: "${finding.text.slice(0, 90)}"`);
  }
  if (evidence.narrativeWords > rules.maxBodyWords) issues.push(`Narrative prose ${evidence.narrativeWords} words exceeds maxBodyWords ${rules.maxBodyWords}.`);
  if (rules.maxTimeBlockWords) {
    for (const line of final.split('\n').filter((item) => /^\s*(?:🌅|☀️|🌙)/u.test(item))) {
      const count = words(line.replace(/^\s*\S+\s*\*\*\w+:\*\*/u, ''));
      if (count > rules.maxTimeBlockWords + 4) issues.push(`Time block has ${count} words (limit ${rules.maxTimeBlockWords}): ${line.trim().slice(0, 60)}`);
    }
  }
  if (/"(?:destinationCards|itineraryDays|formattingRules|nextQuestions)"|\b(?:formattingRules|trip_planner_agent|update_trip_planner|get_place_images|turn_plan|web_search)\b|\[\[render:/.test(final)) issues.push('Internal fields, tools or markers leaked into the answer.');
  const jargon = outsideCards.match(/\b(?:anchors?|patch(?:es|ed)?|phases?)\b/gi);
  if (jargon) issues.push(`Internal planning jargon reached the traveler: ${[...new Set(jargon.map((word) => word.toLowerCase()))].join(', ')}.`);
  return issues;
}

async function main() {
  if (process.env.RUN_MANAGER_TRIP_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
    throw new Error('Set RUN_MANAGER_TRIP_LIVE=1 with OPENAI_API_KEY for this paid check.');
  }
  const turnNumber = Number(arg('--turn'));
  if (!Number.isInteger(turnNumber) || turnNumber < 1 || turnNumber > TURNS.length) throw new Error(`--turn must be 1-${TURNS.length}.`);
  const directory = path.resolve(arg('--dir') || path.join('artifacts', `manager-trip-conversation-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, 'report.json');
  const storePath = path.join(directory, 'chats.json');
  const report: any = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : { directory, turns: [] };
  if (turnNumber > 1 && !report.turns[turnNumber - 2]) throw new Error(`Run turn ${turnNumber - 1} first.`);

  process.env.FLIGHT_AGENT_LOG_LEVEL = 'warn';
  const [{ createChatServer }, { JsonChatStore }, { ManagerAgent }, { TripPlannerManagerAgent },
    { getRequestState }, { getGlobalTraceProvider }, { getDefaultOpenAIClient, setDefaultOpenAIClient, OpenAIConversationsSession },
    { default: OpenAI }, { pinManagerLiveModels }] = await Promise.all([
    import('../../src/api/chat/server.js'), import('../../src/api/chat/store.js'),
    import('../../src/agents/manager-orchestrator/agent.js'), import('../../src/agents/trip-planner/agent.js'),
    import('../../src/shared/runtime/request-context.js'), import('@openai/agents'), import('@openai/agents-openai'),
    import('openai'), import('./manager-live-model-policy.js'),
  ]);
  pinManagerLiveModels();

  // Restore the state before this turn when it was already attempted.
  const before = path.join(directory, `chats.before-turn-${turnNumber}.json`);
  if (report.turns[turnNumber - 1]) {
    const previous = report.turns[turnNumber - 1];
    if (turnNumber === 1) {
      await rm(storePath, { force: true });
      delete report.chatId;
      delete report.conversationId;
    } else {
      await copyFile(before, storePath);
      const session = new OpenAIConversationsSession({ conversationId: report.conversationId });
      let items = await session.getItems();
      while (items.length > previous.remoteItemsBefore) { await session.popItem(); items = await session.getItems(); }
      console.log(JSON.stringify({ phase: 'rollback', turn: turnNumber, remoteItems: items.length }));
    }
    report.turns = report.turns.slice(0, turnNumber - 1);
  } else if (existsSync(storePath)) {
    await copyFile(storePath, before);
  }
  let remoteItemsBefore = 0;
  if (report.conversationId) {
    remoteItemsBefore = (await new OpenAIConversationsSession({ conversationId: report.conversationId }).getItems()).length;
  }

  const evidence = { manager: [] as Call[], trip: [] as Call[], rawTrip: [] as any[], rawManager: [] as string[], responses: [] as ResponseMetric[] };
  const track = (calls: Call[]) => ({
    start: (_context: unknown, tool: { name: string }, details: any) => {
      const raw = details.toolCall;
      calls.push({ callId: String(raw.callId || raw.id || ''), tool: tool.name, input: parseToolValue(raw.arguments), completed: false });
    },
    end: (_context: unknown, _tool: unknown, output: unknown, details: any) => {
      const raw = details.toolCall;
      const call = calls.find((entry) => entry.callId === String(raw.callId || raw.id || '') && !entry.completed);
      if (call) { call.output = parseToolValue(output); call.completed = true; }
    },
  });
  const managerCalls = track(evidence.manager);
  const tripCalls = track(evidence.trip);
  ManagerAgent.on('agent_tool_start', managerCalls.start);
  ManagerAgent.on('agent_tool_end', managerCalls.end);
  ManagerAgent.on('agent_end', (_context, output) => { evidence.rawManager.push(String(output)); });
  TripPlannerManagerAgent.on('agent_tool_start', tripCalls.start);
  TripPlannerManagerAgent.on('agent_tool_end', tripCalls.end);
  TripPlannerManagerAgent.on('agent_end', (context, output) => {
    evidence.rawTrip.push({ output: parseToolValue(output),
      planningBrief: structuredClone(getRequestState(context.context as any).tripPlanner?.planningBrief?.responseStrategy || null) });
  });

  const configured = getDefaultOpenAIClient();
  const configuredFetch = configured ? Reflect.get(configured, 'fetch') : undefined;
  const originalFetch: typeof fetch = typeof configuredFetch === 'function' ? configuredFetch : globalThis.fetch;
  const reads: Promise<unknown>[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let metric: ResponseMetric | null = null;
    if (url.pathname.endsWith('/responses') && method === 'POST') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '{}');
      const instructions = String(body.instructions || '');
      const agent = instructions.includes('# Trip Planning Intelligence') ? 'trip' : instructions.includes('travel Manager') ? 'manager' : 'other';
      metric = {
        agent, model: body.model, effort: body.reasoning?.effort,
        tools: (body.tools || []).map((tool: any) => tool.name || tool.type),
        inputItems: Array.isArray(body.input) ? body.input.length : 1,
        ...(agent === 'trip' ? { tripContext: {
          turn_clock: tag(instructions, 'turn_clock'), trip_state: tag(instructions, 'trip_state'),
          turn_plan: tag(instructions, 'turn_plan'), manager_formatting_rules: tag(instructions, 'manager_formatting_rules'),
        } } : {}),
        ...(agent === 'manager' ? { managerState: instructions.match(/# Current Trusted Routing State[\s\S]*$/)?.[0] ?? null } : {}),
      };
      evidence.responses.push(metric);
      console.log(JSON.stringify({ phase: 'responses.started', agent, model: body.model, tools: metric.tools }));
    }
    const response = await originalFetch(input, init);
    if (metric) {
      metric.httpStatus = response.status;
      reads.push(response.clone().json().then((body: any) => {
        metric!.output = (body.output || []).map((item: any) => item.type === 'message'
          ? { type: 'message', text: item.content?.map((part: any) => part.text).join('') }
          : item.type === 'reasoning' ? { type: 'reasoning' }
          : { type: item.type, name: item.name, arguments: item.arguments, status: item.status, action: item.action });
        metric!.webSearches = (body.output || []).filter((item: any) => item.type === 'web_search_call')
          .map((item: any) => ({ status: item.status, query: item.action?.query ?? null, action: item.action ?? null }));
        metric!.usage = body.usage;
      }).catch(() => undefined));
    }
    return response;
  };
  setDefaultOpenAIClient(configured?.withOptions({ maxRetries: 0, fetch: observedFetch }) ?? new OpenAI({ maxRetries: 0, fetch: observedFetch }));

  const store = await new JsonChatStore({ filePath: storePath }).init();
  const server = createChatServer({ store });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const scenario = TURNS[turnNumber - 1];
  const item: any = { turn: turnNumber, user: scenario.user, intent: scenario.intent, expect: scenario.expect, remoteItemsBefore, startedAt: new Date().toISOString() };
  try {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(report.chatId ? { chatId: report.chatId } : {}), message: scenario.user, timeZone: 'Asia/Kolkata' }),
      signal: AbortSignal.timeout(300_000),
    });
    const events = parseEvents(await response.text());
    await Promise.all(reads);
    const done = events.find((event) => event.event === 'done')?.data;
    report.chatId ||= events.find((event) => event.event === 'chat.created')?.data?.chatId;
    report.conversationId ||= events.find((event) => event.event === 'conversation.ready')?.data?.conversationId;
    const saved = store.getChat(report.chatId);
    const tripOutput = evidence.manager.find((call) => call.tool === 'trip_planner_agent')?.output;
    const parsed = tripPlannerManagerOutputSchema.safeParse(tripOutput);
    const trip = parsed.success ? parsed.data : null;
    const final = String(done?.finalText || '');
    const webSearches = evidence.responses.filter((metric) => metric.agent === 'trip').flatMap((metric) => metric.webSearches || []);
    const tripSequence = evidence.trip.map((call) => call.tool);
    const issues: string[] = [];
    if (response.status !== 200 || events.some((event) => event.event === 'error') || !done) issues.push(`HTTP/SSE turn failed: ${JSON.stringify(events.find((event) => event.event === 'error')?.data || response.status)}`);
    if (JSON.stringify(evidence.manager.map((call) => call.tool)) !== JSON.stringify(['trip_planner_agent'])) issues.push(`Manager tools: [${evidence.manager.map((call) => call.tool)}], expected one trip_planner_agent call.`);
    if (tripSequence[0] !== 'update_trip_planner_context' || tripSequence.at(-1) !== 'update_trip_planner_suggested_questions') issues.push(`Trip tool order: [${tripSequence}].`);
    if (evidence.responses.some((metric) => metric.tools?.includes('validate_trip_date')) || tripSequence.includes('validate_trip_date')) issues.push('The removed date tool is still offered or called.');
    if (scenario.expect.webSearch !== webSearches.length > 0) issues.push(`web_search used ${webSearches.length} times; expected ${scenario.expect.webSearch ? 'research' : 'none'}.`);
    const imageCalls = tripSequence.filter((tool) => tool === 'get_place_images_batch').length;
    if (imageCalls !== scenario.expect.imageCalls) issues.push(`Image tool called ${imageCalls} times, expected ${scenario.expect.imageCalls}.`);
    if (scenario.expect.contextDetails && !tripSequence.includes('get_trip_planner_context_details')) issues.push('Saved plan details were not retrieved for a day patch.');
    if (trip?.mode === 'compact_patch' && trip.itineraryDays.length && !tripSequence.includes('get_trip_planner_context_details')) issues.push('Trip changed saved days without reading the saved plan.');
    const tripJargon = JSON.stringify([trip?.itineraryDays, trip?.recommendation, trip?.notes]).match(/\b(?:anchors?|patch(?:es|ed)?)\b/gi);
    if (tripJargon) issues.push(`Trip facts (saved to the plan) use internal jargon: ${[...new Set(tripJargon.map((word) => word.toLowerCase()))].join(', ')}.`);
    const metaBlock = trip?.itineraryDays.flatMap((day) => [day.morning, day.afternoon, day.evening]).find((block) => block && /\bkeep (?:the rest|your)\b[^.]*\bsame\b/i.test(block));
    if (metaBlock) issues.push(`A changed block is a note, not a plan: "${metaBlock.slice(0, 80)}"`);
    const subtask = String(evidence.manager.find((call) => call.tool === 'trip_planner_agent')?.input?.input || '');
    const subtaskScope = findTripPlannerScopeViolations(subtask);
    if (subtaskScope.length) issues.push(`Manager's Trip subtask names excluded topics (${subtaskScope.join(', ')}).`);
    const contractEvidence: any = {};
    issues.push(...contractIssues(trip, final, scenario.expect, contractEvidence));
    const firstTurnFinal = turnNumber === 1 ? final
      : JSON.parse(await readFile(path.join(directory, 'turn-1.json'), 'utf8')).finalText || '';
    issues.push(...persistedIssues(turnNumber, saved?.runtimeContext?.summaryContext, saved?.runtimeContext?.tripPlanner, firstTurnFinal));
    Object.assign(item, {
      requestId: events.find((event) => event.event === 'turn.started')?.data?.requestId,
      traceId: events.find((event) => event.event === 'turn.started')?.data?.traceId,
      managerCalls: evidence.manager, tripCalls: evidence.trip, webSearches,
      tripTurnPlans: evidence.responses.filter((metric) => metric.agent === 'trip').map((metric) => metric.tripContext),
      managerRoutingState: evidence.responses.find((metric) => metric.agent === 'manager')?.managerState ?? null,
      rawTripOutputs: evidence.rawTrip, sanitizedTripOutput: tripOutput, rawManagerOutputs: evidence.rawManager,
      finalText: final, ...contractEvidence,
      persisted: { summaryContext: saved?.runtimeContext?.summaryContext,
        tripPlanner: { askedQuestionKeys: saved?.runtimeContext?.tripPlanner?.askedQuestionKeys,
          imageCodes: Object.keys(saved?.runtimeContext?.tripPlanner?.placeImageCache || {}),
          dateHint: saved?.runtimeContext?.tripPlanner?.dateHint ?? null,
          lastPlanArtifact: saved?.runtimeContext?.tripPlanner?.lastPlanArtifact ?? null } },
      responses: evidence.responses.map(({ tripContext: _context, managerState: _state, ...metric }) => metric),
      usage: evidence.responses.reduce((sum, metric) => ({
        input: sum.input + Number(metric.usage?.input_tokens || 0), output: sum.output + Number(metric.usage?.output_tokens || 0),
      }), { input: 0, output: 0 }),
      issues, completedAt: new Date().toISOString(),
    });
  } catch (error) {
    item.issues = [`Run failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`];
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
    await getGlobalTraceProvider().forceFlush();
  }
  report.turns[turnNumber - 1] = { turn: turnNumber, remoteItemsBefore, issues: item.issues, usage: item.usage, traceId: item.traceId };
  await writeFile(path.join(directory, `turn-${turnNumber}.json`), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  await writeFile(path.join(directory, `turn-${turnNumber}.md`), renderMarkdown(item), 'utf8');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ phase: 'turn.done', turn: turnNumber, directory, issues: item.issues, usage: item.usage }, null, 2));
  if (item.issues.length) process.exitCode = 1;
}

function renderMarkdown(item: any): string {
  const block = (value: unknown) => `\`\`\`\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n\`\`\``;
  const lines = [
    `# Turn ${item.turn}`, '', `**User:** ${item.user}`, '', `**Intent:** ${item.intent}`, '',
    `## Manager routing`, '', ...(item.managerCalls || []).map((call: Call) => `- \`${call.tool}\` subtask: ${call.input?.input ?? JSON.stringify(call.input)}`), '',
    `## Trip phases (turn_clock / turn_plan per model call)`, '',
    ...(item.tripTurnPlans || []).map((plan: any, index: number) => `### Trip call ${index + 1}\n${block([plan?.turn_clock, plan?.trip_state, plan?.turn_plan].filter(Boolean).join('\n'))}`), '',
    `## Trip tools`, '', ...(item.tripCalls || []).map((call: Call) => `- \`${call.tool}\` input ${JSON.stringify(call.input)} -> ${JSON.stringify(call.output?.status ?? call.output)?.slice(0, 160)}`),
    ...(item.webSearches || []).map((search: any) => `- \`web_search\` (${search.status}) query: ${search.query ?? JSON.stringify(search.action)}`), '',
    `## Trip feedback (sanitized, as the Manager received it)`, '', block(item.sanitizedTripOutput), '',
    ...(item.rawTripOutputs || []).filter((raw: any) => JSON.stringify(raw.output) !== JSON.stringify({ ...item.sanitizedTripOutput, formattingRules: undefined }))
      .map((raw: any) => `### Raw Trip output before the sanitizer\n${block(raw.output)}\n`),
    `## Manager final answer`, '', item.finalText ?? '', '',
    `## Checks`, '', ...(item.issues?.length ? item.issues.map((issue: string) => `- ❌ ${issue}`) : ['- ✅ No contract issues detected.']), '',
    `Narrative words: ${item.narrativeWords ?? '?'}; words outside cards: ${item.wordsOutsideCards ?? '?'}; tokens in/out: ${item.usage?.input ?? '?'}/${item.usage?.output ?? '?'}; trace: ${item.traceId ?? '?'}`, '',
    `## Persisted context`, '', block(item.persisted), '',
  ];
  return `${lines.join('\n')}\n`;
}

await main();
