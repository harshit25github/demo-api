/** Scripted models, real production Manager -> Flight SDK path and real tools.
 * This checks payload transport/state/sequencing, not live model intent quality. */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';

const { Runner, Usage } = await import('@openai/agents');
const { runGatewayAgent } = await import('../../src/agents/manager-orchestrator/runner.js');
const { FlightManagerAgent } = await import('../../src/agents/flight/agent.js');
const { getRequestState } = await import('../../src/shared/runtime/request-context.js');
const { getFlightSearchState } = await import('../../src/agents/flight/context/flight-context.js');
const { snapshotGatewayContext, hydrateGatewayContext } = await import('../../src/api/chat/context-hydration.js');
const { snapshotFlightSearchRuntime } = await import('../../src/agents/flight/context/search-runtime-store.js');
const { activeFilterValues, parseToolValue } = await import('../live/manager-flight-evidence.js');

type Call = { tool: string; input: Record<string, any> };
const filter = (filterType: string, fields: Record<string, unknown>) => ({
  filterType, filterCode: null, minDurationMinutes: null, maxDurationMinutes: null,
  minPrice: null, maxPrice: null, airlineNames: null, layoverAirportNames: null,
  departureAirportNames: null, arrivalAirportNames: null, rawUserFilter: null, ...fields,
});
const search = (date: string) => ({
  onds: [{ origin: 'Delhi', destination: 'New York', origin_iata: 'DEL', destination_iata: 'NYC',
    origin_airport_name: null, destination_airport_name: null, outbound_date: date, return_date: null }],
  trip_type: 'oneway', passengers: { adults: 1, children: 0, infants: 0 }, cabin_class: 'economy',
});
const suggestions = (questions: string[]): Call => ({
  tool: 'update_flight_suggested_questions', input: { suggestedQuestions: questions },
});
const answer = (text: string) => ({ usage: new Usage(), responseId: 'resp_scripted',
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] });
const functionCall = ({ tool, input }: Call, id: string) => ({
  usage: new Usage(), responseId: `resp_${id}`,
  output: [{ type: 'function_call', name: tool, callId: id, arguments: JSON.stringify(input), status: 'completed' }],
});

