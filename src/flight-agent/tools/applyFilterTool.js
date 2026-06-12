import { tool } from '@openai/agents';
import { z } from 'zod';
import { log } from '../logger.js';

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
];
const baggageFilterCodes = ['0', '1', '2'];
const timeSlotFilterCodes = ['EARLYMORNING', 'MORNING', 'AFTERNOON', 'EVENING'];
const stopFilterCodes = ['0', '2', '3'];
const durationFilterTypes = ['totalDuration', 'layoverDuration'];
const apiFilterTypeByToolType = {
  stops: 'stop',
  departureTime: 'departtimeslotfilter',
  arrivalTime: 'departlandtimeslotfilter',
  baggage: 'baggage',
  airline: 'airline',
  layoverAirport: 'outboundlayover',
  price: 'price',
  totalDuration: 'departdurationfilter',
  layoverDuration: 'departlayoverfilter',
};
const orderedFilterTypes = [
  'stops',
  'departureTime',
  'arrivalTime',
  'baggage',
  'airline',
  'layoverAirport',
  'price',
  'totalDuration',
  'layoverDuration',
];
const maxOnlyFilterLabels = {
  totalDuration: 'total duration',
  layoverDuration: 'layover duration',
  price: 'price',
};

const applyFilterSchema = z.object({
  filters: z
    .array(
      z.object({
        filterType: z
          .enum(filterTypeValues)
          .describe(
            'Filter category: baggage, departureTime, arrivalTime, stops, totalDuration, layoverDuration, price, airline, or layoverAirport.',
          ),
        filterCode: z
          .string()
          .nullable()
          .describe(
            'Candidate API code for baggage, time, or stops. Stop counts are normalized to supported API buckets. Use null for airline, layover airport, duration, and price filters.',
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
        rawUserFilter: z
          .string()
          .nullable()
          .describe('Original user filter text used to map natural language to API codes.'),
      }),
    )
    .min(1)
    .describe('Apply-filter API filters. Each item must use exact API filter codes.'),
});

function getFlightContext(runContext) {
  const appContext = runContext?.context || {};
  appContext.UID ||= 'demo-user';
  appContext.toolCallLog ||= [];
  return appContext;
}

function toSearchText(value) {
  return (value || '').trim().toLowerCase();
}

function durationToMinutes(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return /m|min|minute/.test(unit || '') ? Math.round(amount) : Math.round(amount * 60);
}

function inferDurationRange(rawUserFilter) {
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

function inferPriceRange(rawUserFilter) {
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

function inferFilterCode(filterType, rawUserFilter) {
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
    if (/non[-\s]?stop|nonstop|direct/.test(text)) {
      return '0';
    }
    if (/one[-\s]?stops?|\b1\s*stops?\b/.test(text)) {
      return '2';
    }
    if (/\b1\+\s*stops?\b/.test(text)) {
      return '3';
    }
    if (
      /\b(?:two|three|four|five|six|seven|eight|nine|ten)(?:\s+or\s+more)?[-\s]*stops?\b/.test(
        text,
      ) ||
      /\b(?:multiple|more|many)\s+stops?\b/.test(text) ||
      /\bmulti[-\s]?stops?\b/.test(text) ||
      /\b(?:at least|more than)\s+\d+\s+stops?\b/.test(text)
    ) {
      return '3';
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

function isAllowedCodeForType(filterType, filterCode) {
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

function normalizeFilterCode(filterType, filterCode, rawUserFilter) {
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

function normalizeStopApiCode(filterCode) {
  if (stopFilterCodes.includes(filterCode)) {
    return filterCode;
  }

  const numericCode = Number(filterCode);
  if (!Number.isInteger(numericCode)) {
    return null;
  }
  if (numericCode >= 3) {
    return '3';
  }
  if (numericCode === 1) {
    return '2';
  }
  return null;
}

function buildIgnoredMinimumFeedback(filterType, ignoredMinimum, validMaximum) {
  const label = maxOnlyFilterLabels[filterType];
  const unit = filterType === 'price' ? '' : ' minutes';
  const maximumMessage =
    validMaximum !== null
      ? ` Applied the ${label} maximum of ${validMaximum}${unit} with minimum fixed at 0.`
      : ` No ${label} update was applied because a maximum value was not provided.`;

  return `The ${label} minimum of ${ignoredMinimum}${unit} was ignored because this filter supports maximum values only.${maximumMessage}`;
}

function normalizeSourceOptionValue(value) {
  return toSearchText(value).replace(/\s+/g, ' ');
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function getRequestedAirlineNames(filter, airlineOptions) {
  const explicitNames = uniqueStrings(
    (filter.airlineNames || []).map((name) => String(name).trim()).filter(Boolean),
  );
  if (explicitNames.length > 0) {
    return explicitNames;
  }

  // Fallback for model omissions: identify known airline names present in raw user text.
  const rawText = normalizeSourceOptionValue(filter.rawUserFilter);
  if (!rawText) {
    return [];
  }

  return uniqueStrings(
    airlineOptions.flatMap((option) => {
      const candidates = [option.Name, option.Text].filter(Boolean);
      return candidates.some((name) => rawText.includes(normalizeSourceOptionValue(name)))
        ? [option.Name || option.Text]
        : [];
    }),
  );
}

function resolveAirlineFilter(filter, airlineOptions) {
  const requestedNames = getRequestedAirlineNames(filter, airlineOptions);
  const enabledOptions = airlineOptions.filter((option) => option && option.IsDisabled !== true);
  const matchedCodes = [];
  const missingNames = [];

  for (const requestedName of requestedNames) {
    const normalizedRequestedName = normalizeSourceOptionValue(requestedName);
    const matches = enabledOptions.filter((option) =>
      [option.Name, option.Text]
        .filter(Boolean)
        .some((name) => normalizeSourceOptionValue(name) === normalizedRequestedName),
    );

    if (matches.length === 0) {
      missingNames.push(requestedName);
      continue;
    }

    for (const match of matches) {
      if (match.Code && !matchedCodes.includes(match.Code)) {
        // Keep the exact source code, including suffixes such as "+".
        matchedCodes.push(match.Code);
      }
    }
  }

  const feedback = [];
  if (requestedNames.length > 0 && matchedCodes.length === 0) {
    feedback.push('The requested airline was not found in the current flight results.');
  } else if (missingNames.length > 0) {
    feedback.push(
      `${missingNames.join(', ')} was not available in the current flight results, so I applied filters for the available requested airlines.`,
    );
  }

  const normalizedFilters =
    matchedCodes.length > 0
      ? matchedCodes.map((filterCode) => ({
          filterType: 'airline',
          filterCode,
          minDurationMinutes: null,
          maxDurationMinutes: null,
          minPrice: null,
          maxPrice: null,
          airlineNames: requestedNames,
          layoverAirportNames: null,
          rawUserFilter: filter.rawUserFilter,
        }))
      : [
          {
            filterType: 'airline',
            filterCode: null,
            minDurationMinutes: null,
            maxDurationMinutes: null,
            minPrice: null,
            maxPrice: null,
            airlineNames: requestedNames,
            layoverAirportNames: null,
            rawUserFilter: filter.rawUserFilter,
          },
        ];

  return { feedback, normalizedFilters };
}

function getRequestedLayoverAirportNames(filter, layoverAirportOptions) {
  const explicitNames = uniqueStrings(
    (filter.layoverAirportNames || []).map((name) => String(name).trim()).filter(Boolean),
  );
  if (explicitNames.length > 0) {
    return explicitNames;
  }

  // Fallback for model omissions: identify known codes, airport names, or cities in raw text.
  const rawText = normalizeSourceOptionValue(filter.rawUserFilter);
  if (!rawText) {
    return [];
  }

  return uniqueStrings(
    layoverAirportOptions.flatMap((option) => {
      const candidates = [option.Code, option.Text, option.AirportCityName].filter(Boolean);
      const matchingCandidate = candidates.find((value) =>
        rawText.includes(normalizeSourceOptionValue(value)),
      );
      return matchingCandidate ? [matchingCandidate] : [];
    }),
  );
}

function resolveLayoverAirportFilter(filter, layoverAirportOptions) {
  const requestedNames = getRequestedLayoverAirportNames(filter, layoverAirportOptions);
  const enabledOptions = layoverAirportOptions.filter(
    (option) => option && option.IsDisabled !== true,
  );
  const matchedCodes = [];
  const missingNames = [];

  for (const requestedName of requestedNames) {
    const normalizedRequestedName = normalizeSourceOptionValue(requestedName);
    const matches = enabledOptions.filter((option) =>
      [option.Code, option.Text, option.AirportCityName]
        .filter(Boolean)
        .some((value) => normalizeSourceOptionValue(value) === normalizedRequestedName),
    );

    if (matches.length === 0) {
      missingNames.push(requestedName);
      continue;
    }

    for (const match of matches) {
      if (match.Code && !matchedCodes.includes(match.Code)) {
        // Keep the exact code supplied by the current search's layover option array.
        matchedCodes.push(match.Code);
      }
    }
  }

  const feedback = [];
  if (requestedNames.length > 0 && matchedCodes.length === 0) {
    feedback.push('The requested layover airport was not found in the current flight results.');
  } else if (missingNames.length > 0) {
    feedback.push(
      `${missingNames.join(', ')} was not available as a layover airport in the current results, so I applied filters for the available requested layover airports.`,
    );
  }

  const normalizedFilters =
    matchedCodes.length > 0
      ? matchedCodes.map((filterCode) => ({
          filterType: 'layoverAirport',
          filterCode,
          minDurationMinutes: null,
          maxDurationMinutes: null,
          minPrice: null,
          maxPrice: null,
          airlineNames: null,
          layoverAirportNames: requestedNames,
          rawUserFilter: filter.rawUserFilter,
        }))
      : [
          {
            filterType: 'layoverAirport',
            filterCode: null,
            minDurationMinutes: null,
            maxDurationMinutes: null,
            minPrice: null,
            maxPrice: null,
            airlineNames: null,
            layoverAirportNames: requestedNames,
            rawUserFilter: filter.rawUserFilter,
          },
        ];

  return { feedback, normalizedFilters };
}

function normalizeApplyFilter(filters, airlineOptions, layoverAirportOptions) {
  // Normalize model/tool input into API codes and max-only ranges once.
  const feedback = [];
  const normalizedFilters = filters.flatMap((filter) => {
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

    if (durationFilterTypes.includes(filter.filterType)) {
      // Duration filters accept legacy minimum input but always apply [0, max].
      const inferredDuration = inferDurationRange(filter.rawUserFilter);
      const providedMinimum =
        inferredDuration.minDurationMinutes ?? filter.minDurationMinutes ?? null;
      const maximum = filter.maxDurationMinutes ?? inferredDuration.maxDurationMinutes ?? null;

      if (providedMinimum !== null && providedMinimum !== 0) {
        feedback.push(
          buildIgnoredMinimumFeedback(filter.filterType, providedMinimum, maximum),
        );
      }

      return {
        filterType: filter.filterType,
        filterCode: null,
        minDurationMinutes: 0,
        maxDurationMinutes: maximum,
        minPrice: null,
        maxPrice: null,
        airlineNames: null,
        layoverAirportNames: null,
        rawUserFilter: filter.rawUserFilter,
      };
    }

    if (filter.filterType === 'price') {
      // Price accepts legacy minimum input but always applies [0, max].
      const inferredPrice = inferPriceRange(filter.rawUserFilter);
      const providedMinimum = inferredPrice.minPrice ?? filter.minPrice ?? null;
      const maximum = filter.maxPrice ?? inferredPrice.maxPrice ?? null;

      if (providedMinimum !== null && providedMinimum !== 0) {
        feedback.push(buildIgnoredMinimumFeedback(filter.filterType, providedMinimum, maximum));
      }

      return {
        filterType: filter.filterType,
        filterCode: null,
        minDurationMinutes: null,
        maxDurationMinutes: null,
        minPrice: 0,
        maxPrice: maximum,
        airlineNames: null,
        layoverAirportNames: null,
        rawUserFilter: filter.rawUserFilter,
      };
    }

    // Prefer valid explicit codes; infer from raw text if the model omits them.
    const filterCode = normalizeFilterCode(
      filter.filterType,
      filter.filterCode,
      filter.rawUserFilter,
    );

    return {
      filterType: filter.filterType,
      filterCode,
      minDurationMinutes: null,
      maxDurationMinutes: null,
      minPrice: null,
      maxPrice: null,
      airlineNames: null,
      layoverAirportNames: null,
      rawUserFilter: filter.rawUserFilter,
    };
  });

  return {
    feedback,
    normalizedFilters,
  };
}

function hasUsableFilterValue(filter) {
  if (durationFilterTypes.includes(filter.filterType)) {
    return filter.maxDurationMinutes !== null;
  }
  if (filter.filterType === 'price') {
    return filter.maxPrice !== null;
  }
  return filter.filterCode !== null;
}

function hasRemoveIntent(filter) {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(remove|without|exclude|clear|drop|delete|no\s+longer)\b/.test(text);
}

function hasClearAllIntent(filters) {
  return filters.some((filter) => {
    const text = toSearchText(filter.rawUserFilter);
    return /\b(clear|remove|drop|delete)\s+(all\s+)?filters?\b/.test(text);
  });
}

function hasReplaceIntent(filter) {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(only|instead|replace|change|switch|show only|make it)\b/.test(text);
}

function hasAddIntent(filter) {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(add|also|include|with|plus|keep)\b/.test(text);
}

function filterStateKey(filter) {
  if (durationFilterTypes.includes(filter.filterType)) {
    return filter.filterType;
  }
  if (filter.filterType === 'price') {
    return filter.filterType;
  }
  return `${filter.filterType}:${filter.filterCode}`;
}

function removeMatchingFilter(filters, filterToRemove) {
  // Remove exact checkbox values when known; otherwise clear the whole type.
  if (
    (filterToRemove.filterType === 'airline' ||
      filterToRemove.filterType === 'layoverAirport') &&
    !filterToRemove.filterCode &&
    (filterToRemove.airlineNames?.length || filterToRemove.layoverAirportNames?.length)
  ) {
    // Requested source options did not match, so preserve the active filter state.
    return filters;
  }

  if (
    !filterToRemove.filterCode ||
    durationFilterTypes.includes(filterToRemove.filterType) ||
    filterToRemove.filterType === 'price'
  ) {
    return filters.filter((filter) => filter.filterType !== filterToRemove.filterType);
  }

  return filters.filter(
    (filter) =>
      filter.filterType !== filterToRemove.filterType ||
      filter.filterCode !== filterToRemove.filterCode,
  );
}

function dedupeFilterState(filters) {
  const seen = new Set();
  const deduped = [];

  for (const filter of filters) {
    const key = filterStateKey(filter);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(filter);
    }
  }

  return deduped;
}

function mergeApplyFilterState(existingFilters, incomingFilters) {
  if (hasClearAllIntent(incomingFilters)) {
    return [];
  }

  // Update rule: duration and price ranges always replace their old range. "only/instead"
  // also replaces only that filter type. If the same checkbox type already
  // exists, a new value replaces it unless the user/model says add/also/with.
  const replaceTypes = new Set(
    incomingFilters
      .filter(
        (filter) =>
          !hasRemoveIntent(filter) &&
          hasUsableFilterValue(filter) &&
          (durationFilterTypes.includes(filter.filterType) ||
            filter.filterType === 'price' ||
            hasReplaceIntent(filter) ||
            ((existingFilters || []).some(
              (existingFilter) => existingFilter.filterType === filter.filterType,
            ) &&
              !hasAddIntent(filter))),
      )
      .map((filter) => filter.filterType),
  );

  let updatedFilters = (existingFilters || []).filter(
    (filter) => !replaceTypes.has(filter.filterType),
  );

  for (const filter of incomingFilters) {
    if (hasRemoveIntent(filter)) {
      updatedFilters = removeMatchingFilter(updatedFilters, filter);
      continue;
    }

    if (hasUsableFilterValue(filter)) {
      updatedFilters.push(filter);
    }
  }

  return dedupeFilterState(updatedFilters);
}

function buildFinalFilterPayload(filters) {
  const groupedValues = new Map();

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
        filterType === 'layoverAirport'
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
    .filter(Boolean);
}

function matchesStopCode(flight, filterCode) {
  if (filterCode === '0') {
    return flight.stops === 0;
  }
  if (filterCode === '2') {
    return flight.stops === 1;
  }
  if (filterCode === '3') {
    return flight.stops >= 2;
  }
  return true;
}

function matchesDurationMinutes(value, { maxDurationMinutes }) {
  if (maxDurationMinutes !== null && value > maxDurationMinutes) {
    return false;
  }
  return true;
}

function matchesPrice(value, { maxPrice }) {
  if (typeof value !== 'number') {
    return false;
  }
  if (maxPrice !== null && value > maxPrice) {
    return false;
  }
  return true;
}

function matchesApiFilter(flight, filter) {
  if (filter.filterType === 'baggage') {
    return !filter.filterCode || flight.baggage.includes(filter.filterCode);
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
    return flight.layover_airport_codes?.includes(filter.filterCode) ?? false;
  }
  return true;
}

function applyFilters(flights, filters) {
  // Dummy-only local filtering. Real integration should use the API response.
  const filtersByType = filters.reduce((groups, filter) => {
    groups[filter.filterType] ||= [];
    groups[filter.filterType].push(filter);
    return groups;
  }, {});

  return flights.filter((flight) =>
    Object.values(filtersByType).every((filterGroup) =>
      filterGroup.some((filter) => matchesApiFilter(flight, filter)),
    ),
  );
}

export const ApplyFilterTool = tool({
  name: 'apply_filter',
  description:
    'Apply filters, including airline and layover airport options, to an existing flight search. Source-option codes are resolved from current search arrays in shared context. Total duration, layover duration, and price are maximum-only filters. Requires searchKey from flight_search.',
  parameters: applyFilterSchema,
  strict: true,
  execute(input, context) {
    const appContext = getFlightContext(context);

    // UID comes from SDK run context and will be sent to the real API.
    // TODO: Read UID from context
    const UID = appContext.UID;

    // searchKey is written by FlightSearchTool and identifies active results.
    // Without it, apply-filter has no search result set to filter.
    // TODO: Read searchKey from context
    const searchKey = appContext.searchKey;

    if (!searchKey) {
      log('info', 'apply_filter.missing_search', {
        requestId: appContext.requestId,
        sessionId: appContext.sessionId,
        UID,
        filters: input.filters,
      });

      return {
        ok: false,
        code: 'MISSING_SEARCH',
        message:
          'No active flight search found. Ask for origin, destination, and travel date before applying filters.',
        feedback: [],
      };
    }

    // Existing filters are the active state from earlier apply_filter turns.
    const existingFilters = appContext.lastAppliedFilters || [];

    // New filters are only what the latest user turn requested.
    // The application adds the active search's airline array to shared SDK context.
    // Airline codes must only be resolved from this context array, never from a static map.
    const airlineFilterOptions =
      appContext.airlineFilterOptions || appContext.airlineFilters || [];
    // The application adds the active search's layover airport array to shared SDK context.
    // Codes must only be resolved from this context array, never generated manually.
    const layoverAirportFilterOptions =
      appContext.layoverAirportFilterOptions || appContext.layoverAirportFilters || [];
    const { feedback, normalizedFilters: newFilters } = normalizeApplyFilter(
      input.filters,
      airlineFilterOptions,
      layoverAirportFilterOptions,
    );

    // Merge state: add new checkbox values, remove explicit values, and
    // replace only the requested filter type for "only/instead/change".
    const updatedFilters = mergeApplyFilterState(existingFilters, newFilters);

    // Final API-ready array in the exact Apply Filter API format.
    // TODO: Build real Apply Filter API payload here using UID, searchKey, and updated filters.
    const finalFilterPayload = buildFinalFilterPayload(updatedFilters);
    console.log('FINAL_APPLY_FILTER_PAYLOAD', finalFilterPayload);

    const applyFilterApiPayload = {
      UID,
      searchKey,
      filters: finalFilterPayload,
    };

    // TODO: Pass `finalFilterPayload` to the real Apply Filter API.
    // TODO: Call real Apply Filter API here.
    //
    // Example real API integration:
    //
    // const payload = buildApplyFilterPayload({
    //   uid: UID,
    //   searchKey,
    //   filters: finalFilterPayload,
    // });
    //
    // const apiResponse = await applyFilterApi(payload);
    //
    // return mapApplyFilterResponse(apiResponse);

    // TODO: Remove dummy response once real API integration is done.
    const baseFlights = appContext.flightResults || [];
    const filteredFlights = applyFilters(baseFlights, updatedFilters);

    // Persist latest filter state in context for follow-up turns and tests.
    appContext.filteredFlightResults = filteredFlights;
    appContext.lastAppliedFilters = updatedFilters;
    appContext.lastFinalFilterPayload = finalFilterPayload;
    appContext.lastApplyFilterPayload = applyFilterApiPayload;
    appContext.lastApplyFilterFeedback = feedback;
    appContext.toolCallLog.push({
      tool: 'apply_filter',
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      apiPayload: applyFilterApiPayload,
      feedback,
    });

    log('info', 'apply_filter.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID,
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      feedback,
      resultCount: filteredFlights.length,
    });

    // TODO: Map real API response into tool output format here.
    return {
      ok: true,
      source: 'dummy',
      message: 'Sample filtered flight results only. No live API was called.',
      UID,
      searchKey,
      filters: updatedFilters,
      finalFilterPayload,
      apiPayload: applyFilterApiPayload,
      feedback,
      summary: {
        originalCount: baseFlights.length,
        filteredCount: filteredFlights.length,
      },
      flights: filteredFlights,
    };
  },
});
