/** Independent expected values for the current search/filter fixture backend. */
export type FilterValues = Record<string, readonly (string | number)[]>;

export const expectedFilterValues: Record<string, readonly FilterValues[]> = {
  normalization_fewshots: [
    {},
    { stops: ['0'], departureTime: ['MORNING'], price: [220], baggage: ['1'] },
    { stops: ['0'], departureTime: ['EVENING'] },
    { stops: ['0'], departureTime: ['EVENING'] },
    { airline: ['AC', 'AC+', 'EK'], layoverDuration: [90] },
    { airline: ['AC', 'AC+', 'EK'], layoverDuration: [90] },
    { airline: ['AC', 'AC+'] },
    { airline: ['AC', 'AC+'] },
  ],
  compound_filters_route_change: [
    {},
    { stops: ['0'], departureTime: ['MORNING'], price: [220], baggage: ['1'] },
    { stops: ['0'], departureTime: ['EVENING'] },
    { departureTime: ['EVENING'], airline: ['CA'], totalDuration: [240] },
    { departureTime: ['EVENING'], airline: ['CA'], totalDuration: [240] },
    { airline: ['CA'] },
    { airline: ['CA'] },
    { airline: ['CA'], stops: ['0'] },
  ],
  roundtrip_airports_layovers: [
    {},
    { departureAirport: ['BUR'], arrivalAirport: ['EWR'], stops: ['2'], baggage: ['0'], layoverDuration: [120] },
    { departureAirport: ['LAX', 'BUR', 'ONT', 'SNA'], stops: ['2'], layoverDuration: [120], layoverAirport: ['DXB', 'AMS'], arrivalTime: ['EVENING'] },
    { departureAirport: ['LAX', 'BUR', 'ONT', 'SNA'], stops: ['2'], arrivalTime: ['MORNING'], totalDuration: [180] },
    { departureAirport: ['LAX', 'BUR', 'ONT', 'SNA'], arrivalTime: ['MORNING'], totalDuration: [180] },
    { arrivalTime: ['MORNING'], totalDuration: [180] },
    {}, {}, {}, {}, {},
  ],
  clarification_relative_context: [
    {}, {},
    { airline: ['EK'], stops: ['2'], arrivalTime: ['EVENING'], layoverDuration: [180] },
    { stops: ['2'], arrivalTime: ['EVENING'], layoverDuration: [180], departureTime: ['AFTERNOON'] },
    { stops: ['2'], departureTime: ['AFTERNOON'], arrivalTime: ['MORNING'], airline: ['AC', 'AC+'] },
    { stops: ['2'], departureTime: ['AFTERNOON'], arrivalTime: ['MORNING'], airline: ['AC', 'AC+'], departureAirport: ['DEL'] },
    { airline: ['AC', 'AC+'], arrivalTime: ['MORNING'] },
    { airline: ['AC', 'AC+'], arrivalTime: ['MORNING'] },
  ],
  reset_prediction_recommit: [
    {},
    { departureTime: ['EARLYMORNING'], arrivalTime: ['AFTERNOON'], baggage: ['2'], stops: ['3'], price: [175] },
    { departureTime: ['EARLYMORNING'], arrivalTime: ['AFTERNOON'], baggage: ['2'], stops: ['3'], price: [175] },
    { stops: ['2'], baggage: ['0'], layoverAirport: ['DXB'], totalDuration: [240] },
    { totalDuration: [240], stops: ['0'], baggage: ['1'], arrivalTime: ['MORNING'] },
    { totalDuration: [240], stops: ['0'], baggage: ['1'], arrivalTime: ['MORNING'] },
    { stops: ['0'], baggage: ['1'], arrivalTime: ['MORNING'], totalDuration: [240] },
    { stops: ['0'], baggage: ['1'], arrivalTime: ['MORNING'], totalDuration: [240] },
    {},
  ],
  deep_filter_state_search_changes: [
    {},
    { stops: ['0'], departureTime: ['EVENING'], price: [250], totalDuration: [180], baggage: ['2'] },
    { departureTime: ['AFTERNOON'], stops: ['2'], baggage: ['0'], totalDuration: [180], airline: ['CA'] },
    { departureTime: ['AFTERNOON'], stops: ['2'], baggage: ['0'], totalDuration: [180], airline: ['CA'], layoverAirport: ['DXB'], layoverDuration: [60], arrivalTime: ['EVENING'] },
    { departureTime: ['AFTERNOON'], stops: ['2'], baggage: ['0'], totalDuration: [180], airline: ['AC', 'AC+', 'EK'], layoverAirport: ['DXB'], layoverDuration: [60], arrivalTime: ['EVENING'] },
    { departureTime: ['AFTERNOON'], stops: ['2'], baggage: ['0'], totalDuration: [180], airline: ['AC', 'AC+', 'EK'], layoverAirport: ['DXB'], layoverDuration: [60], arrivalTime: ['EVENING'] },
    { stops: ['2'], departureTime: ['AFTERNOON'], arrivalTime: ['EVENING'], baggage: ['0'], totalDuration: [180], layoverAirport: ['DXB'], layoverDuration: [60] },
    { stops: ['2'], departureTime: ['AFTERNOON'], arrivalTime: ['EVENING'], baggage: ['0'], totalDuration: [180], layoverAirport: ['DXB'], layoverDuration: [60] },
    { stops: ['2'], departureTime: ['AFTERNOON'], arrivalTime: ['EVENING'], baggage: ['0'], totalDuration: [180], layoverAirport: ['DXB'], layoverDuration: [60] },
  ],
};

