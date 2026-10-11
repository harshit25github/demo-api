import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const { JsonChatStore } = await import('../../src/api/chat/store.js');
const {
  createEmptySummaryContext,
  hydrateGatewayContext,
} = await import('../../src/api/chat/context-hydration.js');
const { streamChatTurn: streamChatTurnDefinition } = await import('../../src/api/chat/orchestrator.js');
const { SseWriter: SseWriterDefinition } = await import('../../src/api/chat/sse.js');
const { createChatServer, publicChat } = await import('../../src/api/chat/server.js');

const streamChatTurn: any = streamChatTurnDefinition;
const SseWriter: any = SseWriterDefinition;

async function temporaryStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-chat-'));
  const filePath = path.join(directory, 'chats.json');
  const store = await new JsonChatStore({ filePath }).init();
  return {
    directory,
    filePath,
    store,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class TestResponse extends PassThrough {
  statusCode: number | null;
  headers: Record<string, string> | null;

  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  flushHeaders() {}
}

function parseEvents(raw) {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(':'))
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function completedSummary() {
  const summary = createEmptySummaryContext();
  summary.origin = { city: 'New York', iata: 'JFK' };
  summary.destination = { city: 'Delhi', iata: 'DEL' };
  summary.outbound_date = '2026-09-05';
  summary.tripType = ['oneway'];
  summary.passengerData.total = 2;
  return summary;
}

test('JSON store writes atomically, locks a chat, and recovers interrupted turns', async () => {
  const fixture = await temporaryStore();
  try {
    const chat = await fixture.store.createChat({ title: 'JFK to Delhi' });
    const release = fixture.store.acquireTurn(chat.chatId);
    assert.equal(typeof release, 'function');
    assert.equal(fixture.store.acquireTurn(chat.chatId), null);
    release();
    assert.equal(typeof fixture.store.acquireTurn(chat.chatId), 'function');

    await fixture.store.updateChat(chat.chatId, (record) => {
      record.turns.push({ id: 'turn-1', status: 'running', completedAt: null } as any);
    });

    const saved = JSON.parse(await readFile(fixture.filePath, 'utf8'));
    assert.equal(saved.chats[chat.chatId].turns[0].status, 'running');

    const restarted = await new JsonChatStore({ filePath: fixture.filePath }).init();
    assert.equal(restarted.getChat(chat.chatId).turns[0].status, 'interrupted');
  } finally {
    await fixture.cleanup();
  }
});

test('public chat projection omits usage while full JSON reload preserves it', async () => {
  const fixture = await temporaryStore();
  try {
    const chat = await fixture.store.createChat({ title: 'Usage projection' });
    await fixture.store.updateChat(chat.chatId, (record) => {
      record.turns.push({ id: 'turn-public-projection', status: 'completed',
        requestId: 'request-public-projection', traceId: 'trace-public-projection',
        lastResponseId: null, finalAgent: 'Manager Agent',
        startedAt: '2026-10-07T10:00:00.000Z', completedAt: '2026-10-07T10:00:01.000Z',
        error: null, usage: { totalTokens: 42 } } as any);
    });
    const fullSnapshot = fixture.store.getChat(chat.chatId);
    const diskReload = (await new JsonChatStore({ filePath: fixture.filePath }).init()).getChat(chat.chatId);
    const publicSnapshot = publicChat(fullSnapshot);
    assert.deepEqual(publicChat(diskReload), publicSnapshot);
    assert.deepEqual(diskReload, fullSnapshot);
    assert.equal(Object.hasOwn(publicSnapshot.turns[0], 'usage'), false);
    assert.deepEqual(fullSnapshot.turns[0].usage, { totalTokens: 42 });
    assert.notDeepEqual(diskReload, publicSnapshot);
  } finally {
    await fixture.cleanup();
  }
});

test('summary context hydrates only missing Flight fields and preserves active search state', () => {
  const summary = completedSummary();
  const empty = hydrateGatewayContext({}, summary);
  assert.equal(empty.flight.segments[0].origin, 'JFK');
  assert.equal(empty.flight.segments[0].destination, 'DEL');
  assert.equal(empty.flight.outboundDate, '2026-09-05');
  assert.equal(empty.flight.pax, 2);
  assert.equal(empty.summaryContext.pax, 2);

  const active = hydrateGatewayContext(
    {
      flight: {
        searchKey: 'search-live',
        tripType: 'roundtrip',
        outboundDate: '2026-10-01',
        segments: [
          { date: '2026-10-01', origin: 'LAX', destination: 'BOM' },
        ],
        passengerData: {
          total: 1,
          adults: 1,
          seniors: 0,
          children: 0,
          lapInfants: 0,
          seatInfants: 0,
          childrenAges: [],
        },
      },
    },
    summary,
  );
  assert.equal(active.flight.segments[0].origin, 'LAX');
  assert.equal(active.flight.segments[0].destination, 'BOM');
  assert.equal(active.flight.outboundDate, '2026-10-01');
  assert.equal(active.flight.tripType, 'roundtrip');
  assert.equal(active.flight.pax, 1);
});

test('saved runtime context preserves explicit clears instead of restoring frozen legacy summary fields', () => {
  const legacySummary = completedSummary();
  legacySummary.return_date = '2026-09-12';
  legacySummary.tripType = ['roundtrip'];
  const runtimeSummary = {
    pax: 3,
    origin: { city: null, iata: null },
    destination: { city: 'Paris', iata: null },
    outbound_date: null,
    return_date: null,
    duration_days: 5,
    budget: { amount: null, currency: null, per_person: null, total: null },
    tripType: ['relaxed', 'family'],
    placesOfInterest: [],
    upcomingEvents: [],
    suggestedQuestions: ['Would you like more museums?'],
  };
  const runtimeContext = {
    summaryContext: runtimeSummary,
    flight: {
      tripType: 'oneway',
      inboundDate: null,
      outboundDate: null,
      segments: [{ date: '', origin: '', destination: '', origin_iata: null, destination_iata: null }],
      resolvedOrigin: { userCity: null, airportIATA: null, airportName: null },
      resolvedDestination: { userCity: null, airportIATA: null, airportName: null },
    },
  };

  const hydrated = hydrateGatewayContext(runtimeContext as any, legacySummary);
  assert.deepEqual(hydrated.summaryContext, runtimeSummary);
  assert.notEqual(hydrated.summaryContext, runtimeSummary);
  assert.equal(hydrated.flight.tripType, 'oneway');
  assert.equal(hydrated.flight.inboundDate, '');
  assert.equal(hydrated.flight.outboundDate, null);
  assert.equal(hydrated.flight.segments[0].origin, '');
  assert.equal(hydrated.flight.segments[0].destination, '');
  assert.equal(hydrated.flight.resolvedOrigin.airportIATA, null);
  assert.equal(hydrated.flight.resolvedDestination.airportIATA, null);
});

test('active chat orchestration does not import or invoke the Summary Extractor', async () => {
  const source = await readFile(new URL('../../src/api/chat/orchestrator.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /extractSummaryContext|runSummary|agents\/summary|summary\.started/);
});

test('nonstream and streaming SSE turns emit final output and persist without Summary extraction', async () => {
  const fixture = await temporaryStore();
  try {
    const chat = await fixture.store.createChat({ title: 'Flights next weekend' });
    const releaseTurn = fixture.store.acquireTurn(chat.chatId);
    const response = new TestResponse();
    let raw = '';
    response.on('data', (chunk) => {
      raw += chunk.toString();
    });
    const writer = new SseWriter(response);
    writer.start();

    let sessionOptions = null;
    const managerStreamingModes: boolean[] = [];
    const createConversationSession = (options) => {
      sessionOptions = options;
      return { getSessionId: async () => 'conv_test_123' };
    };
    const runGateway = async ({ context, session, stream }) => {
      managerStreamingModes.push(stream);
      assert.equal(session.getSessionId instanceof Function, true);
      context.flight.searchKey = 'search_sse_visibility';
      context.flight.showFlight = true;
      context.flight.searchResults = [
        { id: 'contract-1', display: false },
        { id: 'contract-2', display: true },
      ];
      return {
        output: 'Authoritative final answer',
        finalAgentName: 'Manager Agent',
        context,
        lastResponseId: 'resp_test_123',
      };
    };
    await streamChatTurn({
      store: fixture.store,
      writer,
      response,
      chat,
      isNewChat: true,
      releaseTurn,
      message: 'Find JFK to Delhi next weekend',
      timeZone: 'Asia/Kolkata',
      createConversationSession,
      runGateway,
    });

    const events = parseEvents(raw);
    assert.deepEqual(
      events.map((item) => item.event),
      [
        'chat.created',
        'conversation.ready',
        'turn.started',
        'delta',
        'done',
      ],
    );
    assert.deepEqual(sessionOptions, { conversationId: undefined });
    // One delta carries the Manager's final answer; card data stays in context.
    assert.equal(events.filter((item) => item.event === 'delta').length, 1);
    assert.equal(
      events.find((item) => item.event === 'delta').data.text,
      'Authoritative final answer',
    );
    assert.equal(
      events.find((item) => item.event === 'done').data.finalText,
      'Authoritative final answer',
    );
    const done = events.find((item) => item.event === 'done').data;
    assert.equal(done.summaryStatus, 'skipped');
    assert.deepEqual(done.summaryContext, createEmptySummaryContext());
    assert.equal(Object.hasOwn(done, 'specialistsUsed'), false);
    assert.equal(Object.hasOwn(done, 'renderFlightOptions'), false);
    assert.equal(done.flightContext.showFlight, true);
    assert.deepEqual(
      events
        .find((item) => item.event === 'done')
        .data.flightContext.searchResults.map((contract) => contract.display),
      [false, true],
    );

    const stored = fixture.store.getChat(chat.chatId);
    assert.equal(stored.conversationId, 'conv_test_123');
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.messages[1].content, 'Authoritative final answer');
    assert.equal(Object.hasOwn(stored.messages[1], 'specialistsUsed'), false);
    assert.equal(Object.hasOwn(stored.messages[1], 'renderFlightOptions'), false);
    assert.deepEqual(stored.summaryContext, createEmptySummaryContext());
    assert.deepEqual(stored.messages[1].summaryContext, createEmptySummaryContext());
    assert.equal(stored.turns[0].status, 'completed');
    assert.equal(stored.turns[0].summaryStatus, 'skipped');
    assert.equal(stored.turns[0].lastResponseId, 'resp_test_123');
    assert.equal(Object.hasOwn(stored.turns[0], 'specialistsUsed'), false);
    assert.equal(Object.hasOwn(stored.turns[0], 'renderFlightOptions'), false);
    assert.equal(stored.runtimeContext.flight.showFlight, true);
    assert.deepEqual(
      (stored.runtimeContext.flight.searchResults as any[]).map(
        (contract) => contract.display,
      ),
      [false, true],
    );

    const secondResponse = new TestResponse();
    let secondRaw = '';
    secondResponse.on('data', (chunk) => { secondRaw += chunk.toString(); });
    const secondWriter = new SseWriter(secondResponse);
    secondWriter.start();
    const secondChat = fixture.store.getChat(chat.chatId);
    const secondRelease = fixture.store.acquireTurn(chat.chatId);
    await streamChatTurn({
      store: fixture.store,
      writer: secondWriter,
      response: secondResponse,
      chat: secondChat,
      isNewChat: false,
      releaseTurn: secondRelease,
      message: 'Make it two people',
      timeZone: 'Asia/Kolkata',
      createConversationSession,
      runGateway,
      stream: true,
    });
    assert.deepEqual(sessionOptions, { conversationId: 'conv_test_123' });
    assert.deepEqual(managerStreamingModes, [false, true]);
    const secondEvents = parseEvents(secondRaw);
    assert.deepEqual(secondEvents.map((item) => item.event), ['conversation.ready', 'turn.started', 'delta', 'done']);
    assert.equal(secondEvents.at(-1).data.summaryStatus, 'skipped');
    assert.deepEqual(secondEvents.at(-1).data.summaryContext, createEmptySummaryContext());
    const secondStored = fixture.store.getChat(chat.chatId);
    assert.equal(secondStored.messages.length, 4);
    assert.equal(secondStored.turns[1].status, 'completed');
    assert.equal(secondStored.turns[1].summaryStatus, 'skipped');
    assert.deepEqual(secondStored.summaryContext, createEmptySummaryContext());
  } finally {
    await fixture.cleanup();
  }
});

test('terminal Gateway stream failure emits SSE error and keeps the turn process-safe', async () => {
  const fixture = await temporaryStore();
  try {
    let chat = await fixture.store.createChat({ title: 'Timeout case' });
    const previousSummary = completedSummary();
    chat = await fixture.store.updateChat(chat.chatId, (record) => {
      record.summaryContext = structuredClone(previousSummary);
    });
    const releaseTurn = fixture.store.acquireTurn(chat.chatId);
    const response = new TestResponse();
    let raw = '';
    response.on('data', (chunk) => {
      raw += chunk.toString();
    });
    const writer = new SseWriter(response);
    writer.start();
    const timeoutError = Object.assign(new Error('Model call timed out after 20000ms.'), {
      name: 'ModelTimeoutError',
      code: 'ETIMEDOUT',
    });
    const runGateway = async ({ context, stream }) => {
      assert.equal(stream, true);
      context.summaryContext.tripType = ['family', 'relaxed'];
      context.summaryContext.budget.amount = null;
      context.flight.searchKey = 'search_before_failure';
      context.flight.showFlight = true;
      context.flight.searchResults = [{ id: 'completed-search-result', display: true }];
      throw timeoutError;
    };

    await streamChatTurn({
      store: fixture.store,
      writer,
      response,
      chat,
      isNewChat: true,
      releaseTurn,
      message: 'Flights next week',
      timeZone: 'Asia/Kolkata',
      createConversationSession: () => ({ getSessionId: async () => 'conv_timeout' }),
      runGateway,
      stream: true,
    });

    const events = parseEvents(raw);
    assert.deepEqual(
      events.map((item) => item.event),
      ['chat.created', 'conversation.ready', 'turn.started', 'error'],
    );
    assert.equal(events.at(-1).data.code, 'ETIMEDOUT');
    assert.equal(
      events.at(-1).data.message,
      'The request could not be completed. Please try again.',
    );
    const stored = fixture.store.getChat(chat.chatId);
    assert.equal(stored.turns[0].status, 'failed');
    assert.equal(stored.turns[0].summaryStatus, 'skipped');
    assert.deepEqual(stored.summaryContext, previousSummary);
    assert.deepEqual(stored.runtimeContext.summaryContext.tripType, ['family', 'relaxed']);
    assert.equal((stored.runtimeContext.summaryContext.budget as Record<string, unknown>).amount, null);
    assert.equal(stored.runtimeContext.flight.searchKey, 'search_before_failure');
    assert.deepEqual(stored.runtimeContext.flight.searchResults, [{ id: 'completed-search-result', display: true }]);
    assert.equal(stored.messages.length, 1);
    assert.equal(response.listenerCount('close'), 0);
    const nextRelease = fixture.store.acquireTurn(chat.chatId);
    assert.equal(typeof nextRelease, 'function');
    nextRelease();
  } finally {
    await fixture.cleanup();
  }
});

test('client cancellation skips Summary extraction and preserves completed specialist context', async () => {
  const fixture = await temporaryStore();
  try {
    let chat = await fixture.store.createChat({ title: 'Cancelled trip update' });
    const previousSummary = completedSummary();
    chat = await fixture.store.updateChat(chat.chatId, (record) => {
      record.summaryContext = structuredClone(previousSummary);
    });
    const response = new TestResponse();
    let raw = '';
    response.on('data', (chunk) => { raw += chunk.toString(); });
    const writer = new SseWriter(response);
    writer.start();

    await streamChatTurn({
      store: fixture.store,
      writer,
      response,
      chat,
      isNewChat: false,
      releaseTurn: fixture.store.acquireTurn(chat.chatId),
      message: 'Clear my budget limit',
      timeZone: 'Asia/Kolkata',
      createConversationSession: () => ({ getSessionId: async () => 'conv_cancelled' }),
      runGateway: async ({ context, signal }) => {
        context.summaryContext.budget = { amount: null, currency: null, per_person: null, total: null };
        context.summaryContext.suggestedQuestions = [];
        context.flight.suggestedQuestions = ['Would you like nonstop flights?'];
        response.emit('close');
        assert.equal(signal.aborted, true);
        throw Object.assign(new Error('Client closed the stream.'), { name: 'AbortError' });
      },
    });

    const events = parseEvents(raw);
    assert.deepEqual(events.map((item) => item.event), ['conversation.ready', 'turn.started', 'error']);
    assert.equal(events.at(-1).data.code, 'CLIENT_ABORTED');
    assert.equal(events.at(-1).data.message, 'The request was cancelled.');
    const stored = fixture.store.getChat(chat.chatId);
    assert.equal(stored.turns[0].status, 'aborted');
    assert.equal(stored.turns[0].summaryStatus, 'skipped');
    assert.deepEqual(stored.summaryContext, previousSummary);
    assert.deepEqual(stored.runtimeContext.summaryContext.budget, {
      amount: null, currency: null, per_person: null, total: null,
    });
    assert.deepEqual(stored.runtimeContext.flight.suggestedQuestions, ['Would you like nonstop flights?']);
    assert.equal(stored.messages.length, 1);
    assert.equal(response.listenerCount('close'), 0);
    const nextRelease = fixture.store.acquireTurn(chat.chatId);
    assert.equal(typeof nextRelease, 'function');
    nextRelease();
  } finally {
    await fixture.cleanup();
  }
});

test('HTTP API serves dashboard, creates chats over SSE, rejects unknown and busy chats', async () => {
  const fixture = await temporaryStore();
  const sdkStreamingModes: boolean[] = [];
  const runTurn = async ({ writer, response, chat, isNewChat, releaseTurn, stream = false }) => {
    sdkStreamingModes.push(stream);
    try {
      if (isNewChat) writer.send('chat.created', { chatId: chat.chatId });
      writer.send('conversation.ready', {
        chatId: chat.chatId,
        conversationId: 'conv_http_test',
      });
      writer.send('done', {
        chatId: chat.chatId,
        turnId: 'turn-http-test',
        conversationId: 'conv_http_test',
        finalAgent: 'Flight Agent',
        finalText: 'HTTP test response',
        summaryContext: createEmptySummaryContext(),
        summaryStatus: 'skipped',
      });
    } finally {
      releaseTurn();
      writer.close();
      response.end();
    }
  };
  const server = createChatServer({ store: fixture.store, runTurn });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true });

    const dashboard = await fetch(baseUrl);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Travel Console/);

    const flightContractsModule = await fetch(`${baseUrl}/flightContracts.js`);
    assert.equal(flightContractsModule.status, 200);
    assert.match(await flightContractsModule.text(), /getVisibleFlightContracts/);

    const dashboardScript = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
    assert.doesNotMatch(dashboardScript, /renderFlightOptions|isFlightAgent|shouldRenderFlightOptions/);
    assert.match(dashboardScript, /state\.flightContext = chat\.runtimeContext\?\.flight \|\| \{\}/);
    assert.match(dashboardScript, /renderFlightContracts\(latestAssistantMessage\.body, state\.flightContext\)/);
    assert.match(dashboardScript, /clearFlightContracts\(\);\s*renderFlightContracts\(draft\.body, state\.flightContext\)/);

    const streamResponse = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Flights next weekend', timeZone: 'Asia/Kolkata' }),
    });
    assert.equal(streamResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const streamEvents = parseEvents(await streamResponse.text());
    assert.deepEqual(
      streamEvents.map((item) => item.event),
      ['chat.created', 'conversation.ready', 'done'],
    );

    const chats = await fetch(`${baseUrl}/api/chats`).then((response) => response.json());
    assert.equal(chats.chats.length, 1);
    const chatId = chats.chats[0].chatId;
    for (const stream of [true, 'true']) {
      const optedIn = await fetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: 'Continue', stream }),
      });
      assert.equal(optedIn.status, 200);
      assert.equal(parseEvents(await optedIn.text()).at(-1).event, 'done');
    }
    assert.deepEqual(sdkStreamingModes, [false, true, false]);

    const unknown = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: '00000000-0000-4000-8000-000000000000',
        message: 'Continue',
      }),
    });
    assert.equal(unknown.status, 404);

    const releaseBusy = fixture.store.acquireTurn(chatId);
    const busy = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: 'Continue' }),
    });
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), { error: 'CHAT_BUSY' });
    releaseBusy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.cleanup();
  }
});

