import { Agent } from '@openai/agents';
import type { ModelSettings } from '@openai/agents';
import type { RequestClock } from '../../shared/time/request-clock.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { SUMMARY_AGENT_PROMPT } from './prompt.js';
import { summaryAgentOutputSchema } from './schema.js';

export const summaryAgentConfig = {
  model: 'gpt-5.4-mini',
  modelSettings: {
    reasoning: { effort: 'medium' },
    text: { verbosity: 'low' },
  } satisfies ModelSettings,
};

export function createSummaryAgentRunContext({
  now = new Date(),
  timeZone,
}: { now?: Date; timeZone?: string } = {}) {
  return {
    summaryAgent: {
      clock: createRequestClock({ now, timeZone }),
    },
  };
}

export function buildSummaryAgentInstructions(runContext: {
  context?: { summaryAgent?: { clock?: RequestClock } };
}): string {
  const clock = runContext?.context?.summaryAgent?.clock;
  const dynamicClock = clock?.localDate
    ? `<current_date_reference>
localDate: ${clock.localDate}
localDateTime: ${clock.localDateTime}
timeZone: ${clock.timeZone}
Use this immutable clock as the only reference for current and relative dates in this turn.
</current_date_reference>`
    : `<current_date_reference>
Clock unavailable. Do not resolve relative dates yourself; use only an exact date confirmed in the current evidence.
</current_date_reference>`;

  return `${SUMMARY_AGENT_PROMPT}\n\n${dynamicClock}`;
}

export const SummaryExtractorAgent = new Agent({
  name: 'Summary Extractor Agent',
  instructions: buildSummaryAgentInstructions,
  model: summaryAgentConfig.model,
  modelSettings: summaryAgentConfig.modelSettings,
  outputType: summaryAgentOutputSchema,
  tools: [],
});
