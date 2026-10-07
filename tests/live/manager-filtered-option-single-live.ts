/** One paid Manager request against a locally prepared, filtered Flight search. */
import 'dotenv/config';
import { managerSpecialistNames } from './manager-flight-evidence.js';

if (process.env.RUN_MANAGER_OPTION_LIVE !== '1' || !process.env.OPENAI_API_KEY) {
  throw new Error('Set RUN_MANAGER_OPTION_LIVE=1 and OPENAI_API_KEY to run this live check.');
}

process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
const { pinManagerLiveModels } = await import('./manager-live-model-policy.js');
pinManagerLiveModels();

const [{ generateTraceId, getGlobalTraceProvider }, { hydrateGatewayContext },
  { runGatewayAgentTextStream }, { FlightSearchTool }, { ApplyFilterTool },
  { createRequestContext }, { createRequestClock }] = await Promise.all([
  import('@openai/agents'),
  import('../../src/api/chat/context-hydration.js'),
  import('../../src/agents/manager-orchestrator/streaming.js'),
  import('../../src/agents/flight/tools/search-tool.js'),
  import('../../src/agents/flight/tools/filter/tool.js'),
  import('../../src/shared/runtime/request-context.js'),
  import('../../src/shared/time/request-clock.js'),
]);

const now = new Date('2026-09-19T10:00:00.000Z');
const context = hydrateGatewayContext({});
const requestContext = createRequestContext(context, createRequestClock({
  now, timeZone: 'Asia/Kolkata',
}));
const search = {
  onds: [{ origin: 'DEL', destination: 'DXB', outbound_date: '2026-09-26', return_date: null }],
  trip_type: 'oneway',
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin_class: 'economy',
};
const filter = { filters: [{
  filterType: 'stops', filterCode: '0',
  minDurationMinutes: null, maxDurationMinutes: null,
  minPrice: null, maxPrice: null,
  airlineNames: null, layoverAirportNames: null,
  departureAirportNames: null, arrivalAirportNames: null,
  rawUserFilter: 'nonstop only',
}] };

await (FlightSearchTool as any).invoke({ context: requestContext }, JSON.stringify(search), {});
await (ApplyFilterTool as any).invoke({ context: requestContext }, JSON.stringify(filter), {});
if (!Array.isArray(context.flight.searchResults) || context.flight.searchResults.length !== 1) {
  throw new Error('Expected exactly one locally filtered flight before the live request.');
}

const traceId = generateTraceId();
const run = runGatewayAgentTextStream({
  input: 'Show me option 2.',
  requestId: 'manager-filtered-option-live',
  traceId,
  sessionId: 'manager-filtered-option-live',
  context,
  now,
  timeZone: 'Asia/Kolkata',
  maxTurns: 12,
});
let streamed = '';
const streamDone = (async () => {
  for await (const chunk of run.stream) streamed += String(chunk);
})();
const result = await run.completed;
await streamDone;
await getGlobalTraceProvider().forceFlush();
const managerResults = (result.result?.newItems || [])
  .filter((item: any) => item?.type === 'tool_call_output_item')
  .flatMap((item: any) => {
    try { return [JSON.parse(String(item.output || ''))]; }
    catch { return []; }
  })
  .filter((item: any) => item?.status && item?.summary);
const output = String(result.output || '');
const checks = {
  oneVisibleOption: context.flight.searchResults.length === 1,
  flightSpecialistUsed: managerSpecialistNames(result).includes('flight_agent'),
  explainsUnavailableOption: /option 2.*(?:not available|isn.t|unavailable)/i.test(output),
  doesNotAskDateAgain: !/what date|which date|when would you like to fly/i.test(output),
  streamMatchesFinal: streamed === output,
};
console.log(JSON.stringify({ traceId, output, checks, managerResults }, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
