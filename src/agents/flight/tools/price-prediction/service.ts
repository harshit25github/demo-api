import { z } from 'zod';
import {
  differenceInDays,
  getPricePredictionDateLimits,
  parseIsoDate,
  PRICE_PREDICTION_WINDOW_DAYS,
  toIsoDate,
} from '../../date/calendar.js';
import { log } from '../../../../shared/logging/logger.js';
import {
  defaultPricePredictionRepository,
  type PricePredictionRepository,
} from './repository.js';
import type { FlightDateRange } from '../../types.js';
import {
  createFlightToolSchemaErrorFunction,
  type FlightToolFieldIssue,
  type FlightToolRecovery,
  type FlightToolRecoveryKind,
} from '../recovery.js';

export { getPricePredictionDateLimits, PRICE_PREDICTION_WINDOW_DAYS };

export const PRICE_PREDICTION_TOOL_NAME = 'price_prediction_tool';

export const pricePredictionInputSchema = z.object({
  originCity: z.string().describe('Required three-letter origin IATA code.'),
  destinationCity: z.string().describe('Required three-letter destination IATA code.'),
  startDate: z.string().describe('Required outbound range start in YYYY-MM-DD format.'),
  endDate: z.string().describe('Required outbound range end in YYYY-MM-DD format.'),
  tripType: z
    .enum(['oneway', 'roundtrip'])
    .nullish()
    .describe('Trip type. Pass null or omit for one-way.'),
  returnStartDate: z
    .string()
    .nullish()
    .describe('Required round-trip return range start, otherwise null.'),
  returnEndDate: z
    .string()
    .nullish()
    .describe('Required round-trip return range end, otherwise null.'),
  tripDuration: z
    .number()
    .int()
    .positive()
    .nullish()
    .describe('Optional preferred round-trip duration in days.'),
  tripDurationFlexibility: z
    .number()
    .int()
    .min(0)
    .nullish()
    .describe('Optional plus/minus trip-duration flexibility in days.'),
});

export type PricePredictionInput = z.infer<typeof pricePredictionInputSchema>;
type PredictionInputLike = Partial<PricePredictionInput>;
type PredictionDateLimits = ReturnType<typeof getPricePredictionDateLimits>;

interface OneWayPrediction {
  departureDate: string;
  predictionRank: number;
}

interface RoundTripPrediction {
  outboundDate: string;
  returnDate: string;
  tripDuration: number;
  predictionRank: number;
}

type RankedPrediction = OneWayPrediction | RoundTripPrediction;

interface ValidatedPredictionInput {
  originCity: string;
  destinationCity: string;
  startDate: string;
  endDate: string;
  tripType: 'oneway' | 'roundtrip';
  returnStartDate: string | null;
  returnEndDate: string | null;
  tripDuration: number | null;
  tripDurationFlexibility: number;
  parsedDates: {
    startDate: Date;
    endDate: Date;
    returnStartDate: Date | null;
    returnEndDate: Date | null;
  };
  limits: PredictionDateLimits;
}

interface PredictionFailureResult {
  ok: false;
  status: string;
  source: string;
  route: { originCity: string | null; destinationCity: string | null };
  tripType: 'oneway' | 'roundtrip';
  searchedDateRange: {
    startDate: string | null;
    endDate: string | null;
    returnStartDate: string | null;
    returnEndDate: string | null;
  };
  predictionWindow: {
    today: string;
    maxDate: string;
    daysAhead: number;
  };
  predictionCount?: number;
  predictions: never[];
  cheapestDates: never[];
  cheapestCombinations: never[];
  priceRangeSummary: null;
  recommendation: string;
  formattedResponse: string;
  message: string;
  missingFields?: string[];
  recovery: FlightToolRecovery;
}

type PublicPrediction =
  | { departureDate: string }
  | { outboundDate: string; returnDate: string; tripDuration: number };

interface PredictionSuccessResult {
  ok: true;
  status: 'SUCCESS';
  source: string;
  dataAsOf: string;
  route: { originCity: string; destinationCity: string };
  tripType: 'oneway' | 'roundtrip';
  searchedDateRange: FlightDateRange & {
    returnStartDate: string | null;
    returnEndDate: string | null;
  };
  tripDuration: number | null;
  tripDurationFlexibility: number | null;
  predictionCount: number;
  predictions: PublicPrediction[];
  cheapestDates: PublicPrediction[];
  cheapestCombinations: PublicPrediction[];
  priceRangeSummary: null;
  recommendation: string;
  formattedResponse: string;
  message: string;
}

