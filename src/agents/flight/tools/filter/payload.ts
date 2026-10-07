import type { FlightContract } from '../../types.js';
import type { FilterPayload, FlightFilter } from './normalization.js';

interface FilterableFlight extends FlightContract {
  stops?: number;
  baggage?: string[];
  departure_time_window?: string;
  arrival_time_window?: string;
  total_duration_minutes?: number;
  layover_duration_minutes?: number;
  price?: { amount?: number };
  airline_code?: string;
  layover_airport_codes?: string[];
  departure_airport_code?: string;
  arrival_airport_code?: string;
}

const durationFilterTypes = ['totalDuration', 'layoverDuration'];

const apiFilterTypeByToolType: Record<string, string> = {
  "stops": "stop",
  "departureTime": "departtimeslotfilter",
  "arrivalTime": "departlandtimeslotfilter",
  "baggage": "baggage",
  "airline": "airline",
  "layoverAirport": "outboundlayover",
  "departureAirport": "outbounddepart",
  "arrivalAirport": "outboundarrival",
  "price": "price",
  "totalDuration": "departdurationfilter",
  "layoverDuration": "departlayoverfilter",
  "reset": "reset"
};

const orderedFilterTypes = ["stops","departureTime","arrivalTime","baggage","airline","layoverAirport","departureAirport","arrivalAirport","price","totalDuration","layoverDuration","reset"];

const stopFilterCodes = ['0', '2', '3'];

function normalizeStopApiCode(filterCode: string | null): string | null {
  if (filterCode && stopFilterCodes.includes(filterCode)) return filterCode;
  const numericCode = Number(filterCode);
  if (!Number.isInteger(numericCode)) return null;
  if (numericCode >= 3) return '3';
  if (numericCode === 1) return '2';
  return null;
}
export function buildFinalFilterPayload(filters: FlightFilter[]): FilterPayload[] {
  const groupedValues = new Map<string, Array<string | number>>();

  for (const filter of filters) {
    const apiFilterType = apiFilterTypeByToolType[filter.filterType];
    if (!apiFilterType) {
      continue;
    }

    if (durationFilterTypes.includes(filter.filterType)) {
      if (filter.maxDurationMinutes !== null) {
        groupedValues.set(apiFilterType, [0, filter.maxDurationMinutes]);
      }
      continue;
    }

    if (filter.filterType === 'price') {
      if (filter.maxPrice !== null) {
        groupedValues.set(apiFilterType, [0, filter.maxPrice]);
      }
      continue;
    }

    const payloadFilterCode =
      filter.filterType === 'stops'
        ? normalizeStopApiCode(filter.filterCode)
        : filter.filterCode;

    if (!payloadFilterCode) {
      continue;
    }

    const values = groupedValues.get(apiFilterType) || [];
    if (!values.includes(payloadFilterCode)) {
      values.push(payloadFilterCode);
    }
    groupedValues.set(apiFilterType, values);
  }

  return orderedFilterTypes
    .map((filterType) => {
      const apiFilterType = apiFilterTypeByToolType[filterType];
      const values = groupedValues.get(apiFilterType);

      if (!values) {
        return null;
      }

      if (
        filterType === 'stops' ||
        filterType === 'airline' ||
        filterType === 'layoverAirport' ||
        filterType === 'departureAirport' ||
        filterType === 'arrivalAirport'
      ) {
        return {
          filterType: apiFilterType,
          Values: [values.join(',')],
        };
      }

      return {
        filterType: apiFilterType,
        Values: values,
      };
    })
    .filter((payload): payload is FilterPayload => payload !== null);
}

function matchesStopCode(flight: FilterableFlight, filterCode: string | null): boolean {
  if (filterCode === '0') {
    return flight.stops === 0;
  }
  if (filterCode === '2') {
    return flight.stops === 1;
  }
  if (filterCode === '3') {
    return typeof flight.stops === 'number' && flight.stops >= 2;
  }
  return true;
}

function matchesDurationMinutes(
  value: number | undefined,
  { maxDurationMinutes }: FlightFilter,
): boolean {
  if (typeof value !== 'number') {
    return false;
  }
  if (maxDurationMinutes !== null && value > maxDurationMinutes) {
    return false;
  }
  return true;
}

function matchesPrice(value: number | undefined, { maxPrice }: FlightFilter): boolean {
  if (typeof value !== 'number') {
    return false;
  }
  if (maxPrice !== null && value > maxPrice) {
    return false;
  }
  return true;
}

function matchesApiFilter(flight: FilterableFlight, filter: FlightFilter): boolean {
  if (filter.filterType === 'baggage') {
    return !filter.filterCode || (flight.baggage?.includes(filter.filterCode) ?? false);
  }
  if (filter.filterType === 'departureTime') {
    return !filter.filterCode || flight.departure_time_window === filter.filterCode;
  }
  if (filter.filterType === 'arrivalTime') {
    return !filter.filterCode || flight.arrival_time_window === filter.filterCode;
  }
  if (filter.filterType === 'stops') {
    return matchesStopCode(flight, filter.filterCode);
  }
  if (filter.filterType === 'totalDuration') {
    return matchesDurationMinutes(flight.total_duration_minutes, filter);
  }
  if (filter.filterType === 'layoverDuration') {
    return matchesDurationMinutes(flight.layover_duration_minutes, filter);
  }
  if (filter.filterType === 'price') {
    return matchesPrice(flight.price?.amount, filter);
  }
  if (filter.filterType === 'airline') {
    return flight.airline_code === filter.filterCode;
  }
  if (filter.filterType === 'layoverAirport') {
    return Boolean(
      filter.filterCode && flight.layover_airport_codes?.includes(filter.filterCode),
    );
  }
  if (filter.filterType === 'departureAirport') {
    return flight.departure_airport_code === filter.filterCode;
  }
  if (filter.filterType === 'arrivalAirport') {
    return flight.arrival_airport_code === filter.filterCode;
  }
  return true;
}

export function applyFilters(
  flights: FlightContract[],
  filters: FlightFilter[],
): FlightContract[] {
  // Dummy-only local filtering. Real integration should use the API response.
  const filtersByType = filters.reduce<Record<string, FlightFilter[]>>((groups, filter) => {
    groups[filter.filterType] ||= [];
    groups[filter.filterType].push(filter);
    return groups;
  }, {});

  return flights.filter((flight) =>
    Object.values(filtersByType).every((filterGroup) =>
      filterGroup.some((filter) => matchesApiFilter(flight as FilterableFlight, filter)),
    ),
  );
}

export function getSearchResultFlights(searchResults: unknown): FlightContract[] {
  if (Array.isArray(searchResults)) {
    return searchResults;
  }
  if (!searchResults || typeof searchResults !== 'object') {
    return [];
  }
  return (
    ('flights' in searchResults && Array.isArray(searchResults.flights) && searchResults.flights) ||
    ('contracts' in searchResults && Array.isArray(searchResults.contracts) && searchResults.contracts) ||
    ('results' in searchResults && Array.isArray(searchResults.results) && searchResults.results) ||
    ('data' in searchResults && Array.isArray(searchResults.data) && searchResults.data) ||
    []
  );
}
