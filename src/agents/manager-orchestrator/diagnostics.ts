import { observeModelInput } from '../../shared/observability/model-usage.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_DIAGNOSTICS_DIRECTORY = '.debug/flight-prompt-traces';
const DEFAULT_RETENTION_HOURS = 24;
const TRACE_ID_PATTERN = /^trace_[A-Za-z0-9_-]+$/;
const SECRET_KEY_PATTERN = /api.?key|authorization|cookie|password|secret|token/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
];

type DynamicRecord = Record<string, any>;

interface PromptModelCallSnapshot extends DynamicRecord {
  sequence: number;
  agent: string;
  responseId?: string | null;
  requestId?: string | null;
  errorKind?: string;
}

interface PromptDiagnosticSnapshot extends DynamicRecord {
  version: number;
  traceId: string;
  requestId: string;
  sessionHash: string | null;
  captureMode: string;
  createdAt: string;
  modelCalls: PromptModelCallSnapshot[];
  status: string;
  completedAt?: string;
  error?: DynamicRecord;
}

interface PromptDiagnosticsOptions {
  traceId?: string;
  requestId?: string;
  sessionId?: string;
  directory?: string;
  enabled?: boolean;
  exactCapture?: boolean;
  staticInstructions?: string;
  onError?: (error: unknown) => void;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(String(value || '').length / 4);
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function itemType(item: any): string {
  if (!item || typeof item !== 'object') {
    return typeof item;
  }
  return item.type || item.role || 'object';
}

function redactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '[REDACTED]'),
    value,
  );
}

export function redactPromptDiagnosticValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactPromptDiagnosticValue(entry, seen));
    seen.delete(value);
    return result;
  }

  const result: DynamicRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : redactPromptDiagnosticValue(entry, seen);
  }
  seen.delete(value);
  return result;
}

function toolSnapshot(tool: DynamicRecord, includeExact: boolean): DynamicRecord {
  const name = String(tool?.name || tool?.type || 'unknown');
  const description = String(tool?.description || '');
  const parameters = redactPromptDiagnosticValue(tool?.parameters ?? null);
  const schemaText = jsonText(parameters);
  const definitionChars = name.length + description.length + schemaText.length;

  return includeExact
    ? { name, description: redactString(description), parameters, definitionChars }
    : {
        name,
        descriptionChars: description.length,
        schemaChars: schemaText.length,
        schemaHash: sha256(schemaText),
        definitionChars,
      };
}

function agentModelTools(agent: DynamicRecord): DynamicRecord[] {
  return Array.isArray(agent?.tools) ? [...agent.tools] : [];
}

