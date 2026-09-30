import type { AgentInputItem } from '@openai/agents';
import { FlightSearchTool } from '../src/agents/flight/tools/search-tool.js';
import { ApplyFilterTool } from '../src/agents/flight/tools/filter/tool.js';
import { sessionOptimization } from '../src/shared/config/session-optimization.js';
import { clearFlightSearchRuntime } from '../src/agents/flight/context/search-runtime-store.js';
import { createRequestContext } from '../src/shared/runtime/request-context.js';
import { createRequestClock } from '../src/shared/time/request-clock.js';
import { ensureFlightRuntimeContext } from '../src/agents/flight/context/flight-context.js';
import { snapshotGatewayContext } from '../src/api/chat/context-hydration.js';

export const fixtureSearchArguments = {
  onds: [{ origin: 'Delhi', destination: 'Mumbai', outbound_date: '2026-10-15', return_date: null }],
  trip_type: 'oneway', passengers: { adults: 1, children: 0, infants: 0 }, cabin_class: 'economy',
};
export const fixtureFilterArguments = { filters: [{ filterType: 'price', filterCode: null,
  minDurationMinutes: null, maxDurationMinutes: null, minPrice: null, maxPrice: 9999999,
  airlineNames: null, layoverAirportNames: null, departureAirportNames: null, arrivalAirportNames: null,
  rawUserFilter: 'Under 9999999' }] };
type FixturePayload = Record<string, any>;
type Invokable = { invoke(context: unknown, input: string, options: object): Promise<unknown> };
function payload(value: unknown): FixturePayload {
  return (typeof value === 'string' ? JSON.parse(value) : value) as FixturePayload;
}

export async function realToolFixtures() {
  const mode = sessionOptimization.mode;
  const originalLog = console.log;
  const context = ensureFlightRuntimeContext({ requestId: 'fixture', sessionId: 'fixture', flight: { uid: 'synthetic_fixture' }, toolCallLog: [] });
  try {
    // Fixture generation is single threaded and never used inside the production server.
    sessionOptimization.mode = 'off';
    console.log = () => {}; // Existing dummy-tool logs contain full payloads; reports are metadata only.
    const search = payload(await (FlightSearchTool as unknown as Invokable).invoke({ context }, JSON.stringify(fixtureSearchArguments), {}));
    const filter = payload(await (ApplyFilterTool as unknown as Invokable).invoke({ context }, JSON.stringify(fixtureFilterArguments), {}));
    for (const result of [search, filter]) {
      result.searchKey = 'search_synthetic_fixture';
      result.UID = 'synthetic_fixture';
      if (result.apiPayload) result.apiPayload.searchKey = result.searchKey;
    }
    const runtimeContext = snapshotGatewayContext(context);
    runtimeContext.flight.searchKey = search.searchKey;
    return { search, filter, runtimeContext };
  } finally {
    clearFlightSearchRuntime(context.flight.searchKey);
    sessionOptimization.mode = mode;
    console.log = originalLog;
  }
}

export function scaleFixture(payload: FixturePayload, count: number): FixturePayload {
  const scaled = structuredClone(payload);
  scaled.flights = Array.from({ length: count }, (_, i) => structuredClone(payload.flights[i % payload.flights.length]));
  if ('optionCount' in scaled.summary) scaled.summary.optionCount = count;
  if ('originalCount' in scaled.summary) scaled.summary = { originalCount: count, filteredCount: count };
  return scaled;
}

export function fixtureHistory(payload: FixturePayload, tool = 'flight_search', turns = 1): AgentInputItem[] {
  const input: AgentInputItem[] = [];
  const messages = ['Find Delhi to Mumbai flights on 15 October.', 'Keep economy and one adult.', 'Which is cheapest?', 'Tell me about option 3.', 'Keep the original departure date.'];
  for (let i = 0; i < turns; i++) {
    input.push({ role: 'user', content: messages[i % messages.length]! },
      { type: 'function_call', name: tool, callId: `call_${i}`, arguments: JSON.stringify(tool === 'flight_search' ? fixtureSearchArguments : fixtureFilterArguments) },
      { type: 'function_call_result', name: tool, callId: `call_${i}`, status: 'completed', output: JSON.stringify(payload) },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Your flight results are ready.' }] });
  }
  input.push({ role: 'user', content: 'Show option 3 from the current results.' });
  return input;
}

export function fixtureContext(payload: FixturePayload) {
  return createRequestContext(ensureFlightRuntimeContext({
    requestId: 'fixture', sessionId: 'fixture', toolCallLog: [],
    flight: { uid: 'synthetic_fixture', searchKey: payload.searchKey, searchResults: payload.flights,
      airlineFilterOptions: payload.airlineFilterOptions ?? [], layoverAirportFilterOptions: payload.layoverAirportFilterOptions ?? [],
      departAirports: payload.DepartAirports ?? [], depLandAirports: payload.DepLandAirports ?? [] },
  }), createRequestClock({ now: '2026-09-08T10:00:00Z', timeZone: 'Asia/Kolkata' }));
}
