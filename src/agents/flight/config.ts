import 'dotenv/config';
import type { ModelSettings } from '@openai/agents';
import { assertOpenAIConfig as assertSharedOpenAIConfig, getOpenAIApiKey } from '../../shared/config/openai.js';

const model = 'gpt-5.2';
const isGpt5Model = /^gpt-5/i.test(model);
const flightModelTimeoutMs = Number(
  process.env.FLIGHT_AGENT_MODEL_TIMEOUT_MS || 20_000,
);
const configuredReasoningEffort = process.env.OPENAI_FLIGHT_REASONING_EFFORT;
const reasoningEffort = ['low', 'medium', 'high', 'xhigh'].includes(
  configuredReasoningEffort || '',
)
  ? configuredReasoningEffort as 'low' | 'medium' | 'high' | 'xhigh'
  : 'medium';

const sharedModelSettings = {
  toolChoice: 'auto',
  parallelToolCalls: false,
} as const;

const modelSettings: ModelSettings = isGpt5Model
  ? {
      ...sharedModelSettings,
      timeoutMs: flightModelTimeoutMs,
      reasoning: { effort: reasoningEffort },
      text: { verbosity: 'medium' },
    }
  : {
      ...sharedModelSettings,
      timeoutMs: flightModelTimeoutMs,
      temperature: Number(process.env.OPENAI_FLIGHT_TEMPERATURE || 0.2),
    };

export const flightAgentConfig = {
  openaiApiKey: getOpenAIApiKey(),
  model,
  maxTurns: Number(process.env.FLIGHT_AGENT_MAX_TURNS || 10),
  logLevel: process.env.FLIGHT_AGENT_LOG_LEVEL || 'info',
  modelSettings,
};

export function assertOpenAIConfig() {
  return assertSharedOpenAIConfig();
}
