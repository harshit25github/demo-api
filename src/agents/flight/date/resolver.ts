import {
  addDays,
  differenceInDays,
  FLIGHT_SEARCH_WINDOW_DAYS,
  getFlightSearchDateLimits,
  parseIsoDate,
  PRICE_PREDICTION_WINDOW_DAYS,
  toIsoDate,
} from './calendar.js';
import type {
  FlightDateIntentInput,
  FlightDateResolution,
  FlightSearchDates,
} from '../types.js';
import type { RequestClock } from '../../../shared/time/request-clock.js';
import type {
  FlightToolFieldIssue,
  FlightToolRecoveryKind,
} from '../tools/recovery.js';

const WEEKDAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

type WeekdayName = keyof typeof WEEKDAY_INDEX;

interface ResolvedRawRange {
  startDate: Date;
  endDate: Date;
  label: string;
}

function validPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function firstDayOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function lastDayOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

function normalizedWeekday(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const candidate = value.trim().toLowerCase();
  if (!candidate) {
    return null;
  }
  const exact = WEEKDAY_INDEX[candidate as WeekdayName];
  if (exact !== undefined) {
    return exact;
  }

  const match = Object.entries(WEEKDAY_INDEX).find(([name]) => name.startsWith(candidate));
  return match ? match[1] : null;
}

function nextOccurrence(today: Date, weekdayIndex: number, includeToday: boolean): Date {
  let offset = (weekdayIndex - today.getUTCDay() + 7) % 7;
  if (offset === 0 && !includeToday) {
    offset = 7;
  }
  return addDays(today, offset);
}

function mondayForWeek(today: Date): Date {
  const offset = today.getUTCDay() === 0 ? -6 : 1 - today.getUTCDay();
  return addDays(today, offset);
}

function deriveExistingTripDuration(
  existingSearch: Partial<FlightSearchDates> = {},
): number | null {
  const outboundDate = parseIsoDate(existingSearch.outbound_date);
  const returnDate = parseIsoDate(existingSearch.return_date);
  if (!outboundDate || !returnDate || returnDate < outboundDate) {
    return null;
  }

  return differenceInDays(returnDate, outboundDate);
}

function invalidResult({
  message,
  kind = 'input',
  retrySafe = kind === 'input',
  fieldIssues = [],
}: {
  message: string;
  kind?: FlightToolRecoveryKind;
  retrySafe?: boolean;
  fieldIssues?: FlightToolFieldIssue[];
}): FlightDateResolution {
  return {
    status: 'INVALID_INTENT',
    range: null,
    searchDate: null,
    returnDate: null,
    assumptionLabel: message,
    recovery: {
      kind,
      retrySafe,
      stateChanged: false,
      ...(fieldIssues.length > 0 ? { fieldIssues } : {}),
    },
  };
}

