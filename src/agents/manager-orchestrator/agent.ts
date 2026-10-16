import { Agent } from '@openai/agents';
import { gatewayAgentConfig } from './config.js';
import { buildManagerInstructions, buildManagerInstructionsV2 } from './manager-prompt.js';
import { flightAgentAsTool } from '../manager/specialists/flight.js';
import { tripPlannerAgentAsTool } from '../manager/specialists/trip-planner.js';
import { tripPlannerV2AgentAsTool } from '../manager/specialists/trip-planner-v2.js';
import { tripPlannerV2Config } from '../trip-planner-v2/config.js';

/** The Manager with Trip Planner v1, or with v2 and its prompt sections. */
export function createManagerAgent({ tripPlannerV2 = false }: { tripPlannerV2?: boolean } = {}) {
  return Agent.create({
    name: 'Manager Agent',
    instructions: tripPlannerV2 ? buildManagerInstructionsV2 : buildManagerInstructions,
    model: gatewayAgentConfig.model,
    modelSettings: gatewayAgentConfig.modelSettings,
    tools: [flightAgentAsTool, tripPlannerV2 ? tripPlannerV2AgentAsTool : tripPlannerAgentAsTool],
  });
}

/** Configured once; request state and conversation history belong to each run. */
export const ManagerAgent = createManagerAgent({ tripPlannerV2: tripPlannerV2Config.enabled });
