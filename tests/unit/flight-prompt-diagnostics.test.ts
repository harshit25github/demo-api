import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentTrace, withTrace } from '@openai/agents';
import {
  createFlightPromptDiagnostics,
  promptDiagnosticSnapshotPath,
  prunePromptDiagnosticSnapshots,
  readFlightPromptDiagnosticSnapshot,
  shouldCaptureExactPromptDiagnostics,
} from '../../src/agents/manager-orchestrator/diagnostics.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flight-prompt-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sampleModelCall() {
  return {
    modelData: {
      instructions: '# Flight Agent\nUse current search context.\n\nDo not expose USER_SECRET.',
      input: [
        { type: 'message', role: 'user', content: 'USER_SECRET sk-testSecretValue123' },
      ],
    },
    agent: {
      name: 'FlightAgent',
      modelSettings: { reasoning: { effort: 'low' }, apiKey: 'sk-agentSecret12345' },
      tools: [
        {
          name: 'flight_search',
          description: 'Search flights.',
          parameters: {
            type: 'object',
            properties: { origin: { type: 'string' } },
          },
        },
        {
          name: 'generated_contracts_context',
          description: 'Get contract context.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'apply_filter',
          description: 'Apply filter.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'price_prediction_tool',
          description: 'Get price prediction.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'update_flight_suggested_questions',
          description: 'Update suggested questions.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
  };
}

test('safe capture records metadata and leaves model input unchanged', async (t) => {
  const directory = await temporaryDirectory(t);
  const diagnostics = createFlightPromptDiagnostics({
    traceId: 'trace_safe123',
    requestId: 'req_safe',
    sessionId: 'session-secret',
    directory,
    exactCapture: false,
    staticInstructions: '# Flight Agent',
  });
  const call = sampleModelCall();

  const returnedModelData = await diagnostics.callModelInputFilter(call);
  await diagnostics.recordResult({
    rawResponses: [{ responseId: 'resp_1', requestId: 'request_1' }],
  });

  assert.strictEqual(returnedModelData, call.modelData);
  const rawSnapshot = await readFile(diagnostics.snapshotPath, 'utf8');
  assert.doesNotMatch(rawSnapshot, /USER_SECRET|sk-testSecretValue123|session-secret/);

  const snapshot = JSON.parse(rawSnapshot);
  assert.equal(snapshot.captureMode, 'safe');
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.modelCalls[0].agent, 'FlightAgent');
  assert.equal(snapshot.modelCalls[0].responseId, 'resp_1');
  assert.equal(snapshot.modelCalls[0].requestId, 'request_1');
  assert.equal(snapshot.modelCalls[0].instructions, undefined);
  assert.equal(snapshot.modelCalls[0].staticInstructionChars, '# Flight Agent'.length);
  assert.equal(
    snapshot.modelCalls[0].dynamicInstructionChars,
    call.modelData.instructions.length - '# Flight Agent'.length,
  );
  assert.deepEqual(snapshot.modelCalls[0].toolNames, [
    'flight_search',
    'generated_contracts_context',
    'apply_filter',
    'price_prediction_tool',
    'update_flight_suggested_questions',
  ]);
});

test('exact capture is non-production only and redacts credential-shaped values', async (t) => {
  const directory = await temporaryDirectory(t);
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (previousEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousEnvironment;
    }
  });

  const diagnostics = createFlightPromptDiagnostics({
    traceId: 'trace_exact123',
    requestId: 'req_exact',
    directory,
    exactCapture: true,
  });
  await diagnostics.callModelInputFilter(sampleModelCall());
  await diagnostics.recordResult({ rawResponses: [] });

  const rawSnapshot = await readFile(diagnostics.snapshotPath, 'utf8');
  const snapshot = JSON.parse(rawSnapshot);
  assert.equal(snapshot.captureMode, 'exact');
  assert.match(snapshot.modelCalls[0].instructions, /Flight Agent/);
  assert.match(rawSnapshot, /USER_SECRET/);
  assert.doesNotMatch(rawSnapshot, /sk-testSecretValue123|sk-agentSecret12345/);
  assert.match(rawSnapshot, /\[REDACTED\]/);
});

test('production environment refuses exact capture', () => {
  assert.equal(
    shouldCaptureExactPromptDiagnostics({ environment: 'production', enabled: 'true' }),
    false,
  );
  assert.equal(
    shouldCaptureExactPromptDiagnostics({ environment: 'staging', enabled: 'true' }),
    true,
  );
});

test('invalid prompt marks the latest captured model call', async (t) => {
  const directory = await temporaryDirectory(t);
  const diagnostics = createFlightPromptDiagnostics({
    traceId: 'trace_failure123',
    requestId: 'req_failure',
    directory,
  });
  await diagnostics.callModelInputFilter(sampleModelCall());
  await diagnostics.recordError(
    new Error('Invalid prompt: your prompt was flagged as potentially violating our usage policy.'),
  );

  const snapshot = await readFlightPromptDiagnosticSnapshot('trace_failure123', { directory });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.error.kind, 'INVALID_PROMPT');
  assert.equal(snapshot.error.failedModelCallSequence, 1);
  assert.equal(snapshot.modelCalls[0].errorKind, 'INVALID_PROMPT');
});

test('custom trace ID is active for the complete traced callback', async () => {
  const traceId = 'trace_custom123';
  await withTrace(
    'gateway-agent-test',
    async () => {
      assert.equal(getCurrentTrace()?.traceId, traceId);
      await Promise.resolve();
      assert.equal(getCurrentTrace()?.traceId, traceId);
    },
    { traceId },
  );
});

test('snapshot pruning removes files older than retention period', async (t) => {
  const directory = await temporaryDirectory(t);
  const oldPath = promptDiagnosticSnapshotPath('trace_old123', directory);
  await mkdir(path.dirname(oldPath), { recursive: true });
  await writeFile(oldPath, '{}', 'utf8');
  const oldTime = new Date('2026-08-18T00:00:00.000Z');
  await utimes(oldPath, oldTime, oldTime);

  const removed = await prunePromptDiagnosticSnapshots({
    directory,
    retentionHours: 24,
    now: new Date('2026-08-21T00:00:00.000Z').getTime(),
  });

  assert.equal(removed, 1);
  assert.equal(await readFlightPromptDiagnosticSnapshot('trace_old123', { directory }), null);
});
