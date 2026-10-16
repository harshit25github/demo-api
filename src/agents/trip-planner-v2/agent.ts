import { Agent, webSearchTool } from '@openai/agents';
import { tripPlannerV2Config } from './config.js';
import { TRIP_PLANNER_V2_INSTRUCTIONS } from './prompt.js';
import { tripResultSchema } from './result.js';

export const tripPlannerV2WebSearchTool = webSearchTool({
  name: 'web_search',
  searchContextSize: 'medium',
  externalWebAccess: true,
});

/** One model call per run: hosted web_search runs inside it, and the result is the only output. */
export const TripPlannerV2Agent = new Agent({
  name: 'Trip Planner v2',
  instructions: TRIP_PLANNER_V2_INSTRUCTIONS,
  model: tripPlannerV2Config.model,
  modelSettings: tripPlannerV2Config.modelSettings,
  tools: [tripPlannerV2WebSearchTool],
  outputType: tripResultSchema,
});
