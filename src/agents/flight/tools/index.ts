import { FlightSearchTool } from './search-tool.js';
import { ApplyFilterTool } from './filter/tool.js';
import { GetGeneratedContractsContextTool } from './contracts-tool.js';
import { PricePredictionTool } from './price-prediction/tool.js';
import { UpdateFlightSuggestedQuestionsTool } from './suggested-questions-tool.js';

export { ApplyFilterTool } from './filter/tool.js';
export { FlightSearchTool } from './search-tool.js';
export { GetGeneratedContractsContextTool } from './contracts-tool.js';
export {
  PRICE_PREDICTION_TOOL_NAME,
  PRICE_PREDICTION_WINDOW_DAYS,
  PricePredictionTool,
  classifyPredictedPrice,
  getPricePredictionDateLimits,
  getPricePrediction,
  pricePredictionInputSchema,
  validatePricePredictionInput,
  clickHouseClient,
} from './price-prediction/tool.js';
export {
  ClickHousePricePredictionRepository,
  buildPricePredictionQuery,
} from './price-prediction/repository.js';
export {
  UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
  UpdateFlightSuggestedQuestionsTool,
  updateFlightSuggestedQuestions,
  update_flight_suggested_questions,
} from './suggested-questions-tool.js';
export {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  createRecoveryFingerprint,
  recordFlightToolFailure,
  recordFlightToolSuccess,
} from './recovery.js';
export type {
  FlightToolFailure,
  FlightToolFieldIssue,
  FlightToolRecovery,
  FlightToolRecoveryKind,
} from './recovery.js';
export {
  GetTripPlannerContextDetailsTool,
  GetPlaceImagesBatchTool,
  TripPlannerWebSearchTool,
  TRIP_PLANNER_TOOL_NAMES,
  UpdateTripPlannerContextTool,
  UpdateTripPlannerSuggestedQuestionsTool,
  ValidateTripDateTool,
  tripPlannerContextUpdateInputSchema,
  tripPlannerSuggestedQuestionsInputSchema,
  tripPlannerTools,
  updateTripPlannerSuggestedQuestions,
} from '../../trip-planner/tools/index.js';

// Agent registration stays centralized here so FlightAgent imports one stable list.
export const flightTools = [
  FlightSearchTool,
  GetGeneratedContractsContextTool,
  ApplyFilterTool,
  PricePredictionTool,
  UpdateFlightSuggestedQuestionsTool,
];
