import type { ModelSettings } from '@openai/agents';

export const tripPlannerAgentConfig = {
  model: 'gpt-5.2',
  maxTurns: Number(process.env.TRIP_PLANNER_MAX_TURNS || 8),
  timeoutMs: Number(process.env.TRIP_PLANNER_TIMEOUT_MS || 120_000),
  modelSettings: {
    toolChoice: 'auto',
    parallelToolCalls: false,
    reasoning: { effort: process.env.OPENAI_TRIP_PLANNER_REASONING_EFFORT || 'low' },
    text: { verbosity: process.env.OPENAI_TRIP_PLANNER_VERBOSITY || 'low' },
  } as ModelSettings,
};
