import { Agent } from '@openai/agents';
import { gatewayAgentConfig } from './config.js';
import { buildManagerInstructions } from './manager-prompt.js';
import { flightAgentAsTool } from '../manager/specialists/flight.js';
import { tripPlannerV2AgentAsTool } from '../manager/specialists/trip-planner-v2.js';
import { acknowledgementToClient } from './acknowledgement.js';

// The acknowledgement goes to the client first, before any specialist's own input checks.
for (const tool of [flightAgentAsTool, tripPlannerV2AgentAsTool]) {
  tool.inputGuardrails = [acknowledgementToClient, ...(tool.inputGuardrails ?? [])];
}

/** Configured once; request state and conversation history belong to each run. */
export const ManagerAgent = Agent.create({
  name: 'Manager Agent',
  instructions: buildManagerInstructions,
  model: gatewayAgentConfig.model,
  modelSettings: gatewayAgentConfig.modelSettings,
  tools: [flightAgentAsTool, tripPlannerV2AgentAsTool],
});
