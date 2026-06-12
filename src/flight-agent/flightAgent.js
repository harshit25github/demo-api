import { Agent, setDefaultOpenAIKey } from '@openai/agents';
import { assertOpenAIConfig, flightAgentConfig } from './config.js';
import { FLIGHT_PROMPT } from './instructions.js';
import { flightTools } from './tools/index.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey);

function buildInstructions(runContext) {
  const hasActiveSearch = Boolean(runContext?.context?.searchKey);
  return `${FLIGHT_PROMPT}

Current search state:
- UID is available in context.
- Active search exists: ${hasActiveSearch ? 'yes' : 'no'}.
`;
}

export const FlightAgent = new Agent({
  name: 'FlightAgent',
  instructions: buildInstructions,
  model: flightAgentConfig.model,
  modelSettings: flightAgentConfig.modelSettings,
  tools: flightTools,
});
