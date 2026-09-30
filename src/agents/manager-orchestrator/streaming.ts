/**
 * Compatibility adapter for callers that want the Manager turn as a stream.
 *
 * The Manager turn itself is a single nonstream `Runner.run()` (see
 * `runGatewayAgent`). The final answer can only be composed once every specialist
 * result is in — render references have to be resolved and scope and link
 * filtering applied before any text is user-visible — so there is nothing to emit
 * incrementally. This adapter therefore emits the finished answer as one chunk.
 *
 * It exists for existing live tests and scripts. The chat API calls
 * `runGatewayAgent` directly. Real token streaming is a separate change: it needs
 * the composition step to move after the stream rather than before it.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { generateTraceId } from '@openai/agents';
import { runGatewayAgent, type ManagerRunOptions } from './runner.js';

export function runGatewayAgentTextStream(options: ManagerRunOptions) {
  // Resolved here rather than inside the run, so the returned identifiers are
  // usable immediately instead of only after `completed`.
  const requestId = options.requestId ?? randomUUID();
  const traceId = options.traceId ?? generateTraceId();
  const sessionId = options.sessionId ?? 'default';

  const stream = new PassThrough();

  const completed = runGatewayAgent({ ...options, requestId, traceId, sessionId }).then(
    (result) => {
      stream.end(result.output);
      return { ...result, streamedOutputChars: result.output.length };
    },
    (error: unknown) => {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
      throw error;
    },
  );

  // A caller that only awaits `completed` must not also get an unhandled
  // 'error' event from a stream it never read.
  stream.on('error', () => {});

  return {
    requestId,
    traceId,
    sessionId,
    stream,
    completed,
    // The run prepares this same object in place, so a caller that passed one can
    // read its turn state without waiting for `completed`.
    context: options.context,
  };
}
