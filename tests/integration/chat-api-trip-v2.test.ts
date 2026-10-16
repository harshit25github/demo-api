/** Chat API with Trip Planner v2: the client summary is saved and returned in its exact shape. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

process.env.OPENAI_API_KEY ||= 'test-key';

const { JsonChatStore } = await import('../../src/api/chat/store.js');
const { createEmptySummaryContext, hydrateGatewayContext } = await import('../../src/api/chat/context-hydration.js');
const { streamChatTurn } = await import('../../src/api/chat/orchestrator.js');
const { SseWriter } = await import('../../src/api/chat/sse.js');

class TestResponse extends PassThrough {
  statusCode: number | null = null;
  writeHead(statusCode: number) { this.statusCode = statusCode; return this; }
  flushHeaders() {}
}

function parseEvents(raw: string) {
  return raw.split('\n\n').map((block) => block.trim()).filter((block) => block && !block.startsWith(':')).map((block) => ({
    event: block.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? 'null'),
  }));
}

test("hydration converts an older chat's Trip-only summary into the client shape", () => {
  const context = hydrateGatewayContext({
    flight: {}, tripPlanner: {}, flightSearchRuntime: null,
    summaryContext: { pax: 3, destination: { city: 'Rome', iata: 'ROM' }, upcomingEvents: [], suggestedQuestions: ['x'], tripType: ['family'] },
  } as any, createEmptySummaryContext());
  const summary = context.summaryContext as any;
  assert.equal(summary.passengerData.total, 3);
  assert.deepEqual(summary.destination, { city: 'Rome', iata: 'ROM' });
  for (const key of ['pax', 'upcomingEvents', 'suggestedQuestions']) assert.equal(Object.hasOwn(summary, key), false);
});

test('a turn saves and returns the client summary, and returns chips and the trip view', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'trip-v2-chat-'));
  try {
    const store = await new JsonChatStore({ filePath: path.join(directory, 'chats.json') }).init();
    let chat = await store.createChat({ title: 'Warm December' });
    chat = (await store.updateChat(chat.chatId, (record) => {
      // The client's own starting summary, as it sends it.
      record.summaryContext = { ...createEmptySummaryContext(), origin: { city: 'NEWDELHI', iata: 'DEL' },
        budget: { amount: null, currency: 'USD', per_person: false, total: null } };
    }))!;
    const response = new TestResponse();
    let raw = '';
    response.on('data', (chunk) => { raw += chunk.toString(); });
    const writer = new SseWriter(response as any);
    writer.start();
    const tripView = { presentation: 'trip_options', cards: [], days: [] };

    await streamChatTurn({
      store, writer, response: response as any, chat, isNewChat: false, releaseTurn: store.acquireTurn(chat.chatId)!,
      message: 'somewhere warm in december, 2 of us', timeZone: 'Asia/Kolkata',
      createConversationSession: () => ({ getSessionId: async () => 'conv_v2' }) as any,
      runGateway: async ({ context }) => {
        assert.equal(context.summaryContext.origin.city, 'NEWDELHI');
        context.summaryContext.passengerData.total = 2;
        context.summaryContext.tripType = ['warm weather'];
        context.tripPlanner.options = [{ code: 'CTG', city: 'Cartagena', country: 'Colombia', why: 'Walled city', bestTime: 'Dec to Apr', cost: '$' }];
        context.tripPlanner.suggestions = ['Plan 5 days in Cartagena'];
        context.tripPlanner.turnView = { requestId: context.requestId, presentation: 'trip_options', presentationDays: [] };
        return { output: 'Here are some warm picks.', finalAgentName: 'Manager Agent', context, lastResponseId: 'resp_v2', tripView };
      },
    });

    const done = parseEvents(raw).find((item) => item.event === 'done')!.data;
    const expected = {
      origin: { city: 'NEWDELHI', iata: 'DEL' },
      destination: { city: null, iata: null },
      outbound_date: null, return_date: null, duration_days: null,
      budget: { amount: null, currency: 'USD', per_person: false, total: null },
      tripType: ['warm weather'],
      placesOfInterest: [],
      passengerData: { total: 2, adults: null, seniors: null, children: null, lapInfants: null, seatInfants: null, childrenAges: [] },
    };
    assert.equal(JSON.stringify(done.summaryContext), JSON.stringify(expected));
    assert.deepEqual(done.tripContext, { suggestedQuestions: ['Plan 5 days in Cartagena'], view: tripView });
    const stored = store.getChat(chat.chatId)!;
    assert.deepEqual(stored.summaryContext, expected);
    assert.deepEqual(stored.messages.at(-1)!.summaryContext, expected);
    assert.deepEqual((stored.runtimeContext.tripPlanner as any).suggestions, ['Plan 5 days in Cartagena']);
    assert.equal((stored.runtimeContext.tripPlanner as any).options[0].city, 'Cartagena');
    assert.equal(Object.hasOwn(stored.runtimeContext.tripPlanner, 'turnView'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
