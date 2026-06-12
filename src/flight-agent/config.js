import 'dotenv/config';

const model = process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.4-mini';
const isGpt5Model = /^gpt-5/i.test(model);

const sharedModelSettings = {
  toolChoice: 'auto',
  parallelToolCalls: false,
};

export const flightAgentConfig = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  model,
  maxTurns: Number(process.env.FLIGHT_AGENT_MAX_TURNS || 4),
  logLevel: process.env.FLIGHT_AGENT_LOG_LEVEL || 'info',
  modelSettings: isGpt5Model
    ? {
        ...sharedModelSettings,
        reasoning: { effort: process.env.OPENAI_FLIGHT_REASONING_EFFORT || 'low' },
        text: { verbosity: 'medium' },
      }
    : {
        ...sharedModelSettings,
        temperature: Number(process.env.OPENAI_FLIGHT_TEMPERATURE || 0.2),
      },
};

export function assertOpenAIConfig() {
  if (!flightAgentConfig.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required to run the Flight Agent.');
  }
}
