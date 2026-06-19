import { Runner, setDefaultOpenAIKey } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { assertOpenAIConfig, flightAgentConfig } from './config.js';
import { GatewayAgent, gatewayAgentConfig } from './gatewayAgent.js';
import { sanitizeGatewayOutputForFinalAgent } from './gatewayOutputGuardrail.js';
import { log } from './logger.js';

export {
  createSanitizedTripPlannerTextStream,
  sanitizeGatewayOutputForFinalAgent,
} from './gatewayOutputGuardrail.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey);

export const gatewayRunner = new Runner({
  model: gatewayAgentConfig.model,
  modelSettings: gatewayAgentConfig.modelSettings,
  workflowName: 'gateway-agent',
  traceIncludeSensitiveData: false,
});

function selectedAgentFromContext(context) {
  return context?.gatewaySelections?.at(-1)?.selectedAgent || null;
}

function finalAgentNameFromResult(result, context) {
  return result?.lastAgent?.name || result?.activeAgent?.name || selectedAgentFromContext(context);
}

function buildGatewayContext({ context, requestId, sessionId }) {
  const appContext = context || {};
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  appContext.gatewaySelections ||= [];
  return appContext;
}

export async function runGatewayAgent({
  input,
  requestId = randomUUID(),
  sessionId = 'default',
  context,
  maxTurns = 6,
} = {}) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const appContext = buildGatewayContext({ context, requestId, sessionId });

  log('info', 'gateway_agent.request', { requestId, sessionId, input });

  const result = await gatewayRunner.run(GatewayAgent, input, {
    context: appContext,
    maxTurns,
  });

  const finalAgentName = finalAgentNameFromResult(result, appContext);
  const processed = sanitizeGatewayOutputForFinalAgent({
    output: result.finalOutput || '',
    finalAgentName,
    context: appContext,
  });
  const latencyMs = Date.now() - startedAt;

  log('info', 'gateway_agent.response', {
    requestId,
    sessionId,
    selectedAgent: finalAgentName,
    latencyMs,
    linkGuardrail: processed.guardrail,
  });

  return {
    requestId,
    sessionId,
    output: processed.output,
    finalAgentName,
    context: appContext,
    latencyMs,
    linkGuardrail: processed.guardrail,
    result,
  };
}

async function completeGatewayAgentStream({
  input,
  requestId,
  sessionId,
  appContext,
  maxTurns,
  includeInternalEvents,
  startedAt,
}) {
  const internalEvents = [];

  log('info', 'gateway_agent.stream_request', { requestId, sessionId, input });

  const streamedResult = await gatewayRunner.run(GatewayAgent, input, {
    context: appContext,
    maxTurns,
    stream: true,
  });

  for await (const event of streamedResult) {
    if (includeInternalEvents) {
      internalEvents.push(event);
    }
  }

  await streamedResult.completed;

  const finalAgentName = finalAgentNameFromResult(streamedResult, appContext);
  const processed = sanitizeGatewayOutputForFinalAgent({
    output: streamedResult.finalOutput || '',
    finalAgentName,
    context: appContext,
  });
  const latencyMs = Date.now() - startedAt;

  log('info', 'gateway_agent.stream_response', {
    requestId,
    sessionId,
    selectedAgent: finalAgentName,
    latencyMs,
    linkGuardrail: processed.guardrail,
  });

  return {
    requestId,
    sessionId,
    output: processed.output,
    finalAgentName,
    context: appContext,
    latencyMs,
    linkGuardrail: processed.guardrail,
    internalEvents: includeInternalEvents ? internalEvents : undefined,
  };
}

export function runGatewayAgentStream({
  input,
  requestId = randomUUID(),
  sessionId = 'default',
  context,
  maxTurns = 6,
  includeInternalEvents = false,
} = {}) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const appContext = buildGatewayContext({ context, requestId, sessionId });
  const completed = completeGatewayAgentStream({
    input,
    requestId,
    sessionId,
    appContext,
    maxTurns,
    includeInternalEvents,
    startedAt,
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await completed;
        if (result.output) {
          controller.enqueue(result.output);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    requestId,
    sessionId,
    stream,
    completed,
    context: appContext,
  };
}
