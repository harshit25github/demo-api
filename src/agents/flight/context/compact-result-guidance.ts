// Shared by every runner using the compact search/filter contract, including rollback
// replays of previously projected receipts. This explains retrieval, not new product behavior.
export const COMPACT_RESULT_TURN_RULE = 'Current flight records remain available in application state even when search/filter receipts omit them or history was compacted. For an option-details or comparison request, call getGeneratedContractsContext in this turn before your final answer. A handoff acknowledgment or a promise to retrieve details does not complete the request.';

export const INDEXED_COMPARISON_RULE = 'For an explicit indexed comparison, call getGeneratedContractsContext once with mode="read" and those indexes. Use select only when the user explicitly requests displaying those options.';
export function deduplicateIndexedComparisonRule(instructions: string): string {
  let seen = false;
  return instructions.split('\n').filter((line) => {
    const normalized = line.trim().replace(/^[-*]\s*/, '').replaceAll('`', '');
    if (normalized !== INDEXED_COMPARISON_RULE) return true;
    if (seen) return false;
    seen = true;
    return true;
  }).join('\n');
}
