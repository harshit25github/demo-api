import { generateTraceId, MaxTurnsExceededError } from '@openai/agents';
import { createHistoryInputFilter } from './history-policy.js';
import { currentUsageCollector, UsageCollector, withUsageCollector } from '../../shared/observability/model-usage.js';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createManagerAgent } from './agent.js';
import {
  buildManagerPartialFallback,
  createManagerTools,
  createManagerTurnState,
  finalizeManagerOutput,
} from '../manager/tools.js';
import {
  buildGatewayContext,
  createGatewayPromptDiagnostics,
  finalizeManagerAgentResult,
  mainChatRunner,
  runWithPromptDiagnostics,
} from './runner.js';
import { isModelTimeoutError } from './retry.js';
import { createRequestContext } from '../../shared/runtime/request-context.js';
import { createRequestClock } from '../../shared/time/request-clock.js';
import { log } from '../../shared/logging/logger.js';
import { buildFlightCoreSuccessFallback } from '../flight/context/recovery-outcome.js';
import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';

type DynamicRecord = Record<string, any>;

interface GatewayTextStreamOptions {
  input: string;
  requestId?: string;
  traceId?: string;
  sessionId?: string;
  context?: unknown;
  maxTurns?: number;
  now?: Date | string | number;
  timeZone?: string;
  runner?: StreamRunner;
  session?: unknown;
  signal?: AbortSignal;
  maxTimeoutRecoveries?: number;
  onRetry?: (details: DynamicRecord) => void | Promise<void>;
}

interface StreamRunResult extends DynamicRecord {
  completed: Promise<unknown>;
  state: unknown;
  toTextStream(options: { compatibleWithNodeStreams: true }): NodeJS.ReadableStream;
}

interface StreamRunner {
  run(agent: unknown, input: unknown, options: DynamicRecord): Promise<StreamRunResult>;
}

function consumeTextStream(result: StreamRunResult, destination: PassThrough) {
  const textStream = result.toTextStream({
    compatibleWithNodeStreams: true,
  });
  let outputChars = 0;

  const textCompleted = new Promise<void>((resolve, reject) => {
    textStream.on('data', (chunk: string | Buffer) => {
      const text = String(chunk || '');
      outputChars += text.length;
      destination.write(text);
    });
    textStream.once('error', reject);
    textStream.once('end', resolve);
  });

  return {
    get outputChars() {
      return outputChars;
    },
    async completed() {
      const outcomes = await Promise.allSettled([textCompleted, result.completed]);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failure) {
        throw failure.reason;
      }
    },
  };
}

export function runGatewayTextStreamWithTimeoutRecovery({
  runner,
  agent,
  input,
  runOptions = {},
  maxTimeoutRecoveries = 1,
  onRetry,
}: {
  runner: StreamRunner;
  agent: unknown;
  input: unknown;
  runOptions?: DynamicRecord;
  maxTimeoutRecoveries?: number;
  onRetry?: (details: DynamicRecord) => void | Promise<void>;
}) {
  const stream = new PassThrough();

  const completed = Promise.resolve().then(async () => {
    let nextInput = input;
    let timeoutRecoveries = 0;
    let totalOutputChars = 0;

    while (true) {
      const result = await runner.run(agent, nextInput, {
        ...runOptions,
        stream: true,
      });
      const attempt = consumeTextStream(result, stream);

      try {
        await attempt.completed();
        totalOutputChars += attempt.outputChars;
        stream.end();
        return {
          result,
          timeoutRecoveries,
          totalOutputChars,
        };
      } catch (error) {
        totalOutputChars += attempt.outputChars;
        const canRecover =
          isModelTimeoutError(error) &&
          timeoutRecoveries < maxTimeoutRecoveries &&
          totalOutputChars === 0;

        if (!canRecover) {
          throw error;
        }

        timeoutRecoveries += 1;
        await onRetry?.({
          attempt: timeoutRecoveries,
          maxTimeoutRecoveries,
          errorName: error.name,
          errorCode: error.code || null,
          state: result.state,
        });

        // Resume the unfinished turn. Re-sending the original input would repeat
        // Gateway handoffs and any completed tools.
        nextInput = result.state;
      }
    }
  });

  completed.catch((error) => {
    stream.destroy(error);
  });

  return {
    stream,
    completed,
  };
}


