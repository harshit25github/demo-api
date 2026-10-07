/** Generate the full reviewable scenario document without any model calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { managerFlightComplexConversations } from '../tests/fixtures/manager-flight-complex-conversations.js';
import { expectedFilterValues } from '../tests/fixtures/manager-flight-complex-state.js';
import { flightTools } from '../src/agents/flight/tools/index.js';

const toolNames = flightTools.map((tool) => tool.name);
const lines = [
  '# Five complex Manager + Flight conversations', '',
  'These are scenario definitions, not execution results. Run one conversation at a time through the production Manager runner, inspect every tool input/result, fix unexpected failures, and rerun that conversation before proceeding.', '',
  'Use the existing API key, GPT-5.2 for every model call, and low reasoning. The clock is fixed to October 5, 2026 in Asia/Kolkata for reproducible relative-date behavior.', '',
  `Current registered Flight tools: ${toolNames.map((name) => `\`${name}\``).join(', ')}.`, '',
  'There is no registered date-resolution tool. Relative timing is resolved through prompt intelligence and the immutable request clock. Search/filter records currently come from the fixture backend; these scenarios test orchestration and state, while price-prediction success depends on configured prediction data.', '',
];

for (const [index, conversation] of managerFlightComplexConversations.entries()) {
  lines.push(`## Conversation ${index + 1}: ${conversation.title}`, '', `Focus: ${conversation.focus}`, '');
  for (const [turnIndex, turn] of conversation.turns.entries()) {
    lines.push(`### Turn ${turnIndex + 1}`, '',
      `- User message: ${turn.user}`,
      `- Expected intent: ${turn.expectedIntent}`,
      `- Expected tool(s): ${turn.expectedTools.map((name) => `\`${name}\``).join(' → ')}`,
      `- Why that tool should be used: ${turn.why}`,
      `- Expected state/context change: ${turn.expectedStateChange}`,
      `- What we are validating: ${turn.validates}`,
      `- Expected active filter values: \`${JSON.stringify(expectedFilterValues[conversation.id][turnIndex])}\``, '',
    );
  }
  const used = new Set(conversation.turns.flatMap((turn) => [...turn.expectedTools]));
  if (toolNames.some((tool) => !used.has(tool as any))) throw new Error(`Incomplete tool coverage: ${conversation.id}`);
  lines.push('### Planned tool coverage checklist', '',
    'Checked items below mean the scenario contains a necessary call; actual execution coverage is recorded separately in each live report.', '',
  );
  for (const toolName of toolNames) {
    const turns = conversation.turns.flatMap((turn, i) => turn.expectedTools.includes(toolName as any) ? [i + 1] : []);
    lines.push(`- [x] \`${toolName}\` — turn${turns.length > 1 ? 's' : ''} ${turns.join(', ')}`);
  }
  lines.push('', 'Run this conversation:', '', '```powershell', "$env:RUN_MANAGER_FLIGHT_LIVE='1'",
    `npx tsx tests/live/manager-flight-five-chats-live.ts --chat ${conversation.id}`, '```', '');
}

const target = path.resolve('artifacts/manager-flight-five-conversations.md');
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, lines.join('\n'));
console.log(target);
