import assert from 'node:assert/strict';
import test from 'node:test';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import { flightTools } from '../../src/agents/flight/tools/index.js';
import { validateFlightSearchInput } from '../../src/agents/flight/tools/search-tool.js';
import { buildPricePredictionRouteSummary } from '../../src/agents/flight/context/prompt-summary.js';
import { mergeFlightAgentContext, getFlightSearchState, createProdFlightContext } from '../../src/agents/flight/context/flight-context.js';
import { buildManagerInstructions } from '../../src/agents/manager-orchestrator/manager-prompt.js';
import { buildFlightAgentInstructions } from '../../src/agents/flight/agent.js';

test('Manager carries historical used actions before a current reset and preserves date-choice scope', () => {
  const instructions = buildManagerInstructions({ context: {} });
  assert.match(instructions, /For a removal, replacement, or reset requested now/);
  assert.match(instructions, /historical used\/reversed actions; not active or pending constraints/);
  assert.match(instructions, /do not suggest these actions again on this unchanged trip/);
  assert.match(instructions, /Every later Flight subtask on that unchanged trip must carry the same compact historical note/);
  assert.match(instructions, /A flexible date bracket means choosing a travel date within it/);
  assert.match(instructions, /Preserve each original filter clause without explanatory negations/);
  assert.match(buildFlightAgentInstructions({ context: {} }), /historical used\/reversed-action note as an exclusion checklist/);
});

test('active few-shots cover the registered tools without inventing a date tool', () => {
  const examples = FLIGHT_PROMPT.split('## Compact tool examples')[1]?.split('## Final response')[0];
  assert.ok(examples);
  for (const tool of flightTools) assert.ok(examples.includes(`### ${tool.name}`), tool.name);
  assert.match(examples, /date resolution is not a callable tool/);
  assert.match(examples, /never reset filters to manufacture a ranking/);
  assert.match(examples, /never call another tool after a successful update/);
  assert.match(examples, /NO_PREDICTIONS.*fallback search.*not a verified cheapest date/);
  assert.match(examples, /Do not run or offer a day-by-day search sweep/);
  assert.match(examples, /nextStep=null; do not solicit more dates for manual comparison/);
  assert.match(examples, /Clearing filters does not make consumed actions new/);
  assert.match(examples, /later search\/filter did not erase the failed date lookup/);
  assert.match(examples, /BUR-only active.*departureAirportNames=\["all departure airports"\]/);
  assert.match(examples, /Do not add "remove BUR-only" to that replacement clause/);
  assert.match(examples, /filterType: "stops", filterCode: "2", rawUserFilter: "Allow one stop"/);
  // Keep demonstrations bounded rather than copying the production reference.
  assert.ok(examples.split(/\s+/).length < 1200);
});

test('separated IATA fields validate and mixed names fail before search mutation', () => {
  const input = {
    onds: [{ origin: 'Delhi', destination: 'New York', origin_iata: 'DEL', destination_iata: 'NYC',
      origin_airport_name: null, destination_airport_name: null,
      outbound_date: '2026-10-20', return_date: null }],
    trip_type: 'oneway' as const, passengers: { adults: 1, children: 0, infants: 0 }, cabin_class: 'economy' as const,
  };
  assert.equal(validateFlightSearchInput(input, '2026-10-05'), null);
  const mixed = structuredClone(input);
  mixed.onds[0].origin = 'Delhi DEL';
  mixed.onds[0].destination = 'New York NYC';
  const failure = validateFlightSearchInput(mixed, '2026-10-05');
  assert.equal(failure?.code, 'INVALID_SEARCH_INPUT');
  assert.deepEqual(failure?.recovery.fieldIssues.map((issue) => issue.path), ['onds.0.origin', 'onds.0.destination']);
  assert.equal(failure?.recovery.stateChanged, false);
  assert.ok(validateFlightSearchInput({ ...input, onds: [{ ...input.onds[0], destination_iata: 'London LHR' }] }));
});

test('separated endpoint details survive hydration but never attach to a changed city', () => {
  const context: any = {};
  mergeFlightAgentContext(context, { flight: {
    segments: [{ date: '2026-10-20', origin: 'Delhi', destination: 'London',
      origin_iata: 'DEL', destination_iata: 'LHR', destination_airport_name: 'London Heathrow Airport' }],
  } });
  let state = getFlightSearchState(context);
  assert.equal(state.onds[0].destination, 'London');
  assert.equal(state.onds[0].destination_iata, 'LHR');
  assert.equal(context.flight.resolvedDestination.airportName, 'London Heathrow Airport');
  assert.equal(buildPricePredictionRouteSummary(context), 'DEL to LHR');
  mergeFlightAgentContext(context, { flight: { outboundDate: '2026-10-21' } });
  state = getFlightSearchState(context);
  assert.equal(state.onds[0].destination_iata, 'LHR');
  mergeFlightAgentContext(context, { flight: { segments: [{ date: '', origin: 'Delhi', destination: 'Paris' }] } });
  state = getFlightSearchState(context);
  assert.equal(state.onds[0].destination, 'Paris');
  assert.equal(state.onds[0].destination_iata, null);
  assert.equal(state.onds[0].destination_airport_name, null);
  assert.equal(state.onds[0].outbound_date, '2026-10-21');
});

test('raw separated segments hydrate resolved airport constraints before any tool runs', () => {
  const context = { flight: createProdFlightContext({ onds: [{ origin: 'Delhi', destination: 'London',
    origin_iata: 'DEL', destination_iata: 'LHR', destination_airport_name: 'London Heathrow Airport',
    outbound_date: '2026-10-20', return_date: null }] }) };
  assert.equal(context.flight.resolvedDestination.airportIATA, 'LHR');
  assert.equal(context.flight.resolvedDestination.airportName, 'London Heathrow Airport');
  assert.equal(buildPricePredictionRouteSummary(context), 'DEL to LHR');
});

test('an airport-code change within the same city clears an unconfirmed old airport name', () => {
  const context: any = {};
  mergeFlightAgentContext(context, { flight: { segments: [{ date: '2026-10-20', origin: 'Delhi', destination: 'New York',
    origin_iata: 'DEL', destination_iata: 'JFK', destination_airport_name: 'John F. Kennedy International Airport' }] } });
  mergeFlightAgentContext(context, { flight: { segments: [{ date: '', origin: 'Delhi', destination: 'New York',
    destination_iata: 'EWR' }] } });
  const state = getFlightSearchState(context);
  assert.equal(state.onds[0].destination_iata, 'EWR');
  assert.equal(state.onds[0].destination_airport_name, null);
  assert.equal(state.onds[0].outbound_date, '2026-10-20');
});