export function runGatewayAgentTextStream({
  input,
  requestId = randomUUID(),
  traceId = generateTraceId(),
  sessionId = 'default',
  context,
  session,
  signal,
  maxTurns = 12,
  maxTimeoutRecoveries = 1,
  onRetry,
  runner = mainChatRunner as unknown as StreamRunner,
  now = new Date(),
  timeZone,
}: GatewayTextStreamOptions) {
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
  const turnToolLogStart = appContext.toolCallLog.length;
  const requestClock = createRequestClock({ now, timeZone });
  const requestContext = createRequestContext(appContext, requestClock);
  const diagnostics = createGatewayPromptDiagnostics({ traceId, requestId, sessionId });
  const managerTurn = createManagerTurnState(appContext, requestId);
  const activeAgent = createManagerAgent(createManagerTools(managerTurn));
  const stream = new PassThrough();
  let streamedOutputChars = 0;

  const usage = currentUsageCollector() ?? new UsageCollector({ requestId, traceId, sessionId });
  const completed = withUsageCollector(usage, () => runWithPromptDiagnostics({
    traceId,
    requestId,
    diagnostics,
    operation: async () => {
      const recovery = runGatewayTextStreamWithTimeoutRecovery({
        runner,
        agent: activeAgent,
        input,
        runOptions: {
          context: requestContext,
          maxTurns,
          session,
          signal,
          callModelInputFilter: createHistoryInputFilter(diagnostics.callModelInputFilter),
        },
        maxTimeoutRecoveries,
        onRetry,
      });

      recovery.stream.on('data', (chunk) => {
        // Manager tool results can contain opaque render references. They are
        // resolved and validated before any user-visible text is emitted.
        if (managerTurn) return;
        const text = String(chunk);
        streamedOutputChars += text.length;
        if (text.length) usage.markFirstDelta();
        stream.write(chunk);
      });
      // Completion carries the authoritative failure. Consume the inner stream
      // error so a terminal model timeout cannot become an unhandled EventEmitter error.
      recovery.stream.on('error', () => {});

      try {
        const recoveryResult = await recovery.completed;
        const finalized = finalizeManagerAgentResult({
          result: recoveryResult.result,
          appContext,
          turnState: managerTurn,
          startedAt,
        });
        if (finalized.output) {
          usage.markFirstDelta();
          streamedOutputChars = finalized.output.length;
        }
        stream.end(finalized.output);
        return {
          ...finalized,
          timeoutRecoveries: recoveryResult.timeoutRecoveries,
          streamedOutputChars,
          result: recoveryResult.result,
          rawResponses: recoveryResult.result.rawResponses,
        };
      } catch (error: unknown) {
        if (error instanceof MaxTurnsExceededError) {
          let fallback = buildManagerPartialFallback(managerTurn);
          if (!fallback) {
            const completedFlightWork = buildFlightCoreSuccessFallback(appContext, turnToolLogStart);
            if (completedFlightWork) {
              managerTurn.outcomes.push({
                name: 'flight_agent',
                input,
                result: { status: 'partial', summary: completedFlightWork },
              });
              fallback = buildManagerPartialFallback(managerTurn);
            }
          }
          if (fallback) {
            const sanitized = sanitizeNoLinks(fallback, { preserveCardImageUrls: true });
            assertNoLinks(sanitized.text, { allowCardImageUrls: true });
            const composed = finalizeManagerOutput('', managerTurn);
            usage.markFirstDelta();
            streamedOutputChars = sanitized.text.length;
            stream.end(sanitized.text);
            log('warn', 'manager_agent.max_turns_partial_result_recovered', {
              requestId,
              traceId,
              sessionId,
              specialistsUsed: composed.specialistsUsed,
            });
            return {
              output: sanitized.text,
              finalAgentName: 'Manager Agent',
              context: appContext,
              latencyMs: Date.now() - startedAt,
              specialistsUsed: composed.specialistsUsed,
              renderFlightOptions: composed.renderFlightOptions,
              lastResponseId: null,
              timeoutRecoveries: 0,
              streamedOutputChars,
              result: null,
              rawResponses: [],
              recoveredFromMaxTurns: true,
            };
          }
        }
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
  })).then((result) => ({ ...result, usage: usage.snapshot() }));

  return {
    requestId,
    traceId,
    sessionId,
    stream,
    completed,
    context: appContext,
  };
}
