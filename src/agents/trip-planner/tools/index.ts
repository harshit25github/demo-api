import { webSearchTool } from '@openai/agents';
import { GetTripPlannerContextDetailsTool, UpdateTripPlannerContextTool, UpdateTripPlannerSuggestedQuestionsTool } from './context-tools.js';
import { ValidateTripDateTool } from './date-tool.js';
import { GetPlaceImagesBatchTool } from './image-tool.js';
import { TRIP_PLANNER_TOOL_NAMES } from './runtime.js';

export { TRIP_PLANNER_TOOL_NAMES } from './runtime.js';
export { ValidateTripDateTool } from './date-tool.js';
export { GetPlaceImagesBatchTool } from './image-tool.js';
export {
  GetTripPlannerContextDetailsTool,
  UpdateTripPlannerContextTool,
  UpdateTripPlannerSuggestedQuestionsTool,
  tripPlannerContextUpdateInputSchema,
  tripPlannerSuggestedQuestionsInputSchema,
  updateTripPlannerSuggestedQuestions,
} from './context-tools.js';

export const TripPlannerWebSearchTool = webSearchTool({
  name: TRIP_PLANNER_TOOL_NAMES.webSearch,
  searchContextSize: 'medium',
  externalWebAccess: true,
});

export const tripPlannerTools = [
  UpdateTripPlannerContextTool,
  ValidateTripDateTool,
  GetPlaceImagesBatchTool,
  TripPlannerWebSearchTool,
  GetTripPlannerContextDetailsTool,
  UpdateTripPlannerSuggestedQuestionsTool,
];