function rawRangeForIntent(
  input: FlightDateIntentInput,
  today: Date,
): ResolvedRawRange | null {
  const kind = input.kind;
  const explicitRangeStart = parseIsoDate(input.rangeStart);
  const explicitRangeEnd = parseIsoDate(input.rangeEnd);

  if (explicitRangeStart && explicitRangeEnd && explicitRangeStart <= explicitRangeEnd) {
    return {
      startDate: explicitRangeStart,
      endDate: explicitRangeEnd,
      label: kind === 'range' ? 'requested date range' : `preserved ${kind} range`,
    };
  }

  if (kind === 'exact') {
    const exactDate = parseIsoDate(input.exactDate);
    if (exactDate) {
      return {
        startDate: exactDate,
        endDate: exactDate,
        label: input.exactDate || toIsoDate(exactDate),
      };
    }
    const offset = input.offset;
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) {
      const relativeDate = addDays(today, offset);
      return {
        startDate: relativeDate,
        endDate: relativeDate,
        label: `${offset} days from ${toIsoDate(today)}`,
      };
    }
    return null;
  }

  if (kind === 'weekday') {
    const weekdayIndex = normalizedWeekday(input.weekday);
    if (weekdayIndex === null) {
      return null;
    }
    const relation = input.relation || 'this';
    const selected =
      relation === 'next'
        ? addDays(
            addDays(mondayForWeek(today), 7),
            (weekdayIndex - WEEKDAY_INDEX.monday + 7) % 7,
          )
        : nextOccurrence(today, weekdayIndex, true);
    return {
      startDate: selected,
      endDate: selected,
      label: `${relation} ${String(input.weekday).toLowerCase()}`,
    };
  }

  if (kind === 'week') {
    const weekOffset = typeof input.offset === 'number' && Number.isInteger(input.offset)
      ? Math.max(0, input.offset)
      : input.relation === 'next'
        ? 1
        : 0;
    const startDate = addDays(mondayForWeek(today), weekOffset * 7);
    return {
      startDate,
      endDate: addDays(startDate, 6),
      label:
        weekOffset === 0
          ? 'this week'
          : weekOffset === 1
            ? 'next week'
            : `${weekOffset} weeks ahead`,
    };
  }

  if (kind === 'weekend') {
    const weekendOffset = typeof input.offset === 'number' && Number.isInteger(input.offset)
      ? Math.max(0, input.offset)
      : input.relation === 'next'
        ? 1
        : 0;
    const nearestSaturday = nextOccurrence(today, WEEKDAY_INDEX.saturday, true);
    const startDate = addDays(nearestSaturday, weekendOffset * 7);
    return {
      startDate,
      endDate: addDays(startDate, 1),
      label: weekendOffset === 0 ? 'this weekend' : 'next weekend',
    };
  }

  if (kind === 'month') {
    const relativeOffset = typeof input.offset === 'number' && Number.isInteger(input.offset)
      ? input.offset
      : input.relation === 'next'
        ? 1
        : input.relation === 'this'
          ? 0
          : null;
    let year: number;
    let monthIndex: number;

    if (relativeOffset !== null) {
      const target = firstDayOfMonth(
        today.getUTCFullYear(),
        today.getUTCMonth() + Math.max(0, relativeOffset),
      );
      year = target.getUTCFullYear();
      monthIndex = target.getUTCMonth();
    } else if (
      typeof input.month === 'number' &&
      Number.isInteger(input.month) &&
      input.month >= 1 &&
      input.month <= 12
    ) {
      monthIndex = input.month - 1;
      const hasExplicitYear = typeof input.year === 'number' && Number.isInteger(input.year);
      year = hasExplicitYear ? input.year as number : today.getUTCFullYear();
      const monthEnded = lastDayOfMonth(year, monthIndex) < today;
      if (!hasExplicitYear && monthEnded) {
        year += 1;
      }
    } else {
      return null;
    }

    return {
      startDate: firstDayOfMonth(year, monthIndex),
      endDate: lastDayOfMonth(year, monthIndex),
      label: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    };
  }

  if (kind === 'range') {
    const startDate = parseIsoDate(input.rangeStart);
    const endDate = parseIsoDate(input.rangeEnd);
    if (!startDate || !endDate || startDate > endDate) {
      return null;
    }
    return { startDate, endDate, label: 'requested date range' };
  }

  if (kind === 'flexible') {
    return {
      startDate: today,
      endDate: addDays(today, PRICE_PREDICTION_WINDOW_DAYS),
      label: 'flexible dates',
    };
  }

  return null;
}

