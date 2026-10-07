import { MemorySession, Runner } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { FlightAgent } from '../../src/agents/flight/agent.js';
import { flightAgentConfig } from '../../src/agents/flight/config.js';
import { prepareFlightAgentTurnContext } from '../../src/agents/flight/context/flight-context.js';
import { createRequestContext } from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';

const baseNow = '2026-09-19T04:30:00.000Z';
const timeZone = 'Asia/Kolkata';
const cases = [
  { id: 'tomorrow', input: 'Find one-way flights from DEL to DXB tomorrow.', out: '2026-09-20' },
  { id: 'day-after-tomorrow', input: 'Find one-way flights from DEL to DXB the day after tomorrow.', out: '2026-09-21' },
  { id: 'next-weekend', input: 'Find one-way flights from DEL to DXB next weekend.', predStart: '2026-09-26', predEnd: '2026-09-27' },
  { id: 'next-to-next-weekend', input: 'Find one-way flights from DEL to DXB next-to-next weekend.', predStart: '2026-10-03', predEnd: '2026-10-04' },
  { id: 'next-week', input: 'Find one-way flights from DEL to DXB sometime next week.', predStart: '2026-09-21', predEnd: '2026-09-27' },
  { id: 'next-month', input: 'Find one-way flights from DEL to DXB sometime next month.', predStart: '2026-10-01', predEnd: '2026-10-31' },
  { id: 'after-two-weeks', input: 'Find one-way flights from DEL to DXB after 2 weeks.', out: '2026-10-03' },
  { id: 'date-range', input: 'Find one-way flights from DEL to DXB between October 12 and October 16.', predStart: '2026-10-12', predEnd: '2026-10-16' },
  { id: 'roundtrip-duration', input: 'Find round-trip flights from DEL to DXB next weekend, staying 5 days.', predStart: '2026-09-26', predEnd: '2026-09-27' },
  { id: 'next-friday', input: 'Find one-way flights from DEL to DXB next Friday.', out: '2026-09-25' },
  { id: 'exact-past', input: 'Find one-way flights from DEL to DXB on September 10, 2026.', noSearch: true },
  { id: 'year-boundary', input: 'Find one-way flights from DEL to DXB next month.', predStart: '2027-01-01', predEnd: '2027-01-31', now: '2026-12-30T04:30:00.000Z' },
  { id: 'prediction-next-week', input: 'Find the cheapest dates from DEL to DXB sometime next week.', predStart: '2026-09-21', predEnd: '2026-09-27' },
] as const;

function parse(value: unknown): any {
  const text = typeof value === 'string' ? value :
    value && typeof value === 'object' && (value as any).type === 'text' ? (value as any).text : null;
  if (typeof text !== 'string') return value ?? null;
  try { return JSON.parse(text); } catch { return text; }
}

function callsFromItems(items: any[]): any[] {
  const results = new Map(items.filter((x) => x.type === 'function_call_result').map((x) => [x.callId, x]));
  return items.filter((x) => x.type === 'function_call').map((x) => {
    const input = parse(x.arguments);
    const output = parse(results.get(x.callId)?.output);
    return {
      tool: x.name,
      input: x.name === 'flight_search' ? { onds: input?.onds, trip_type: input?.trip_type } :
        x.name === 'price_prediction_tool' ? { startDate: input?.startDate, endDate: input?.endDate } : undefined,
      output: x.name === 'flight_search' ? { ok: output?.ok, status: output?.status, code: output?.code,
        resultCount: Array.isArray(output?.flights) ? output.flights.length : undefined } :
        x.name === 'price_prediction_tool' ? { status: output?.status } : undefined,
    };
  });
}

const runner = new Runner({
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  workflowName: 'flight-date-routing-eval',
  tracingDisabled: true,
});
const agent = FlightAgent;

const selected = process.env.DATE_EVAL_CASE_ID
  ? cases.filter((testCase) => testCase.id === process.env.DATE_EVAL_CASE_ID)
  : cases;
