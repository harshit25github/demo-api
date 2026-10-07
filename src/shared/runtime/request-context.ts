import type { RequestClock } from '../time/request-clock.js';
import { isRecord } from '../types/json.js';

export interface RequestContext<TState extends object> {
  readonly state: TState;
  readonly runtime: {
    readonly clock: RequestClock;
  };
}

export function createRequestContext<TState extends object>(
  state: TState,
  clock: RequestClock,
): RequestContext<TState> {
  if (!isRecord(state)) {
    throw new TypeError('Request state must be an object.');
  }
  if (!isRecord(clock) || !clock.localDate || !clock.timeZone) {
    throw new TypeError('Request clock must be initialized.');
  }

  return Object.freeze({
    state,
    runtime: Object.freeze({ clock }),
  });
}

export function getRequestState<TState extends object>(
  context: RequestContext<TState> | TState,
): TState {
  const candidate = context as RequestContext<TState>;
  return isRecord(candidate.state) && isRecord(candidate.runtime?.clock)
    ? candidate.state
    : (context as TState);
}

export function getRequestClock(
  context: RequestContext<object> | object | null | undefined,
): RequestClock | null {
  if (!isRecord(context) || !isRecord(context.runtime) || !isRecord(context.runtime.clock)) {
    return null;
  }
  return context.runtime.clock as unknown as RequestClock;
}

/**
 * The request text this run is scoped to.
 *
 * When an agent runs as a nested `Agent.asTool()` call with an `inputBuilder`,
 * the SDK puts the structured tool input on the nested `RunContext` as
 * `toolInput`. That is the subtask the caller delegated, which is narrower than
 * the whole user turn: on a mixed "find flights and plan my trip" request, only
 * the flight half belongs to the Flight Agent.
 *
 * Reading it here means nothing has to mutate shared state to scope a nested
 * run. Running standalone there is no `toolInput`, so the caller's fallback —
 * normally `context.currentUserMessage` — is used instead.
 *
 * Deliberately does not import from the SDK: this only reads a documented
 * property off whatever run context was passed in.
 */
export function getScopedRequestText(
  runContext: unknown,
  fallback: unknown,
): string {
  const toolInput = isRecord(runContext)
    ? (runContext as { toolInput?: unknown }).toolInput
    : undefined;
  const scoped = isRecord(toolInput) ? (toolInput as { input?: unknown }).input : undefined;
  return typeof scoped === 'string' && scoped.trim()
    ? scoped.trim()
    : String(fallback || '').trim();
}
