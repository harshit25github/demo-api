/**
 * Paid, staged Manager -> native Trip Planner HTTP conversation.
 * Discovery only: RUN_MANAGER_TRIP_LIVE=1 npx tsx tests/live/manager-trip-discovery-live.ts
 * Continue the same saved chat after inspecting/fixing discovery:
 *   npx tsx tests/live/manager-trip-discovery-live.ts --followups <report-directory>
 * Offline parser/grader checks: npx tsx tests/live/manager-trip-discovery-live.ts --dry-run
 * Images are current dummy URLs; browser rendering is deliberately outside this check.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoredChat } from '../../src/api/chat/types.js';
import { tripPlannerFeedbackSchema, tripPlannerManagerOutputSchema, type TripPlannerManagerOutput } from '../../src/agents/trip-planner/manager-output.js';
import { parseToolValue, type ObservedFlightToolCall } from './manager-flight-evidence.js';

const USERS = [
  'My partner and I want a relaxed four-day food-and-history break from Delhi in November 2026. We are considering Paris, Rome, and Tokyo but have not chosen a destination. Show photos of all three and help us pick. Our budget is US$1,200 total for food and activities; we do not need flight or hotel bookings.',
  'Let us choose the second one. November 12-15, 2026. Keep the same budget and relaxed food-and-history vibe. Give me the four-day plan.',
  "Make day 2 lighter: keep its morning activity, drop the afternoon stop, and verify the morning place's current opening hours. Leave everything else alone.",
];
type SseEvent = { event: string; data: any };
type Evidence = {
  manager: ObservedFlightToolCall[]; trip: ObservedFlightToolCall[]; flight: ObservedFlightToolCall[];
  rawTrip: TripPlannerManagerOutput[]; rawManager: string[];
  sharedAtManagerEnd?: any;
};

function parseEvents(raw: string): SseEvent[] {
  return raw.replace(/\r\n/g, '\n').split('\n\n').slice(0, -1).flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1];
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    return event ? [{ event, data: data ? JSON.parse(data) : null }] : [];
  });
}

function cards(text: string): string[] {
  return text.match(/\[CARD\][\s\S]*?\[\/CARD\]/g) || [];
}
function cardBlock(text: string): string[] {
  return text.match(/:::cards\s*\n[\s\S]*?\n:::cards/g) || [];
}
function dayNumbers(text: string): number[] {
  return [...text.matchAll(/^\s*(?:#{1,3}\s*)?(?:\*\*)?Day\s+(\d+)\b/gim)]
    .map((match) => Number(match[1]));
}
function urls(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>\])]+/g) || [];
}
function structuredPresentationIssues(trip: TripPlannerManagerOutput, final: string, count: number): string[] {
  const issues: string[] = [];
  const rendered = cards(final);
  if (trip.destinationCards.length !== count || rendered.length !== count) issues.push(`expected ${count} destination facts and rendered native cards`);
  if (count && cardBlock(final).length !== 1) issues.push('expected one paired native card block');
  for (const [index, card] of rendered.entries()) {
    const keys = card.split('\n').flatMap((line) => line.match(/^\s*(title|image|known_for|weather|budget):/)?.[1] || []);
    if (JSON.stringify(keys) !== JSON.stringify(['title', 'image', 'known_for', 'weather', 'budget'])) issues.push('native card field order/shape changed');
    const expected = trip.destinationCards[index];
    if (card.match(/^title:\s*(.+)$/m)?.[1]?.trim() !== expected?.title) issues.push('Manager changed destination title/display order');
    if (card.match(/^image:\s*(.+)$/m)?.[1]?.trim() !== (expected?.imageUrl || 'Photo unavailable')) issues.push('Manager changed card image asset');
  }
  const expectedUrls = trip.destinationCards.flatMap((card) => card.imageUrl ? [card.imageUrl] : []);
  if (JSON.stringify(urls(final).sort()) !== JSON.stringify(expectedUrls.sort())) issues.push('Manager added, removed, or duplicated image URLs');
  const outside = final.replace(/:::cards\s*\n[\s\S]*?\n:::cards/g, '');
  if (urls(outside).length || /!\[[^\]]*\]\(/.test(final)) issues.push('image URLs escaped native image fields');
  if (JSON.stringify(dayNumbers(final)) !== JSON.stringify(trip.itineraryDays.map((day) => day.day))) issues.push('Manager omitted, duplicated, or invented itinerary days');
  if (/"(?:destinationCards|itineraryDays|formattingRules)"\s*:/.test(final)) issues.push('internal structured Trip feedback leaked into final answer');
  return issues;
}

function checkTurn(index: number, item: any, previous: StoredChat | null, first: any): string[] {
  const issues: string[] = [];
  const { calls, persisted: saved, finalText: final, events } = item;
  const tripResult = tripPlannerManagerOutputSchema.safeParse(calls.manager.find((call: ObservedFlightToolCall) => call.tool === 'trip_planner_agent')?.output);
  const trip = tripResult.success ? tripResult.data : null;
  const state: any = saved?.runtimeContext.tripPlanner || {};
  const plan = state.lastPlanArtifact;
  const summary = saved?.runtimeContext.summaryContext;
  if (item.httpStatus !== 200 || events.some((event: SseEvent) => event.event === 'error')
    || events.filter((event: SseEvent) => event.event === 'done').length !== 1) issues.push('HTTP/SSE did not complete cleanly once');
  const done = events.find((event: SseEvent) => event.event === 'done')?.data;
  if (done?.finalAgent !== 'Manager Agent' || done?.summaryStatus !== 'skipped'
    || saved?.turns?.at(-1)?.summaryStatus !== 'skipped') issues.push('native Manager flow did not complete with extraction skipped');
  if (events.some((event: SseEvent) => event.event === 'summary.started')
    || item.responses.some((response: any) => response.agent === 'Summary Extractor Agent' || !response.agent)) issues.push('removed Summary workflow ran unexpectedly');
  if (JSON.stringify(calls.manager.map((call: ObservedFlightToolCall) => call.tool)) !== JSON.stringify(['trip_planner_agent'])
    || calls.flight.length) issues.push('expected one native Trip delegation and no Flight calls');
  if ([...calls.manager, ...calls.trip].some((call: ObservedFlightToolCall) => !call.completed)) issues.push('a native tool call did not finish');
  const sequence = calls.trip.map((call: ObservedFlightToolCall) => call.tool);
  if (sequence[0] !== 'update_trip_planner_context' || sequence.at(-1) !== 'update_trip_planner_suggested_questions') issues.push('Trip context capture/suggestion sequencing changed');
  if (!item.diskReloadMatches) issues.push('disk-reloaded context differs from persisted HTTP context');
  if (!saved || saved.messages.length !== (index + 1) * 2 || saved.turns.length !== index + 1
    || saved.messages.at(-1)?.content !== final) issues.push('saved transcript missing or duplicated a turn');
  if (!item.conversationId || saved?.conversationId !== item.conversationId
    || (previous && previous.conversationId !== item.conversationId)) issues.push('remote session/conversation was not preserved');
  if (!item.remoteHistoryCalls.some((entry: any) => entry.method === 'GET' && entry.path.endsWith(`/conversations/${item.conversationId}/items`))) issues.push('Manager did not load remote conversation history');
  if (/\[\[render:|\b(?:trip_planner_agent|flight_agent|update_trip_planner_context)\b/.test(final)) issues.push('internal markers/tools leaked to user text');
  if (!trip) issues.push('Trip did not return schema-valid structured facts');
  else {
    issues.push(...structuredPresentationIssues(trip, final, index === 0 ? 3 : index === 1 ? 1 : 0));
    if (trip.mode !== (index === 0 ? 'discovery_cards' : index === 1 ? 'compact_full' : 'compact_patch')) issues.push('Trip used the wrong structured response mode');
    if (trip.status !== 'success') issues.push(`Trip did not fulfill the request: ${trip.status}; ${trip.limitations.join('; ')}`);
    if (calls.rawTrip.length !== 1 || !tripPlannerFeedbackSchema.safeParse(calls.rawTrip[0]).success) issues.push('native specialist final output was not one structured result');
  }
  if (summary?.origin.city !== 'Delhi' || summary?.duration_days !== 4 || summary?.pax !== 2
    || (summary?.budget.total ?? summary?.budget.amount) !== 1200 || summary?.budget.currency !== 'USD') issues.push('persisted known trip preferences were lost');
  if (!/relax/i.test(JSON.stringify(summary?.tripType)) || !/food|culinar/i.test(JSON.stringify(summary?.tripType))
    || !/histor|cultur/i.test(JSON.stringify(summary?.tripType))) issues.push('relaxed food/history preferences were not persisted');
  const imageCalls = calls.trip.filter((call: ObservedFlightToolCall) => call.tool === 'get_place_images_batch');
  if (index === 0) {
    if (trip?.itineraryDays.length || dayNumbers(final).length) issues.push('discovery expanded into unrequested itineraries');
    if ((final.match(/\?/g) || []).length !== 1) issues.push('discovery did not retain exactly one interactive selection question');
    if (imageCalls.length !== 1 || JSON.stringify([...imageCalls[0].input.itemCodes].sort()) !== JSON.stringify(['PAR', 'ROM', 'TYO'])) issues.push('expected one image batch for the three requested cities');
    const toolUrls = imageCalls.flatMap((call: ObservedFlightToolCall) => call.output?.images?.map((image: any) => image.imageUrl) || []);
    if (trip?.destinationCards.some((card) => !card.imageUrl || !toolUrls.includes(card.imageUrl))) issues.push('Trip omitted or invented an image asset');
    const toolImages = imageCalls[0]?.output?.images || [];
    if (trip?.destinationCards.some((card) => !toolImages.some((image: any) => image.itemCode === card.itemCode && image.imageUrl === card.imageUrl))) issues.push('Trip destination item codes did not match actual image assets');
    if (calls.rawManager.some((raw: string) => urls(raw).some((url) => !toolUrls.includes(url)))) issues.push('raw Manager output invented URLs before sanitization');
    const scoped = String(calls.manager[0]?.input?.input || '');
    if (/\bat least (?:two|2)\s+(?:photos|images)|\b(?:two|2)\s+(?:photos|images)\s+per/i.test(scoped)) issues.push('Manager imposed an unrequested image quota');
    const titles = trip?.destinationCards.map((card) => card.title.split(',')[0].trim()) || [];
    if (JSON.stringify([...titles].sort()) !== JSON.stringify(['Paris', 'Rome', 'Tokyo'])) issues.push('discovery did not preserve the requested three destinations');
    if (summary?.destination.city) issues.push('discovery prematurely confirmed a destination');
    if (sequence.includes('get_trip_planner_context_details')) issues.push('discovery unnecessarily read saved private records');
    if (Object.keys(state.placeImageCache || {}).length !== 3) issues.push('three images were not cached');
    if (trip?.nextQuestions.length !== 1 || !/destination/i.test(trip.nextQuestions[0].key)) issues.push('Trip discovery omitted the destination-selection intent');
  } else {
    const firstTrip = tripPlannerManagerOutputSchema.parse(first.calls.manager[0]?.output);
    const second = cards(first.finalText)[1]?.match(/^title:\s*(.+)$/m)?.[1]?.split(',')[0].trim();
    if (summary?.destination.city !== second || plan?.destination?.city !== second) issues.push('ordinal selection lost actual displayed second destination');
    if (summary?.outbound_date !== '2026-11-12' || summary?.return_date !== '2026-11-15') issues.push('confirmed dates were not retained');
    if (imageCalls.length) issues.push('cached images were unnecessarily requested again');
    const oldCache: any = previous?.runtimeContext.tripPlanner?.placeImageCache || {};
    const currentCache: any = state.placeImageCache || {};
    if (index === 1) {
      const selectedUrl = firstTrip.destinationCards[1]?.imageUrl;
      const selectedCode = Object.keys(oldCache).find((code) => oldCache[code]?.imageUrl === selectedUrl);
      if (!selectedCode || JSON.stringify(currentCache[selectedCode]) !== JSON.stringify(oldCache[selectedCode])
        || Object.keys(currentCache).some((code) => code !== selectedCode)) issues.push('destination selection failed to reuse the selected image or retain only compatible cached assets');
    } else if (JSON.stringify(currentCache) !== JSON.stringify(oldCache)) issues.push('day-only revision changed cached image assets');
    if (JSON.stringify(plan?.days?.map((day: any) => day.day)) !== JSON.stringify([1, 2, 3, 4])) issues.push('saved four-day artifact lost days');
    if (index === 1) {
      if (JSON.stringify(trip?.itineraryDays.map((day) => day.day)) !== JSON.stringify([1, 2, 3, 4])
        || trip?.itineraryDays.some((day) => !day.morning || !day.afternoon || !day.evening)) issues.push('requested complete four-day facts were not delivered');
      if (plan?.responseMode !== 'compact_full') issues.push('four-day request did not use full-plan mode');
    } else {
      if (JSON.stringify(trip?.itineraryDays.map((day) => day.day)) !== JSON.stringify([2]) || plan?.responseMode !== 'compact_patch') issues.push('day-only revision regenerated unrelated days or used wrong mode');
      if (!calls.trip.some((call: ObservedFlightToolCall) => call.tool === 'get_trip_planner_context_details'
        && call.input?.sections?.includes('last_plan') && /day\s*2/i.test(call.input?.query || ''))) issues.push('day-only revision did not selectively retrieve saved day 2');
      if (!item.responses.some((response: any) => response.agent === 'Trip Planner Agent'
        && response.output?.some((entry: any) => entry.type === 'web_search_call'))) issues.push('current-hours request did not use hosted web search');
      const oldPlan: any = previous?.runtimeContext.tripPlanner?.lastPlanArtifact;
      for (const day of [1, 3, 4]) {
        if (JSON.stringify(plan?.days?.find((entry: any) => entry.day === day)) !== JSON.stringify(oldPlan?.days?.find((entry: any) => entry.day === day))) issues.push(`saved unchanged day ${day} was overwritten`);
      }
      if (JSON.stringify(plan?.days?.find((entry: any) => entry.day === 2)) === JSON.stringify(oldPlan?.days?.find((entry: any) => entry.day === 2))) issues.push('day 2 was not revised');
      const oldDay = oldPlan?.days?.find((entry: any) => entry.day === 2);
      const patchedDay = plan?.days?.find((entry: any) => entry.day === 2);
      const patch = trip?.itineraryDays.find((day) => day.day === 2);
      if (patch?.morning === null && oldDay?.morning && patchedDay?.morning !== oldDay.morning) issues.push('saved unchanged morning activity was lost');
      if (patch?.evening !== null || (oldDay?.evening && patchedDay?.evening !== oldDay.evening)) issues.push('day 2 revision changed the unrequested evening');
      if (!patch?.afternoon || !/free|rest|relax|unscheduled|open|leisure/i.test(patch.afternoon)) issues.push('afternoon stop was not replaced with lighter free time');
      const hourFacts = trip?.notes.filter((note) => note.kind === 'fact' && note.sourceName
        && /hour|open|clos|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(note.text)) || [];
      item.researchedHourFacts = hourFacts;
      if (!hourFacts.length) issues.push('current-hours result lacked researched facts with a named source');
    }
  }
  return [...new Set(issues)];
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    assert.deepEqual(parseEvents('event: done\r\ndata: {"ok":true}\r\n\r\n'), [{ event: 'done', data: { ok: true } }]);
    assert.deepEqual(parseEvents('event: done\ndata: {"incomplete":'), []);
    const block = ':::cards\n[CARD]\ntitle: Rome, Italy\nimage: https://images.example.test/rome.jpg\nknown_for: History\nweather: Mild\nbudget: Moderate\n[/CARD]\n:::cards';
    const facts = { destinationCards: [{ itemCode: 'ROM', title: 'Rome, Italy', imageUrl: 'https://images.example.test/rome.jpg' }], itineraryDays: [] } as TripPlannerManagerOutput;
    assert.deepEqual(structuredPresentationIssues(facts, `Happy to help!\n${block}\nWhich city?`, 1), []);
    assert.ok(structuredPresentationIssues(facts, 'Rome: https://invented.test/photo.jpg', 1).length);
    assert.ok(structuredPresentationIssues(facts, `${block}\n**Day 1 - Invented plan**`, 1).length);
    assert.deepEqual(dayNumbers('## Day 1 - First\nMorning\n**Day 2 - Second**'), [1, 2]);
    console.log(JSON.stringify({ offlineChecks: 'passed', apiCalls: 0 }));
    return;
  }
  if (process.env.RUN_MANAGER_TRIP_LIVE !== '1' || !process.env.OPENAI_API_KEY) throw new Error('Set RUN_MANAGER_TRIP_LIVE=1 and reuse the existing OPENAI_API_KEY for this paid check.');
  process.env.ORCHESTRATION_MODE = 'manager';
  process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
  delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
  const followupArg = process.argv.indexOf('--followups');
  if (followupArg >= 0 && !process.argv[followupArg + 1]) throw new Error('--followups requires the previously checked report directory.');
  const directory = followupArg >= 0 ? path.resolve(process.argv[followupArg + 1]) : await mkdtemp(path.join(tmpdir(), 'manager-trip-discovery-'));
  const reportPath = path.join(directory, 'report.json');
  const storePath = path.join(directory, 'chats.json');
  const report: any = followupArg >= 0 ? JSON.parse(await readFile(reportPath, 'utf8')) : {
    model: 'gpt-5.2', reasoning: 'low', reportPath, storePath, turns: [], responses: [], conversationRequests: [],
    boundaries: { live: ['Responses', 'Conversations session', 'Manager native Trip asTool', 'Specialist-owned context', 'HTTP/SSE', 'JSON persistence'], dummy: ['Trip image URLs'], notTested: ['Browser rendering', 'Real image loading'] },
  };
  if (followupArg >= 0 && (report.turns.length !== 1 || report.turns[0]?.classification !== 'stable')) throw new Error('Followups require exactly one stable discovery turn; inspect/fix the current report before continuing.');
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const [{ createChatServer, publicChat }, { JsonChatStore }, { ManagerAgent }, { FlightManagerAgent },
    { TripPlannerManagerAgent }, { getRequestState }, { getGlobalTraceProvider },
    { getDefaultOpenAIClient, setDefaultOpenAIClient }, { default: OpenAI }, { pinManagerLiveModels }] = await Promise.all([
    import('../../src/api/chat/server.js'), import('../../src/api/chat/store.js'), import('../../src/agents/manager-orchestrator/agent.js'),
    import('../../src/agents/flight/agent.js'), import('../../src/agents/trip-planner/agent.js'),
    import('../../src/shared/runtime/request-context.js'), import('@openai/agents'), import('@openai/agents-openai'), import('openai'), import('./manager-live-model-policy.js'),
  ]);
  pinManagerLiveModels();
  const evidence = new Map<string, Evidence>();
  let activeRequestId = '';
  let activeAgent: string | null = null;
  const callsFor = (id: string): Evidence => {
    let item = evidence.get(id);
    if (!item) { item = { manager: [], trip: [], flight: [], rawTrip: [], rawManager: [] }; evidence.set(id, item); }
    return item;
  };
  for (const [agent, kind] of [[ManagerAgent, 'manager'], [TripPlannerManagerAgent, 'trip'], [FlightManagerAgent, 'flight']] as const) {
    agent.on('agent_start', (context) => {
      activeRequestId = String(getRequestState(context.context as any).requestId || '');
      activeAgent = agent.name;
    });
    agent.on('agent_end', (context, output) => {
      const requestId = String(getRequestState(context.context as any).requestId || '');
      const calls = callsFor(requestId);
      if (kind === 'trip') calls.rawTrip.push(parseToolValue(output));
      if (kind === 'manager') {
        calls.rawManager.push(String(output));
        const state = getRequestState(context.context as any);
        calls.sharedAtManagerEnd = structuredClone({ tripPlanner: state.tripPlanner, summaryContext: state.summaryContext });
      }
      activeAgent = kind === 'manager' ? null : ManagerAgent.name;
    });
    agent.on('agent_tool_start', (context, tool, details) => {
      const raw: any = details.toolCall;
      callsFor(String(getRequestState(context.context as any).requestId || ''))[kind].push({
        callId: String(raw.callId || raw.id || ''), tool: tool.name, input: parseToolValue(raw.arguments), completed: false,
      });
    });
    agent.on('agent_tool_end', (context, _tool, output, details) => {
      const raw: any = details.toolCall;
      const call = callsFor(String(getRequestState(context.context as any).requestId || ''))[kind]
        .find((entry) => entry.callId === String(raw.callId || raw.id || '') && !entry.completed);
      if (call) { call.output = parseToolValue(output); call.completed = true; }
    });
  }
  const configured = getDefaultOpenAIClient();
  const configuredFetch = configured ? Reflect.get(configured, 'fetch') : undefined;
  const originalFetch: typeof fetch = typeof configuredFetch === 'function' ? configuredFetch : globalThis.fetch;
  const responseReads: Promise<unknown>[] = [];
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (/\/conversations(?:\/|$)/.test(url.pathname)) report.conversationRequests.push({ method, path: url.pathname });
    let metric: any = null;
    if (url.pathname.endsWith('/responses') && method === 'POST') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '');
      assert.equal(body.model, 'gpt-5.2', 'Only GPT-5.2 is allowed');
      assert.equal(body.reasoning?.effort, 'low', 'Only low reasoning is allowed');
      metric = { requestId: activeRequestId, agent: activeAgent, startedAt: new Date().toISOString(), model: body.model, effort: body.reasoning.effort,
        tools: body.tools?.map((tool: any) => tool.name || tool.type),
        tripPhase: body.instructions?.match(/<turn_plan>\s*phase=(context_capture|planning)/)?.[1] || null };
      report.responses.push(metric);
      console.log(JSON.stringify({ phase: 'responses.started', ...metric }));
    }
    try {
      const response = await originalFetch(input, init);
      if (metric) {
        metric.httpStatus = response.status;
        metric.apiRequestId = response.headers.get('x-request-id');
        // Retain only response evidence, never request headers, credentials, or system prompts.
        responseReads.push(response.clone().json().then((body: any) => {
          metric.responseId = body.id; metric.output = body.output; metric.usage = body.usage;
          metric.completedAt = new Date().toISOString();
        }).catch((error) => { metric.bodyReadError = error instanceof Error ? error.name : 'UnknownError'; }));
      }
      return response;
    } catch (error) {
      if (metric) metric.errorName = error instanceof Error ? error.name : 'UnknownError';
      throw error;
    }
  };
  setDefaultOpenAIClient(configured?.withOptions({ maxRetries: 0, fetch: observedFetch }) ?? new OpenAI({ maxRetries: 0, fetch: observedFetch }));
  const store = await new JsonChatStore({ filePath: storePath }).init();
  const server = createChatServer({ store });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let chatId: string | null = report.chatId || null;
  let previous = chatId ? store.getChat(chatId) : null;
  console.log(JSON.stringify({ phase: 'trip.replay.started', phaseMode: followupArg >= 0 ? 'followups' : 'discovery', reportPath, storePath }));
  try {
    for (const index of followupArg >= 0 ? [1, 2] : [0]) {
      activeRequestId = '';
      activeAgent = null;
      const remoteOffset = report.conversationRequests.length;
      const responseOffset = report.responses.length;
      const item: any = { turn: index + 1, user: USERS[index], clientStartedAt: new Date().toISOString(), classification: 'running', events: [] };
      report.activeTurn = item;
      await persist();
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(chatId ? { chatId } : {}), message: USERS[index], timeZone: 'Asia/Calcutta' }),
        signal: AbortSignal.timeout(180_000),
      });
      item.httpStatus = response.status;
      const raw = await response.text();
      await writeFile(path.join(directory, `turn-${index + 1}.sse`), raw, 'utf8');
      item.events = parseEvents(raw);
      const started = item.events.find((event: SseEvent) => event.event === 'turn.started')?.data;
      const ready = item.events.find((event: SseEvent) => event.event === 'conversation.ready')?.data;
      const done = item.events.find((event: SseEvent) => event.event === 'done')?.data;
      chatId ||= ready?.chatId || item.events.find((event: SseEvent) => event.event === 'chat.created')?.data?.chatId;
      item.requestId = started?.requestId || activeRequestId;
      item.traceId = started?.traceId;
      item.conversationId = ready?.conversationId;
      item.finalText = done?.finalText || '';
      item.calls = callsFor(item.requestId);
      const saved = store.getChat(chatId || '');
      item.persisted = saved;
      const fresh = (await new JsonChatStore({ filePath: storePath }).init()).getChat(chatId || '');
      const getResponse = await fetch(`${baseUrl}/api/chats/${chatId}`);
      const publicSaved = getResponse.ok ? (await getResponse.json() as any).chat : null;
      item.diskReloadMatches = JSON.stringify(fresh) === JSON.stringify(saved)
        && JSON.stringify(saved && publicChat(saved)) === JSON.stringify(publicSaved);
      await Promise.all(responseReads);
      item.responses = report.responses.slice(responseOffset);
      item.remoteHistoryCalls = report.conversationRequests.slice(remoteOffset);
      item.issues = checkTurn(index, item, previous, report.turns[0]);
      item.acceptableDeviations = [];
      const trip = tripPlannerManagerOutputSchema.safeParse(item.calls.manager[0]?.output);
      const proseWords = item.finalText.replace(/:::cards\s*\n[\s\S]*?\n:::cards/g, '').trim().split(/\s+/).length;
      const proseLimit = trip.success ? trip.data.formattingRules.maxBodyWords : 90;
      if (proseWords > proseLimit) item.acceptableDeviations.push(`Manager prose ${proseWords} words vs ${proseLimit}-word target; recorded separately from critical presentation/state failures.`);
      item.proseWordsOutsideCards = proseWords;
      item.classification = item.issues.length ? 'unexpected_failure' : 'stable';
      item.clientCompletedAt = new Date().toISOString();
      report.turns.push(item);
      delete report.activeTurn;
      report.chatId = chatId;
      report.conversationId = saved?.conversationId;
      previous = saved;
      await persist();
      console.log(JSON.stringify({ phase: 'turn.checked', turn: item.turn, classification: item.classification,
        issues: item.issues, acceptableDeviations: item.acceptableDeviations, tripTools: item.calls.trip.map((call: ObservedFlightToolCall) => call.tool), traceId: item.traceId }));
      if (item.issues.length) { process.exitCode = 1; break; }
    }
  } catch (error) {
    report.error = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) };
    if (report.activeTurn) {
      report.activeTurn.calls = callsFor(activeRequestId);
      report.activeTurn.persisted = store.getChat(chatId || '');
      report.activeTurn.classification = 'unexpected_failure';
    }
    process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
    await Promise.all(responseReads);
    await getGlobalTraceProvider().forceFlush();
    report.discoveryStable = report.turns[0]?.classification === 'stable';
    report.completedConversation = report.turns.length === 3 && report.turns.every((item: any) => item.classification === 'stable');
    report.completedAt = new Date().toISOString();
    await persist();
    console.log(JSON.stringify({ summary: true, discoveryStable: report.discoveryStable, completedConversation: report.completedConversation,
      turns: report.turns.length, responses: report.responses.length, reportPath, storePath, error: report.error || null }));
  }
}

await main();
