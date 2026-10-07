import { tool } from '@openai/agents';
import { parseIsoDate } from '../../date/calendar.js';
import {
  getRequestClock,
  getRequestState,
} from '../../../../shared/runtime/request-context.js';
import { log } from '../../../../shared/logging/logger.js';
import {
  createPricePredictionFailure,
  getPricePrediction,
  PRICE_PREDICTION_TOOL_NAME,
  pricePredictionInputSchema,
  schemaErrorOutput,
} from './service.js';
import type { FlightAppContext } from '../../types.js';
import {
  recordFlightToolFailure,
  recordFlightToolSuccess,
} from '../recovery.js';

export {
  classifyPredictedPrice,
  getPricePrediction,
  getPricePredictionDateLimits,
  PRICE_PREDICTION_TOOL_NAME,
  PRICE_PREDICTION_WINDOW_DAYS,
  pricePredictionInputSchema,
  validatePricePredictionInput,
} from './service.js';
export type { PricePredictionInput } from './service.js';
export { clickHouseClient } from './repository.js';

export const PricePredictionTool = tool({
  name: PRICE_PREDICTION_TOOL_NAME,
  description:
    'Return ranked travel-date intelligence for explicit cheapest-date, fare-comparison, flexible-price, prediction, or book-now/wait requests, including “any cheaper dates?” after a search, and for any explicit or implicit flexible date window that permits multiple travel dates even without price wording. Examples include “any day next week”, a between/from-to date range, “sometime next month”, and “I’m flexible during these dates”. Exact dates, single-day relative dates, and fixed outbound/return pairs search directly instead. Date-only results do not establish fare amounts, purchase-price trends, or whether to book now or wait. No active search or searchKey is required. Required fields are originCity, destinationCity, startDate, and endDate; round trips also require returnStartDate and returnEndDate. Reuse known current route codes and trip duration. Preserve a stated bracket as the prediction bounds; use the full current prediction window only for bare flexibility without a requested interval, and use a nearby bounded range for a cheaper-date follow-up to an existing search. On success, recommend only returned dates or combinations inside the user’s bracket and preserve their ranking. Call flight_search with the first returned usable date or combination only when the assigned request also asks for flight results, then apply any requested filters; advice-only requests do not authorize a search. Input failures contain field-level recovery metadata and may be retried only with changed, reliable values. NO_PREDICTIONS or temporary failures are not argument-retry signals and must never be exposed as invented fare advice.',
  parameters: pricePredictionInputSchema,
  strict: true,
  errorFunction: schemaErrorOutput,
  async execute(input, runContext) {
    const appContext = getRequestState(runContext?.context as FlightAppContext);
    const localToday = parseIsoDate(
      getRequestClock(runContext?.context as object | undefined)?.localDate,
    );
    const result = localToday
      ? await getPricePrediction(input, { now: localToday })
      : createPricePredictionFailure({
          status: 'ERROR',
          message: 'Price prediction could not be loaded right now. I can still search your preferred dates.',
          input,
          source: 'request_clock',
        });
    appContext.flight.lastPricePrediction = result;

    if (result.ok === false) {
      recordFlightToolFailure({
        appContext,
        toolName: PRICE_PREDICTION_TOOL_NAME,
        input,
        failure: {
          ...result,
          code: result.status,
        },
      });
    } else {
      recordFlightToolSuccess({
        appContext,
        toolName: PRICE_PREDICTION_TOOL_NAME,
      });
    }

    log('info', 'price_prediction_tool.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      status: result.status,
      route: result.route,
      predictionCount: result.predictionCount || 0,
    });

    return result;
  },
});
