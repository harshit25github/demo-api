import process from 'node:process';
import { readFlightPromptDiagnosticSnapshot } from '../src/agents/manager-orchestrator/diagnostics.js';

type DynamicRecord = Record<string, any>;

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function formatCall(call: DynamicRecord): string {
  const status = call.errorKind ? `FAILED (${call.errorKind})` : 'captured';
  return [
    `#${call.sequence} ${call.agent} - ${status}`,
    `  model: ${call.model}`,
    `  instructions: ${call.instructionChars} chars (~${call.estimatedInstructionTokens} tokens)`,
    `  static/dynamic: ${call.staticInstructionChars}/${call.dynamicInstructionChars} chars`,
    `  input: ${call.inputItemCount} items, ${call.inputChars} chars (~${call.estimatedInputTokens} tokens)`,
    `  tools: ${call.toolCount} (${call.toolNames.join(', ') || 'none'})`,
    `  tool definitions: ${call.toolDefinitionChars} chars`,
    `  responseId: ${call.responseId || 'not available'}`,
    `  requestId: ${call.requestId || 'not available'}`,
    `  repeated instruction blocks: ${call.repeatedInstructionBlocks.length}`,
    '  largest instruction sections:',
    ...call.largestInstructionSections.map(
      (section: DynamicRecord) =>
        `    - ${section.heading || section.headingHash}: ${section.chars} chars`,
    ),
  ].join('\n');
}

function printExactCall(call: DynamicRecord): void {
  process.stdout.write(`\n===== MODEL CALL #${call.sequence}: ${call.agent} =====\n`);
  process.stdout.write('\n--- Instructions ---\n');
  process.stdout.write(`${call.instructions || ''}\n`);
  process.stdout.write('\n--- Input/history ---\n');
  process.stdout.write(`${JSON.stringify(call.input || [], null, 2)}\n`);
  process.stdout.write('\n--- Tools ---\n');
  process.stdout.write(`${JSON.stringify(call.tools || [], null, 2)}\n`);
  process.stdout.write('\n--- Model settings ---\n');
  process.stdout.write(`${JSON.stringify(call.modelSettings || null, null, 2)}\n`);
}

async function main() {
  const traceId = argumentValue('--trace-id');
  const showExact = process.argv.includes('--show-exact');

  if (!traceId) {
    throw new Error('Usage: npm run inspect:flight-prompt -- --trace-id trace_xxx [--show-exact]');
  }

  const snapshot = await readFlightPromptDiagnosticSnapshot(traceId);
  if (!snapshot) {
    process.stderr.write(
      [
        `No local prompt snapshot exists for ${traceId}.`,
        'Old traces created without request-time diagnostics cannot be reconstructed.',
        'Use the OpenAI Traces dashboard for timing, model, tool, response ID, and request ID metadata.',
      ].join('\n') + '\n',
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    [
      `Trace: ${snapshot.traceId}`,
      `Request: ${snapshot.requestId || 'not available'}`,
      `Capture mode: ${snapshot.captureMode}`,
      `Status: ${snapshot.status}`,
      `Model calls: ${snapshot.modelCalls.length}`,
      snapshot.error
        ? `Terminal error: ${snapshot.error.kind}; failed call #${snapshot.error.failedModelCallSequence || 'unknown'}`
        : 'Terminal error: none',
      '',
      ...snapshot.modelCalls.map(formatCall).flatMap((value: string) => [value, '']),
    ].join('\n'),
  );

  if (!showExact) {
    return;
  }
  if (snapshot.captureMode !== 'exact') {
    process.stderr.write(
      '\nExact prompt was not captured. Enable FLIGHT_PROMPT_DIAGNOSTICS_EXACT=true in a non-production environment and reproduce the request.\n',
    );
    process.exitCode = 3;
    return;
  }

  for (const call of snapshot.modelCalls) {
    printExactCall(call);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
