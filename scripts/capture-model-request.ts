import { Runner } from '@openai/agents';
import type { Agent, AgentInputItem, ModelSettings } from '@openai/agents';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import type OpenAI from 'openai';
import type { InputTokenCountParams } from 'openai/resources/responses/input-tokens';
import { createHistoryInputFilter } from '../src/agents/manager-orchestrator/history-policy.js';
import type { OptimizationMode } from '../src/shared/config/session-optimization.js';

// Capture through the installed provider conversion path, never hand-roll SDK -> wire mapping.
export async function captureModelRequest(
  agent: Agent<any, any>, input: AgentInputItem[] | string, context: unknown,
  mode: OptimizationMode, modelSettings: ModelSettings = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const stop = new Error('request captured without provider execution');
  const client = { responses: { create: async (body: Record<string, unknown>) => {
    captured = structuredClone(body); throw stop;
  } } } as unknown as OpenAI;
  const runner = new Runner({
    tracingDisabled: true, modelSettings: { ...modelSettings, retry: { maxRetries: 0 } },
    callModelInputFilter: createHistoryInputFilter(undefined, mode),
    modelProvider: { getModel: (name) => new OpenAIResponsesModel(client, name ?? 'unknown') },
  });
  try { await runner.run(agent, input, { context, maxTurns: 1 }); }
  catch (error) { if (!captured) throw error; }
  if (!captured) throw new Error('No model request was captured.');
  return captured;
}

export function inputCountRequest(wire: Record<string, unknown>): InputTokenCountParams {
  // Only fields accepted by the installed token-count endpoint. Include schema/style/tool controls.
  const fields = ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls',
    'text', 'reasoning', 'personality', 'conversation', 'previous_response_id', 'truncation'];
  return Object.fromEntries(fields.filter((field) => wire[field] !== undefined).map((field) => [field, wire[field]])) as InputTokenCountParams;
}
