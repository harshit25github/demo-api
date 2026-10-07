import { generateTraceId, Runner, withTrace } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { ObservedModelProvider, observeModelInput, currentUsageCollector, UsageCollector, withUsageCollector } from '../../shared/observability/model-usage.js';
import type { ChatTurnUsage, UsageCorrelation } from '../../shared/observability/model-usage.js';
import { encode } from '@toon-format/toon';
import {
  SummaryExtractorAgent,
  createSummaryAgentRunContext,
} from './agent.js';
import type { SummaryContext } from '../../api/chat/types.js';

const summaryRunner = new Runner({
  modelProvider: new ObservedModelProvider(),
  callModelInputFilter: observeModelInput,
  modelSettings: { preserveRawUsage: true },
  workflowName: 'summary-extractor',
  traceIncludeSensitiveData: true,
});

export async function extractSummaryContext({
  previousSummary,
  userMessage,
  agentResponse,
  now = new Date(),
  timeZone,
  usageCorrelation,
  onUsage,
}: {
  previousSummary: SummaryContext;
  userMessage: string;
  agentResponse: string;
  now?: Date;
  timeZone?: string;
  usageCorrelation?: UsageCorrelation;
  onUsage?: (usage: ChatTurnUsage) => void;
}): Promise<SummaryContext> {
  const previousSummaryToon = encode(previousSummary);
  const input = `Old Summary Context (TOON):
\`\`\`toon
${previousSummaryToon}
\`\`\`

Current User Message:
${userMessage}

Current Agent Response:
${agentResponse}`;

  const id = randomUUID();
  const usage = currentUsageCollector() ?? new UsageCollector(usageCorrelation ?? { requestId: id, traceId: generateTraceId(), sessionId: 'summary' });
  return withUsageCollector(usage, () => withTrace('summary-extractor', async () => {
    try {
      const result = await summaryRunner.run(SummaryExtractorAgent, input, {
        context: createSummaryAgentRunContext({ now, timeZone }),
        maxTurns: 1,
      });
      if (!result.finalOutput) {
        throw new Error('Summary Extractor returned no output.');
      }
      return result.finalOutput.summary as SummaryContext;
    } finally {
      onUsage?.(usage.snapshot());
    }
  }, { traceId: usage.correlation.traceId }));
}
