import { FlightSearchTool } from './search-tool.js';
import { ApplyFilterTool } from './filter/tool.js';
import { GetGeneratedContractsContextTool } from './contracts-tool.js';
import { PricePredictionTool } from './price-prediction/tool.js';
import { UpdateFlightSuggestedQuestionsTool } from './suggested-questions-tool.js';

// Agent registration stays centralized here so FlightAgent imports one stable list.
export const flightTools = [
  FlightSearchTool,
  GetGeneratedContractsContextTool,
  ApplyFilterTool,
  PricePredictionTool,
  UpdateFlightSuggestedQuestionsTool,
];
