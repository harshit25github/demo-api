import type { ModelSettings } from '@openai/agents';

const model = 'gpt-5.4-mini';
const isGpt5Model = /^gpt-5/i.test(model);

export const gatewayAgentConfig = {
  model,
  modelSettings: (isGpt5Model
    ? {
        toolChoice: 'auto',
        parallelToolCalls: false,
        reasoning: { effort: process.env.OPENAI_GATEWAY_REASONING_EFFORT || 'low' },
        text: { verbosity: 'low' },
      }
    : {
        toolChoice: 'auto',
        parallelToolCalls: false,
        temperature: 0,
      }) as ModelSettings,
};
