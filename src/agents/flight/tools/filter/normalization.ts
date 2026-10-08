import { z } from 'zod';

import {
  resolveAirlineFilter,
  resolveFlightEndpointAirportFilter,
  resolveLayoverAirportFilter,
  toSearchText,
} from './source-matching.js';

const filterTypeValues = [
  'baggage',
  'departureTime',
  'arrivalTime',
  'stops',
  'totalDuration',
  'layoverDuration',
  'price',
  'airline',
  'layoverAirport',
  'departureAirport',
  'arrivalAirport',
  'reset',
] as const;
const baggageFilterCodes = ['0', '1', '2'];
const timeSlotFilterCodes = ['EARLYMORNING', 'MORNING', 'AFTERNOON', 'EVENING'];
const stopFilterCodes = ['0', '2', '3'];
const durationFilterTypes = ['totalDuration', 'layoverDuration'];
const maxOnlyFilterLabels = {
  totalDuration: 'total duration',
  layoverDuration: 'layover duration',
  price: 'price',
};

export const applyFilterSchema = z.object({
  filters: z
    .array(
      z.object({
        filterType: z
          .enum(filterTypeValues)
          .describe(
            'Filter category: baggage, departureTime, arrivalTime, stops, totalDuration, layoverDuration, price, airline, layoverAirport, departureAirport, arrivalAirport, or reset. Standalone clear-all uses one reset entry. For reset plus new constraints, include reset and the requested additions in one call.',
          ),
        filterCode: z
          .string()
          .nullable()
          .describe(
            'Candidate API code for baggage, time, or stops. Stop counts are normalized to supported API buckets. Use null for airline, airport, duration, and price filters.',
          ),
        minDurationMinutes: z
          .number()
          .int()
          .min(0)
          .nullable()
          .describe('Deprecated minimum duration. It is accepted but ignored and normalized to 0.'),
        maxDurationMinutes: z
          .number()
          .int()
          .min(0)
          .nullable()
          .describe('Maximum duration in minutes. No fixed tool-level cap is applied.'),
        minPrice: z
          .number()
          .min(0)
          .nullable()
          .describe('Deprecated minimum price. It is accepted but ignored and normalized to 0.'),
        maxPrice: z
          .number()
          .min(0)
          .nullable()
          .describe('Maximum price. Use only for price filters.'),
        airlineNames: z
          .array(z.string())
          .nullable()
          .describe(
            'User-requested airline names. Use only for airline filters; use null for other filters.',
          ),
        layoverAirportNames: z
          .array(z.string())
          .nullable()
          .describe(
            'User-requested layover airport codes, airport names, or city names. Use only for layoverAirport filters; use null for other filters.',
          ),
        departureAirportNames: z
          .array(z.string())
          .nullable()
          .describe(
            'User-requested departure airport codes, airport names, or city names. Use only for departureAirport filters; use null for other filters.',
          ),
        arrivalAirportNames: z
          .array(z.string())
          .nullable()
          .describe(
            'User-requested arrival airport codes, airport names, or city names. Use only for arrivalAirport filters; use null for other filters.',
          ),
        rawUserFilter: z
          .string()
          .nullable()
          .describe('Original operation clause for this filter, preserving remove/also/only/nearby/all wording. Exclude unrelated clauses: an addition after reset must not contain the reset clause, and an inclusion or replacement must not carry an explanatory remove/exclude clause even when the request has one ("Delhi airport only", not "DEL only; exclude nearby airports").'),
      }),
    )
    .min(1)
    .describe('At least one filter entry is required. To clear all filters, send one reset entry; an empty array is invalid.'),
});

export type ApplyFilterInput = z.infer<typeof applyFilterSchema>;
export type FlightFilter = ApplyFilterInput['filters'][number];
export interface SourceOption extends Record<string, unknown> {
  Code?: string;
  Name?: string | null;
  Text?: string;
  AirportCityName?: string | null;
  IsNearby?: boolean;
}
export interface FilterPayload {
  filterType: string;
  Values: Array<string | number>;
}

interface DurationRange {
  minDurationMinutes?: number | null;
  maxDurationMinutes?: number | null;
}