type PricePredictionResult = PredictionFailureResult | PredictionSuccessResult;

function normalizeIata(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function searchedDateRangeFromInput(input: PredictionInputLike = {}) {
  return {
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    returnStartDate: input.returnStartDate || null,
    returnEndDate: input.returnEndDate || null,
  };
}

export function createPricePredictionFailure({
  status,
  message,
  input = {},
  source = 'validation',
  missingFields = [],
  limits = getPricePredictionDateLimits(),
  kind,
  retrySafe,
  fieldIssues = [],
}: {
  status: string;
  message: string;
  input?: PredictionInputLike;
  source?: string;
  missingFields?: string[];
  limits?: PredictionDateLimits;
  kind?: FlightToolRecoveryKind;
  retrySafe?: boolean;
  fieldIssues?: FlightToolFieldIssue[];
}): PredictionFailureResult {
  const recoveryKind = kind || (
    status === 'NO_PREDICTIONS'
      ? 'unavailable'
      : status === 'ERROR'
        ? 'temporary'
        : 'input'
  );
  const recoveryIssues = fieldIssues.length > 0
    ? fieldIssues
    : missingFields.map((field) => ({
        path: field,
        problem: 'Required value is missing.',
      }));
  return {
    ok: false,
    status,
    source,
    route: {
      originCity: normalizeIata(input.originCity),
      destinationCity: normalizeIata(input.destinationCity),
    },
    tripType: input.tripType === 'roundtrip' ? 'roundtrip' : 'oneway',
    searchedDateRange: searchedDateRangeFromInput(input),
    predictionWindow: {
      today: limits.todayString,
      maxDate: limits.maxDateString,
      daysAhead: PRICE_PREDICTION_WINDOW_DAYS,
    },
    predictions: [],
    cheapestDates: [],
    cheapestCombinations: [],
    priceRangeSummary: null,
    recommendation: message,
    formattedResponse: message,
    message,
    ...(missingFields.length > 0 ? { missingFields } : {}),
    recovery: {
      kind: recoveryKind,
      retrySafe: retrySafe ?? recoveryKind === 'input',
      stateChanged: false,
      ...(recoveryIssues.length > 0 ? { fieldIssues: recoveryIssues } : {}),
    },
  };
}

export function validatePricePredictionInput(
  input: PredictionInputLike = {},
  { now = new Date() }: { now?: Date } = {},
):
  | { ok: false; result: PredictionFailureResult; value?: never }
  | { ok: true; value: ValidatedPredictionInput; result?: never } {
  const limits = getPricePredictionDateLimits(now);
  const requiredFields = ['originCity', 'destinationCity', 'startDate', 'endDate'] as const;
  const missingFields: string[] = requiredFields.filter(
    (field) => typeof input[field] !== 'string' || !input[field].trim(),
  );
  const tripType = input.tripType || 'oneway';

  if (tripType === 'roundtrip') {
    for (const field of ['returnStartDate', 'returnEndDate'] as const) {
      if (typeof input[field] !== 'string' || !input[field].trim()) {
        missingFields.push(field);
      }
    }
  }

  if (missingFields.length > 0) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: `Missing required price prediction fields: ${missingFields.join(', ')}.`,
        input,
        missingFields,
        limits,
        fieldIssues: missingFields.map((field) => ({
          path: field,
          problem: 'Required price-prediction value is missing.',
        })),
      }),
    };
  }

  const originCity = normalizeIata(input.originCity);
  const destinationCity = normalizeIata(input.destinationCity);
  if (!originCity || !destinationCity) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: 'Origin and destination must be valid three-letter IATA codes.',
        input,
        limits,
        fieldIssues: [
          ...(!originCity ? [{ path: 'originCity', problem: 'Expected a three-letter IATA code.' }] : []),
          ...(!destinationCity ? [{ path: 'destinationCity', problem: 'Expected a three-letter IATA code.' }] : []),
        ],
      }),
    };
  }

  if (!['oneway', 'roundtrip'].includes(tripType)) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: 'tripType must be oneway or roundtrip.',
        input,
        limits,
        fieldIssues: [{ path: 'tripType', problem: 'Expected oneway or roundtrip.' }],
      }),
    };
  }

  const startDate = parseIsoDate(input.startDate);
  const endDate = parseIsoDate(input.endDate);
  const returnStartDate =
    tripType === 'roundtrip' ? parseIsoDate(input.returnStartDate) : null;
  const returnEndDate =
    tripType === 'roundtrip' ? parseIsoDate(input.returnEndDate) : null;

  if (
    !startDate ||
    !endDate ||
    (tripType === 'roundtrip' && (!returnStartDate || !returnEndDate))
  ) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_DATE_RANGE',
        message: 'Prediction dates must be valid calendar dates in YYYY-MM-DD format.',
        input,
        limits,
        fieldIssues: [
          ...(!startDate ? [{ path: 'startDate', problem: 'Expected a valid YYYY-MM-DD calendar date.' }] : []),
          ...(!endDate ? [{ path: 'endDate', problem: 'Expected a valid YYYY-MM-DD calendar date.' }] : []),
          ...(tripType === 'roundtrip' && !returnStartDate ? [{ path: 'returnStartDate', problem: 'Expected a valid YYYY-MM-DD calendar date.' }] : []),
          ...(tripType === 'roundtrip' && !returnEndDate ? [{ path: 'returnEndDate', problem: 'Expected a valid YYYY-MM-DD calendar date.' }] : []),
        ],
      }),
    };
  }

  if (startDate < limits.today) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_DATE_RANGE',
        message: 'The outbound start date cannot be in the past.',
        input,
        limits,
        fieldIssues: [{
          path: 'startDate',
          problem: 'Outbound start date is in the past.',
          acceptedValue: limits.todayString,
          constraint: 'Use this boundary only when the user allowed date flexibility.',
        }],
      }),
    };
  }

  if (startDate > endDate) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_DATE_RANGE',
        message: 'The outbound start date must be on or before the outbound end date.',
        input,
        limits,
        fieldIssues: [{ path: 'startDate', problem: 'Must be on or before endDate.' }],
      }),
    };
  }

  const requestedDates = [startDate, endDate, returnStartDate, returnEndDate].filter(
    (date): date is Date => date !== null,
  );
  if (requestedDates.some((date) => date > limits.maxDate)) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'DATE_RANGE_EXCEEDED',
        message: `Price prediction is available only through ${limits.maxDateString}.`,
        input,
        limits,
        fieldIssues: [{
          path: 'dateRange',
          problem: 'One or more dates exceed the price-prediction window.',
          acceptedValue: limits.maxDateString,
          constraint: `Prediction dates must be on or before ${limits.maxDateString}.`,
        }],
      }),
    };
  }

  if (tripType === 'roundtrip') {
    if (returnStartDate! > returnEndDate!) {
      return {
        ok: false,
        result: createPricePredictionFailure({
          status: 'INVALID_DATE_RANGE',
          message: 'The return start date must be on or before the return end date.',
          input,
          limits,
          fieldIssues: [{ path: 'returnStartDate', problem: 'Must be on or before returnEndDate.' }],
        }),
      };
    }
    if (returnStartDate! < startDate) {
      return {
        ok: false,
        result: createPricePredictionFailure({
          status: 'INVALID_DATE_RANGE',
          message: 'The return date range cannot begin before the outbound date range.',
          input,
          limits,
          fieldIssues: [{ path: 'returnStartDate', problem: 'Cannot be before startDate.' }],
        }),
      };
    }
  }

  const tripDuration = input.tripDuration ?? null;
  const tripDurationFlexibility = input.tripDurationFlexibility ?? null;
  if (tripDuration !== null && (!Number.isInteger(tripDuration) || tripDuration < 1)) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: 'tripDuration must be a positive whole number of days.',
        input,
        limits,
        fieldIssues: [{ path: 'tripDuration', problem: 'Expected a positive whole number of days.' }],
      }),
    };
  }
  if (
    tripDurationFlexibility !== null &&
    (!Number.isInteger(tripDurationFlexibility) || tripDurationFlexibility < 0)
  ) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: 'tripDurationFlexibility must be zero or a positive whole number.',
        input,
        limits,
        fieldIssues: [{ path: 'tripDurationFlexibility', problem: 'Expected zero or a positive whole number.' }],
      }),
    };
  }
  if (tripDurationFlexibility !== null && tripDuration === null) {
    return {
      ok: false,
      result: createPricePredictionFailure({
        status: 'INVALID_INPUT',
        message: 'tripDuration is required when tripDurationFlexibility is provided.',
        input,
        limits,
        fieldIssues: [{
          path: 'tripDuration',
          problem: 'Required when tripDurationFlexibility is provided.',
        }],
      }),
    };
  }

  return {
    ok: true,
    value: {
      originCity,
      destinationCity,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      tripType,
      returnStartDate: returnStartDate ? toIsoDate(returnStartDate) : null,
      returnEndDate: returnEndDate ? toIsoDate(returnEndDate) : null,
      tripDuration,
      tripDurationFlexibility: tripDurationFlexibility ?? 0,
      parsedDates: { startDate, endDate, returnStartDate, returnEndDate },
      limits,
    },
  };
}

