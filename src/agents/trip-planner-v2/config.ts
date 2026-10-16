import type { ModelSettings } from '@openai/agents';

export const tripPlannerV2Config = {
  /** Switches the Manager from Trip Planner v1 to v2. v1 stays the default until v2 passes the benchmark. */
  enabled: false,
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
