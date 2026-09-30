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
const { createChatServer } = await import('../../src/api/chat/server.js');

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

test('SSE turn creates conversation, streams draft, summarizes once, then persists authoritative result', async () => {
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

    let summaryRuns = 0;
    let sessionOptions = null;
    const createConversationSession = (options) => {
      sessionOptions = options;
      return { getSessionId: async () => 'conv_test_123' };
    };
    const runGateway = ({ context, session }) => {
      assert.equal(session.getSessionId instanceof Function, true);
      context.flight.searchKey = 'search_sse_visibility';
      context.flight.searchResults = [
        { id: 'contract-1', display: false },
        { id: 'contract-2', display: true },
      ];
      const stream = new PassThrough();
      queueMicrotask(() => {
        stream.write('Draft answer');
        stream.end();
      });
      return {
        stream,
        context,
        completed: Promise.resolve({
          output: 'Authoritative final answer',
          finalAgentName: 'Manager Agent',
          specialistsUsed: ['flight_agent', 'trip_planner_agent'],
          renderFlightOptions: true,
          context,
          lastResponseId: 'resp_test_123',
        }),
      };
    };
    const runSummary = async ({ previousSummary, userMessage, agentResponse }) => {
      summaryRuns += 1;
      assert.deepEqual(previousSummary, createEmptySummaryContext());
      assert.equal(userMessage, 'Find JFK to Delhi next weekend');
      assert.equal(agentResponse, 'Authoritative final answer');
      return completedSummary();
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
      runSummary,
    });

    const events = parseEvents(raw);
    assert.deepEqual(
      events.map((item) => item.event),
      [
        'chat.created',
        'conversation.ready',
        'turn.started',
        'delta',
        'summary.started',
        'done',
      ],
    );
    assert.deepEqual(sessionOptions, { conversationId: undefined });
    assert.equal(events.find((item) => item.event === 'delta').data.text, 'Draft answer');
    assert.equal(
      events.find((item) => item.event === 'done').data.finalText,
      'Authoritative final answer',
    );
    assert.deepEqual(
      events.find((item) => item.event === 'done').data.specialistsUsed,
      ['flight_agent', 'trip_planner_agent'],
    );
    assert.equal(events.find((item) => item.event === 'done').data.renderFlightOptions, true);
    assert.deepEqual(
      events
        .find((item) => item.event === 'done')
        .data.flightContext.searchResults.map((contract) => contract.display),
      [false, true],
    );
    assert.equal(summaryRuns, 1);

    const stored = fixture.store.getChat(chat.chatId);
    assert.equal(stored.conversationId, 'conv_test_123');
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.messages[1].content, 'Authoritative final answer');
    assert.deepEqual(stored.messages[1].specialistsUsed, ['flight_agent', 'trip_planner_agent']);
    assert.equal(stored.messages[1].renderFlightOptions, true);
    assert.equal(stored.messages[1].summaryContext.destination.iata, 'DEL');
    assert.equal(stored.turns[0].status, 'completed');
    assert.equal(stored.turns[0].lastResponseId, 'resp_test_123');
    assert.deepEqual(stored.turns[0].specialistsUsed, ['flight_agent', 'trip_planner_agent']);
    assert.deepEqual(
      (stored.runtimeContext.flight.searchResults as any[]).map(
        (contract) => contract.display,
      ),
      [false, true],
    );

    const secondResponse = new TestResponse();
    secondResponse.resume();
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
      runSummary,
    });
    assert.deepEqual(sessionOptions, { conversationId: 'conv_test_123' });
  } finally {
    await fixture.cleanup();
  }
});

test('terminal Gateway stream failure emits SSE error and keeps the turn process-safe', async () => {
  const fixture = await temporaryStore();
  try {
    const chat = await fixture.store.createChat({ title: 'Timeout case' });
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
    const runGateway = ({ context }) => {
      const stream = new PassThrough();
      const completed = Promise.reject(timeoutError);
      queueMicrotask(() => stream.destroy(timeoutError));
      return { stream, completed, context };
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
      runSummary: async () => {
        throw new Error('Summary must not run after Gateway failure.');
      },
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
    assert.equal(fixture.store.getChat(chat.chatId).turns[0].status, 'failed');
  } finally {
    await fixture.cleanup();
  }
});

test('HTTP API serves dashboard, creates chats over SSE, rejects unknown and busy chats', async () => {
  const fixture = await temporaryStore();
  const runTurn = async ({ writer, response, chat, isNewChat, releaseTurn }) => {
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
        summaryStatus: 'completed',
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

test('Summary Extractor failure keeps the previous summary and still sends done', async () => {
  const fixture = await temporaryStore();
  try {
    let chat = await fixture.store.createChat({ title: 'Existing Paris trip' });
    const previousSummary = completedSummary();
    chat = await fixture.store.updateChat(chat.chatId, (record) => {
      record.conversationId = 'conv_existing';
      record.summaryContext = structuredClone(previousSummary);
    });

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
      runGateway: ({ context }) => {
        const stream = new PassThrough();
        queueMicrotask(() => stream.end('Lighter itinerary'));
        return {
          stream,
          context,
          completed: Promise.resolve({
            output: 'Lighter itinerary',
            finalAgentName: 'Trip Planner Agent',
            context,
            lastResponseId: 'resp_summary_failure',
          }),
        };
      },
      runSummary: async () => {
        throw new Error('Extractor unavailable');
      },
    });

    const done = parseEvents(raw).find((item) => item.event === 'done').data;
    assert.equal(done.summaryStatus, 'failed');
    assert.deepEqual(done.summaryContext, previousSummary);
    const stored = fixture.store.getChat(chat.chatId);
    assert.deepEqual(stored.summaryContext, previousSummary);
    assert.equal(stored.turns[0].status, 'completed');
    assert.equal(stored.turns[0].summaryStatus, 'failed');
    assert.equal(stored.messages[1].content, 'Lighter itinerary');
  } finally {
    await fixture.cleanup();
  }
});
