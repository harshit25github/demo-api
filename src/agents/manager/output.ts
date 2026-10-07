import type { ManagerTurnState } from './turn-state.js';

/** Only checks whether the application has card data to display. */
function hasFlightResults(results: unknown): boolean {
  if (Array.isArray(results)) return results.length > 0;
  if (!results || typeof results !== 'object') return false;
  const value = results as Record<string, unknown>;
  return ['flights', 'contracts', 'results', 'data'].some((key) =>
    Array.isArray(value[key]) && value[key].length > 0);
}

/** Resolve render references and finalize Manager output */
export function finalizeManagerOutput(managerText: string, state: ManagerTurnState) {
  let output = String(managerText || '');

  // Resolve render markers
  const used = new Set<string>();
  for (const [ref, content] of state.renders) {
    const marker = `[[render:${ref}]]`;
    const at = output.indexOf(marker);
    if (at >= 0) {
      const before = output.slice(0, at);
      // Rendered content is block markup: a Trip plan opens with `:::cards`, which
      // the Trip prompt requires to be exactly three colons on its own line. The
      // Manager routinely writes a lead-in ending in ':' before the marker, so
      // concatenating directly produced `plan::::cards` and broke the block. Start
      // the content on its own line instead.
      const separator = !before || /\n\n$/.test(before) ? ''
        : /\n$/.test(before) ? '\n'
        : '\n\n';
      output = `${before}${separator}${content}${output.slice(at + marker.length)}`;
      // A repeated marker for the same ref must not duplicate the content.
      output = output.split(marker).join('');
      used.add(ref);
    }
  }

  // Remove unresolved markers
  output = output.replace(/\[\[render:[^\]]+\]\]/g, '');

  // Append missing renders without rebuilding the Manager's prose from feedback.
  const missingRenders = [...state.renders].filter(([ref]) => !used.has(ref));
  for (const [, content] of missingRenders) {
    if (output.includes(content)) continue;
    output = `${output.trim()}\n\n${content}`.trim();
  }

  const specialistsUsed = [...new Set(state.outcomes.map(({ name }) => name))];

  // Honor Flight feedback when shared context has visible card data.
  const renderFlightOptions = state.outcomes.some(({ name, result }) =>
    name === 'flight_agent' && (result.status === 'success' || result.status === 'partial') &&
    Boolean(result.presentation)) &&
    state.appContext.flight.showFlight !== false &&
    hasFlightResults(state.appContext.flight.searchResults);

  return { output: output.trim(), specialistsUsed, renderFlightOptions };
}
