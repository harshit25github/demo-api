import { generateTraceId, withTrace } from '@openai/agents';
import { MaxTurnsExceededError, Runner } from '@openai/agents';
import type { Session } from '@openai/agents';
import { ObservedModelProvider, observeModelInput, UsageCollector, withUsageCollector } from '../../shared/observability/model-usage.js';
import { randomUUID } from 'node:crypto';
import { assertOpenAIConfig } from '../flight/config.js';
import { sanitizeTripPlannerOutput } from './scope-policy.js';
import { log } from '../../shared/logging/logger.js';
import {
  createTripPlannerSummaryContext,
  mergeTripPlannerSummaryContext,
} from './context/summary-context.js';
import {
  buildTripPlannerDynamicContext,
  TripPlannerAgent,
} from './agent.js';
import { tripPlannerAgentConfig } from './config.js';
import { createTripPlannerSession } from './session.js';
import {
  finalizeTripPlannerTurn,
  prepareTripPlannerTurn,
} from './context/lifecycle.js';

assertOpenAIConfig();

export const tripPlannerRunner = new Runner({
  modelProvider: new ObservedModelProvider(),
  callModelInputFilter: observeModelInput,
  model: tripPlannerAgentConfig.model,
  modelSettings: { ...tripPlannerAgentConfig.modelSettings, preserveRawUsage: true },
  workflowName: 'dummy-trip-planner-agent',
  traceIncludeSensitiveData: false,
});

type DynamicRecord = Record<string, any>;
const tripPlannerSessions = new Map<string, Session>();
const tripPlannerContexts = new Map<string, DynamicRecord>();

type PreparedTripPlannerTurn = ReturnType<typeof prepareTripPlannerTurn>;

interface PreparedTurnLogInput {
  requestId: string;
  sessionId: string;
  input: string;
  prepared: PreparedTripPlannerTurn;
  dynamicInstructions: string;
}

interface CompletedTurnLogInput {
  requestId: string;
  sessionId: string;
  output: string;
  lastAgent: string;
  toolsCalled: DynamicRecord[];
  context: DynamicRecord;
  scopeGuardrail: DynamicRecord | null;
}

interface RunTripPlannerOptions {
  input: string;
  summaryContext?: DynamicRecord;
  context?: DynamicRecord;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
}

function compactText(value: unknown, maxLength = 700): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function compactSummaryForLog(value: DynamicRecord = {}): DynamicRecord {
  const summary = createTripPlannerSummaryContext(value);
  return {
    pax: summary.pax,
    budget: summary.budget,
    origin: summary.origin,
    destination: summary.destination,
    tripType: summary.tripType,
    outbound_date: summary.outbound_date,
    return_date: summary.return_date,
    duration_days: summary.duration_days,
    upcomingEventCount: summary.upcomingEvents.length,
    placeCount: summary.placesOfInterest.length,
    suggestedQuestions: summary.suggestedQuestions,
  };
}