const repetitions = Math.max(1, Number(process.env.DATE_EVAL_REPETITIONS || 1));

if (process.env.DATE_EVAL_MULTI === '1') {
  const journeys = [
    { id: 'date-before-route', turns: ['Find flights next weekend.', 'DEL to DXB, one adult, economy, one-way.'], out: '2026-09-26', ret: null },
    { id: 'duration-later', turns: ['Round-trip DEL to DXB next month for one adult, economy.', 'Stay for five days.'], out: '2026-10-01', ret: '2026-10-06' },
  ];
  for (const journey of journeys) {
    const sessionId = `date-removal-multi-${journey.id}-${randomUUID()}`;
    const context = prepareFlightAgentTurnContext({ flight: { uid: sessionId }, toolCallLog: [] }, { requestId: sessionId, sessionId });
    const session = new MemorySession({ sessionId });
    const turns = [];
    for (const input of journey.turns) {
      context.currentUserMessage = input;
      const requestContext = createRequestContext(context, createRequestClock({ now: new Date(baseNow), timeZone }));
      const before = (await session.getItems()).length;
      let finalOutput: unknown = null;
      let error: string | null = null;
      try {
        const result = await runner.run(agent, input, { context: requestContext, session, maxTurns: flightAgentConfig.maxTurns });
        finalOutput = result.finalOutput;
      } catch (cause) {
        error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      }
      turns.push({ input, calls: callsFromItems((await session.getItems() as any[]).slice(before)), finalOutput, error });
    }
    const search = turns.at(-1)?.calls.filter((call) => call.tool === 'flight_search').at(-1);
    const out = search?.input?.onds?.[0]?.outbound_date ?? null;
    const ret = search?.input?.onds?.[0]?.return_date ?? null;
    const passed = out === journey.out && ret === journey.ret && turns.every((turn) => !turn.error);
    console.log(JSON.stringify({ id: journey.id, passed, out, ret, turns }));
    if (!passed) process.exitCode = 1;
  }
  process.exit();
}

for (const testCase of selected) {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const sessionId = `date-removal-${testCase.id}-${repetition}-${randomUUID()}`;
    const context = prepareFlightAgentTurnContext({ flight: { uid: sessionId }, toolCallLog: [] }, { requestId: sessionId, sessionId });
    context.currentUserMessage = testCase.input;
    const requestContext = createRequestContext(context, createRequestClock({ now: new Date('now' in testCase ? testCase.now : baseNow), timeZone }));
    const session = new MemorySession({ sessionId });
    let finalOutput: unknown = null;
    let error: string | null = null;
    try {
      const result = await runner.run(agent, testCase.input, { context: requestContext, session, maxTurns: flightAgentConfig.maxTurns });
      finalOutput = result.finalOutput;
    } catch (cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    }
    const calls = callsFromItems(await session.getItems() as any[]);
    const search = calls.filter((call) => call.tool === 'flight_search').at(-1);
    const actualOut = search?.input?.onds?.[0]?.outbound_date ?? null;
    const actualRet = search?.input?.onds?.[0]?.return_date ?? null;
    const prediction = calls.find((call) => call.tool === 'price_prediction_tool');
    const passed = 'predStart' in testCase
      ? prediction?.input?.startDate === testCase.predStart && prediction?.input?.endDate === testCase.predEnd
      : 'noSearch' in testCase ? !search : actualOut === testCase.out && (!('ret' in testCase) || actualRet === testCase.ret);
    console.log(JSON.stringify({ id: testCase.id, repetition, localDate: requestContext.runtime.clock.localDate,
      expectedOut: 'out' in testCase ? testCase.out : null, actualOut,
      expectedRet: 'ret' in testCase ? testCase.ret : null, actualRet,
      passed, calls, finalOutput, error }));
    if (!passed || error) process.exitCode = 1;
    if (error && /429|quota|credit|insufficient_quota|billing/i.test(error)) process.exit(2);
  }
}
