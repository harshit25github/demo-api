import type { FlightFilter, SourceOption } from './normalization.js';

type SourceMatchType = 'exact' | 'partial' | 'fuzzy' | 'alias' | null;
type AirportNameField = 'departureAirportNames' | 'arrivalAirportNames';

interface SourceMatchResult {
  status: 'matched' | 'missing' | 'ambiguous';
  matches: SourceOption[];
  displayLabels: string[];
  matchType: SourceMatchType;
}

interface SourceMatchInput {
  requestedValue: string;
  options: SourceOption[];
  candidateFields: string[];
  displayFields: string[];
  allowPartial?: boolean;
}

interface AirportMatchInput {
  requestedValue: string;
  options: SourceOption[];
  displayFields: string[];
}

interface ResolvedSourceFilter {
  feedback: string[];
  normalizedFilters: FlightFilter[];
}

function toSearchText(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}
function normalizeSourceOptionValue(value: unknown): string {
  return toSearchText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeComparableSourceValue(value: unknown): string {
  return normalizeSourceOptionValue(value)
    .replace(/[^a-z0-9+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function escapeRegExp(value: unknown): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function damerauLevenshteinDistance(leftValue: unknown, rightValue: unknown): number {
  const left = normalizeComparableSourceValue(leftValue);
  const right = normalizeComparableSourceValue(rightValue);
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distances = Array.from({ length: rows }, () => Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) {
    distances[row][0] = row;
  }
  for (let column = 0; column < columns; column += 1) {
    distances[0][column] = column;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + cost,
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distances[row][column] = Math.min(
          distances[row][column],
          distances[row - 2][column - 2] + 1,
        );
      }
    }
  }

  return distances[left.length][right.length];
}

function isConfidentFuzzyMatch(
  requestedValue: unknown,
  candidateValue: unknown,
  distance: number,
): boolean {
  const requested = normalizeComparableSourceValue(requestedValue);
  const candidate = normalizeComparableSourceValue(candidateValue);
  const maxLength = Math.max(requested.length, candidate.length);
  if (Math.min(requested.length, candidate.length) < 4 || maxLength === 0) {
    return false;
  }

  const similarity = 1 - distance / maxLength;
  return distance <= 1 || (distance <= 2 && maxLength >= 7 && similarity >= 0.72);
}

function getSourceOptionCandidates(option: SourceOption, fields: string[]): string[] {
  return fields
    .map((field) => option?.[field])
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => String(value).trim());
}

function displaySourceOption(option: SourceOption, preferredFields: string[]): string {
  const value = preferredFields
    .map((field) => option?.[field])
    .find((candidate) => candidate !== null && candidate !== undefined && String(candidate).trim());
  return value ? String(value).trim() : String(option?.Code || '').trim();
}

function resolveSourceOptionMatches({
  requestedValue,
  options,
  candidateFields,
  displayFields,
  allowPartial = false,
}: SourceMatchInput): SourceMatchResult {
  const requested = normalizeComparableSourceValue(requestedValue);
  if (!requested) {
    return { status: 'missing', matches: [], displayLabels: [], matchType: null };
  }

  const candidateRows = options.flatMap((option) =>
    getSourceOptionCandidates(option, candidateFields).map((candidate) => ({
      option,
      candidate,
      normalizedCandidate: normalizeComparableSourceValue(candidate),
    })),
  );

  const exactCandidateKeys = uniqueStrings(
    candidateRows
      .filter((row) => row.normalizedCandidate === requested)
      .map((row) => row.normalizedCandidate),
  );

  if (exactCandidateKeys.length > 0) {
    const matches = options.filter((option) =>
      getSourceOptionCandidates(option, candidateFields).some((candidate) =>
        exactCandidateKeys.includes(normalizeComparableSourceValue(candidate)),
      ),
    );
    return {
      status: 'matched',
      matches,
      displayLabels: uniqueStrings(matches.map((option) => displaySourceOption(option, displayFields))),
      matchType: 'exact',
    };
  }

  if (allowPartial && requested.length >= 3) {
    const partialCandidateKeys = uniqueStrings(
      candidateRows
        .filter(
          (row) =>
            row.normalizedCandidate.length >= 3 &&
            (row.normalizedCandidate.includes(requested) ||
              requested.includes(row.normalizedCandidate)),
        )
        .map((row) => row.normalizedCandidate),
    );

    if (partialCandidateKeys.length > 0) {
      const matches = options.filter((option) =>
        getSourceOptionCandidates(option, candidateFields).some((candidate) =>
          partialCandidateKeys.includes(normalizeComparableSourceValue(candidate)),
        ),
      );
      return {
        status: 'matched',
        matches,
        displayLabels: uniqueStrings(matches.map((option) => displaySourceOption(option, displayFields))),
        matchType: 'partial',
      };
    }
  }

  const scoredRows = candidateRows
    .map((row) => ({
      ...row,
      distance: damerauLevenshteinDistance(requested, row.normalizedCandidate),
    }))
    .filter((row) => isConfidentFuzzyMatch(requested, row.normalizedCandidate, row.distance))
    .sort((left, right) => left.distance - right.distance);

  if (scoredRows.length === 0) {
    return { status: 'missing', matches: [], displayLabels: [], matchType: null };
  }

  const bestDistance = scoredRows[0].distance;
  const bestCandidateKeys = uniqueStrings(
    scoredRows
      .filter((row) => row.distance === bestDistance)
      .map((row) => row.normalizedCandidate),
  );

  if (bestCandidateKeys.length > 1) {
    return { status: 'ambiguous', matches: [], displayLabels: [], matchType: 'fuzzy' };
  }

  const matches = options.filter((option) =>
    getSourceOptionCandidates(option, candidateFields).some((candidate) =>
      bestCandidateKeys.includes(normalizeComparableSourceValue(candidate)),
    ),
  );

  return {
    status: 'matched',
    matches,
    displayLabels: uniqueStrings(matches.map((option) => displaySourceOption(option, displayFields))),
    matchType: 'fuzzy',
  };
}

function addCorrectionFeedback(
  feedback: string[],
  label: string,
  requestedName: string,
  displayLabels: string[],
): void {
  if (!displayLabels.length) {
    return;
  }

  const requested = normalizeComparableSourceValue(requestedName);
  const alreadyExact = displayLabels.some(
    (displayLabel) => normalizeComparableSourceValue(displayLabel) === requested,
  );
  if (!alreadyExact) {
    feedback.push(`Applied ${label} filter for ${displayLabels.join(', ')}.`);
  }
}

function emptySourceFilter({
  filterType,
  filterCode = null,
  airlineNames = null,
  layoverAirportNames = null,
  departureAirportNames = null,
  arrivalAirportNames = null,
  rawUserFilter = null,
}: {
  filterType: FlightFilter['filterType'];
  filterCode?: string | null;
  airlineNames?: string[] | null;
  layoverAirportNames?: string[] | null;
  departureAirportNames?: string[] | null;
  arrivalAirportNames?: string[] | null;
  rawUserFilter?: string | null;
}): FlightFilter {
  return {
    filterType,
    filterCode,
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

const genericAirlineTokens = new Set(['air', 'airline', 'airlines', 'airway', 'airways']);

function normalizeAirlineAliasValue(value: unknown): string {
  return normalizeComparableSourceValue(value)
    .split(' ')
    .filter((token) => token && !genericAirlineTokens.has(token))
    .join(' ');
}

function resolveAirlineSourceOptionMatches(
  requestedName: string,
  airlineOptions: SourceOption[],
): SourceMatchResult {
  const directMatch = resolveSourceOptionMatches({
    requestedValue: requestedName,
    options: airlineOptions,
    candidateFields: ['Code', 'Name', 'Text'],
    displayFields: ['Name', 'Text', 'Code'],
  });

  if (directMatch.status !== 'missing') {
    return directMatch;
  }

  const requestedAlias = normalizeAirlineAliasValue(requestedName);
  if (!requestedAlias || requestedAlias.length < 2) {
    return directMatch;
  }

  const matches = airlineOptions.filter((option) =>
    [option?.Name, option?.Text]
      .filter(Boolean)
      .some((candidate) => normalizeAirlineAliasValue(candidate) === requestedAlias),
  );

  if (matches.length === 0) {
    return directMatch;
  }

  const displayLabels = uniqueStrings(
    matches.map((option) => displaySourceOption(option, ['Name', 'Text', 'Code'])),
  );

  if (displayLabels.length > 1) {
    return { status: 'ambiguous', matches: [], displayLabels: [], matchType: 'alias' };
  }

  return {
    status: 'matched',
    matches,
    displayLabels,
    matchType: 'alias',
  };
}

function rawTextMatchesAirlineCandidate(rawText: string, candidate: unknown): boolean {
  const normalizedCandidate = normalizeComparableSourceValue(candidate);
  if (!rawText || !normalizedCandidate) {
    return false;
  }

  if (rawText.includes(normalizedCandidate)) {
    return true;
  }

  return normalizedCandidate
    .split(' ')
    .filter((token) => token.length >= 3 && !genericAirlineTokens.has(token))
    .some((token) => new RegExp(`\\b${escapeRegExp(token)}\\b`).test(rawText));
}

function getRequestedAirlineNames(
  filter: FlightFilter,
  airlineOptions: SourceOption[],
): string[] {
  const explicitNames = uniqueStrings(
    (filter.airlineNames || []).map((name) => String(name).trim()).filter(Boolean),
  );

  // Fallback for model omissions: identify known airline names present in raw user text.
  const rawText = normalizeComparableSourceValue(filter.rawUserFilter);
  if (!rawText) {
    return explicitNames;
  }

  const inferredNames = uniqueStrings(
    airlineOptions.flatMap((option) => {
      const candidates = [option.Name, option.Text].filter(Boolean);
      return candidates.some((name) => rawTextMatchesAirlineCandidate(rawText, name))
        ? [option.Name || option.Text]
        : [];
    }),
  );

  return uniqueStrings([...explicitNames, ...inferredNames]);
}

export function resolveAirlineFilter(
  filter: FlightFilter,
  airlineOptions: SourceOption[],
): ResolvedSourceFilter {
  const requestedNames = getRequestedAirlineNames(filter, airlineOptions);
  const availableOptions = airlineOptions.filter((option) => option);
  const matchedCodes: string[] = [];
  const missingNames: string[] = [];
  const ambiguousNames: string[] = [];
  const resolvedNames: string[] = [];
  const feedback: string[] = [];

  for (const requestedName of requestedNames) {
    const resolved = resolveAirlineSourceOptionMatches(requestedName, availableOptions);

    if (resolved.status === 'ambiguous') {
      ambiguousNames.push(requestedName);
      feedback.push(
        `${requestedName} matched multiple airlines in the current results. Please clarify the airline.`,
      );
      continue;
    }

    if (resolved.status === 'missing') {
      missingNames.push(requestedName);
      continue;
    }

    if (resolved.matchType === 'fuzzy') {
      addCorrectionFeedback(feedback, 'airline', requestedName, resolved.displayLabels);
    }
    resolvedNames.push(...resolved.displayLabels);

    for (const match of resolved.matches) {
      if (match.Code && !matchedCodes.includes(match.Code)) {
        // Keep the exact source code, including suffixes such as "+".
        matchedCodes.push(match.Code);
      }
    }
  }

  if (requestedNames.length > 0 && matchedCodes.length === 0) {
    if (missingNames.length > 0 && ambiguousNames.length === 0) {
      feedback.push('The requested airline was not found in the current flight results.');
    }
  } else if (missingNames.length > 0) {
    feedback.push(
      `${missingNames.join(', ')} was not available in the current flight results, so I applied filters for the available requested airlines.`,
    );
  }

  const normalizedFilters: FlightFilter[] =
    matchedCodes.length > 0
      ? matchedCodes.map((filterCode) => ({
          filterType: 'airline',
          filterCode,
          minDurationMinutes: null,
          maxDurationMinutes: null,
          minPrice: null,
          maxPrice: null,
          airlineNames: uniqueStrings(resolvedNames),
          layoverAirportNames: null,
          departureAirportNames: null,
          arrivalAirportNames: null,
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
            departureAirportNames: null,
            arrivalAirportNames: null,
            rawUserFilter: filter.rawUserFilter,
          },
        ];

  return { feedback, normalizedFilters };
}

function getRequestedLayoverAirportNames(
  filter: FlightFilter,
  layoverAirportOptions: SourceOption[],
): string[] {
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

export function resolveLayoverAirportFilter(
  filter: FlightFilter,
  layoverAirportOptions: SourceOption[],
): ResolvedSourceFilter {
  const requestedNames = getRequestedLayoverAirportNames(filter, layoverAirportOptions);
  const availableOptions = layoverAirportOptions.filter((option) => option);
  const matchedCodes: string[] = [];
  const missingNames: string[] = [];
  const ambiguousNames: string[] = [];
  const resolvedNames: string[] = [];
  const feedback: string[] = [];

  for (const requestedName of requestedNames) {
    const resolved = resolveAirportSourceOptionMatches({
      requestedValue: requestedName,
      options: availableOptions,
      displayFields: ['AirportCityName', 'Text', 'Name', 'Code'],
    });

    if (resolved.status === 'ambiguous') {
      ambiguousNames.push(requestedName);
      feedback.push(
        `${requestedName} matched multiple layover airports in the current results. Please clarify the layover airport.`,
      );
      continue;
    }

    if (resolved.status === 'missing') {
      missingNames.push(requestedName);
      continue;
    }

    if (resolved.matchType === 'fuzzy') {
      addCorrectionFeedback(feedback, 'layover airport', requestedName, resolved.displayLabels);
    }
    resolvedNames.push(...resolved.displayLabels);

    for (const match of resolved.matches) {
      if (match.Code && !matchedCodes.includes(match.Code)) {
        // Keep the exact code supplied by the current search's layover option array.
        matchedCodes.push(match.Code);
      }
    }
  }

  if (requestedNames.length > 0 && matchedCodes.length === 0) {
    if (missingNames.length > 0 && ambiguousNames.length === 0) {
      feedback.push('The requested layover airport was not found in the current flight results.');
    }
  } else if (missingNames.length > 0) {
    feedback.push(
      `${missingNames.join(', ')} was not available as a layover airport in the current results, so I applied filters for the available requested layover airports.`,
    );
  }

  const normalizedFilters: FlightFilter[] =
    matchedCodes.length > 0
      ? matchedCodes.map((filterCode) => ({
          filterType: 'layoverAirport',
          filterCode,
          minDurationMinutes: null,
          maxDurationMinutes: null,
          minPrice: null,
          maxPrice: null,
          airlineNames: null,
          layoverAirportNames: uniqueStrings(resolvedNames),
          departureAirportNames: null,
          arrivalAirportNames: null,
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
            departureAirportNames: null,
            arrivalAirportNames: null,
            rawUserFilter: filter.rawUserFilter,
          },
        ];

  return { feedback, normalizedFilters };
}

function getAirportNearbyPreference(rawUserFilter: string | null): boolean | null {
  const text = toSearchText(rawUserFilter);
  if (/\b(non[-\s]?nearby|not\s+nearby|main|primary)\b/.test(text)) {
    return false;
  }
  if (/\b(nearby|alternate|alternative|near\s*by)\b/.test(text)) {
    return true;
  }
  return null;
}

const genericAirportTokens = new Set(['airport', 'airports', 'apt', 'intl', 'international']);

function normalizeAirportAliasValue(value: unknown): string {
  return normalizeComparableSourceValue(value)
    .split(' ')
    .filter((token) => token && !genericAirportTokens.has(token))
    .join(' ');
}

function optionMatchesAirportAlias(option: SourceOption, requestedAirport: string): boolean {
  const requested = normalizeAirportAliasValue(requestedAirport);
  if (!requested) {
    return false;
  }

  return [option.Code, option.Text, option.Name, option.AirportCityName]
    .filter(Boolean)
    .some((value) => {
      const candidate = normalizeAirportAliasValue(value);
      return candidate === requested || candidate.includes(requested) || requested.includes(candidate);
    });
}

function optionMatchesRequestedAirport(option: SourceOption, requestedAirport: string): boolean {
  const requested = normalizeComparableSourceValue(requestedAirport);
  if (!requested) {
    return false;
  }

  const code = normalizeComparableSourceValue(option.Code);
  if (code && code === requested) {
    return true;
  }

  return [option.Text, option.Name, option.AirportCityName]
    .filter(Boolean)
    .some((value) => {
      const candidate = normalizeComparableSourceValue(value);
      return candidate === requested || candidate.includes(requested) || requested.includes(candidate);
    });
}

function resolveAirportSourceOptionMatches({
  requestedValue,
  options,
  displayFields,
}: AirportMatchInput): SourceMatchResult {
  const exactOrPartialMatches = options.filter(
    (option) =>
      optionMatchesRequestedAirport(option, requestedValue) ||
      optionMatchesAirportAlias(option, requestedValue),
  );

  if (exactOrPartialMatches.length > 0) {
    return {
      status: 'matched',
      matches: exactOrPartialMatches,
      displayLabels: uniqueStrings(
        exactOrPartialMatches.map((option) => displaySourceOption(option, displayFields)),
      ),
      matchType: 'partial',
    };
  }

  return resolveSourceOptionMatches({
    requestedValue,
    options,
    candidateFields: ['Code', 'Text', 'Name', 'AirportCityName'],
    displayFields,
    allowPartial: true,
  });
}

function getRequestedAirportNames(
  filter: FlightFilter,
  airportOptions: SourceOption[],
  inputField: AirportNameField,
): string[] {
  const explicitNames = uniqueStrings(
    (filter[inputField] || []).map((name) => String(name).trim()).filter(Boolean),
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
    airportOptions.flatMap((option) => {
      const candidates = [option.Code, option.Text, option.AirportCityName].filter(Boolean);
      const matchingCandidate = candidates.find((value) =>
        rawText.includes(normalizeSourceOptionValue(value)),
      );
      return matchingCandidate ? [matchingCandidate] : [];
    }),
  );
}

function buildAirportFeedbackLabel(filterType: FlightFilter['filterType']): string {
  return filterType === 'departureAirport' ? 'departure airport' : 'arrival airport';
}

function isGenericAirportSelectionRequest(value: unknown): boolean {
  const text = toSearchText(value);
  return (
    /\b(all|every|each|these|available|options?|nearby|alternate|alternative|near\s*by|main|primary|current|non[-\s]?nearby|not\s+nearby)\b/.test(
      text,
    ) &&
    /\b(airport|airports|arrival|departure|arrive|depart|options?|area|only)\b/.test(text)
  );
}

export function resolveFlightEndpointAirportFilter(
  filter: FlightFilter,
  airportOptions: SourceOption[],
  inputField: AirportNameField,
): ResolvedSourceFilter {
  const requestedNames = getRequestedAirportNames(filter, airportOptions, inputField);
  const hasGenericSelectionRequest =
    (requestedNames.length === 0 && isGenericAirportSelectionRequest(filter.rawUserFilter)) ||
    (requestedNames.length > 0 && requestedNames.every(isGenericAirportSelectionRequest));
  const effectiveRequestedNames =
    hasGenericSelectionRequest
      ? []
      : requestedNames;
  const nearbyPreference = getAirportNearbyPreference(filter.rawUserFilter);
  const availableOptions = airportOptions.filter((option) => option);
  const eligibleOptions = availableOptions.filter(
    (option) => nearbyPreference === null || option.IsNearby === nearbyPreference,
  );
  const matchedCodes: string[] = [];
  const missingNames: string[] = [];
  const ambiguousNames: string[] = [];
  const resolvedNames: string[] = [];
  const feedback: string[] = [];
  const label = buildAirportFeedbackLabel(filter.filterType);

  if (effectiveRequestedNames.length === 0 && (nearbyPreference !== null || hasGenericSelectionRequest)) {
    for (const option of eligibleOptions) {
      if (option.Code && !matchedCodes.includes(option.Code)) {
        matchedCodes.push(option.Code);
      }
    }
  } else {
    for (const requestedName of effectiveRequestedNames) {
      const resolved = resolveAirportSourceOptionMatches({
        requestedValue: requestedName,
        options: eligibleOptions,
        displayFields: ['AirportCityName', 'Text', 'Name', 'Code'],
      });

      if (resolved.status === 'ambiguous') {
        ambiguousNames.push(requestedName);
        feedback.push(
          `${requestedName} matched multiple ${label}s in the current results. Please clarify the ${label}.`,
        );
        continue;
      }

      if (resolved.status === 'missing') {
        missingNames.push(requestedName);
        continue;
      }

      if (resolved.matchType === 'fuzzy') {
        addCorrectionFeedback(feedback, label, requestedName, resolved.displayLabels);
      }
      resolvedNames.push(...resolved.displayLabels);

      for (const match of resolved.matches) {
        if (match.Code && !matchedCodes.includes(match.Code)) {
          matchedCodes.push(match.Code);
        }
      }
    }
  }

  if (nearbyPreference === true && matchedCodes.length > 0) {
    feedback.push(
      `Applied nearby/alternate ${label} filter using ${matchedCodes.join(', ')}.`,
    );
  }

  if (nearbyPreference === true && matchedCodes.length === 0) {
    feedback.push(
      `No eligible nearby/alternate ${label}s were found in the current flight results.`,
    );
  } else if (effectiveRequestedNames.length > 0 && matchedCodes.length === 0) {
    if (missingNames.length > 0 && ambiguousNames.length === 0) {
      feedback.push(`The requested ${label} was not found in the current flight results.`);
    }
  } else if (missingNames.length > 0) {
    feedback.push(
      `${missingNames.join(', ')} was not available as a ${label} in the current results, so I applied filters for the available requested airports.`,
    );
  }

  const sourceNames =
    resolvedNames.length > 0
      ? uniqueStrings(resolvedNames)
      : effectiveRequestedNames.length > 0
        ? effectiveRequestedNames
        : null;
  const normalizedFilters: FlightFilter[] =
    matchedCodes.length > 0
      ? matchedCodes.map((filterCode) =>
          emptySourceFilter({
            filterType: filter.filterType,
            filterCode,
            departureAirportNames:
              filter.filterType === 'departureAirport' ? sourceNames : null,
            arrivalAirportNames: filter.filterType === 'arrivalAirport' ? sourceNames : null,
            rawUserFilter: filter.rawUserFilter,
          }),
        )
      : [
          emptySourceFilter({
            filterType: filter.filterType,
            departureAirportNames:
              filter.filterType === 'departureAirport' ? sourceNames : null,
            arrivalAirportNames: filter.filterType === 'arrivalAirport' ? sourceNames : null,
            rawUserFilter: filter.rawUserFilter,
          }),
        ];

  return { feedback, normalizedFilters };
}