export const expectedPredictionInput: Record<string, Record<number, Record<string, string | number>>> = {
  normalization_fewshots: { 7: { originCity: 'DEL', destinationCity: 'NYC', startDate: '2026-10-21', endDate: '2026-10-28', tripType: 'oneway' } },
  compound_filters_route_change: { 6: { originCity: 'NYC', destinationCity: 'LAX', startDate: '2026-10-21', endDate: '2026-10-28', tripType: 'oneway' } },
  roundtrip_airports_layovers: { 6: { originCity: 'LAX', destinationCity: 'NYC', startDate: '2026-11-01', endDate: '2026-11-05', returnStartDate: '2026-11-08', returnEndDate: '2026-11-12', tripType: 'roundtrip', tripDuration: 7, tripDurationFlexibility: 0 } },
  clarification_relative_context: { 2: { originCity: 'DEL', destinationCity: 'DXB', startDate: '2026-10-12', endDate: '2026-10-18', tripType: 'oneway' } },
  reset_prediction_recommit: { 6: { originCity: 'SFO', destinationCity: 'TYO', startDate: '2026-11-16', endDate: '2026-11-23', tripType: 'oneway' } },
  deep_filter_state_search_changes: { 8: { originCity: 'DEL', destinationCity: 'DXB', startDate: '2026-12-08', endDate: '2026-12-15', returnStartDate: '2026-12-15', returnEndDate: '2026-12-22', tripType: 'roundtrip', tripDuration: 7, tripDurationFlexibility: 0 } },
};

/**
 * Independent leaf-level oracles for model-generated search arguments. A list
 * means any listed value is correct: a city code the model knows, or null.
 */
export type PayloadOracle = Record<string, string | number | null | readonly (string | null)[]>;

const delhiToNewYork = {
  'onds.0.origin': 'Delhi', 'onds.0.destination': ['New York', 'New York City'],
  'onds.0.origin_iata': 'DEL', 'onds.0.destination_iata': 'NYC',
  'onds.0.origin_airport_name': null, 'onds.0.destination_airport_name': null,
  'onds.0.return_date': null, trip_type: 'oneway', cabin_class: 'economy',
  'passengers.adults': 1, 'passengers.children': 0, 'passengers.infants': 0,
};
const NEW_YORK = ['New York', 'New York City'];
const oneAdultEconomy = {
  'passengers.adults': 1, 'passengers.children': 0, 'passengers.infants': 0, cabin_class: 'economy',
};
const noAirportNames = { 'onds.0.origin_airport_name': null, 'onds.0.destination_airport_name': null };

