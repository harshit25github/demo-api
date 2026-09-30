import { sessionOptimization } from '../../../shared/config/session-optimization.js';
import type { OptimizationMode } from '../../../shared/config/session-optimization.js';
import { observeProjection } from '../../../shared/observability/model-usage.js';

type Payload = Record<string, unknown>;
export interface OutputProjection { output: unknown; changed: boolean; reason: string }
function object(value: unknown): value is Payload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const searchFields = ['source', 'message', 'searchKey', 'searchParams', 'summary',
  'airlineFilterOptions', 'layoverAirportFilterOptions', 'DepartAirports', 'DepLandAirports'];
const filterFields = ['source', 'message', 'searchKey', 'filters', 'feedback', 'summary'];

export function projectFlightToolOutput(tool: string, output: unknown): OutputProjection {
  const skip = (reason: string): OutputProjection => ({ output, changed: false, reason });
  if (tool !== 'flight_search' && tool !== 'apply_filter') return skip('tool_not_allowed');
  if (!object(output)) return skip('unknown_payload');
  if (output.projectionVersion === 1) return skip('already_projected');
  if (output.ok === false || output.error || output.status === 'error') return skip('error_payload');
  // Closed schemas prevent dropping newly introduced API feedback without reviewing the projector.
  const fields = tool === 'flight_search' ? searchFields : filterFields;
  const known = new Set([...fields, 'ok', 'flights', 'UID', ...(tool === 'apply_filter' ? ['finalFilterPayload', 'apiPayload'] : [])]);
  if (Object.keys(output).some((key) => !known.has(key))) return skip('unknown_fields');
  if (typeof output.searchKey !== 'string' || !output.searchKey || !Array.isArray(output.flights) ||
      !object(output.summary) || typeof output.source !== 'string' || typeof output.message !== 'string') return skip('unknown_payload');
  if (tool === 'flight_search' && (!object(output.searchParams) ||
      !['airlineFilterOptions', 'layoverAirportFilterOptions', 'DepartAirports', 'DepLandAirports'].every((key) => Array.isArray(output[key])))) return skip('unknown_payload');
  if (tool === 'apply_filter' && (output.ok !== true || !Array.isArray(output.filters) || !('feedback' in output))) return skip('unknown_payload');
  const projected: Payload = { ok: true, projectionVersion: 1,
    detailsTool: 'getGeneratedContractsContext' };
  for (const key of fields) if (key in output) projected[key] = output[key];
  if (tool === 'flight_search') projected.summary = { ...output.summary, optionCount: output.flights.length };
  return { output: structuredClone(projected), changed: true, reason: 'projected' };
}

export function modelFacingToolOutput<T>(tool: string, output: T, mode: OptimizationMode = sessionOptimization.mode): T | Payload {
  if (mode === 'off') return output;
  const candidate = projectFlightToolOutput(tool, output);
  observeProjection({
    source: 'tool', tool, applied: mode === 'enforce' && candidate.changed,
    beforeBytes: Buffer.byteLength(JSON.stringify(output)),
    afterBytes: Buffer.byteLength(JSON.stringify(candidate.output)), reason: candidate.reason,
  });
  return mode === 'enforce' ? candidate.output as T | Payload : output;
}
