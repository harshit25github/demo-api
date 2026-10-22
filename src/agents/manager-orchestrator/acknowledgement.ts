import type { ToolInputGuardrailDefinition } from '@openai/agents';
import { getAcknowledgementListener } from '../../shared/runtime/request-context.js';

/**
 * The turn's acknowledgement reaches the client as the Manager's first specialist call starts (plan 12.12, A1): the
 * sentence is that call's acknowledgement argument, so this guardrail reads it and hands it to the request's listener,
 * which the chat API sends as an "acknowledgement" event. It never blocks or changes the call.
 */
export const acknowledgementToClient: ToolInputGuardrailDefinition = {
  type: 'tool_input',
  name: 'acknowledgement_to_client',
  async run({ context, toolCall }) {
    let text = '';
    try {
      text = String(JSON.parse(toolCall.arguments || '{}').acknowledgement ?? '').trim();
    } catch { /* Arguments the tool will reject anyway. */ }
    if (text) getAcknowledgementListener(context.context)?.(text);
    return { behavior: { type: 'allow' } };
  },
};
