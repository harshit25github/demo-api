import { PassThrough } from 'node:stream';
import { Runner } from '@openai/agents';
import { isModelTimeoutError } from '../../src/agents/manager-orchestrator/retry.js';

type RunnerOptions = {
  model: unknown;
  modelSettings: Record<string, unknown>;
  retry: unknown;
  timeoutMs: number;
};

type RecoveryOptions = RunnerOptions & {
  agent: unknown;
  input: unknown;
  context: unknown;
  session?: unknown;
  maxTurns: number;
  initialTimeoutMs?: number;
  timeoutIncrementMs?: number;
  maxRecoveries?: number;
  onRecovery?: (event: {
    recovery: number;
    previousTimeoutMs: number;
    nextTimeoutMs: number;
  }) => void | Promise<void>;
};

function createRunner({ model, modelSettings, retry, timeoutMs }: RunnerOptions) {
  return new Runner({
    model: model as never,
    modelSettings: {
      ...modelSettings,
      timeoutMs,
      retry,
    },
  });
}

function forwardText(result: any, output: PassThrough) {
  const textStream = result.toTextStream({ compatibleWithNodeStreams: true });
  let outputChars = 0;

  const textCompleted = new Promise<void>((resolve, reject) => {
    textStream.on('data', (chunk: unknown) => {
      const text = String(chunk || '');
      outputChars += text.length;
      output.write(text);
    });
    textStream.once('end', resolve);
    textStream.once('error', reject);
  });

  return {
    get outputChars() {
      return outputChars;
    },
    async completed() {
      const settled = await Promise.allSettled([textCompleted, result.completed]);
      const failure = settled.find((item) => item.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    },
  };
}

export function runStreamingWithTimeoutRecovery({
  agent,
  input,
  context,
  session,
  maxTurns,
  model,
  modelSettings,
  retry,
  initialTimeoutMs = 80_000,
  timeoutIncrementMs = 4_000,
  maxRecoveries = 4,
  onRecovery,
}: RecoveryOptions) {
  const output = new PassThrough();

  const completed = (async () => {
    let runInput = input;
    let timeoutMs = initialTimeoutMs;
    let recoveries = 0;
    let outputChars = 0;

    while (true) {
      const runner = createRunner({ model, modelSettings, retry, timeoutMs });
      const result: any = await runner.run(agent as never, runInput as never, {
        context,
        session,
        maxTurns,
        stream: true,
      } as never);
      const current = forwardText(result, output);

      try {
        await current.completed();
        outputChars += current.outputChars;
        output.end();
        return { result, recoveries, timeoutMs };
      } catch (error) {
        outputChars += current.outputChars;
        const canRecover =
          isModelTimeoutError(error) &&
          outputChars === 0 &&
          recoveries < maxRecoveries &&
          Boolean(result.state);

        if (!canRecover) throw error;

        recoveries += 1;
        const previousTimeoutMs = timeoutMs;
        timeoutMs += timeoutIncrementMs;
        await onRecovery?.({ recovery: recoveries, previousTimeoutMs, nextTimeoutMs: timeoutMs });

        // Continue the unfinished turn instead of resending the original input.
        runInput = result.state;
      }
    }
  })();

  completed.catch((error) => output.destroy(error));
  return { stream: output, completed };
}
