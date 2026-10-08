export interface FlightEndpoint {
  userCity: string | null;
  airportIATA: string | null;
  airportName?: string | null;
}

export interface FlightSegment {
  date: string;
  origin: string;
  destination: string;
  origin_iata?: string | null;
  destination_iata?: string | null;
  origin_airport_name?: string | null;
  destination_airport_name?: string | null;
}

export interface PassengerData {
  total: number;
  adults: number;
  seniors: number;
  children: number;
  lapInfants: number;
  seatInfants: number;
  childrenAges: number[];
}

export interface FlightContract extends Record<string, unknown> {
  display?: boolean;
}

export interface FlightContext extends Record<string, unknown> {
  pax: number;
  uid: string;
  cntKey: string;
  deeplink: string | null;
  tripType: string;
  searchKey: string;
  cabinClass: string;
  showFlight: boolean;
  inboundDate: string;
  redirectUrl: string | null;
  outboundDate: string | null;
  bookingStatus: string | null;
  segments: FlightSegment[];
  passengerData: PassengerData;
  searchResults: unknown;
  departAirports: unknown[];
  resolvedOrigin: FlightEndpoint;
  depLandAirports: unknown[];
  resolvedDestination: FlightEndpoint;
  directFlightOnly: boolean;
  totalResultsFound: number;
  _awaitingWebSearch: boolean;
  suggestedQuestions: string[];
  lastPricePrediction: unknown;
  airlineFilterOptions: unknown;
  layoverAirportFilterOptions: unknown;
  flight_estimated_cost_total: number | null;
  flight_estimated_cost_per_person: number | null;
}

export interface FlightAppContext extends Record<string, unknown> {
  requestId?: string | null;
  sessionId?: string | null;
  flight: FlightContext;
  tripPlanner?: Record<string, unknown>;
  summaryContext?: Record<string, unknown>;
  toolCallLog: unknown[];
}

export interface FlightSearchRuntime {
  sourceFlights: FlightContract[];
  visibleFlights: FlightContract[];
  appliedFilters: unknown[];
  finalFilterPayload: unknown[];
  lastApplyFilterPayload: unknown;
  feedback: unknown[];
}

export interface FlightDateRange {
  startDate: string;
  endDate: string;
}