function parseToolArguments(value: unknown): unknown {
  if (!value) {
    return null;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function normalizeHostedToolCall(item: DynamicRecord): DynamicRecord | null {
  const rawItem = item?.rawItem;
  if (item?.type !== 'tool_call_item' || rawItem?.type !== 'hosted_tool_call') {
    return null;
  }

  const providerData = rawItem.providerData || {};
  return {
    tool: rawItem.name === 'web_search_call' ? 'web_search' : rawItem.name,
    input: parseToolArguments(rawItem.arguments) || providerData.action || null,
    status: String(rawItem.status || 'completed').toUpperCase(),
    output: {
      ok: rawItem.status !== 'failed',
      status: String(rawItem.status || 'completed').toUpperCase(),
    },
  };
}

function orderTurnToolCalls(
  result: DynamicRecord,
  recordedCalls: DynamicRecord[],
): DynamicRecord[] {
  const recordedByName = new Map<string, DynamicRecord[]>();
  for (const entry of recordedCalls) {
    const queue = recordedByName.get(entry.tool) || [];
    queue.push(entry);
    recordedByName.set(entry.tool, queue);
  }

  const ordered: DynamicRecord[] = [];
  for (const item of result?.newItems || []) {
    const hostedCall = normalizeHostedToolCall(item);
    if (hostedCall) {
      ordered.push(hostedCall);
      continue;
    }

    const rawItem = item?.rawItem;
    if (item?.type !== 'tool_call_item' || rawItem?.type !== 'function_call') {
      continue;
    }
    const queue = recordedByName.get(rawItem.name) || [];
    const recorded = queue.shift();
    if (recorded) {
      ordered.push(recorded);
    }
  }

  return ordered.length > 0 ? ordered : recordedCalls;
}

function getTripPlannerContext(
  sessionId: string,
  incomingContext?: DynamicRecord,
  incomingSummaryContext?: DynamicRecord,
): DynamicRecord {
  const existing = tripPlannerContexts.get(sessionId) || {};
  const appContext = { ...existing, ...(incomingContext || {}) };
  appContext.summaryContext = mergeTripPlannerSummaryContext(
    mergeTripPlannerSummaryContext(
      createTripPlannerSummaryContext(existing.summaryContext),
      incomingContext?.summaryContext,
    ),
    incomingSummaryContext,
  );
  appContext.tripPlanner = {
    ...(existing.tripPlanner || {}),
    ...(incomingContext?.tripPlanner || {}),
  };
  appContext.toolCallLog = Array.isArray(existing.toolCallLog)
    ? existing.toolCallLog
    : [];
  tripPlannerContexts.set(sessionId, appContext);
  return appContext;
}

export function getTripPlannerSession(sessionId = 'trip-planner-default'): Session {
  if (!tripPlannerSessions.has(sessionId)) {
    tripPlannerSessions.set(sessionId, createTripPlannerSession(sessionId));
  }
  return tripPlannerSessions.get(sessionId)!;
}

export async function clearTripPlannerSession(sessionId = 'trip-planner-default') {
  const session = tripPlannerSessions.get(sessionId);
  if (session) {
    await session.clearSession();
  }
  const hadContext = tripPlannerContexts.delete(sessionId);
  tripPlannerSessions.delete(sessionId);
  return Boolean(session || hadContext);
}

function logPreparedTurn({
  requestId,
  sessionId,
  input,
  prepared,
  dynamicInstructions,
}: PreparedTurnLogInput): void {
  log('info', '[SummaryContext][before]', {
    requestId,
    sessionId,
    summaryContext: compactSummaryForLog(prepared.summaryContextBefore),
  });
  log('info', '[CurrentUserMessage]', {
    requestId,
    sessionId,
    message: compactText(input),
  });
  log('info', 'trip_planner.dynamic_context', {
    requestId,
    sessionId,
    contextChars: dynamicInstructions.length,
    renderMode: prepared.planningBrief.responseStrategy.renderMode,
    scopeMode: prepared.scopeClassification.mode,
    toolStrategy: prepared.planningBrief.toolStrategy,
  });
}

function snapshotRunUsage(usage: DynamicRecord | null | undefined): DynamicRecord | null {
  if (!usage) {
    return null;
  }
  return {
    requests: Number(usage.requests || 0),
    inputTokens: Number(usage.inputTokens || 0),
    outputTokens: Number(usage.outputTokens || 0),
    totalTokens: Number(usage.totalTokens || 0),
  };
}

function logCompletedTurn({
  requestId,
  sessionId,
  output,
  lastAgent,
  toolsCalled,
  context,
  scopeGuardrail,
}: CompletedTurnLogInput): boolean {
  const webSearchUsed = toolsCalled.some((entry) => entry.tool === 'web_search');
  log('info', '[CurrentAgentResponse]', {
    requestId,
    sessionId,
    response: compactText(output),
  });
  log('info', '[LastAgent]', { requestId, sessionId, lastAgent });
  log('info', '[ToolsCalled]', {
    requestId,
    sessionId,
    tools: toolsCalled.map(({ tool, status, input }) => ({ tool, status, input })),
  });
  log('info', '[WebSearchUsed]', { requestId, sessionId, webSearchUsed });
  log('info', '[SummaryContext][after]', {
    requestId,
    sessionId,
    summaryContext: compactSummaryForLog(context.summaryContext),
  });
  if (scopeGuardrail?.changed) {
    log('warn', 'trip_planner.scope_guardrail', {
      requestId,
      sessionId,
      categories: scopeGuardrail.categories,
      violationCount: scopeGuardrail.violationCount,
    });
  }
  return webSearchUsed;
}

export async function runTripPlannerAgent(options: RunTripPlannerOptions) {
  const requestId = options.requestId ?? randomUUID();
  const sessionId = options.sessionId ?? 'trip-planner-default';
  const traceId = options.traceId ?? generateTraceId();
  const usage = new UsageCollector({ requestId, sessionId, traceId });
  return withUsageCollector(usage, () => withTrace('trip-planner', async () => ({
    ...await runTripPlannerAgentInternal({ ...options, requestId, traceId, sessionId }),
    usage: usage.snapshot(),
  }), { traceId }));
}

async function runTripPlannerAgentInternal({
  input,
  summaryContext,
  context,
  requestId = randomUUID(),
  sessionId = 'trip-planner-default',
}: RunTripPlannerOptions) {
  if (!input) {
    throw new Error('input is required.');
  }

  const startedAt = Date.now();
  const appContext = getTripPlannerContext(sessionId, context, summaryContext);
  appContext.requestId = requestId;
  appContext.sessionId = sessionId;
  const prepared = prepareTripPlannerTurn({
    context: appContext,
    input,
    requestId,
    sessionId,
  });
  const dynamicInstructions = buildTripPlannerDynamicContext({ context: appContext });
  const beforeToolCallCount = appContext.toolCallLog.length;
  let streamEventCount = 0;

  logPreparedTurn({
    requestId,
    sessionId,
    input,
    prepared,
    dynamicInstructions,
  });

  try {
    const result = await tripPlannerRunner.run(TripPlannerAgent, input, {
      context: appContext,
      maxTurns: tripPlannerAgentConfig.maxTurns,
      session: getTripPlannerSession(sessionId),
      stream: true,
      signal: AbortSignal.timeout(tripPlannerAgentConfig.timeoutMs),
    });
    const streamedHostedCallIds = new Set();
    for await (const event of result) {
      streamEventCount += 1;
      if (event.type !== 'run_item_stream_event' || event.name !== 'tool_called') {
        continue;
      }
      const hostedCall = normalizeHostedToolCall(event.item);
      const hostedCallId = event.item?.rawItem?.id || null;
      if (!hostedCall || (hostedCallId && streamedHostedCallIds.has(hostedCallId))) {
        continue;
      }
      appContext.toolCallLog.push(hostedCall);
      appContext.tripPlanner.currentTurnToolCalls.push(hostedCall);
      if (hostedCallId) {
        streamedHostedCallIds.add(hostedCallId);
      }
    }
    await result.completed;

    const lastAgent = result.lastAgent?.name || TripPlannerAgent.name;
    const guardedOutput = sanitizeTripPlannerOutput(result.finalOutput || '', appContext);
    const output = guardedOutput.output;
    const recordedCalls = appContext.tripPlanner.currentTurnToolCalls || [];
    const toolsCalled = orderTurnToolCalls(
      result as unknown as DynamicRecord,
      recordedCalls,
    );
    appContext.toolCallLog.splice(
      beforeToolCallCount,
      appContext.toolCallLog.length - beforeToolCallCount,
      ...toolsCalled,
    );
    const finalized = finalizeTripPlannerTurn({
      context: appContext,
      output,
      responseMode:
        appContext.tripPlanner?.planningBrief?.responseStrategy?.renderMode ||
        null,
      storePlanArtifact: !guardedOutput.scopeGuardrail?.changed,
    });
    const webSearchUsed = logCompletedTurn({
      requestId,
      sessionId,
      output,
      lastAgent,
      toolsCalled,
      context: appContext,
      scopeGuardrail: guardedOutput.scopeGuardrail,
    });
    const latencyMs = Date.now() - startedAt;
    const usage = snapshotRunUsage(result.runContext?.usage);

    log('info', 'trip_planner.final_response', {
      requestId,
      sessionId,
      latencyMs,
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      suggestionCount: appContext.summaryContext.suggestedQuestions.length,
      revision: finalized.revision,
    });

    return {
      requestId,
      sessionId,
      model: tripPlannerAgentConfig.model,
      output,
      latencyMs,
      context: appContext,
      debug: {
        inputSummaryContext: prepared.summaryContextBefore,
        hydratedSummaryContext: prepared.summaryContextAfterHydration,
        inferredContextPatch: appContext.tripPlanner.latestContextPatch || {},
        planningBrief: appContext.tripPlanner.planningBrief,
        dynamicInstructions,
        toolsCalled,
        webSearchUsed,
        lastAgent,
        streamEventCount,
        summaryContextAfter: finalized.summaryContext,
        contextRevision: finalized.revision,
        linkGuardrail: guardedOutput.guardrail,
        scopeGuardrail: guardedOutput.scopeGuardrail,
        suggestedQuestions: finalized.summaryContext.suggestedQuestions,
        usage,
      },
      result,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startedAt;
    appContext.summaryContext.suggestedQuestions = [];
    const toolsCalled = [...(appContext.tripPlanner.currentTurnToolCalls || [])];
    const webSearchUsed = toolsCalled.some((entry) => entry.tool === 'web_search');
    const output =
      error instanceof MaxTurnsExceededError
        ? 'I could not complete the trip plan within the current turn limit.'
        : 'I am having trouble creating that trip plan right now. Please try again.';

    log('error', 'trip_planner.error', {
      requestId,
      sessionId,
      latencyMs,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    logCompletedTurn({
      requestId,
      sessionId,
      output,
      lastAgent: TripPlannerAgent.name,
      toolsCalled,
      context: appContext,
      scopeGuardrail: null,
    });

    return {
      requestId,
      sessionId,
      model: tripPlannerAgentConfig.model,
      output,
      latencyMs,
      context: appContext,
      error: true,
      debug: {
        inputSummaryContext: prepared.summaryContextBefore,
        hydratedSummaryContext: prepared.summaryContextAfterHydration,
        inferredContextPatch: appContext.tripPlanner.latestContextPatch || {},
        planningBrief: appContext.tripPlanner.planningBrief,
        dynamicInstructions,
        toolsCalled,
        webSearchUsed,
        lastAgent: TripPlannerAgent.name,
        streamEventCount,
        summaryContextAfter: createTripPlannerSummaryContext(appContext.summaryContext),
        suggestedQuestions: [],
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : 'Trip Planner run failed.',
        },
      },
    };
  }
}
