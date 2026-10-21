/**
 * Bold only on a label that starts a line (plan 12.12), such as "**Day 1 · Old Tokyo:**" or "- **Note:**". The prompt
 * asks for this, but replies kept bolding words inside sentences, so the runner applies it after the reply is written,
 * as it removes links. Every other bold pair loses its asterisks and keeps its words.
 */
const LINE_LABEL = /^(\s*(?:[-*•]|\d+[.)])?\s*)\*\*([^*\n]+)\*\*/;

export function boldLabelsOnly(markdown: string): string {
  return markdown.split('\n').map((line) => {
    const label = LINE_LABEL.exec(line);
    const head = label ? label[0] : '';
    return head + line.slice(head.length).replace(/\*\*([^*\n]+)\*\*/g, '$1');
  }).join('\n');
}
