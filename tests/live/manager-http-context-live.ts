/**
 * Paid four-turn HTTP/SSE replay of the actual Manager chat application.
 * Run one conversation only, then inspect the retained evidence:
 *   $env:RUN_MANAGER_FLIGHT_LIVE='1'; npx tsx tests/live/manager-http-context-live.ts
 * Offline parser/grader checks (no server, model imports, or API calls):
 *   npx tsx tests/live/manager-http-context-live.ts --dry-run
 *
 * OpenAI models and Conversations are live. Flight inventory,
 * filtering/contracts, prediction repository, and Trip image URLs remain the
 * application's current dummy/local implementations; this is not live airfare QA.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { StoredChat } from '../../src/api/chat/types.js';
import { comparableToolSequence, parseToolValue, type ObservedFlightToolCall } from './manager-flight-evidence.js';

type Event = { event: string; data: any };
type Calls = {
  manager: ObservedFlightToolCall[];
  flight: ObservedFlightToolCall[];
  trip: ObservedFlightToolCall[];
  lifecycle: Array<{ agent: string; event: 'start' | 'end'; at: string }>;
};
type ResponseMetric = {
  model: string; effort: string; requestId: string | null; agent: string | null;
  startedAt: string; endedAt: string | null; elapsedMs: number | null;
  monotonicElapsedMs: number | null; status: number | null; error: string | null;
  apiRequestId: string | null; providerProcessingMs: number | null;
};
const TIME_ZONE = 'Asia/Calcutta';
const USERS = [
  'Find one-way flights from Delhi to New York tomorrow for one adult in economy.',
  'Show me cheaper ones.',
  'Same date, but fly to London Heathrow Airport (LHR) instead.',
  'Plan a three-day sightseeing trip in London using those dates.',
];
const BACKEND_BOUNDARY = {
  live: ['OpenAI Responses (gpt-5.2/low)', 'OpenAI Conversations session/history',
    'Manager and nested specialists', 'Specialist-owned context', 'HTTP/SSE', 'JSON chat persistence/reload'],
  localOrDummy: ['Flight inventory', 'Flight filtering/contracts',
    'ClickHouse prediction placeholder (no rows)', 'Trip image URLs'],
  notTested: ['Browser DOM interaction', 'Real airline fares/availability', 'Successful production price prediction'],
};

function parseEvents(raw: string): Event[] {
  // Only complete frames: a client timeout may leave an unfinished JSON frame.
  return raw.replace(/\r\n/g, '\n').split('\n\n').slice(0, -1).flatMap((block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1];
    if (!event) return [];
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    return [{ event, data: data ? JSON.parse(data) : null }];
  });
}

function tomorrowFromStartedAt(startedAt: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(startedAt)).filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1))
    .toISOString().slice(0, 10);
}

function searchCore(chat: StoredChat | null): string {
  const flight: any = chat?.runtimeContext.flight || {};
  return JSON.stringify({ segments: flight.segments, tripType: flight.tripType,
    outboundDate: flight.outboundDate, inboundDate: flight.inboundDate,
    passengerData: flight.passengerData, cabinClass: flight.cabinClass,
    resolvedOrigin: flight.resolvedOrigin, resolvedDestination: flight.resolvedDestination });
}

function cheaperIntentIssues(calls: ObservedFlightToolCall[], feedback: any, finalText = ''): string[] {
  const issues: string[] = [];
  const reads = calls.filter((call) => call.tool === 'getGeneratedContractsContext');
  if (new Set(reads.map((call) => JSON.stringify([call.input?.mode, call.input?.indexes]))).size !== reads.length) {
    issues.push('cheaper-ones follow-up duplicated an unchanged current-contract read');
  }
  if (calls.some((call) => ['flight_search', 'price_prediction_tool', 'apply_filter'].includes(call.tool))) {
    issues.push('cheaper-ones follow-up unnecessarily searched, predicted, or mutated filters');
  }
  if (calls.some((call) => call.tool === 'getGeneratedContractsContext'
    && (call.input?.mode !== 'read' || call.input?.indexes !== null))) {
    issues.push('open-ended cheaper-ones ranking selected indexes or changed current card visibility');
  }
  const sortClaim = /\b(?:sorted|reordered|rearranged)\b.{0,60}\b(?:cards|results|flights|options)\b|\b(?:cards|results|flights|options)\b.{0,40}\b(?:are|were|now|been)\b.{0,20}\b(?:sorted|reordered|rearranged)\b/i;
  if (sortClaim.test(`${JSON.stringify(feedback || {})} ${finalText}`)) {
    issues.push('read-only ranking claimed the displayed cards/results were sorted');
  }
  const clarification = feedback?.status === 'needs_input' && Array.isArray(feedback.missingInformation)
    && feedback.missingInformation.length > 0;
  if (clarification && calls.some((call) => call.tool !== 'update_flight_suggested_questions')) {
    issues.push('genuine cheaper-ones clarification performed unnecessary core-tool work');
  }
  if (!clarification && !calls.some((call) => call.tool === 'getGeneratedContractsContext' && call.input?.mode === 'read')) {
    issues.push('cheaper-ones follow-up neither read current contracts nor returned a genuine clarification');
  }
  if (clarification && feedback.missingInformation.some((question: string) =>
    /\b(?:departure|origin|destination|passenger|cabin|class)\b/i.test(question)
    || /\b(?:which|what|provide|confirm|travel)\s+(?:date|day)\b/i.test(question))) {
    issues.push('cheaper-ones clarification re-asked established search details');
  }
  if (clarification && !feedback.missingInformation.some((question: string) =>
    /\b(?:cheap|cheaper|price|budget|current|date|day)\b/i.test(question))) {
    issues.push('cheaper-ones clarification did not address the actual price/date ambiguity');
  }
  return issues;
}

function safeError(error: unknown): string {
  return `${(error as Error)?.name || 'Error'}: ${String((error as Error)?.message || error)}`
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
}

async function main(): Promise<void> {
  if (process.argv.includes('--dry-run')) {
    assert.deepEqual(parseEvents(': heartbeat\r\n\r\nid: 1\r\nevent: done\r\ndata: {"summaryStatus":"skipped"}\r\n\r\n'),
      [{ event: 'done', data: { summaryStatus: 'skipped' } }]);
    assert.equal(tomorrowFromStartedAt('2026-10-07T20:00:00.000Z'), '2026-10-09');
    assert.deepEqual(cheaperIntentIssues([{ callId: 'read', tool: 'getGeneratedContractsContext', input: { mode: 'read', indexes: null }, completed: true }],
      { status: 'success', missingInformation: [] }), []);
    const read: ObservedFlightToolCall = { callId: 'read', tool: 'getGeneratedContractsContext', input: { mode: 'read', indexes: null }, completed: true };
    assert.ok(cheaperIntentIssues([read, { ...read, callId: 'select', input: { mode: 'select', indexes: [3, 2, 1] } }], {}).length > 0);
    assert.ok(cheaperIntentIssues([read, { ...read, callId: 'duplicate-read' }], {}).length > 0);
    assert.ok(cheaperIntentIssues([read, { ...read, callId: 'show-all', input: { mode: 'show_all', indexes: null } }], {}).length > 0);
    assert.ok(cheaperIntentIssues([{ ...read, input: { mode: 'read', indexes: [1] } }], {}).length > 0);
    assert.ok(cheaperIntentIssues([read], {}, 'Sorted the current results by lowest price.').length > 0);
    assert.deepEqual(cheaperIntentIssues([read], {}, 'The cheapest current option is option 3.'), []);
    assert.deepEqual(cheaperIntentIssues([], { status: 'needs_input',
      missingInformation: ['Do you mean cheaper current options or cheaper dates?'] }), []);
    assert.ok(cheaperIntentIssues([{ callId: 'search', tool: 'flight_search', input: {}, completed: true }],
      { status: 'success' }).length > 0);
    assert.ok(cheaperIntentIssues([], { status: 'needs_input', missingInformation: ['What is your origin?'] }).length > 0);
    assert.deepEqual(parseEvents('event: done\ndata: {"incomplete":'), []);
    console.log(JSON.stringify({ offlineChecks: 'passed', apiCalls: 0, users: USERS,
      models: 'gpt-5.2', reasoning: 'low', backendBoundary: BACKEND_BOUNDARY }));
    return;
  }
  if (process.env.RUN_MANAGER_FLIGHT_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
    throw new Error('Live execution requires RUN_MANAGER_FLIGHT_LIVE=1 and the existing OPENAI_API_KEY.');
  }
  process.env.ORCHESTRATION_MODE = 'manager';
  process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
  delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

  const originalFetch = globalThis.fetch;
  const apiCalls: ResponseMetric[] = [];
  const conversationRequests: Array<{ method: string; path: string }> = [];
  const traceExportStatuses: number[] = [];
  let activeRequestId = '';
  let activeAgent: string | null = null;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input?.url || String(input));
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    let metric: ResponseMetric | null = null;
    const startedMs = Date.now();
    const monotonicStart = performance.now();
    if (url.pathname.endsWith('/responses') && method === 'POST') {
      const body = typeof init?.body === 'string' ? init.body : await input.clone().text();
      const request = JSON.parse(body);
      if (request.model !== 'gpt-5.2' || request.reasoning?.effort !== 'low') {
        throw new Error('HTTP live replay permits only gpt-5.2 with low reasoning for every model.');
      }
      metric = { model: request.model, effort: request.reasoning.effort,
        requestId: activeRequestId || null, agent: activeAgent,
        startedAt: new Date(startedMs).toISOString(), endedAt: null, elapsedMs: null,
        monotonicElapsedMs: null, status: null, error: null, apiRequestId: null, providerProcessingMs: null };
      apiCalls.push(metric);
      console.log(JSON.stringify({ phase: 'responses.started', ...metric }));
    }
    if (/\/conversations(?:\/|$)/.test(url.pathname)) {
      conversationRequests.push({ method, path: url.pathname });
    }
    try {
      const response = await originalFetch(input, init);
      if (metric) {
        metric.status = response.status;
        metric.apiRequestId = response.headers.get('x-request-id');
        const processing = response.headers.get('openai-processing-ms');
        metric.providerProcessingMs = processing && Number.isFinite(Number(processing)) ? Number(processing) : null;
      }
      if (url.pathname.includes('/traces/ingest')) traceExportStatuses.push(response.status);
      return response;
    } catch (error) {
      if (metric) metric.error = safeError(error);
      throw error;
    } finally {
      if (metric) {
        metric.endedAt = new Date().toISOString();
        metric.elapsedMs = Date.now() - startedMs;
        metric.monotonicElapsedMs = Math.round(performance.now() - monotonicStart);
        console.log(JSON.stringify({ phase: 'responses.finished', ...metric }));
      }
    }
  }) as typeof fetch;

  const [{ createChatServer, publicChat }, { JsonChatStore }, { ManagerAgent }, { FlightManagerAgent },
    { TripPlannerManagerAgent }, { getRequestState }, { getGlobalTraceProvider }] = await Promise.all([
    import('../../src/api/chat/server.js'), import('../../src/api/chat/store.js'),
    import('../../src/agents/manager-orchestrator/agent.js'), import('../../src/agents/flight/agent.js'),
    import('../../src/agents/trip-planner/agent.js'),
    import('../../src/shared/runtime/request-context.js'), import('@openai/agents'),
  ]);
  for (const agent of [ManagerAgent, FlightManagerAgent, TripPlannerManagerAgent]) {
    agent.model = 'gpt-5.2';
    agent.modelSettings = { ...agent.modelSettings, reasoning: { effort: 'low' } };
  }
  const evidence = new Map<string, Calls>();
  function callsFor(requestId: string): Calls {
    const calls = evidence.get(requestId) || { manager: [], flight: [], trip: [], lifecycle: [] };
    evidence.set(requestId, calls);
    return calls;
  }
  ManagerAgent.on('agent_start', (context) => {
    activeRequestId = String((getRequestState(context.context as any) as any).requestId || '');
    activeAgent = ManagerAgent.name;
    callsFor(activeRequestId).lifecycle.push({ agent: ManagerAgent.name, event: 'start', at: new Date().toISOString() });
    console.log(JSON.stringify({ phase: 'manager.started', requestId: activeRequestId }));
  });
  ManagerAgent.on('agent_end', () => {
    callsFor(activeRequestId).lifecycle.push({ agent: ManagerAgent.name, event: 'end', at: new Date().toISOString() });
    activeAgent = null;
  });
  for (const [agent, kind] of [[ManagerAgent, 'manager'], [FlightManagerAgent, 'flight'],
    [TripPlannerManagerAgent, 'trip']] as const) {
    if (kind !== 'manager') {
      agent.on('agent_start', (context) => {
        activeAgent = agent.name;
        const requestId = String((getRequestState(context.context as any) as any).requestId || '');
        callsFor(requestId).lifecycle.push({ agent: agent.name, event: 'start', at: new Date().toISOString() });
      });
      agent.on('agent_end', (context) => {
        const requestId = String((getRequestState(context.context as any) as any).requestId || '');
        callsFor(requestId).lifecycle.push({ agent: agent.name, event: 'end', at: new Date().toISOString() });
        activeAgent = ManagerAgent.name;
      });
    }
    agent.on('agent_tool_start', (context, tool, details) => {
      const requestId = String((getRequestState(context.context as any) as any).requestId || '');
      const raw = details.toolCall as any;
      callsFor(requestId)[kind].push({ callId: String(raw.callId || raw.id || ''), tool: tool.name,
        input: parseToolValue(raw.arguments), completed: false });
    });
    agent.on('agent_tool_end', (context, _tool, output, details) => {
      const requestId = String((getRequestState(context.context as any) as any).requestId || '');
      const raw = details.toolCall as any;
      const call = callsFor(requestId)[kind].find((entry) => entry.callId === String(raw.callId || raw.id || '') && !entry.completed);
      if (call) { call.output = parseToolValue(output); call.completed = true; }
    });
  }

  await mkdir(path.resolve('artifacts'), { recursive: true });
  const directory = await mkdtemp(path.resolve('artifacts/manager-http-context-'));
  const storePath = path.join(directory, 'chats.json');
  const reportPath = path.join(directory, 'report.json');
  const store = await new JsonChatStore({ filePath: storePath }).init();
  const server = createChatServer({ store }); // Default real runTurn and session implementations.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const report: any = { models: 'gpt-5.2', reasoning: 'low', timeZone: TIME_ZONE,
    backendBoundary: BACKEND_BOUNDARY, storePath, reportPath, turns: [], apiCalls,
    conversationRequests, traceExportStatuses };
  let chatId: string | null = null;
  let conversationId: string | null = null;
  let previous: StoredChat | null = null;
  let expectedOutbound = '';
  let pendingTurn: any = null;
  let pendingRaw = '';
  const persist = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ phase: 'http.replay.started', reportPath, storePath, backendBoundary: BACKEND_BOUNDARY }));
  try {
    for (const [index, user] of USERS.entries()) {
      activeRequestId = '';
      activeAgent = null;
      const conversationRequestOffset = conversationRequests.length;
      pendingRaw = '';
      pendingTurn = { turn: index + 1, user, clientStartedAt: new Date().toISOString(),
        conversationRequestOffset, apiCallOffset: apiCalls.length, sseEvents: [],
        ssePath: path.join(directory, `turn-${index + 1}.sse`), classification: 'running' };
      report.activeTurn = pendingTurn;
      await persist();
      const response = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(chatId ? { chatId } : {}), message: user, timeZone: TIME_ZONE }),
        signal: AbortSignal.timeout(300_000),
      });
      pendingTurn.httpStatus = response.status;
      pendingTurn.headersReceivedAt = new Date().toISOString();
      if (!response.body) throw new Error('HTTP response had no readable SSE body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pendingRaw += decoder.decode(chunk.value, { stream: true });
        pendingTurn.sseEvents = parseEvents(pendingRaw);
        const started = pendingTurn.sseEvents.find((event: Event) => event.event === 'turn.started')?.data;
        const ready = pendingTurn.sseEvents.find((event: Event) => event.event === 'conversation.ready')?.data;
        chatId ||= ready?.chatId || pendingTurn.sseEvents.find((event: Event) => event.event === 'chat.created')?.data?.chatId || null;
        conversationId ||= ready?.conversationId || null;
        pendingTurn.requestId = started?.requestId || activeRequestId || null;
        pendingTurn.traceId = started?.traceId || null;
        pendingTurn.calls = callsFor(pendingTurn.requestId || '');
        await writeFile(pendingTurn.ssePath, pendingRaw, 'utf8');
        await persist();
      }
      pendingRaw += decoder.decode();
      const raw = pendingRaw;
      const events = parseEvents(raw);
      await writeFile(path.join(directory, `turn-${index + 1}.sse`), raw, 'utf8');
      const started = events.find((event) => event.event === 'turn.started')?.data;
      const ready = events.find((event) => event.event === 'conversation.ready')?.data;
      const done = events.find((event) => event.event === 'done')?.data;
      chatId ||= ready?.chatId || events.find((event) => event.event === 'chat.created')?.data?.chatId || null;
      conversationId ||= ready?.conversationId || null;
      const calls = callsFor(String(started?.requestId || activeRequestId));
      const remoteHistoryCalls = conversationRequests.slice(conversationRequestOffset);
      let saved: StoredChat | null = null;
      if (chatId) {
        const getResponse = await fetch(`${baseUrl}/api/chats/${chatId}`);
        if (getResponse.ok) saved = (await getResponse.json() as any).chat;
      }
      const issues: string[] = [];
      const acceptableDeviations: string[] = [];
      const currentTurn = saved?.turns.find((turn) => turn.id === started?.turnId);
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/event-stream')) {
        issues.push(`expected HTTP 200 SSE; got ${response.status}`);
      }
      if (events.some((event) => event.event === 'error')) issues.push('SSE emitted a terminal error');
      if (events.filter((event) => event.event === 'done').length !== 1) issues.push('SSE did not emit exactly one done event');
      if (events.at(-1)?.event !== 'done') issues.push('SSE terminal event was not done');
      if (events.some((event) => event.event === 'summary.started')) issues.push('removed Summary workflow emitted summary.started');
      if (done?.summaryStatus !== 'skipped' || currentTurn?.summaryStatus !== 'skipped') issues.push('removed Summary workflow was not skipped');
      if (apiCalls.some((call) => call.requestId === started?.requestId && !call.agent)) issues.push('unexpected model call outside Manager/specialist lifecycle');
      if (currentTurn?.status !== 'completed') issues.push('persisted HTTP turn did not complete');
      if (!ready?.conversationId || ready.conversationId !== conversationId || saved?.conversationId !== conversationId
        || done?.conversationId !== conversationId) issues.push('conversation ID was absent or changed');
      if (!remoteHistoryCalls.some((call) => call.method === 'GET' && call.path.endsWith(`/conversations/${conversationId}/items`))) {
        issues.push('Manager did not retrieve actual remote conversation history for this turn');
      }
      if (remoteHistoryCalls.some((call) => {
        const remoteId = call.path.match(/\/conversations\/([^/]+)/)?.[1];
        return remoteId && remoteId !== conversationId;
      })) issues.push('HTTP turn used a different remote conversation');
      if (!done?.finalText?.trim() || done.finalAgent !== 'Manager Agent') issues.push('missing Manager final text');
      if (events.filter((event) => event.event === 'delta').map((event) => event.data.text).join('') !== done?.finalText) {
        issues.push('SSE deltas did not equal final Manager text');
      }
      if (/\[\[render:|\[\[render_ref:|^\s*\{\s*"status"\s*:|\b(?:flight_agent|trip_planner_agent|flight_search|apply_filter|searchKey)\b/m.test(done?.finalText || '')) {
        issues.push('render markers or internal specialist/tool payload leaked into user text');
      }
      if (!saved || saved.messages.length !== (index + 1) * 2 || saved.turns.length !== index + 1
        || saved.messages.at(-1)?.content !== done?.finalText) issues.push('GET chat did not restore complete saved transcript');
      if (saved && JSON.stringify(saved.summaryContext) !== JSON.stringify(done?.summaryContext)) issues.push('GET summary differs from SSE summary');
      if (saved && JSON.stringify(saved.runtimeContext.flight) !== JSON.stringify(done?.flightContext)) issues.push('GET Flight state differs from SSE Flight state');
      // A newly opened store proves disk persistence rather than only an in-memory GET.
      const reloaded = (await new JsonChatStore({ filePath: storePath }).init()).getChat(chatId || '');
      if (!reloaded || JSON.stringify(publicChat(reloaded)) !== JSON.stringify(saved)) {
        issues.push('fresh JSON store public projection differs from HTTP GET snapshot');
      }
      if (JSON.stringify(reloaded) !== JSON.stringify(store.getChat(chatId || ''))) {
        issues.push('fresh JSON store differs from full live-store snapshot');
      }
      if ([...calls.manager, ...calls.flight, ...calls.trip].some((call) => !call.completed)) issues.push('native tool started without completing');
      const delegates = calls.manager.map((call) => call.tool);
      const expectedDelegate = index === 3 ? 'trip_planner_agent' : 'flight_agent';
      if (JSON.stringify(delegates) !== JSON.stringify([expectedDelegate])) issues.push(`expected only ${expectedDelegate}; got ${delegates.join(', ')}`);
      const flightSequence = comparableToolSequence(calls.flight);
      if (index < 3 && flightSequence.at(-1) !== 'update_flight_suggested_questions') issues.push('Flight suggestions were not last');
      const flight: any = saved?.runtimeContext.flight || {};
      const specialistContext: any = saved?.runtimeContext.summaryContext;
      const searchKey = flight.searchKey || null;
      const previousKey = previous?.runtimeContext.flight.searchKey || null;
      const search = calls.flight.find((call) => call.tool === 'flight_search');
      if (index === 0) expectedOutbound = currentTurn?.startedAt ? tomorrowFromStartedAt(currentTurn.startedAt) : '';
      if (index === 0 || index === 2) {
        if (JSON.stringify(flightSequence) !== JSON.stringify(['flight_search', 'update_flight_suggested_questions'])) {
          issues.push(`expected clean search -> suggestions; got ${flightSequence.join(' -> ')}`);
        }
        if (!searchKey || searchKey === previousKey) issues.push('new route search did not create a new search key');
        const input = search?.input;
        if (input?.trip_type !== 'oneway' || input?.cabin_class !== 'economy' || input?.passengers?.adults !== 1
          || input?.passengers?.children !== 0 || input?.passengers?.infants !== 0) issues.push('search lost known trip type/passenger/cabin');
        if (input?.onds?.length !== 1 || input?.onds?.[0]?.origin !== 'Delhi') issues.push('search lost clean Delhi origin');
        if (input?.onds?.[0]?.outbound_date !== expectedOutbound || input?.onds?.[0]?.return_date !== null) issues.push('search did not preserve resolved tomorrow');
        if (saved?.runtimeContext.flightSearchRuntime?.appliedFilters?.length) issues.push('clean search retained unsolicited filters');
        if (index === 0 && !['New York', 'New York City'].includes(input?.onds?.[0]?.destination)) issues.push('initial search lost clean New York destination');
        if (index === 2 && (input?.onds?.[0]?.destination !== 'London' || input?.onds?.[0]?.destination_iata !== 'LHR'
          || !['London Heathrow Airport', 'London Heathrow'].includes(input?.onds?.[0]?.destination_airport_name))) {
          issues.push('London search did not separate city, IATA, and airport name');
        }
      }
      if (index === 1) {
        const feedback = calls.manager[0]?.output;
        issues.push(...cheaperIntentIssues(calls.flight, feedback, done?.finalText || ''));
        if (searchKey !== previousKey || searchCore(saved) !== searchCore(previous)) issues.push('cheaper-ones turn lost original search context');
        const visibility = (chat: StoredChat | null) => JSON.stringify(
          (Array.isArray(chat?.runtimeContext.flight.searchResults) ? chat.runtimeContext.flight.searchResults : [])
            .map((contract: any) => ({ id: contract.id, display: contract.display })));
        if (visibility(saved) !== visibility(previous)) issues.push('cheaper-ones ranking changed current card visibility');
        if (JSON.stringify(saved?.runtimeContext.flightSearchRuntime?.appliedFilters) !==
          JSON.stringify(previous?.runtimeContext.flightSearchRuntime?.appliedFilters)) issues.push('cheaper-ones turn changed filters');
        if (feedback?.status === 'needs_input' && issues.length === 0) {
          acceptableDeviations.push('Cheaper ones was treated as genuine current-price versus flexible-date ambiguity; no search/filter mutation was made.');
        }
      }
      if (flight.resolvedOrigin?.userCity !== 'Delhi' || flight.outboundDate !== expectedOutbound || flight.passengerData?.adults !== 1) {
        issues.push('persisted Flight context lost known origin/date/passenger');
      }
      if (index < 2 && !['New York', 'New York City'].includes(flight.resolvedDestination?.userCity || '')) issues.push('Flight context lost New York destination');
      if (index >= 2 && flight.resolvedDestination?.userCity !== 'London') issues.push('Flight context lost updated London destination');
      if (index === 3) {
        const tripOutput = calls.manager[0]?.output;
        const plan: any = saved?.runtimeContext.tripPlanner.lastPlanArtifact;
        if (calls.flight.length || searchKey !== previousKey || searchCore(saved) !== searchCore(previous)) issues.push('Trip-only turn unnecessarily changed Flight search');
        if (!plan?.id || !plan.content || plan.destination?.city !== 'London') issues.push('Trip output was not persisted as a London plan artifact');
        if (specialistContext?.duration_days !== 3 || specialistContext?.destination?.city !== 'London'
          || specialistContext?.origin?.city !== 'Delhi' || specialistContext?.outbound_date !== expectedOutbound
          || specialistContext?.pax !== 1) issues.push('specialist-owned Trip context lost duration or known flight facts');
        if (tripOutput?.status !== 'success' || tripOutput?.mode !== 'compact_full') issues.push('Trip did not return successful full-plan facts');
        if (![1, 2, 3].every((day) => tripOutput?.itineraryDays?.some((entry: any) => entry.day === day)
          && new RegExp(`\\bDay\\s*${day}\\b`, 'i').test(done?.finalText || ''))) issues.push('Trip facts or Manager markdown omitted requested itinerary days');
      }
      const item = { turn: index + 1, user, expectedOutbound, requestId: started?.requestId,
        traceId: started?.traceId, conversationId: ready?.conversationId, calls,
        clientStartedAt: pendingTurn.clientStartedAt, clientCompletedAt: new Date().toISOString(),
        remoteHistoryCalls, sseEvents: events, persisted: saved, issues, acceptableDeviations,
        classification: issues.length ? 'unexpected_failure' : 'stable' };
      report.turns.push(item);
      pendingTurn = null;
      delete report.activeTurn;
      previous = saved;
      await persist();
      console.log(JSON.stringify({ phase: 'turn.checked', turn: item.turn, classification: item.classification,
        issues, acceptableDeviations, flightTools: flightSequence, delegates, traceId: item.traceId }));
      if (issues.length) break; // Never pay for subsequent turns after an unexpected failure.
    }
  } catch (error) {
    report.error = safeError(error);
    if (pendingTurn) {
      pendingTurn.sseEvents = parseEvents(pendingRaw);
      pendingTurn.requestId ||= activeRequestId || null;
      pendingTurn.calls = callsFor(pendingTurn.requestId || '');
      pendingTurn.remoteHistoryCalls = conversationRequests.slice(pendingTurn.conversationRequestOffset);
      pendingTurn.persistedAtClientFailure = store.getChat(chatId || '');
      pendingTurn.error = report.error;
      pendingTurn.clientFailedAt = new Date().toISOString();
      pendingTurn.classification = 'unexpected_failure';
      pendingTurn.issues = ['HTTP/SSE request failed before a verified terminal outcome'];
      await writeFile(pendingTurn.ssePath, pendingRaw, 'utf8');
      report.turns.push(pendingTurn);
      delete report.activeTurn;
      await persist();
    }
    process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
    if (pendingTurn) pendingTurn.persistedAfterServerSettled = store.getChat(chatId || '');
    await getGlobalTraceProvider().forceFlush();
    report.completedConversation = report.turns.length === USERS.length && report.turns.every((turn: any) => turn.classification === 'stable');
    report.chatId = chatId;
    report.conversationId = conversationId;
    report.chatStoreRetained = true;
    await persist();
    globalThis.fetch = originalFetch;
    if (!report.completedConversation) process.exitCode = 1;
    console.log(JSON.stringify({ summary: true, completedConversation: report.completedConversation,
      turns: report.turns.length, apiCalls: apiCalls.length, traceExportStatuses, reportPath, storePath,
      error: report.error || null, backendBoundary: BACKEND_BOUNDARY }));
  }
}

await main();