interface PriceRange {
  minPrice?: number | null;
  maxPrice?: number | null;
}

function durationToMinutes(value: string, unit?: string): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return /m|min|minute/.test(unit || '') ? Math.round(amount) : Math.round(amount * 60);
}

function inferDurationRange(rawUserFilter: string | null): DurationRange {
  const text = toSearchText(rawUserFilter);
  if (!text) {
    return {};
  }

  const durationPattern = '(\\d+(?:\\.\\d+)?)\\s*(hours?|hrs?|h|minutes?|mins?|m)?';
  const rangeMatch = text.match(
    new RegExp(`(?:between|from)\\s+${durationPattern}\\s+(?:and|to|-)\\s+${durationPattern}`),
  );
  if (rangeMatch) {
    return {
      minDurationMinutes: durationToMinutes(rangeMatch[1], rangeMatch[2] || rangeMatch[4]),
      maxDurationMinutes: durationToMinutes(rangeMatch[3], rangeMatch[4] || rangeMatch[2]),
    };
  }

  const maxMatch = text.match(
    new RegExp(
      `(?:under|less than|below|up to|within|max(?:imum)?|at most|no more than)\\s+${durationPattern}`,
    ),
  );
  if (maxMatch) {
    return {
      maxDurationMinutes: durationToMinutes(maxMatch[1], maxMatch[2]),
    };
  }

  const minMatch = text.match(
    new RegExp(
      `(?:over|more than|above|at least|min(?:imum)?)\\s+${durationPattern}`,
    ),
  );
  if (minMatch) {
    return {
      minDurationMinutes: durationToMinutes(minMatch[1], minMatch[2]),
    };
  }

  const plainMatch = text.match(new RegExp(durationPattern));
  if (plainMatch) {
    return {
      maxDurationMinutes: durationToMinutes(plainMatch[1], plainMatch[2]),
    };
  }

  return {};
}

function inferPriceRange(rawUserFilter: string | null): PriceRange {
  const text = toSearchText(rawUserFilter).replace(/,/g, '');
  if (!text) {
    return {};
  }

  const pricePattern =
    '(?:usd|us\\$|\\$|dollars?|bucks?)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:usd|dollars?|bucks?)?';
  const rangeMatch = text.match(
    new RegExp(`(?:between|from)\\s+${pricePattern}\\s+(?:and|to|-)\\s+${pricePattern}`),
  );
  if (rangeMatch) {
    return {
      minPrice: Number(rangeMatch[1]),
      maxPrice: Number(rangeMatch[2]),
    };
  }

  const hyphenMatch = text.match(new RegExp(`${pricePattern}\\s*-\\s*${pricePattern}`));
  if (hyphenMatch) {
    return {
      minPrice: Number(hyphenMatch[1]),
      maxPrice: Number(hyphenMatch[2]),
    };
  }

  const maxMatch = text.match(
    new RegExp(
      `(?:under|less than|below|up to|within|max(?:imum)?|at most|no more than|cheaper than)\\s+${pricePattern}`,
    ),
  );
  if (maxMatch) {
    return {
      minPrice: 0,
      maxPrice: Number(maxMatch[1]),
    };
  }

  const minMatch = text.match(
    new RegExp(`(?:over|more than|above|at least|min(?:imum)?)\\s+${pricePattern}`),
  );
  if (minMatch) {
    return {
      minPrice: Number(minMatch[1]),
      maxPrice: null,
    };
  }

  return {};
}

