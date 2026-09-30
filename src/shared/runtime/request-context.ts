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