export function resolveFlightDateIntent(
  input: FlightDateIntentInput,
  {
    clock,
    existingSearch = {},
  }: { clock: RequestClock | null; existingSearch?: Partial<FlightSearchDates> } = {
    clock: null,
  },
): FlightDateResolution {
  if (!clock) {
    return invalidResult({
      message: 'The current local date is invalid.',
      kind: 'internal',
      retrySafe: false,
    });
  }
  const today = parseIsoDate(clock.localDate);
  if (!today) {
    return invalidResult({
      message: 'The current local date is invalid.',
      kind: 'internal',
      retrySafe: false,
    });
  }

  const rawRange = rawRangeForIntent(input, today);
  if (!rawRange) {
    return invalidResult({
      message: 'The structured date intent did not contain enough valid calendar detail.',
      fieldIssues: [
        {
          path: 'dateIntent',
          problem: 'The structured intent does not identify a usable date or date range.',
          constraint: 'Use only date evidence from the user, current context, or relevant history.',
        },
      ],
    });
  }

  if (rawRange.endDate < today) {
    return invalidResult({
      message: 'That date intent is now in the past. Please provide a future travel period.',
      fieldIssues: [
        {
          path: 'exactDate',
          problem: 'The requested period is wholly in the past.',
          acceptedValue: toIsoDate(addDays(today, 1)),
          constraint: 'Travel must start after the current local date. Use this boundary only when the user allowed date flexibility.',
        },
      ],
    });
  }

  const searchLimits = getFlightSearchDateLimits(clock.localDate);
  if (rawRange.startDate > searchLimits.maxDate) {
    return {
      status: 'OUTSIDE_SEARCH_WINDOW',
      range: {
        startDate: toIsoDate(rawRange.startDate),
        endDate: toIsoDate(rawRange.endDate),
      },
      searchDate: null,
      returnDate: null,
      assumptionLabel: `The requested period is outside the ${FLIGHT_SEARCH_WINDOW_DAYS}-day flight search window ending ${searchLimits.maxDateString}.`,
      recovery: {
        kind: 'input',
        retrySafe: true,
        stateChanged: false,
        fieldIssues: [
          {
            path: 'dateRange',
            problem: 'The requested period begins after the flight search window.',
            acceptedValue: searchLimits.maxDateString,
            constraint: `Travel must be on or before ${searchLimits.maxDateString}. Use this boundary only when the user allowed date flexibility.`,
          },
        ],
      },
    };
  }

  const startDate = rawRange.startDate < today ? today : rawRange.startDate;
  const endDate = rawRange.endDate > searchLimits.maxDate ? searchLimits.maxDate : rawRange.endDate;
  const tripDurationDays =
    validPositiveInteger(input.tripDurationDays) || deriveExistingTripDuration(existingSearch);
  const searchDate = startDate;
  const returnDate = tripDurationDays ? addDays(searchDate, tripDurationDays) : null;

  if (returnDate && returnDate > searchLimits.maxDate) {
    return {
      status: 'OUTSIDE_SEARCH_WINDOW',
      range: { startDate: toIsoDate(startDate), endDate: toIsoDate(endDate) },
      searchDate: toIsoDate(searchDate),
      returnDate: null,
      assumptionLabel: `The inferred return date is outside the flight search window ending ${searchLimits.maxDateString}.`,
      recovery: {
        kind: 'input',
        retrySafe: true,
        stateChanged: false,
        fieldIssues: [
          {
            path: 'tripDurationDays',
            problem: 'The inferred return date exceeds the flight search window.',
            constraint: `The return date must be on or before ${searchLimits.maxDateString}.`,
          },
        ],
      },
    };
  }

  const requiresReturnTiming =
    (input.tripType || existingSearch.trip_type) === 'roundtrip' && !tripDurationDays;
  const range = { startDate: toIsoDate(startDate), endDate: toIsoDate(endDate) };
  const rangeWasClipped = rawRange.startDate < startDate || rawRange.endDate > endDate;
  const assumptionLabel = `${rawRange.label}: ${range.startDate} to ${range.endDate}; use ${range.startDate} for flight search.${rangeWasClipped ? ' The usable range was clipped to the flight search window.' : ''}`;

  const result: FlightDateResolution = {
    status: requiresReturnTiming ? 'NEEDS_RETURN_TIMING' : 'RESOLVED',
    range,
    searchDate: toIsoDate(searchDate),
    returnDate: returnDate ? toIsoDate(returnDate) : null,
    assumptionLabel,
  };
  if (requiresReturnTiming) {
    result.recovery = {
      kind: 'input',
      retrySafe: true,
      stateChanged: false,
      fieldIssues: [
        {
          path: 'tripDurationDays',
          problem: 'Round-trip return timing is not known.',
          constraint: 'Use a reliable trip duration or return date; otherwise ask one narrow question.',
        },
      ],
      requiredState: ['tripDurationDays or return timing'],
    };
  }
  return result;
}