function inferFilterCode(
  filterType: FlightFilter['filterType'],
  rawUserFilter: string | null,
): string | null {
  const text = toSearchText(rawUserFilter);
  if (!text) {
    return null;
  }

  if (filterType === 'baggage') {
    if (/checked|check[-\s]?in|checkin/.test(text)) {
      return '0';
    }
    if (/carry[-\s]?on|cabin bag|hand baggage/.test(text)) {
      return '1';
    }
    if (/personal item|laptop|handbag|hand bag/.test(text)) {
      return '2';
    }
  }

  if (filterType === 'departureTime' || filterType === 'arrivalTime') {
    if (/early\s*morning/.test(text)) {
      return 'EARLYMORNING';
    }
    if (/afternoon/.test(text)) {
      return 'AFTERNOON';
    }
    if (/evening|night/.test(text)) {
      return 'EVENING';
    }
    if (/morning/.test(text)) {
      return 'MORNING';
    }
  }

  if (filterType === 'stops') {
    const buckets = new Set<string>();
    if (/non[-\s]?stop|nonstop|direct/.test(text)) {
      buckets.add('0');
    }
    if (/one[-\s]?stops?|\b1\s*stops?\b/.test(text)) {
      buckets.add('2');
    }
    if (/\b1\+\s*stops?\b/.test(text)) {
      buckets.add('3');
    }
    if (
      /\b(?:two|three|four|five|six|seven|eight|nine|ten)(?:\s+or\s+more)?[-\s]*stops?\b/.test(
        text,
      ) ||
      /\b(?:multiple|more|many)\s+stops?\b/.test(text) ||
      /\bmulti[-\s]?stops?\b/.test(text) ||
      /\b(?:at least|more than)\s+\d+\s+stops?\b/.test(text)
    ) {
      buckets.add('3');
    }
    // Text naming several buckets ("up to 1 stop (nonstop or 1-stop acceptable)")
    // is not one stop-count intent, so leave it to an explicit valid code
    // rather than taking whichever bucket is checked first.
    if (buckets.size > 0) {
      return buckets.size === 1 ? [...buckets][0] : null;
    }

    const numericStopMatch = text.match(/\b(\d+)\s*(?:\+|or\s+more)?\s*stops?\b/);
    if (numericStopMatch) {
      const requestedStopCount = Number(numericStopMatch[1]);
      if (requestedStopCount >= 2) {
        return '3';
      }
      if (requestedStopCount === 1) {
        return '2';
      }
      if (requestedStopCount === 0) {
        return '0';
      }
    }
  }

  return null;
}

function isAllowedCodeForType(
  filterType: FlightFilter['filterType'],
  filterCode: string | null,
): boolean {
  if (filterCode === null) {
    return durationFilterTypes.includes(filterType);
  }
  if (filterType === 'baggage') {
    return baggageFilterCodes.includes(filterCode);
  }
  if (filterType === 'departureTime' || filterType === 'arrivalTime') {
    return timeSlotFilterCodes.includes(filterCode);
  }
  if (filterType === 'stops') {
    return stopFilterCodes.includes(filterCode);
  }
  return false;
}

function normalizeFilterCode(
  filterType: FlightFilter['filterType'],
  filterCode: string | null,
  rawUserFilter: string | null,
): string | null {
  const inferredCode = inferFilterCode(filterType, rawUserFilter);

  if (filterType === 'stops') {
    // Raw stop-count intent wins because API code "2" means one stop, while
    // a user's "2 stops" request belongs to the max bucket API code "3".
    if (inferredCode) {
      return inferredCode;
    }

    const numericCode = Number(filterCode);
    if (Number.isInteger(numericCode)) {
      if (numericCode >= 3) {
        return '3';
      }
      if (numericCode === 1) {
        return '2';
      }
    }
  }

  return isAllowedCodeForType(filterType, filterCode) ? filterCode : inferredCode;
}

function buildIgnoredMinimumFeedback(
  filterType: 'totalDuration' | 'layoverDuration' | 'price',
  ignoredMinimum: number,
  validMaximum: number | null,
): string {
  const label = maxOnlyFilterLabels[filterType];
  const unit = filterType === 'price' ? '' : ' minutes';
  const maximumMessage =
    validMaximum !== null
      ? ` Applied the ${label} maximum of ${validMaximum}${unit} with minimum fixed at 0.`
      : ` No ${label} update was applied because a maximum value was not provided.`;

  return `The ${label} minimum of ${ignoredMinimum}${unit} was ignored because this filter supports maximum values only.${maximumMessage}`;
}