export const expectedSearchPayload: Record<string, Record<number, PayloadOracle>> = {
  normalization_fewshots: {
    1: { ...delhiToNewYork, 'onds.0.outbound_date': '2026-10-20' },
    7: { ...delhiToNewYork, 'onds.0.outbound_date': '2026-10-21' },
    8: { ...delhiToNewYork, 'onds.0.destination': 'London', 'onds.0.destination_iata': 'LHR',
      'onds.0.destination_airport_name': ['London Heathrow Airport', 'London Heathrow'], 'onds.0.outbound_date': '2026-10-21' },
  },
  compound_filters_route_change: {
    // "New York (NYC) to Los Angeles LAX"
    1: { ...oneAdultEconomy, ...noAirportNames, trip_type: 'oneway', 'onds.length': 1,
      'onds.0.origin': NEW_YORK, 'onds.0.origin_iata': 'NYC',
      'onds.0.destination': 'Los Angeles', 'onds.0.destination_iata': 'LAX',
      'onds.0.outbound_date': '2026-10-20', 'onds.0.return_date': null },
    // Unavailable prediction: the single fallback search is the earliest in-window day.
    6: { ...oneAdultEconomy, trip_type: 'oneway',
      'onds.0.origin': NEW_YORK, 'onds.0.origin_iata': 'NYC',
      'onds.0.destination': 'Los Angeles', 'onds.0.destination_iata': 'LAX',
      'onds.0.outbound_date': '2026-10-21', 'onds.0.return_date': null },
    // "Newark (EWR)": a city plus its code, no invented airport name.
    7: { ...oneAdultEconomy, ...noAirportNames, trip_type: 'oneway',
      'onds.0.origin': 'Newark', 'onds.0.origin_iata': 'EWR',
      'onds.0.destination': 'Los Angeles', 'onds.0.destination_iata': 'LAX' },
  },
  roundtrip_airports_layovers: {
    // "Los Angeles, California to New York, NY": no state text in names.
    1: { ...noAirportNames, trip_type: 'roundtrip', cabin_class: 'business', 'passengers.adults': 2,
      'onds.0.origin': 'Los Angeles', 'onds.0.origin_iata': [null, 'LAX'],
      'onds.0.destination': NEW_YORK, 'onds.0.destination_iata': [null, 'NYC'],
      'onds.0.outbound_date': '2026-10-30', 'onds.0.return_date': '2026-11-06' },
    6: { trip_type: 'roundtrip', cabin_class: 'business', 'passengers.adults': 2,
      'onds.0.origin': 'Los Angeles', 'onds.0.destination': NEW_YORK },
    // "Boston, Massachusetts": stale New York details dropped.
    7: { trip_type: 'roundtrip', cabin_class: 'business', 'passengers.adults': 2,
      'onds.0.origin': 'Los Angeles', 'onds.0.destination': 'Boston',
      'onds.0.destination_iata': [null, 'BOS'], 'onds.0.destination_airport_name': null },
    11: { trip_type: 'multicity', cabin_class: 'business', 'passengers.adults': 2, 'onds.length': 3,
      'onds.0.origin': 'Los Angeles', 'onds.0.destination': NEW_YORK, 'onds.0.outbound_date': '2026-11-10',
      'onds.1.origin': NEW_YORK, 'onds.1.destination': 'Boston', 'onds.1.outbound_date': '2026-11-14',
      'onds.2.origin': 'Boston', 'onds.2.destination': 'Los Angeles', 'onds.2.outbound_date': '2026-11-18' },
  },
  clarification_relative_context: {
    // "Delhi (DEL), India"
    2: { ...oneAdultEconomy, ...noAirportNames, trip_type: 'oneway',
      'onds.0.origin': 'Delhi', 'onds.0.origin_iata': 'DEL',
      'onds.0.destination': 'Dubai', 'onds.0.destination_iata': [null, 'DXB'], 'onds.0.return_date': null },
    // "Mumbai, India (BOM)"
    7: { ...oneAdultEconomy, ...noAirportNames, trip_type: 'oneway',
      'onds.0.origin': 'Mumbai', 'onds.0.origin_iata': 'BOM', 'onds.0.destination': 'Dubai' },
  },
  reset_prediction_recommit: {
    // "SFO San Francisco to Tokyo, Japan"
    1: { ...oneAdultEconomy, ...noAirportNames, trip_type: 'oneway',
      'onds.0.origin': 'San Francisco', 'onds.0.origin_iata': 'SFO',
      'onds.0.destination': 'Tokyo', 'onds.0.destination_iata': [null, 'TYO'],
      'onds.0.outbound_date': '2026-11-15', 'onds.0.return_date': null },
    7: { ...oneAdultEconomy, trip_type: 'oneway',
      'onds.0.origin': 'San Francisco', 'onds.0.origin_iata': 'SFO', 'onds.0.destination': 'Tokyo',
      'onds.0.outbound_date': '2026-11-20', 'onds.0.return_date': null },
    9: { ...oneAdultEconomy, trip_type: 'roundtrip',
      'onds.0.origin': 'San Francisco', 'onds.0.destination': 'Tokyo',
      'onds.0.outbound_date': '2026-11-20', 'onds.0.return_date': '2026-11-27' },
  },
  deep_filter_state_search_changes: {
    // "DEL Delhi to Dubai DXB"
    1: { ...noAirportNames, trip_type: 'roundtrip', cabin_class: 'economy', 'passengers.adults': 2,
      'onds.0.origin': 'Delhi', 'onds.0.origin_iata': 'DEL',
      'onds.0.destination': 'Dubai', 'onds.0.destination_iata': 'DXB',
      'onds.0.outbound_date': '2026-12-05', 'onds.0.return_date': '2026-12-12' },
    7: { trip_type: 'roundtrip', cabin_class: 'business', 'passengers.adults': 3,
      'onds.0.origin': 'Delhi', 'onds.0.origin_iata': 'DEL',
      'onds.0.destination': 'Dubai', 'onds.0.destination_iata': 'DXB',
      'onds.0.outbound_date': '2026-12-05', 'onds.0.return_date': '2026-12-12' },
  },
};
