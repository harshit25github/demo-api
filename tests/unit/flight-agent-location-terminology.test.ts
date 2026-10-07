import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFlightAgentInstructions } from '../../src/agents/flight/agent.js';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import { FlightSearchTool } from '../../src/agents/flight/tools/search-tool.js';
import { PricePredictionTool } from '../../src/agents/flight/tools/price-prediction/tool.js';

test('static Flight prompt names route blockers for Manager feedback without traveler scripts', () => {
  assert.match(
    FLIGHT_PROMPT,
    /departure location \(internal field `origin`\), arrival location \(internal field `destination`\)/i,
  );
  assert.match(
    FLIGHT_PROMPT,
    /Delhi is already the arrival location.*departure location and travel date/i,
  );
  assert.match(FLIGHT_PROMPT, /put blockers in missingInformation/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /Please share your|end exactly with/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /ask for origin and destination/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /Origin\?", "Destination\?/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /Change destination to X/i);
});

test('assembled Flight instructions preserve dynamic location behavior', () => {
  const instructions = buildFlightAgentInstructions({
    context: {
      flight: {
        clock: {
          localDate: '2026-08-03',
          localDateTime: '2026-08-03T10:00:00+05:30',
          timeZone: 'Asia/Calcutta',
        },
      },
    },
  });
  const dynamicInstructions = instructions.slice(FLIGHT_PROMPT.length);

  assert.match(
    FLIGHT_PROMPT,
    /New user input overrides only fields explicitly mentioned/i,
  );
  assert.match(
    FLIGHT_PROMPT,
    /put blockers in missingInformation/i,
  );
  assert.match(
    dynamicInstructions,
    /Current Existing Search Parameters/i,
  );
  assert.match(dynamicInstructions, /actually make it X/i);
  assert.match(dynamicInstructions, /updated arrival location/i);
  assert.match(
    dynamicInstructions,
    /Do not ask again for departure location, arrival location, dates/i,
  );
  assert.match(dynamicInstructions, /missing the departure location or arrival location/i);
  assert.doesNotMatch(instructions, /Do not ask again for origin, destination/i);
  assert.doesNotMatch(instructions, /change destination to X/i);
});

test('Flight tool contracts retain their original internal field names', () => {
  const routeFields =
    FlightSearchTool.parameters.properties.onds.items.properties;
  assert.deepEqual(Object.keys(routeFields), [
    'origin',
    'destination',
    'origin_iata',
    'destination_iata',
    'origin_airport_name',
    'destination_airport_name',
    'outbound_date',
    'return_date',
  ]);

  const predictionFields = Object.keys(PricePredictionTool.parameters.properties);
  assert.ok(predictionFields.includes('originCity'));
  assert.ok(predictionFields.includes('destinationCity'));
  assert.equal(predictionFields.includes('departureLocation'), false);
  assert.equal(predictionFields.includes('arrivalLocation'), false);
});
