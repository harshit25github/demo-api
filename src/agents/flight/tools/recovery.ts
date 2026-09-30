import { createHash } from 'node:crypto';
import type { RunContext } from '@openai/agents';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import { log } from '../../../shared/logging/logger.js';
import type { FlightAppContext } from '../types.js';

export type FlightToolRecoveryKind =
  | 'input'
  | 'temporary'
  | 'unavailable'
  | 'internal';

export interface FlightToolFieldIssue {
  path: string;
  problem: string;
  acceptedValue?: string | number | boolean | null;
  constraint?: string;
}

export interface FlightToolRecovery {
  kind: FlightToolRecoveryKind;
  retrySafe: boolean;
  stateChanged: boolean;
  fieldIssues?: FlightToolFieldIssue[];
  requiredState?: string[];
}

export interface FlightToolFailure {
  ok: false;
  code: string;
  message: string;
  recovery: FlightToolRecovery;
  [key: string]: unknown;
}

interface CreateFailureOptions {
  code: string;
  message: string;
  kind?: FlightToolRecoveryKind;
  retrySafe?: boolean;
  stateChanged?: boolean;
  fieldIssues?: FlightToolFieldIssue[];
  requiredState?: string[];
  details?: Record<string, unknown>;
}

export function createFlightToolFailure({
  code,
  message,
  kind = 'input',
  retrySafe = kind === 'input',
  stateChanged = false,
  fieldIssues = [],
  requiredState = [],
  details = {},
}: CreateFailureOptions): FlightToolFailure {
  return {
    ok: false,
    code,
    message,
    ...details,
    recovery: {
      kind,
      retrySafe,
      stateChanged,
      ...(fieldIssues.length > 0 ? { fieldIssues } : {}),
      ...(requiredState.length > 0 ? { requiredState } : {}),
    },
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function createRecoveryFingerprint(
  toolName: string,
  code: string,
  input: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({ toolName, code, input })))
    .digest('hex')
    .slice(0, 16);
}

export function recordFlightToolFailure({
  appContext,
  toolName,
  failure,
  input,
}: {
  appContext: FlightAppContext;
  toolName: string;
  failure: FlightToolFailure;
  input?: unknown;
}): FlightToolFailure {
  const fingerprint = createRecoveryFingerprint(toolName, failure.code, input);
  const requestId = appContext.requestId || null;
  const priorAttempts = (appContext.toolCallLog as Array<Record<string, unknown>>).filter(
    (entry) =>
      entry.tool === toolName &&
      entry.ok === false &&
      entry.requestId === requestId &&
      entry.recoveryFingerprint === fingerprint,
  ).length;
  if (priorAttempts >= 1) {
    failure.recovery.retrySafe = false;
    failure.message = `${failure.message} This exact failed payload was already attempted; do not retry it again.`;
  }
  appContext.toolCallLog.push({
    tool: toolName,
    requestId,
    ok: false,
    code: failure.code,
    recovery: failure.recovery,
    recoveryFingerprint: fingerprint,
    recoveryDecision: 'pending_model_decision',
    retryCount: priorAttempts,
  });
  log('info', 'flight_tool.failure', {
    requestId: appContext.requestId,
    sessionId: appContext.sessionId,
    tool: toolName,
    code: failure.code,
    recoveryKind: failure.recovery.kind,
    retrySafe: failure.recovery.retrySafe,
    stateChanged: failure.recovery.stateChanged,
    affectedFields: failure.recovery.fieldIssues?.map((issue) => issue.path) || [],
    recoveryFingerprint: fingerprint,
  });
  return failure;
}

export function recordFlightToolSuccess({
  appContext,
  toolName,
}: {
  appContext: FlightAppContext;
  toolName: string;
}): { recoveryDecision: 'retry_succeeded'; recoveryFingerprint: string } | null {
  const requestId = appContext.requestId || null;
  const failure = [...appContext.toolCallLog]
    .reverse()
    .find((entry: any) =>
      entry.tool === toolName &&
      entry.ok === false &&
      entry.requestId === requestId &&
      entry.recoveryDecision === 'pending_model_decision',
    ) as Record<string, any> | undefined;
  if (!failure) return null;

  failure.recoveryDecision = 'retry_succeeded';
  return {
    recoveryDecision: 'retry_succeeded',
    recoveryFingerprint: String(failure.recoveryFingerprint),
  };
}

type ZodIssueLike = {
  path?: Array<string | number | symbol>;
  message?: string;
};

function findValidationIssues(error: unknown): ZodIssueLike[] {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    if (typeof candidate !== 'object') continue;

    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.issues)) return record.issues as ZodIssueLike[];
    queue.push(record.originalError, record.cause, record.error);
  }

  return [];
}

function safeIssuePath(path: ZodIssueLike['path']): string {
  if (!Array.isArray(path) || path.length === 0) return 'request';
  return path
    .map((part) => (typeof part === 'symbol' ? part.description || 'field' : String(part)))
    .join('.');
}

function parseToolInput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[part];
  }, input);
}

export function createFlightToolSchemaErrorFunction(
  toolName: string,
  {
    retrySafe = true,
    code = 'INVALID_TOOL_INPUT',
    details = {},
    requiredFields = [],
  }: {
    retrySafe?: boolean;
    code?: string;
    details?: Record<string, unknown>;
    requiredFields?: string[];
  } = {},
) {
  return (
    runContext: RunContext<unknown>,
    error: unknown,
    callDetails?: { toolCall?: { arguments?: string } },
  ) => {
    const isInputFailure = (error as { name?: string })?.name === 'InvalidToolInputError';
    const issues = findValidationIssues(error);
    const rawInput =
      (error as { toolInvocation?: { input?: unknown } })?.toolInvocation?.input ||
      callDetails?.toolCall?.arguments;
    const parsedInput = parseToolInput(rawInput);
    const missingIssues = parsedInput
      ? requiredFields
          .filter((path) => valueAtPath(parsedInput, path) === undefined)
          .map((path) => ({ path, problem: 'Required value is missing.' }))
      : [];
    const fieldIssues: FlightToolFieldIssue[] = issues.length > 0
      ? issues.slice(0, 12).map((issue) => ({
          path: safeIssuePath(issue.path),
          problem: String(issue.message || 'Invalid value.'),
        }))
      : missingIssues.length > 0
        ? missingIssues
      : requiredFields.length > 0
        ? requiredFields.map((path) => ({
            path,
            problem: 'Required field is missing or invalid; preserve it when already valid in the prior call.',
          }))
      : [{ path: 'request', problem: 'The tool payload is missing required fields or contains invalid values.' }];
    const failure = isInputFailure
      ? createFlightToolFailure({
          code,
          message: retrySafe
            ? 'Repair the listed fields from reliable conversation evidence, then retry with a changed payload. Ask the user only when the correction is genuinely ambiguous.'
            : 'The optional tool input was invalid. Do not retry it or delay the core response.',
          retrySafe,
          fieldIssues,
          details,
        })
      : createFlightToolFailure({
          code: 'TOOL_EXECUTION_ERROR',
          message: 'The tool could not complete because of an internal failure. Do not invent corrected inputs or retry it as an input error.',
          kind: 'internal',
          retrySafe: false,
        });
    const appContext = getRequestState(runContext?.context as FlightAppContext);
    appContext.flight ||= {} as FlightAppContext['flight'];
    appContext.toolCallLog = Array.isArray(appContext.toolCallLog)
      ? appContext.toolCallLog
      : [];
    recordFlightToolFailure({ appContext, toolName, failure, input: rawInput });
    return JSON.stringify(failure);
  };
}