function parseJsonField(value: unknown, fieldName: string): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} was missing from the prediction row.`);
  }
  return JSON.parse(value);
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function extractPredictionRank(value: unknown): number | null {
  if (value && typeof value === 'object') {
    return finiteNumber(
      (value as Record<string, unknown>).Score,
      (value as Record<string, unknown>).score,
      (value as Record<string, unknown>).Rank,
      (value as Record<string, unknown>).rank,
      (value as Record<string, unknown>).PredictedPrice,
      (value as Record<string, unknown>).predictedPrice,
      (value as Record<string, unknown>).Price,
      (value as Record<string, unknown>).price,
      (value as Record<string, unknown>).Amount,
      (value as Record<string, unknown>).amount,
    );
  }
  return finiteNumber(value);
}

export function classifyPredictedPrice(
  price: number,
  thresholds: { lowerLimit: number; upperLimit: number },
) {
  if (price <= thresholds.lowerLimit) {
    return { priceBucket: 'LOW', priceLevel: 'low', dealLabel: 'great deal' };
  }
  if (price <= thresholds.upperLimit) {
    return { priceBucket: 'MEDIUM', priceLevel: 'medium', dealLabel: 'fair price' };
  }
  return { priceBucket: 'HIGH', priceLevel: 'high', dealLabel: 'premium' };
}

function isDateWithin(date: Date, startDate: Date, endDate: Date): boolean {
  return date >= startDate && date <= endDate;
}

function parseOneWayPredictions(
  tripPredictions: Record<string, unknown>,
  validated: ValidatedPredictionInput,
): OneWayPrediction[] {
  const predictions: OneWayPrediction[] = [];
  for (const [departureDateText, rawPrediction] of Object.entries(tripPredictions || {})) {
    const departureDate = parseIsoDate(departureDateText);
    const predictionRank = extractPredictionRank(rawPrediction);
    if (
      !departureDate ||
      predictionRank === null ||
      !isDateWithin(
        departureDate,
        validated.parsedDates.startDate,
        validated.parsedDates.endDate,
      )
    ) {
      continue;
    }

    predictions.push({
      departureDate: departureDateText,
      predictionRank,
    });
  }

  return predictions.sort((left, right) =>
    left.departureDate.localeCompare(right.departureDate),
  );
}

function parseRoundTripPredictions(
  tripPredictions: Record<string, unknown>,
  validated: ValidatedPredictionInput,
): RoundTripPrediction[] {
  const predictions: RoundTripPrediction[] = [];
  const minDuration = validated.tripDuration
    ? Math.max(1, validated.tripDuration - validated.tripDurationFlexibility)
    : null;
  const maxDuration = validated.tripDuration
    ? validated.tripDuration + validated.tripDurationFlexibility
    : null;

  for (const [outboundDateText, returnEntries] of Object.entries(tripPredictions || {})) {
    const outboundDate = parseIsoDate(outboundDateText);
    if (
      !outboundDate ||
      !isDateWithin(
        outboundDate,
        validated.parsedDates.startDate,
        validated.parsedDates.endDate,
      ) ||
      !returnEntries ||
      typeof returnEntries !== 'object'
    ) {
      continue;
    }

    for (const [returnDateText, rawPrediction] of Object.entries(returnEntries)) {
      const returnDate = parseIsoDate(returnDateText);
      const predictionRank = extractPredictionRank(rawPrediction);
      if (
        !returnDate ||
        returnDate < outboundDate ||
        predictionRank === null ||
        !isDateWithin(
          returnDate,
          validated.parsedDates.returnStartDate!,
          validated.parsedDates.returnEndDate!,
        )
      ) {
        continue;
      }

      const tripDuration = differenceInDays(returnDate, outboundDate);
      if (
        minDuration !== null &&
        (tripDuration < minDuration || tripDuration > maxDuration!)
      ) {
        continue;
      }

      predictions.push({
        outboundDate: outboundDateText,
        returnDate: returnDateText,
        tripDuration,
        predictionRank,
      });
    }
  }

  return predictions.sort(
    (left, right) =>
      left.outboundDate.localeCompare(right.outboundDate) ||
      left.returnDate.localeCompare(right.returnDate),
  );
}

function formatPredictionDate(dateText: string): string {
  const date = parseIsoDate(dateText);
  if (!date) {
    return dateText;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function buildRecommendation(
  tripType: 'oneway' | 'roundtrip',
  cheapestOption: RankedPrediction,
): string {
  if (tripType === 'roundtrip') {
    const option = cheapestOption as RoundTripPrediction;
    return `Strongest predicted round-trip combination: ${formatPredictionDate(option.outboundDate)} to ${formatPredictionDate(option.returnDate)}`;
  }
  return `Strongest predicted travel date: ${formatPredictionDate((cheapestOption as OneWayPrediction).departureDate)}`;
}

function buildFormattedResponse(
  tripType: 'oneway' | 'roundtrip',
  cheapestOptions: RankedPrediction[],
): string {
  if (tripType === 'roundtrip') {
    const roundTripOptions = cheapestOptions as RoundTripPrediction[];
    const rows = roundTripOptions.map(
      (option, index) =>
        `| ${index + 1} | ${formatPredictionDate(option.outboundDate)} | ${formatPredictionDate(option.returnDate)} |`,
    );
    const best = roundTripOptions[0];
    return `### Promising Round-Trip Combinations\n\n| Rank | Outbound | Return |\n|:----:|----------|--------|\n${rows.join('\n')}\n\n### Recommendation\n\nStrongest predicted round-trip combination: **${formatPredictionDate(best.outboundDate)} to ${formatPredictionDate(best.returnDate)}**. These recommendations rank travel dates; fare amounts and purchase-price trends are not provided.`;
  }

  const oneWayOptions = cheapestOptions as OneWayPrediction[];
  const rows = oneWayOptions.map(
    (option, index) => `| ${index + 1} | ${formatPredictionDate(option.departureDate)} |`,
  );
  const best = oneWayOptions[0];
  return `### Strongest Predicted Travel Dates\n\n| Rank | Travel Date |\n|:----:|-------------|\n${rows.join('\n')}\n\n### Recommendation\n\nStrongest predicted travel date: **${formatPredictionDate(best.departureDate)}**. These recommendations rank travel dates; fare amounts and purchase-price trends are not provided.`;
}

