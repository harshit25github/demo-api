/** One paid Manager request after a locally prepared round-trip search. */
import 'dotenv/config';

if (process.env.RUN_MANAGER_PRICE_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
  throw new Error('Set RUN_MANAGER_PRICE_LIVE=1 and OPENAI_API_KEY to run this live check.');
}

process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const [{ generateTraceId, getGlobalTraceProvider }, { hydrateGatewayContext },
  { runGatewayAgentTextStream }, { FlightSearchTool },
  { createRequestContext }, { createRequestClock }] = await Promise.all([
  import('@openai/agents'),
  import('../../src/api/chat/context-hydration.js'),
  import('../../src/agents/manager-orchestrator/streaming.js'),
  import('../../src/agents/flight/tools/search-tool.js'),
  import('../../src/shared/runtime/request-context.js'),
  import('../../src/shared/time/request-clock.js'),
]);

const now = new Date('2026-09-20T10:00:00.000Z');
const context = hydrateGatewayContext({});
const requestContext = createRequestContext(context, createRequestClock({
  now, timeZone: 'Asia/Kolkata',
}));
await (FlightSearchTool as any).invoke({ context: requestContext }, JSON.stringify({
  onds: [{ origin: 'NYC', destination: 'London',
    outbound_date: '2026-11-05', return_date: '2026-11-12' }],
  trip_type: 'roundtrip',
  passengers: { adults: 2, children: 0, infants: 0 },
  cabin_class: 'economy',
}), {});

const priorPrediction = context.flight.lastPricePrediction;
const traceId = generateTraceId();
const run = runGatewayAgentTextStream({
  input: 'Any cheaper dates?',
  requestId: 'manager-cheaper-dates-live',
  traceId,
  sessionId: 'manager-cheaper-dates-live',
  context,
  now,
  timeZone: 'Asia/Kolkata',
  maxTurns: 12,
  maxTimeoutRecoveries: 0,
});
let streamed = '';
const streamDone = (async () => {
  for await (const chunk of run.stream) streamed += String(chunk);
})();
const result = await run.completed;
await streamDone;
await getGlobalTraceProvider().forceFlush();

const prediction = result.context.flight.lastPricePrediction as
  | { status?: string; route?: unknown; searchedDateRange?: unknown } | null;
const managerResults = (result.result?.newItems || [])
  .filter((item: any) => item?.type === 'tool_call_output_item')
  .flatMap((item: any) => {
    try { return [JSON.parse(String(item.output || ''))]; }
    catch { return []; }
  })
  .filter((item: any) => item?.status && item?.summary);
const output = String(result.output || '');
const checks = {
  flightSpecialistUsed: result.specialistsUsed?.includes('flight_agent') || false,
  predictionCalled: prediction !== priorPrediction && Boolean(prediction?.status),
  noPrematureAirportQuestion: !/which .*airport|specific airport|lhr.*lgw/i.test(output),
  streamMatchesFinal: streamed === output,
};
console.log(JSON.stringify({ traceId, output, checks,
  prediction: prediction ? {
    status: prediction.status, route: prediction.route,
    searchedDateRange: prediction.searchedDateRange,
  } : null,
  managerResults,
}, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
