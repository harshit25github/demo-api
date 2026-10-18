import type { ModelSettings } from '@openai/agents';

// The model the Manager's replies are tested and tuned on; change it only with a new round of live tests.
const model = 'gpt-5.2';
const isGpt5Model = /^gpt-5/i.test(model);

export const gatewayAgentConfig = {
  model,
  modelSettings: (isGpt5Model
    ? {
        toolChoice: 'auto',
        parallelToolCalls: true,
        // Medium since 18 Oct 2026: at low the routing call often used no reasoning tokens and missed
        // coordination between the specialists, such as children added in trip terms (plan section 10.8).
        reasoning: { effort: 'medium' },
        // Medium since 18 Oct 2026: at low the reply dropped Trip's reasons and squeezed plans (plan section 10.4).
        text: { verbosity: 'medium' },
      }
    : {
        toolChoice: 'auto',
        parallelToolCalls: true,
        temperature: 0,
      }) as ModelSettings,
};
