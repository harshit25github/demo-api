import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFlightSearchState,
  hasRequiredFlightSearchFields,
  mergeFlightAgentContext,
} from '../../src/agents/flight/context/flight-context.js';
import { buildActiveSearchSummary } from '../../src/agents/flight/context/prompt-summary.js';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';

const FlightSearchTool: any = FlightSearchToolDefinition;

function existingRoundTripContext(): any {
  return {
    toolCallLog: [],
    flight: {
      uid: 'context-carry-forward-user',
      tripType: 'roundtrip',
      outboundDate: '2026-08-20',
      inboundDate: '2026-08-27',
      cabinClass: 'economy',
      segments: [{ date: '2026-08-20', origin: 'DEL', destination: 'BLR' }],
      passengerData: { adults: 1, children: 0, lapInfants: 0, seatInfants: 0 },
      resolvedOrigin: { userCity: 'Delhi', airportIATA: 'DEL' },
      resolvedDestination: { userCity: 'Bangalore', airportIATA: 'BLR' },
    },
  };
}

function routeOnlyContext(origin = 'LAX', destination = 'LAS'): any {
  return {
    flight: {
      segments: [{ date: '', origin, destination }],
      resolvedOrigin: { userCity: null, airportIATA: origin },
      resolvedDestination: { userCity: null, airportIATA: destination },
    },
  };
}

function toFlightSearchPayload(context) {
  const state = getFlightSearchState(context);
  return {
    onds: state.onds,
    trip_type: state.trip_type,
    passengers: state.passengers,
    cabin_class: state.cabin_class,
  };
}

test('route-only update reuses existing dates and can execute flight_search', async () => {
  const context = existingRoundTripContext();
  mergeFlightAgentContext(null, context);
  mergeFlightAgentContext(context, routeOnlyContext());

  assert.deepEqual(getFlightSearchState(context).onds, [
    {
      origin: 'LAX',
      destination: 'LAS',
      outbound_date: '2026-08-20',
      return_date: '2026-08-27',
    },
  ]);
  assert.equal(hasRequiredFlightSearchFields(context), true);
  assert.match(buildActiveSearchSummary(context), /2026-08-20/);
  assert.match(buildActiveSearchSummary(context), /2026-08-27/);

  await FlightSearchTool.invoke({ context }, JSON.stringify(toFlightSearchPayload(context)), {});
  assert.deepEqual(context.toolCallLog.map((entry) => entry.tool), ['flight_search']);
  assert.equal(context.toolCallLog[0].input.onds[0].outbound_date, '2026-08-20');
  assert.match(FLIGHT_PROMPT, /route-only change[\s\S]*keep existing outbound and return dates/i);
});

test('route change preserves the existing return date and round-trip type', () => {
  const context = existingRoundTripContext();
  mergeFlightAgentContext(context, routeOnlyContext('SFO', 'SEA'));

  const state = getFlightSearchState(context);
  assert.equal(state.return_date, '2026-08-27');
  assert.equal(state.trip_type, 'roundtrip');
  assert.equal(state.onds[0].return_date, '2026-08-27');
});

test('explicit outbound date update overrides the old date', () => {
  const context = existingRoundTripContext();
  mergeFlightAgentContext(context, {
    flight: { outboundDate: '2026-07-15' },
  });

  assert.equal(context.flight.outboundDate, '2026-07-15');
  assert.equal(context.flight.inboundDate, '2026-08-27');
});

test('route without any stored date remains incomplete and exposes no invented date', () => {
  const context = routeOnlyContext();
  mergeFlightAgentContext(null, context);

  assert.equal(hasRequiredFlightSearchFields(context), false);
  assert.equal(context.flight.outboundDate, null);
  assert.doesNotMatch(buildActiveSearchSummary(context), /2026-/);
});