function rankCheapestOptions<T extends RankedPrediction>(predictions: T[]): T[] {
  const predictionDate = (prediction: RankedPrediction) =>
    'departureDate' in prediction ? prediction.departureDate : prediction.outboundDate;
  return [...predictions]
    .sort(
      (left, right) =>
        left.predictionRank - right.predictionRank ||
        predictionDate(left).localeCompare(predictionDate(right)),
    )
    .slice(0, 5);
}

function toPublicPrediction(
  tripType: 'oneway' | 'roundtrip',
  prediction: RankedPrediction,
): PublicPrediction {
  if (tripType === 'roundtrip') {
    const option = prediction as RoundTripPrediction;
    return {
      outboundDate: option.outboundDate,
      returnDate: option.returnDate,
      tripDuration: option.tripDuration,
    };
  }
  return { departureDate: (prediction as OneWayPrediction).departureDate };
}

function successfulResult({
  validated,
  row,
  predictions,
  source,
}: {
  validated: ValidatedPredictionInput;
  row: Record<string, any>;
  predictions: RankedPrediction[];
  source: string;
}): PredictionSuccessResult {
  const cheapestOptions = rankCheapestOptions(predictions);
  const publicPredictions = predictions.map((prediction) =>
    toPublicPrediction(validated.tripType, prediction),
  );
  const publicCheapestOptions = cheapestOptions.map((prediction) =>
    toPublicPrediction(validated.tripType, prediction),
  );
  const recommendation = buildRecommendation(validated.tripType, cheapestOptions[0]);
  const formattedResponse = buildFormattedResponse(validated.tripType, cheapestOptions);

  return {
    ok: true,
    status: 'SUCCESS',
    source,
    dataAsOf: row.SearchDate || validated.limits.yesterdayString,
    route: {
      originCity: validated.originCity,
      destinationCity: validated.destinationCity,
    },
    tripType: validated.tripType,
    searchedDateRange: {
      startDate: validated.startDate,
      endDate: validated.endDate,
      returnStartDate: validated.returnStartDate,
      returnEndDate: validated.returnEndDate,
    },
    tripDuration: validated.tripDuration,
    tripDurationFlexibility:
      validated.tripDuration === null ? null : validated.tripDurationFlexibility,
    predictionCount: publicPredictions.length,
    predictions: publicPredictions,
    cheapestDates: validated.tripType === 'oneway' ? publicCheapestOptions : [],
    cheapestCombinations:
      validated.tripType === 'roundtrip' ? publicCheapestOptions : [],
    priceRangeSummary: null,
    recommendation,
    formattedResponse,
    message: 'Price predictions returned successfully.',
  };
}