test('specialist-owned summary persists across disk reload and the next turn while legacy summary stays unchanged', async () => {
  const fixture = await temporaryStore();
  try {
    let chat = await fixture.store.createChat({ title: 'Existing Paris trip' });
    const previousSummary = completedSummary();
    previousSummary.return_date = '2026-09-12';
    previousSummary.budget = { amount: 1500, currency: 'USD', per_person: false, total: 1500 };
    chat = await fixture.store.updateChat(chat.chatId, (record) => {
      record.conversationId = 'conv_existing';
      record.summaryContext = structuredClone(previousSummary);
    });

    const specialistSummary = {
      pax: 3,
      budget: { amount: null, currency: null, per_person: null, total: null },
      origin: { city: null, iata: null },
      destination: { city: 'Paris', iata: null },
      tripType: ['family', 'relaxed'],
      outbound_date: null,
      return_date: null,
      duration_days: 5,
      upcomingEvents: [{ name: 'Museum night', date: '2026-11-07' }],
      placesOfInterest: [{ placeName: 'Louvre', description: 'Art museum' }],
      suggestedQuestions: ['Would you like a quieter day 3?'],
    };
    const response = new TestResponse();
    let raw = '';
    response.on('data', (chunk) => {
      raw += chunk.toString();
    });
    const writer = new SseWriter(response);
    writer.start();
    const releaseTurn = fixture.store.acquireTurn(chat.chatId);

    await streamChatTurn({
      store: fixture.store,
      writer,
      response,
      chat,
      isNewChat: false,
      releaseTurn,
      message: 'Make it lighter',
      timeZone: 'Asia/Kolkata',
      createConversationSession: () => ({ getSessionId: async () => 'conv_existing' }),
      runGateway: async ({ context }) => {
        assert.equal(context.summaryContext.pax, 2);
        assert.equal(context.summaryContext.destination.iata, 'DEL');
        context.summaryContext = structuredClone(specialistSummary);
        context.flight.tripType = 'oneway';
        context.flight.inboundDate = null;
        context.flight.outboundDate = null;
        context.flight.segments = [{ date: '', origin: '', destination: '', origin_iata: null, destination_iata: null }];
        context.flight.resolvedOrigin = { userCity: null, airportIATA: null, airportName: null };
        context.flight.resolvedDestination = { userCity: null, airportIATA: null, airportName: null };
        context.tripPlanner.lastPlanArtifact = { destination: { city: 'Paris' }, output: 'Lighter itinerary' };
        context.tripPlanner.currentUserMessage = 'Make it lighter';
        context.tripPlanner.turnState = { phase: 'completed' };
        context.tripPlanner.planningBrief = { transient: true };
        return {
          output: 'Lighter itinerary',
          finalAgentName: 'Manager Agent',
          context,
          lastResponseId: 'resp_specialist_context',
        };
      },
    });

    const events = parseEvents(raw);
    assert.deepEqual(events.map((item) => item.event), ['conversation.ready', 'turn.started', 'delta', 'done']);
    const done = events.find((item) => item.event === 'done').data;
    assert.equal(done.summaryStatus, 'skipped');
    assert.deepEqual(done.summaryContext, previousSummary);
    const stored = fixture.store.getChat(chat.chatId);
    assert.deepEqual(stored.summaryContext, previousSummary);
    assert.deepEqual(stored.messages[0].summaryContext, previousSummary);
    assert.deepEqual(stored.messages[1].summaryContext, previousSummary);
    assert.deepEqual(stored.runtimeContext.summaryContext, specialistSummary);
    assert.deepEqual(stored.runtimeContext.tripPlanner.lastPlanArtifact, {
      destination: { city: 'Paris' }, output: 'Lighter itinerary',
    });
    for (const key of ['currentUserMessage', 'turnState', 'planningBrief']) {
      assert.equal(Object.hasOwn(stored.runtimeContext.tripPlanner, key), false);
    }
    assert.equal(stored.turns[0].status, 'completed');
    assert.equal(stored.turns[0].summaryStatus, 'skipped');
    assert.equal(stored.messages[1].content, 'Lighter itinerary');

    const restartedStore = await new JsonChatStore({ filePath: fixture.filePath }).init();
    const reloaded = restartedStore.getChat(chat.chatId);
    assert.deepEqual(reloaded, stored);
    const nextResponse = new TestResponse();
    let nextRaw = '';
    nextResponse.on('data', (chunk) => { nextRaw += chunk.toString(); });
    const nextWriter = new SseWriter(nextResponse);
    nextWriter.start();
    await streamChatTurn({
      store: restartedStore,
      writer: nextWriter,
      response: nextResponse,
      chat: reloaded,
      isNewChat: false,
      releaseTurn: restartedStore.acquireTurn(chat.chatId),
      message: 'Keep the same preferences for day 3',
      timeZone: 'Asia/Kolkata',
      stream: true,
      createConversationSession: ({ conversationId }) => {
        assert.equal(conversationId, 'conv_existing');
        return { getSessionId: async () => conversationId };
      },
      runGateway: async ({ context, stream }) => {
        assert.equal(stream, true);
        assert.deepEqual(context.summaryContext, specialistSummary);
        assert.equal(context.flight.tripType, 'oneway');
        assert.equal(context.flight.inboundDate, '');
        assert.equal(context.flight.outboundDate, null);
        assert.equal(context.flight.resolvedOrigin.airportIATA, null);
        assert.equal(context.flight.resolvedDestination.airportIATA, null);
        assert.equal(context.flight.segments[0].origin, '');
        assert.equal(context.flight.segments[0].destination, '');
        assert.equal(context.tripPlanner.lastPlanArtifact.output, 'Lighter itinerary');
        return { output: 'Updated day 3', finalAgentName: 'Manager Agent', context, lastResponseId: 'resp_follow_up' };
      },
    });
    const nextEvents = parseEvents(nextRaw);
    assert.deepEqual(nextEvents.map((item) => item.event), ['conversation.ready', 'turn.started', 'delta', 'done']);
    assert.equal(nextEvents.at(-1).data.summaryStatus, 'skipped');
    const nextStored = restartedStore.getChat(chat.chatId);
    assert.deepEqual(nextStored.summaryContext, previousSummary);
    assert.deepEqual(nextStored.runtimeContext.summaryContext, specialistSummary);
    assert.equal(nextStored.turns[1].status, 'completed');
    assert.equal(nextStored.turns[1].summaryStatus, 'skipped');
    assert.equal(nextStored.messages[3].content, 'Updated day 3');
  } finally {
    await fixture.cleanup();
  }
});
