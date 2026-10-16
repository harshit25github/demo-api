import type { ModelSettings } from '@openai/agents';

export const tripPlannerV2Config = {
  model: 'gpt-5.2',
  // One model call normally finishes the run; hosted web_search runs inside it.
  maxTurns: 3,
  modelSettings: {
    toolChoice: 'auto',
    parallelToolCalls: false,
    reasoning: { effort: 'low' },
    text: { verbosity: 'low' },
    // The instructions, tool and schema are identical for every call, so one key keeps them cached together.
    providerData: { prompt_cache_key: 'trip-planner-v2' },
  } as ModelSettings,
};