export function normalizeApplyFilter(
  filters: FlightFilter[],
  airlineOptions: SourceOption[],
  layoverAirportOptions: SourceOption[],
  departureAirportOptions: SourceOption[],
  arrivalAirportOptions: SourceOption[],
): { feedback: string[]; normalizedFilters: FlightFilter[] } {
  // Normalize model/tool input into API codes and max-only ranges once.
  const feedback: string[] = [];
  const normalizedFilters: FlightFilter[] = filters.flatMap((filter): FlightFilter[] => {
    if (filter.filterType === 'reset') {
      return [{
        filterType: 'reset',
        filterCode: null,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        minPrice: null,
        maxPrice: null,
        airlineNames: null,
        layoverAirportNames: null,
        departureAirportNames: null,
        arrivalAirportNames: null,
        rawUserFilter: filter.rawUserFilter,
      }];
    }

    if (filter.filterType === 'airline') {
      const resolvedAirline = resolveAirlineFilter(filter, airlineOptions);
      feedback.push(...resolvedAirline.feedback);
      return resolvedAirline.normalizedFilters;
    }

    if (filter.filterType === 'layoverAirport') {
      const resolvedLayoverAirport = resolveLayoverAirportFilter(filter, layoverAirportOptions);
      feedback.push(...resolvedLayoverAirport.feedback);
      return resolvedLayoverAirport.normalizedFilters;
    }

    if (filter.filterType === 'departureAirport') {
      const resolvedDepartureAirport = resolveFlightEndpointAirportFilter(
        filter,
        departureAirportOptions,
        'departureAirportNames',
      );
      feedback.push(...resolvedDepartureAirport.feedback);
      return resolvedDepartureAirport.normalizedFilters;
    }

    if (filter.filterType === 'arrivalAirport') {
      const resolvedArrivalAirport = resolveFlightEndpointAirportFilter(
        filter,
        arrivalAirportOptions,
        'arrivalAirportNames',
      );
      feedback.push(...resolvedArrivalAirport.feedback);
      return resolvedArrivalAirport.normalizedFilters;
    }

    if (durationFilterTypes.includes(filter.filterType)) {
      // Duration filters accept legacy minimum input but always apply [0, max].
      const inferredDuration = inferDurationRange(filter.rawUserFilter);
      const providedMinimum =
        inferredDuration.minDurationMinutes ?? filter.minDurationMinutes ?? null;
      const maximum = filter.maxDurationMinutes ?? inferredDuration.maxDurationMinutes ?? null;

      if (providedMinimum !== null && providedMinimum !== 0) {
        feedback.push(
          buildIgnoredMinimumFeedback(
            filter.filterType as 'totalDuration' | 'layoverDuration',
            providedMinimum,
            maximum,
          ),
        );
      }

      return [{
        filterType: filter.filterType,
        filterCode: null,
        minDurationMinutes: 0,
        maxDurationMinutes: maximum,
        minPrice: null,
        maxPrice: null,
        airlineNames: null,
        layoverAirportNames: null,
        departureAirportNames: null,
        arrivalAirportNames: null,
        rawUserFilter: filter.rawUserFilter,
      }];
    }

    if (filter.filterType === 'price') {
      // Price accepts legacy minimum input but always applies [0, max].
      const inferredPrice = inferPriceRange(filter.rawUserFilter);
      const providedMinimum = inferredPrice.minPrice ?? filter.minPrice ?? null;
      const maximum = filter.maxPrice ?? inferredPrice.maxPrice ?? null;

      if (providedMinimum !== null && providedMinimum !== 0) {
        feedback.push(buildIgnoredMinimumFeedback(filter.filterType, providedMinimum, maximum));
      }

      return [{
        filterType: filter.filterType,
        filterCode: null,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        minPrice: 0,
        maxPrice: maximum,
        airlineNames: null,
        layoverAirportNames: null,
        departureAirportNames: null,
        arrivalAirportNames: null,
        rawUserFilter: filter.rawUserFilter,
      }];
    }

    // Prefer valid explicit codes; infer from raw text if the model omits them.
    const filterCode = normalizeFilterCode(
      filter.filterType,
      filter.filterCode,
      filter.rawUserFilter,
    );

    return [{
      filterType: filter.filterType,
      filterCode,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      minPrice: null,
      maxPrice: null,
      airlineNames: null,
      layoverAirportNames: null,
      departureAirportNames: null,
      arrivalAirportNames: null,
      rawUserFilter: filter.rawUserFilter,
    }];
  });

  return {
    feedback,
    normalizedFilters,
  };
}
