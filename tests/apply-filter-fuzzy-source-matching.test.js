import assert from 'node:assert/strict';
import test from 'node:test';

process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { ApplyFilterTool } = await import('../src/flight-agent/tools/index.js');

const airlineFilterOptions = [
  { Code: 'AC', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'AC+', Text: 'Air Canada', Name: 'Air Canada', IsDisabled: false },
  { Code: 'EK', Text: 'Emirates', Name: 'Emirates', IsDisabled: false },
  { Code: '6E', Text: 'IndiGo', Name: 'IndiGo', IsDisabled: true },
];

const layoverAirportFilterOptions = [
  { Code: 'AMS', Text: 'Amsterdam Schiphol', Name: null, AirportCityName: 'Amsterdam', IsDisabled: false },
  { Code: 'DXB', Text: 'Dubai', Name: null, AirportCityName: 'Dubai', IsDisabled: false },
  { Code: 'SIN', Text: 'Singapore Changi', Name: null, AirportCityName: 'Singapore', IsDisabled: true },
];

const airportOptions = [
  {
    Code: 'DXB',
    Text: 'Dubai International',
    Name: null,
    AirportCityName: 'Dubai',
    IsNearby: false,
    IsDisabled: false,
  },
  {
    Code: 'LAX',
    Text: 'Los Angeles Intl',
    Name: null,
    AirportCityName: 'Los Angeles',
    IsNearby: false,
    IsDisabled: false,
  },
  {
    Code: 'DIA',
    Text: 'Disabled Airport',
    Name: null,
    AirportCityName: 'Disabled City',
    IsNearby: false,
    IsDisabled: true,
  },
];

function parseToolResult(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function createContext() {
  return {
    UID: 'fuzzy-user',
    uid: 'fuzzy-user',
    searchKey: 'search-fuzzy-123',
    sid: 'search-fuzzy-123',
    requestId: 'fuzzy-request',
    sessionId: 'fuzzy-session',
    toolCallLog: [],
    airlineFilterOptions,
    layoverAirportFilterOptions,
    DepartAirports: airportOptions,
    DepLandAirports: airportOptions,
    flightResults: [],
    filteredFlightResults: [],
  };
}

function filterPayload({
  filterType,
  airlineNames = null,
  layoverAirportNames = null,
  departureAirportNames = null,
  arrivalAirportNames = null,
  rawUserFilter = null,
}) {
  return {
    filterType,
    filterCode: null,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    minPrice: null,
    maxPrice: null,
    airlineNames,
    layoverAirportNames,
    departureAirportNames,
    arrivalAirportNames,
    rawUserFilter,
  };
}

async function applyOneFilter(filter) {
  const context = createContext();
  const result = parseToolResult(
    await ApplyFilterTool.invoke({ context }, JSON.stringify({ filters: [filter] }), {}),
  );
  return { context, result };
}

function findFinalPayload(result, filterType) {
  return result.finalFilterPayload.find((filter) => filter.filterType === filterType);
}

test('misspelled airline Air Canda resolves to all Air Canada codes', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'airline',
      airlineNames: ['Air Canda'],
      rawUserFilter: 'Show only Air Canda flights',
    }),
  );

  assert.deepEqual(findFinalPayload(result, 'airline'), {
    filterType: 'airline',
    Values: ['AC,AC+'],
  });
  assert.match(result.feedback.join(' '), /Air Canada/);
  assert.deepEqual(result.filters.filter((filter) => filter.filterType === 'airline').map((filter) => filter.filterCode), [
    'AC',
    'AC+',
  ]);
});

test('misspelled airline Emrates resolves to Emirates', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'airline',
      airlineNames: ['Emrates'],
      rawUserFilter: 'Show Emrates flights',
    }),
  );

  assert.deepEqual(findFinalPayload(result, 'airline'), {
    filterType: 'airline',
    Values: ['EK'],
  });
  assert.match(result.feedback.join(' '), /Emirates/);
});

test('extra spaces and case normalize before airline matching', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'airline',
      airlineNames: ['  eMiRaTeS  '],
      rawUserFilter: '  eMiRaTeS  ',
    }),
  );

  assert.deepEqual(findFinalPayload(result, 'airline'), {
    filterType: 'airline',
    Values: ['EK'],
  });
  assert.equal(result.feedback.length, 0);
});

test('misspelled layover Amsterdem resolves to Amsterdam AMS', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'layoverAirport',
      layoverAirportNames: ['Amsterdem'],
      rawUserFilter: 'Show layover in Amsterdem',
    }),
  );

  assert.deepEqual(findFinalPayload(result, 'outboundlayover'), {
    filterType: 'outboundlayover',
    Values: ['AMS'],
  });
  assert.deepEqual(result.filters[0].layoverAirportNames, ['Amsterdam']);
});

test('misspelled airport Dubia resolves to Dubai DXB', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'departureAirport',
      departureAirportNames: ['Dubia'],
      rawUserFilter: 'Depart from Dubia',
    }),
  );

  assert.deepEqual(findFinalPayload(result, 'outbounddepart'), {
    filterType: 'outbounddepart',
    Values: ['DXB'],
  });
  assert.match(result.feedback.join(' '), /Dubai/);
});

test('disabled source option is ignored', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'airline',
      airlineNames: ['Indgo'],
      rawUserFilter: 'Show Indgo flights',
    }),
  );

  assert.equal(findFinalPayload(result, 'airline'), undefined);
  assert.match(result.feedback.join(' '), /requested airline was not found/i);
});

test('no confident source match does not apply a filter', async () => {
  const { result } = await applyOneFilter(
    filterPayload({
      filterType: 'arrivalAirport',
      arrivalAirportNames: ['Marsport'],
      rawUserFilter: 'Arrive at Marsport',
    }),
  );

  assert.equal(findFinalPayload(result, 'outboundarrival'), undefined);
  assert.match(result.feedback.join(' '), /requested arrival airport was not found/i);
});
