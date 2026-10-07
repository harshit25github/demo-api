import type { FilterPayload, FlightFilter } from './normalization.js';

const durationFilterTypes = ['totalDuration', 'layoverDuration'];

const clearPayloadByToolType: Record<string, FilterPayload> = {
  "baggage": {
    "filterType": "baggage",
    "Values": []
  },
  "stops": {
    "filterType": "stop",
    "Values": [
      "all"
    ]
  },
  "departureTime": {
    "filterType": "departtimeslotfilter",
    "Values": []
  },
  "arrivalTime": {
    "filterType": "departlandtimeslotfilter",
    "Values": []
  },
  "airline": {
    "filterType": "airline",
    "Values": [
      "all"
    ]
  },
  "layoverAirport": {
    "filterType": "outboundlayover",
    "Values": [
      "all"
    ]
  },
  "departureAirport": {
    "filterType": "outbounddepart",
    "Values": [
      "all"
    ]
  },
  "arrivalAirport": {
    "filterType": "outboundarrival",
    "Values": [
      "all"
    ]
  }
};

function toSearchText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}
function hasUsableFilterValue(filter: FlightFilter): boolean {
  if (durationFilterTypes.includes(filter.filterType)) {
    return filter.maxDurationMinutes !== null;
  }
  if (filter.filterType === 'price') {
    return filter.maxPrice !== null;
  }
  return filter.filterCode !== null;
}

function hasRemoveIntent(filter: FlightFilter): boolean {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(remove|without|exclude|clear|drop|delete|no\s+longer)\b/.test(text);
}

function hasClearAllIntent(filters: FlightFilter[]): boolean {
  return filters.some((filter) => {
    if (filter.filterType === 'reset') {
      return true;
    }
    const text = toSearchText(filter.rawUserFilter);
    return /\b(clear|remove|drop|delete)\s+(all\s+)?filters?\b/.test(text);
  });
}

function isClearWholeFilterIntent(filter: FlightFilter): boolean {
  if (!hasRemoveIntent(filter)) {
    return false;
  }

  const text = toSearchText(filter.rawUserFilter);
  return (
    /\b(clear|reset)\b/.test(text) ||
    /\b(remove|drop|delete)\s+all\b/.test(text) ||
    /\b(all|entire|whole)\b/.test(text) ||
    /\bfilters?\b/.test(text) ||
    !hasUsableFilterValue(filter)
  );
}

function hasReplaceIntent(filter: FlightFilter): boolean {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(only|instead|replace|change|switch|show only|make it)\b/.test(text);
}

function hasAddIntent(filter: FlightFilter): boolean {
  const text = toSearchText(filter.rawUserFilter);
  return /\b(add|also|include|with|plus|keep)\b/.test(text);
}

function filterStateKey(filter: FlightFilter): string {
  if (durationFilterTypes.includes(filter.filterType)) {
    return filter.filterType;
  }
  if (filter.filterType === 'price') {
    return filter.filterType;
  }
  return `${filter.filterType}:${filter.filterCode}`;
}

function removeMatchingFilter(
  filters: FlightFilter[],
  filterToRemove: FlightFilter,
): FlightFilter[] {
  // Remove exact checkbox values when known; otherwise clear the whole type.
  if (
    (filterToRemove.filterType === 'airline' ||
      filterToRemove.filterType === 'layoverAirport' ||
      filterToRemove.filterType === 'departureAirport' ||
      filterToRemove.filterType === 'arrivalAirport') &&
    !filterToRemove.filterCode &&
    (filterToRemove.airlineNames?.length ||
      filterToRemove.layoverAirportNames?.length ||
      filterToRemove.departureAirportNames?.length ||
      filterToRemove.arrivalAirportNames?.length)
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

function dedupeFilterState(filters: FlightFilter[]): FlightFilter[] {
  const seen = new Set<string>();
  const deduped: FlightFilter[] = [];

  for (const filter of filters) {
    const key = filterStateKey(filter);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(filter);
    }
  }

  return deduped;
}

export function mergeApplyFilterState(
  existingFilters: FlightFilter[],
  incomingFilters: FlightFilter[],
): FlightFilter[] {
  if (hasClearAllIntent(incomingFilters)) {
    // Reset the old state, then apply only the independently requested clauses.
    // A reset must not discard additions in the same request.
    return mergeApplyFilterState([], incomingFilters.filter(
      (filter) => !hasClearAllIntent([filter]),
    ));
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

function sameFilterValue(left: FlightFilter, right: FlightFilter): boolean {
  return left.filterType === right.filterType && left.filterCode === right.filterCode;
}

function buildClearPayload(filterType: FlightFilter['filterType']): FilterPayload | null {
  const clearPayload = clearPayloadByToolType[filterType];
  if (!clearPayload) {
    return null;
  }

  return {
    filterType: clearPayload.filterType,
    Values: [...clearPayload.Values],
  };
}

export function buildRemovalFilterPayloads(
  existingFilters: FlightFilter[],
  incomingFilters: FlightFilter[],
  updatedFilters: FlightFilter[],
): FilterPayload[] {
  if (hasClearAllIntent(incomingFilters)) {
    return [{ filterType: 'reset', Values: [] }];
  }

  const clearPayloads: FilterPayload[] = [];

  for (const filter of incomingFilters) {
    if (!hasRemoveIntent(filter)) {
      continue;
    }

    const hadActiveType = existingFilters.some(
      (existingFilter) => existingFilter.filterType === filter.filterType,
    );
    const hasRemainingType = updatedFilters.some(
      (updatedFilter) => updatedFilter.filterType === filter.filterType,
    );
    const removedExactValue =
      hasUsableFilterValue(filter) &&
      existingFilters.some((existingFilter) => sameFilterValue(existingFilter, filter));

    if (!hadActiveType && !isClearWholeFilterIntent(filter)) {
      continue;
    }

    if (isClearWholeFilterIntent(filter) || (removedExactValue && !hasRemainingType)) {
      const clearPayload = buildClearPayload(filter.filterType);
      if (clearPayload) {
        clearPayloads.push(clearPayload);
      }
    }
  }

  const seen = new Set<string>();
  return clearPayloads.filter((payload) => {
    if (seen.has(payload.filterType)) {
      return false;
    }
    seen.add(payload.filterType);
    return true;
  });
}

export function mergeFinalAndRemovalPayloads(
  finalFilterPayload: FilterPayload[],
  removalPayloads: FilterPayload[],
): FilterPayload[] {
  if (removalPayloads.some((payload) => payload.filterType === 'reset')) {
    return [{ filterType: 'reset', Values: [] }, ...finalFilterPayload];
  }

  const removalTypes = new Set(removalPayloads.map((payload) => payload.filterType));
  return [
    ...finalFilterPayload.filter((payload) => !removalTypes.has(payload.filterType)),
    ...removalPayloads,
  ];
}
