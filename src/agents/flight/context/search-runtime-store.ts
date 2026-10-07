import type { FlightContract, FlightSearchRuntime } from '../types.js';

const searchRuntimeByKey = new Map<string, FlightSearchRuntime>();

function cloneList<T>(value: unknown): T[] {
  return Array.isArray(value) ? [...value] : [];
}

function cloneValue<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}

export function initializeFlightSearchRuntime(
  searchKey: string,
  flights: FlightContract[] = [],
): FlightSearchRuntime | null {
  if (!searchKey) {
    return null;
  }
  const state: FlightSearchRuntime = {
    sourceFlights: cloneList<FlightContract>(flights),
    visibleFlights: cloneList<FlightContract>(flights),
    appliedFilters: [],
    finalFilterPayload: [],
    lastApplyFilterPayload: null,
    feedback: [],
  };
  searchRuntimeByKey.set(searchKey, state);
  return state;
}

export function getFlightSearchRuntime(searchKey: string | null | undefined) {
  return searchKey ? searchRuntimeByKey.get(searchKey) || null : null;
}

export function updateFlightSearchRuntime(
  searchKey: string,
  patch: Partial<FlightSearchRuntime> = {},
): FlightSearchRuntime | null {
  if (!searchKey) {
    return null;
  }
  const current =
    getFlightSearchRuntime(searchKey) ||
    initializeFlightSearchRuntime(searchKey, patch.sourceFlights || []);
  if (!current) return null;
  Object.assign(current, patch);
  return current;
}

export function clearFlightSearchRuntime(searchKey: string | null | undefined): void {
  if (searchKey) {
    searchRuntimeByKey.delete(searchKey);
  }
}

export function snapshotFlightSearchRuntime(searchKey: string | null | undefined) {
  const state = getFlightSearchRuntime(searchKey);
  return state ? cloneValue(state) : null;
}

export function restoreFlightSearchRuntime(
  searchKey: string,
  snapshot: Partial<FlightSearchRuntime> | null | undefined,
): FlightSearchRuntime | null {
  if (!searchKey || !snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const state = {
    sourceFlights: cloneList<FlightContract>(snapshot.sourceFlights),
    visibleFlights: cloneList<FlightContract>(snapshot.visibleFlights),
    appliedFilters: cloneList(snapshot.appliedFilters),
    finalFilterPayload: cloneList(snapshot.finalFilterPayload),
    lastApplyFilterPayload: cloneValue(snapshot.lastApplyFilterPayload),
    feedback: cloneList(snapshot.feedback),
  };
  searchRuntimeByKey.set(searchKey, state);
  return state;
}
