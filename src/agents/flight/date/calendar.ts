export const DAY_MS = 24 * 60 * 60 * 1000;
export const PRICE_PREDICTION_WINDOW_DAYS = 89;
export const FLIGHT_SEARCH_WINDOW_DAYS = 359;

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

export function differenceInDays(laterDate: Date, earlierDate: Date): number {
  return Math.round((laterDate.getTime() - earlierDate.getTime()) / DAY_MS);
}

export function dateLimitsFromLocalDate(localDate: string, windowDays: number) {
  const today = parseIsoDate(localDate);
  if (!today) {
    throw new Error('localDate must be a valid YYYY-MM-DD date.');
  }

  return {
    today,
    yesterday: addDays(today, -1),
    maxDate: addDays(today, windowDays),
    todayString: toIsoDate(today),
    yesterdayString: toIsoDate(addDays(today, -1)),
    maxDateString: toIsoDate(addDays(today, windowDays)),
  };
}

export function getPricePredictionDateLimits(now = new Date()) {
  const today = startOfUtcDay(now);
  return dateLimitsFromLocalDate(toIsoDate(today), PRICE_PREDICTION_WINDOW_DAYS);
}

export function getFlightSearchDateLimits(localDate: string) {
  return dateLimitsFromLocalDate(localDate, FLIGHT_SEARCH_WINDOW_DAYS);
}