function repeatedBlockSummary(instructions: unknown) {
  const counts = new Map<string, number>();
  for (const block of String(instructions || '').split(/\n\s*\n/)) {
    const normalized = block.replace(/\s+/g, ' ').trim();
    if (normalized.length < 80) {
      continue;
    }
    const hash = sha256(normalized);
    counts.set(hash, (counts.get(hash) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([hash, count]) => ({ hash, count }));
}

function instructionSectionSummary(instructions: unknown, includeExact: boolean) {
  const sections: Array<{ heading: string; text: string }> = [];
  let current = { heading: 'preamble', text: '' };

  for (const line of String(instructions || '').split('\n')) {
    if (/^#{1,6}\s+/.test(line)) {
      if (current.text) {
        sections.push(current);
      }
      current = { heading: line.replace(/^#{1,6}\s+/, '').trim(), text: '' };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text || sections.length === 0) {
    sections.push(current);
  }

  return sections
    .map((section) => ({
      ...(includeExact
        ? { heading: redactString(section.heading) }
        : { headingHash: sha256(section.heading) }),
      chars: section.text.length,
    }))
    .sort((left, right) => right.chars - left.chars)
    .slice(0, 12);
}

function safeModelSettings(agent: DynamicRecord, includeExact: boolean): unknown {
  const settings = redactPromptDiagnosticValue(agent?.modelSettings ?? null);
  if (includeExact) {
    return settings;
  }
  const text = jsonText(settings);
  return { chars: text.length, hash: sha256(text) };
}

function modelCallSnapshot({
  modelData,
  agent,
  sequence,
  includeExact,
  staticInstructions,
}: {
  modelData: DynamicRecord;
  agent: DynamicRecord;
  sequence: number;
  includeExact: boolean;
  staticInstructions: string;
}): PromptModelCallSnapshot {
  const instructions = String(modelData?.instructions || '');
  const input = Array.isArray(modelData?.input) ? modelData.input : [];
  const serializableInput = redactPromptDiagnosticValue(input);
  const inputText = jsonText(serializableInput);
  const tools = agentModelTools(agent);
  const toolDetails = tools.map((tool) => toolSnapshot(tool, includeExact));
  const hasStaticPrefix = Boolean(staticInstructions) && instructions.startsWith(staticInstructions);
  const staticInstructionChars = hasStaticPrefix ? staticInstructions.length : 0;
  const dynamicInstructionChars = hasStaticPrefix
    ? instructions.length - staticInstructions.length
    : instructions.length;

  return {
    sequence,
    agent: String(agent?.name || 'unknown'),
    model:
      typeof agent?.model === 'string'
        ? agent.model
        : String(agent?.model?.model || agent?.model?.name || 'runner-default'),
    instructionChars: instructions.length,
    staticInstructionChars,
    dynamicInstructionChars,
    estimatedInstructionTokens: estimateTokens(instructions),
    inputChars: inputText.length,
    estimatedInputTokens: estimateTokens(inputText),
    inputItemCount: input.length,
    inputItemTypes: [...new Set(input.map(itemType))],
    toolCount: tools.length,
    toolNames: tools.map((tool) => String(tool?.name || tool?.type || 'unknown')),
    toolDefinitionChars: toolDetails.reduce(
      (total, tool) => total + (tool.definitionChars || 0),
      0,
    ),
    instructionHash: sha256(instructions),
    inputHash: sha256(inputText),
    repeatedInstructionBlocks: repeatedBlockSummary(instructions),
    largestInstructionSections: instructionSectionSummary(instructions, includeExact),
    modelSettings: safeModelSettings(agent, includeExact),
    ...(includeExact
      ? {
          instructions: redactString(instructions),
          input: serializableInput,
          tools: toolDetails,
        }
      : {}),
  };
}

function classifyError(error: unknown): string {
  const errorRecord = error as DynamicRecord;
  const message = String(errorRecord?.message || '');
  if (/invalid prompt|usage policy/i.test(message)) {
    return 'INVALID_PROMPT';
  }
  if (/timed out|timeout/i.test(message)) {
    return 'MODEL_TIMEOUT';
  }
  if (errorRecord?.name === 'AbortError') {
    return 'ABORTED';
  }
  return 'MODEL_ERROR';
}

function diagnosticsDirectory(directory?: string): string {
  return path.resolve(directory || process.env.FLIGHT_PROMPT_DIAGNOSTICS_DIR || DEFAULT_DIAGNOSTICS_DIRECTORY);
}

export function validatePromptDiagnosticTraceId(traceId?: string): string {
  if (!TRACE_ID_PATTERN.test(String(traceId || ''))) {
    throw new Error('A valid trace ID starting with trace_ is required.');
  }
  return String(traceId);
}

export function promptDiagnosticSnapshotPath(traceId: string, directory?: string): string {
  return path.join(diagnosticsDirectory(directory), `${validatePromptDiagnosticTraceId(traceId)}.json`);
}

export function shouldCaptureExactPromptDiagnostics({
  environment = process.env.NODE_ENV,
  enabled = process.env.FLIGHT_PROMPT_DIAGNOSTICS_EXACT,
}: { environment?: string; enabled?: string } = {}): boolean {
  return environment !== 'production' && String(enabled || '').toLowerCase() === 'true';
}

async function writeSnapshot(
  snapshot: PromptDiagnosticSnapshot,
  directory?: string,
): Promise<string> {
  const filePath = promptDiagnosticSnapshotPath(snapshot.traceId, directory);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
  return filePath;
}

export async function prunePromptDiagnosticSnapshots({
  directory,
  retentionHours = Number(process.env.FLIGHT_PROMPT_DIAGNOSTICS_RETENTION_HOURS) || DEFAULT_RETENTION_HOURS,
  now = Date.now(),
}: { directory?: string; retentionHours?: number; now?: number } = {}) {
  const root = diagnosticsDirectory(directory);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  const cutoff = now - Math.max(1, retentionHours) * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(root, entry.name);
    const details = await stat(filePath);
    if (details.mtimeMs < cutoff) {
      await rm(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export function createFlightPromptDiagnostics({
  traceId,
  requestId,
  sessionId,
  directory,
  enabled = process.env.FLIGHT_PROMPT_DIAGNOSTICS_ENABLED !== 'false',
  exactCapture = shouldCaptureExactPromptDiagnostics(),
  staticInstructions = '',
  onError,
}: PromptDiagnosticsOptions = {}) {
  const validTraceId = validatePromptDiagnosticTraceId(traceId);
  const includeExact = Boolean(exactCapture) && process.env.NODE_ENV !== 'production';
  const snapshot: PromptDiagnosticSnapshot = {
    version: 1,
    traceId: validTraceId,
    requestId: String(requestId || ''),
    sessionHash: sessionId ? sha256(sessionId) : null,
    captureMode: includeExact ? 'exact' : 'safe',
    createdAt: new Date().toISOString(),
    modelCalls: [],
    status: 'running',
  };
  let writeQueue: Promise<string | null> = Promise.resolve(null);

  const persist = () => {
    if (!enabled) {
      return Promise.resolve(null);
    }
    writeQueue = writeQueue
      .then(() => writeSnapshot(snapshot, directory))
      .catch((error) => {
        onError?.(error);
        return null;
      });
    return writeQueue;
  };

  const callModelInputFilter = async ({ modelData, agent }: DynamicRecord) => {
    observeModelInput({ modelData, agent }, snapshot.modelCalls.length + 1);
    snapshot.modelCalls.push(
      modelCallSnapshot({
        modelData,
        agent,
        sequence: snapshot.modelCalls.length + 1,
        includeExact,
        staticInstructions,
      }),
    );
    await persist();
    return modelData;
  };

  const recordResult = async (result: DynamicRecord) => {
    const responses = Array.isArray(result?.rawResponses) ? result.rawResponses : [];
    responses.forEach((response, index) => {
      const call = snapshot.modelCalls[index];
      if (!call) {
        return;
      }
      call.responseId = response?.responseId || null;
      call.requestId = response?.requestId || null;
    });
    snapshot.status = 'completed';
    snapshot.completedAt = new Date().toISOString();
    await persist();
  };

  const recordError = async (error: unknown) => {
    const errorKind = classifyError(error);
    const errorRecord = error as DynamicRecord;
    const latestCall = snapshot.modelCalls.at(-1);
    if (latestCall) {
      latestCall.errorKind = errorKind;
    }
    snapshot.status = 'failed';
    snapshot.error = {
      kind: errorKind,
      name: String(errorRecord?.name || 'Error'),
      code: errorRecord?.code ? String(errorRecord.code) : null,
      failedModelCallSequence: latestCall?.sequence || null,
    };
    snapshot.completedAt = new Date().toISOString();
    await persist();
  };

  return {
    traceId: validTraceId,
    exactCapture: includeExact,
    callModelInputFilter,
    recordResult,
    recordError,
    snapshotPath: promptDiagnosticSnapshotPath(validTraceId, directory),
  };
}

export async function readFlightPromptDiagnosticSnapshot(
  traceId: string,
  { directory }: { directory?: string } = {},
) {
  const filePath = promptDiagnosticSnapshotPath(traceId, directory);
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
