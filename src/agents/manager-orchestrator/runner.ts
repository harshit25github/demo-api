import { generateTraceId, Runner, setDefaultOpenAIKey, withTrace } from '@openai/agents';
import { ObservedModelProvider, observeModelInput, currentUsageCollector, UsageCollector, withUsageCollector } from '../../shared/observability/model-usage.js';
import { sessionOptimization } from '../../shared/config/session-optimization.js';
import { resolveCompactionPolicy } from '../../shared/config/compaction-policy.js';
import { randomUUID } from 'node:crypto';
import { assertOpenAIConfig, flightAgentConfig } from '../flight/config.js';
import {
  ensureFlightRuntimeContext,
  prepareFlightAgentTurnContext,
} from '../flight/context/flight-context.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { createManagerAgent } from './agent.js';
import { gatewayAgentConfig } from './config.js';
import {
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
} from '../manager/tools.js';
import {
  gatewayModelRetrySettings,
} from './retry.js';
import { log } from '../../shared/logging/logger.js';
import { FLIGHT_PROMPT } from '../flight/prompt.js';
import {
  createFlightPromptDiagnostics,
  prunePromptDiagnosticSnapshots,
} from './diagnostics.js';
import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import type { FlightAppContext } from '../flight/types.js';

export { sanitizeGatewayOutputForFinalAgent } from './output-guardrail.js';

assertOpenAIConfig();
setDefaultOpenAIKey(flightAgentConfig.openaiApiKey!);

type DynamicRecord = Record<string, any>;

interface ManagerRunOptions {
  input: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  context?: unknown;
  maxTurns?: number;
  now?: Date | string | number;
  timeZone?: string;
  workflowName?: string;
}

// Compaction policy for Manager mode
const managerModeModels = [gatewayAgentConfig.model];
export const mainChatCompaction = resolveCompactionPolicy(sessionOptimization, managerModeModels);
export const mainChatRunner = new Runner({
  modelProvider: new ObservedModelProvider(),
  callModelInputFilter: observeModelInput,
  model: gatewayAgentConfig.model,
  modelSettings: {
    ...gatewayAgentConfig.modelSettings,
    preserveRawUsage: true,
    retry: gatewayModelRetrySettings,
    ...mainChatCompaction.settings,
  },
  workflowName: 'travel-manager',
  traceIncludeSensitiveData: true,
});
if (sessionOptimization.compactionEnabled && !mainChatCompaction.enabled) {
  log('warn', 'session_compaction.disabled', { reason: mainChatCompaction.reason });
}

let promptDiagnosticsCleanupStarted = false;

export function createGatewayPromptDiagnostics({
  traceId,
  requestId,
  sessionId,
}: {
  traceId: string;
  requestId: string;
  sessionId: string;
}) {
  if (!promptDiagnosticsCleanupStarted) {
    promptDiagnosticsCleanupStarted = true;
    void prunePromptDiagnosticSnapshots().catch((error: unknown) => {
      log('warn', 'flight_prompt_diagnostics.cleanup_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  }

  return createFlightPromptDiagnostics({
    traceId,
    requestId,
    sessionId,
    staticInstructions: FLIGHT_PROMPT,
    onError(error: unknown) {
      log('warn', 'flight_prompt_diagnostics.capture_failed', {
        traceId,
        requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    },
  });
}

export async function runWithPromptDiagnostics<T>({
  traceId,
  requestId,
  diagnostics,
  operation,
}: {
  traceId: string;
  requestId: string;
  diagnostics: ReturnType<typeof createGatewayPromptDiagnostics>;
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    const result = await withTrace(
      'travel-manager',
      operation,
      {
      traceId,
      metadata: { requestId },
      },
    );
    await diagnostics.recordResult(result as DynamicRecord);
    return result;
  } catch (error) {
    await diagnostics.recordError(error);
    throw error;
  }
}

export function finalizeManagerAgentResult({
  result,
  appContext,
  turnState,
  startedAt = Date.now(),
}: {
  result: DynamicRecord;
  appContext: FlightAppContext;
  turnState: ReturnType<typeof createManagerTurnState>;
  startedAt?: number;
}) {
  const composed = finalizeManagerOutput(String(result?.finalOutput || ''), turnState);
  const sanitized = sanitizeNoLinks(composed.output, { preserveCardImageUrls: true });
  assertNoLinks(sanitized.text, { allowCardImageUrls: true });
  return {
    output: sanitized.text,
    finalAgentName: 'Manager Agent',
    context: appContext,
    latencyMs: Date.now() - startedAt,
    specialistsUsed: composed.specialistsUsed,
    renderFlightOptions: composed.renderFlightOptions,
    lastResponseId: result?.lastResponseId || null,
  };
}

export function buildGatewayContext({
  context,
  input,
  requestId,
  sessionId,
}: {
  context?: unknown;
  input: string;
  requestId: string;
  sessionId: string;
}): FlightAppContext {
  const appContext = ensureFlightRuntimeContext(context);
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  appContext.currentUserMessage = String(input || '');
  appContext.tripPlanner =
    appContext.tripPlanner && typeof appContext.tripPlanner === 'object'
      ? appContext.tripPlanner
      : {};
  appContext.tripPlanner.currentUserMessage = String(input || '');
  prepareFlightAgentTurnContext(appContext, {
    requestId,
    sessionId,
  });
  return appContext;
}

export async function runGatewayAgent(options: ManagerRunOptions) {
  const requestId = options.requestId ?? randomUUID();
  const traceId = options.traceId ?? generateTraceId();
  const sessionId = options.sessionId ?? 'default';
  const usage = currentUsageCollector() ?? new UsageCollector({ requestId, traceId, sessionId });
  return withUsageCollector(usage, async () => ({
    ...await runManagerAgentInternal({ ...options, requestId, traceId, sessionId }),
    usage: usage.snapshot(),
  }));
}

async function runManagerAgentInternal({
  input,
  requestId = randomUUID(),
  traceId = generateTraceId(),
  sessionId = 'default',
  context,
  maxTurns = 12,
  now = new Date(),
  timeZone,
}: ManagerRunOptions) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const appContext = buildGatewayContext({
    context,
    input,
    requestId,
    sessionId,
  });
  const requestClock = createRequestClock({ now, timeZone });
  const requestContext = createRequestContext(appContext, requestClock);
  const diagnostics = createGatewayPromptDiagnostics({ traceId, requestId, sessionId });
  const managerTurn = createManagerTurnState(appContext, requestId);
  const managerAgent = createManagerAgent(createManagerTools(managerTurn));

  log('info', 'manager_agent.request', { requestId, traceId, sessionId, input });

  const result: DynamicRecord = await runWithPromptDiagnostics({
    traceId,
    requestId,
    diagnostics,
    operation: () =>
      mainChatRunner.run(managerAgent, input, {
        context: requestContext,
        maxTurns,
        callModelInputFilter: diagnostics.callModelInputFilter,
      }),
  });

  const finalized = finalizeManagerAgentResult({
    result,
    appContext,
    turnState: managerTurn,
    startedAt,
  });

  log('info', 'manager_agent.response', {
    requestId,
    traceId,
    sessionId,
    specialistsUsed: finalized.specialistsUsed,
    latencyMs: finalized.latencyMs,
  });

  return {
    requestId,
    traceId,
    sessionId,
    ...finalized,
    result,
  };
}
