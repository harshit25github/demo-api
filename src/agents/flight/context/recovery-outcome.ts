import { getFlightSearchState } from './flight-context.js';
import type { FlightAppContext } from '../types.js';

type ToolLogEntry = Record<string, any>;

const CORE_TOOLS = new Set([
  'flight_search',
  'apply_filter',
  'getGeneratedContractsContext',
]);

function formatDate(value: unknown): string | null {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text || null;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function latestSuccessfulFlightCoreTool(
  context: FlightAppContext,
  toolLogStart = 0,
): ToolLogEntry | null {
  const entries = context.toolCallLog.slice(toolLogStart) as ToolLogEntry[];
  return [...entries]
    .reverse()
    .find((entry) => CORE_TOOLS.has(entry.tool) && entry.ok !== false) || null;
}

export function buildFlightCoreSuccessFallback(
  context: FlightAppContext,
  toolLogStart = 0,
): string | null {
  const completed = latestSuccessfulFlightCoreTool(context, toolLogStart);
  if (!completed) return null;

  if (completed.tool === 'apply_filter') {
    const count = Number(context.flight.totalResultsFound || 0);
    return count > 0
      ? `I updated the flight results and found ${count} matching option${count === 1 ? '' : 's'}.`
      : 'I updated the flight filters, but no options match all active filters.';
  }

  if (completed.tool === 'getGeneratedContractsContext') {
    return 'I reviewed the current flight options and kept the relevant results ready.';
  }

  const state = getFlightSearchState(context);
  const firstSegment = state.onds?.[0];
  const lastSegment = state.onds?.at(-1) || firstSegment;
  const route = firstSegment?.origin && lastSegment?.destination
    ? ` from ${firstSegment.origin} to ${lastSegment.destination}`
    : '';
  const outbound = formatDate(firstSegment?.outbound_date);
  const inbound = formatDate(firstSegment?.return_date);
  const dates = outbound ? inbound ? ` for ${outbound} to ${inbound}` : ` for ${outbound}` : '';
  return `I found flight options${route}${dates}. Note: Prices shown are per person.`;
}
