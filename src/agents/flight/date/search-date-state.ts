function nonEmptyDateString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function firstFlightSearchDate(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = nonEmptyDateString(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function mergeFlightSearchDates(
  base: Partial<FlightSearchDates> = {},
  update: Partial<FlightSearchDates> = {},
): Pick<FlightSearchDates, 'outbound_date' | 'return_date'> {
  return {
    outbound_date: update.outbound_date || base.outbound_date || null,
    return_date:
      update.trip_type === 'oneway'
        ? null
        : update.return_date || base.return_date || null,
  };
}
import type { FlightSearchDates } from '../types.js';

