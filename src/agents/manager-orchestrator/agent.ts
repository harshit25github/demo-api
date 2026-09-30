import { Agent } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { gatewayAgentConfig } from './config.js';
import { buildManagerInstructions } from './manager-prompt.js';

/**
 * Create a fresh Manager Agent for each turn.
 *
 * The Manager Agent is created per-turn (not singleton) so its tool adapters
 * can hold only that turn's outcomes and render references in isolated state.
 *
 * @param tools - Specialist agents converted to tools via createManagerTools()
 */
export function createManagerAgent(tools: Tool<any>[]) {
  return new Agent({
    name: 'Manager Agent',
    instructions: buildManagerInstructions,
    model: gatewayAgentConfig.model,
    modelSettings: gatewayAgentConfig.modelSettings,
    tools,
  });
}