export async function getPricePrediction(
  input: PredictionInputLike = {},
  {
    repository,
    now = new Date(),
  }: { repository?: PricePredictionRepository; now?: Date } = {},
): Promise<PricePredictionResult> {
  const validation = validatePricePredictionInput(input, { now });
  if (!validation.ok) {
    return validation.result;
  }

  const validated = validation.value;
  const activeRepository = repository || defaultPricePredictionRepository;

  try {
    const row = await activeRepository.findCityPrediction({
      searchDate: validated.limits.yesterdayString,
      originCity: validated.originCity,
      destinationCity: validated.destinationCity,
      isRoundTrip: validated.tripType === 'roundtrip',
    });

    if (!row) {
      return createPricePredictionFailure({
        status: 'NO_PREDICTIONS',
        message: 'Price prediction is unavailable for this route and date range. I can still search your preferred dates.',
        input: validated,
        source: activeRepository.source || 'repository',
        limits: validated.limits,
      });
    }

    const tripPredictions = parseJsonField(row.TripPredictions, 'TripPredictions');
    const predictions =
      validated.tripType === 'roundtrip'
        ? parseRoundTripPredictions(tripPredictions, validated)
        : parseOneWayPredictions(tripPredictions, validated);

    if (predictions.length === 0) {
      return createPricePredictionFailure({
        status: 'NO_PREDICTIONS',
        message: 'No price predictions were available inside the requested date range. I can still search your preferred dates.',
        input: validated,
        source: activeRepository.source || 'repository',
        limits: validated.limits,
      });
    }

    return successfulResult({
      validated,
      row,
      predictions,
      source: activeRepository.source || 'repository',
    });
  } catch (error: unknown) {
    log('error', 'price_prediction_tool.repository_error', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return createPricePredictionFailure({
      status: 'ERROR',
      message: 'Price prediction could not be loaded right now. I can still search your preferred dates.',
      input: validated,
      source: activeRepository.source || 'repository',
      limits: validated.limits,
    });
  }
}


export const schemaErrorOutput = createFlightToolSchemaErrorFunction(
  PRICE_PREDICTION_TOOL_NAME,
  {
    code: 'INVALID_INPUT',
    details: { status: 'INVALID_INPUT' },
    requiredFields: [
      'originCity',
      'destinationCity',
      'startDate',
      'endDate',
      'tripType',
      'returnStartDate',
      'returnEndDate',
      'tripDuration',
      'tripDurationFlexibility',
    ],
  },
);
