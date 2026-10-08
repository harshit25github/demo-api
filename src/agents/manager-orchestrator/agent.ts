import { Agent } from '@openai/agents';
import { gatewayAgentConfig } from './config.js';
import { buildManagerInstructions } from './manager-prompt.js';
import { flightAgentAsTool } from '../manager/specialists/flight.js';
import { tripPlannerAgentAsTool } from '../manager/specialists/trip-planner.js';

/** Configured once; request state and conversation history belong to each run. */
export const ManagerAgent = Agent.create({
  name: 'Manager Agent',
  instructions: buildManagerInstructions,
  model: gatewayAgentConfig.model,
  modelSettings: gatewayAgentConfig.modelSettings,
  tools: [flightAgentAsTool, tripPlannerAgentAsTool],
});