test('few-shot payloads execute all five tools through Manager and preserve multi-turn state', async () => {
  const turns: Array<{ user: string; calls: Call[]; filters: Record<string, Array<string | number>> }> = [
    { user: 'Delhi DEL to New York NYC on October 20, 2026, one adult, economy.', calls: [
      { tool: 'flight_search', input: search('2026-10-20') },
      suggestions(['Show nonstop flights only', 'Which option is fastest?', 'Any cheaper dates nearby?']),
    ], filters: {} },
    { user: 'Show only nonstop morning departures under $220 with carry-on baggage.', calls: [
      { tool: 'apply_filter', input: { filters: [
        filter('stops', { filterCode: '0', rawUserFilter: 'only nonstop' }),
        filter('departureTime', { filterCode: 'MORNING', rawUserFilter: 'morning departures' }),
        filter('price', { maxPrice: 220, rawUserFilter: 'under $220' }),
        filter('baggage', { filterCode: '1', rawUserFilter: 'with carry-on baggage' }),
      // One option matches, so no ranking chip: the tool rejects those below two options.
      ] } }, suggestions(['Show details for option 1', 'Show Air Canada flights only', 'Make this a round trip']),
    ], filters: { stops: ['0'], departureTime: ['MORNING'], price: [220], baggage: ['1'] } },
    { user: 'Make it evening instead, drop the price cap, and remove carry-on.', calls: [
      { tool: 'apply_filter', input: { filters: [
        filter('departureTime', { filterCode: 'EVENING', rawUserFilter: 'Make it evening instead' }),
        filter('price', { rawUserFilter: 'drop the price cap' }),
        filter('baggage', { rawUserFilter: 'remove carry-on' }),
      ] } }, suggestions(['Remove the evening filter', 'Allow one stop instead', 'Change cabin to business']),
    ], filters: { stops: ['0'], departureTime: ['EVENING'] } },
    { user: 'Which current option is cheapest, and why?', calls: [
      { tool: 'getGeneratedContractsContext', input: { mode: 'read', indexes: null } },
      suggestions(['Remove the nonstop filter', 'Include morning departures too', 'Add another adult passenger']),
    ], filters: { stops: ['0'], departureTime: ['EVENING'] } },
    { user: 'Clear all filters and use only Air Canada or Emirates, with a layover under 90 minutes.', calls: [
      { tool: 'apply_filter', input: { filters: [
        filter('reset', { rawUserFilter: 'Clear all filters' }),
        filter('airline', { airlineNames: ['Air Canada', 'Emirates'], rawUserFilter: 'use only Air Canada or Emirates' }),
        filter('layoverDuration', { maxDurationMinutes: 90, rawUserFilter: 'a layover under 90 minutes' }),
      ] } }, suggestions(['Show details for option 1', 'Add checked baggage requirement', 'Search nearby travel days']),
    ], filters: { airline: ['AC', 'AC+', 'EK'], layoverDuration: [90] } },
    // Explicit indexed display retains select transport coverage; open-ended
    // cheapest-option ranking is read-only in the live normalization fixture.
    { user: 'Show option 1.', calls: [
      { tool: 'getGeneratedContractsContext', input: { mode: 'select', indexes: [1] } },
      suggestions(['Show all current options again', 'Limit total duration to three hours', 'Use premium economy instead']),
    ], filters: { airline: ['AC', 'AC+', 'EK'], layoverDuration: [90] } },
    { user: 'Find flights between October 21 and October 28, keeping only Air Canada.', calls: [
      { tool: 'price_prediction_tool', input: { originCity: 'DEL', destinationCity: 'NYC',
        startDate: '2026-10-21', endDate: '2026-10-28', tripType: 'oneway',
        returnStartDate: null, returnEndDate: null, tripDuration: null, tripDurationFlexibility: null } },
      { tool: 'flight_search', input: search('2026-10-21') },
      { tool: 'apply_filter', input: { filters: [filter('airline', {
        airlineNames: ['Air Canada'], rawUserFilter: 'keeping only Air Canada',
      })] } }, suggestions(['Which option has least baggage restrictions?', 'Show personal item included flights', 'Add one child passenger']),
    ], filters: { airline: ['AC', 'AC+'] } },
  ];
  const originalModel = FlightManagerAgent.model;
  const observed: Array<Call & { output?: any }> = [];
  const onStart = (_context: any, tool: any, details: any) => {
    observed.push({ tool: tool.name, input: parseToolValue(details.toolCall.arguments) });
  };
  const onEnd = (runContext: any, tool: any, output: any) => {
    assert.ok(getRequestState(runContext.context).requestId);
    const call = [...observed].reverse().find((entry) => entry.tool === tool.name && entry.output === undefined);
    assert.ok(call);
    call.output = parseToolValue(output);
  };
  FlightManagerAgent.on('agent_tool_start', onStart);
  FlightManagerAgent.on('agent_tool_end', onEnd);
  let storedContext: any = {};
  const coverage = new Set<string>();
  try {
    for (const [turnIndex, turn] of turns.entries()) {
      observed.length = 0;
      let flightStep = 0;
      (FlightManagerAgent as any).model = { async getResponse() {
        const call = turn.calls[flightStep++];
        if (call) return functionCall(call, `flight_${turnIndex}_${flightStep}`);
        return answer(JSON.stringify({ status: turnIndex === 6 ? 'partial' : 'success', completedTask: 'Completed the scoped Flight task',
          summary: 'Checked the current request.', findings: [], limitations: [], missingInformation: [], nextStep: null,
          presentation: turn.calls.some((entry) => entry.tool === 'flight_search') ? 'flight_cards_with_price_note' : null }));
      } };
      let managerStep = 0;
      const managerModel: any = { async getResponse() {
        return managerStep++ === 0
          ? functionCall({ tool: 'flight_agent', input: { input: turn.user } }, `delegate_${turnIndex}`)
          : answer('Checked your flight request.');
      } };
      const sdkRunner = new Runner({ tracingDisabled: true, toolExecution: { maxFunctionToolConcurrency: 1 } });
      const result = await runGatewayAgent({ input: turn.user, context: hydrateGatewayContext(storedContext),
        requestId: `fewshot-${turnIndex}`, now: new Date('2026-10-05T10:00:00Z'), timeZone: 'Asia/Kolkata',
        runner: { run: (agent: any, input: any, options: any) => sdkRunner.run(agent.clone({ model: managerModel }), input, options) } as any,
      });
      assert.equal(result.finalAgentName, 'Manager Agent');
      assert.equal(result.result.newItems.some((item: any) =>
        item.type === 'tool_call_item' && item.rawItem?.name === 'flight_agent'), true);
      assert.deepEqual(observed.map(({ tool, input }) => ({ tool, input })), turn.calls);
      for (const call of observed) {
        coverage.add(call.tool);
        if (call.tool === 'flight_search') {
          assert.equal(call.output?.source, 'dummy');
          assert.ok(call.output?.searchKey);
        } else assert.equal(call.output?.ok, call.tool === 'price_prediction_tool' ? false : true, `${turnIndex + 1}: ${call.tool}`);
      }
      assert.deepEqual(activeFilterValues(snapshotFlightSearchRuntime(result.context.flight.searchKey)?.appliedFilters || []), turn.filters);
      const state = getFlightSearchState(result.context);
      assert.equal(state.origin, 'Delhi');
      assert.equal(state.destination, 'New York');
      assert.equal(state.onds[0].origin_iata, 'DEL');
      assert.equal(state.onds[0].destination_iata, 'NYC');
      if (turnIndex === 3) assert.equal(result.context.flight.totalResultsFound, 0);
      if (turnIndex === 6) assert.equal((result.context.flight.lastPricePrediction as any).status, 'NO_PREDICTIONS');
      assert.equal(observed.at(-1)?.tool, 'update_flight_suggested_questions');
      storedContext = snapshotGatewayContext(result.context);
    }
    assert.deepEqual([...coverage].sort(), ['flight_search', 'apply_filter', 'getGeneratedContractsContext',
      'price_prediction_tool', 'update_flight_suggested_questions'].sort());
  } finally {
    FlightManagerAgent.model = originalModel;
    FlightManagerAgent.off('agent_tool_start', onStart);
    FlightManagerAgent.off('agent_tool_end', onEnd);
  }
});
