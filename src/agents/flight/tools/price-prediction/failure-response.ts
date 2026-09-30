import { getFlightSearchState } from '../../context/flight-context.js';

type MutableContext = Record<string, any>;

const FAILURE_STATUSES = new Set([
  'NO_PREDICTIONS',
  'ERROR',
  'DATE_RANGE_EXCEEDED',
  'INVALID_DATE_RANGE',
  'INVALID_INPUT',
]);

const DATE_REQUEST =
  'Please provide your expected travel date so I can pull up the best flight options for you.';
const KNOWN_DATE_FAILURE =
  "I couldn't verify a price recommendation for your current trip right now.";

function isExplicitDebugRequest(message: unknown): boolean {
  return /\b(?:debug|diagnos(?:e|is|tic)|developer|tool\s+(?:error|output|failure)|internal\s+(?:error|details)|why\s+(?:did\s+)?(?:the\s+)?prediction)\b/i.test(
    String(message || ''),
  );
}

function currentFailureStatus(
  context: MutableContext,
  previousPricePrediction: unknown,
): string | null {
  const prediction = context?.flight?.lastPricePrediction;
  if (!prediction || prediction === previousPricePrediction) {
    return null;
  }
  return FAILURE_STATUSES.has(prediction.status) ? prediction.status : null;
}

function formatDate(dateText: unknown): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) {
    return dateText ? String(dateText) : null;
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return String(dateText);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function buildSearchConfirmation(context: MutableContext): string {
  const state = getFlightSearchState(context);
  const firstSegment = state.onds?.[0] || {};
  const lastSegment = state.onds?.at(-1) || firstSegment;
  const route =
    firstSegment.origin && lastSegment.destination
      ? ` from ${firstSegment.origin} to ${lastSegment.destination}`
      : '';
  const outboundDate = formatDate(firstSegment.outbound_date);
  const returnDate = formatDate(firstSegment.return_date);
  const dates = outboundDate
    ? returnDate
      ? ` for ${outboundDate} to ${returnDate}`
      : ` for ${outboundDate}`
    : '';

  return `I found flight options${route}${dates}. Note: Prices shown are per person.`;
}

export function sanitizePricePredictionFailureResponse({
  output = '',
  context = {},
  currentUserMessage = '',
  previousPricePrediction = null,
  previousSearchKey = null,
}: {
  output?: string;
  context?: MutableContext;
  currentUserMessage?: string;
  previousPricePrediction?: unknown;
  previousSearchKey?: string | null;
} = {}) {
  const status = currentFailureStatus(context, previousPricePrediction);
  const userMessage = currentUserMessage || context?.currentUserMessage || '';
  if (!status || isExplicitDebugRequest(userMessage)) {
    return {
      output,
      guardrail: {
        applied: false,
        changed: false,
        action: null,
      },
    };
  }

  const currentSearchKey = context.flight?.searchKey || null;
  const searchCompleted = Boolean(
    currentSearchKey && currentSearchKey !== previousSearchKey,
  );
  const hasCurrentTravelDate = Boolean(
    getFlightSearchState(context).onds?.[0]?.outbound_date,
  );
  const replacement = searchCompleted
    ? buildSearchConfirmation(context)
    : hasCurrentTravelDate ? KNOWN_DATE_FAILURE : DATE_REQUEST;

  return {
    output: replacement,
    guardrail: {
      applied: true,
      changed: replacement !== output,
      action: searchCompleted ? 'search_confirmation'
        : hasCurrentTravelDate ? 'price_unverified' : 'request_travel_date',
    },
  };
}

export { DATE_REQUEST as PRICE_PREDICTION_FAILURE_DATE_REQUEST };
