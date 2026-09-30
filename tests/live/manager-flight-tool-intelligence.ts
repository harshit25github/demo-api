/**
 * Manager Agent → Flight Agent Tool Intelligence Test Suite (GPT-5.2)
 *
 * Tests Manager Agent's ability to:
 * - Route to flight_agent correctly
 * - Pass proper payloads to flight_agent
 * - Preserve context across turns
 * - Handle flight_agent responses naturally
 *
 * Flight Agent validates:
 * - flight_search payloads
 * - apply_filter payloads
 * - price_prediction_tool usage
 *
 * All workflows use name "OpenAI" for easy trace debugging.
 */

import { test } from 'node:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runGatewayAgent } from '../../src/agents/manager-orchestrator/runner.js';
import type { FlightAppContext } from '../../src/agents/flight/types.js';

interface TurnCapture {
  turnNumber: number;
  userInput: string;
  interpretation: string;
  managerCalled: string[]; // Which specialist tools Manager called
  flightToolsCalled: Array<{
    toolName: string;
    payload: unknown;
    result: string;
  }>;
  managerOutput: string;
  verdict: 'PASS' | 'FAIL';
  reason: string;
}

interface ConversationReport {
  conversationId: string;
  description: string;
  turns: TurnCapture[];
  overallVerdict: 'PASS' | 'FAIL';
  issues: string[];
}

async function runConversation(
  conversationId: string,
  description: string,
  userMessages: string[],
): Promise<ConversationReport> {
  const turns: TurnCapture[] = [];
  let context: FlightAppContext | null = null;
  let turnNumber = 0;

  for (const userInput of userMessages) {
    turnNumber++;
    const priorToolCount = Array.isArray(context?.toolCallLog)
      ? context.toolCallLog.length : 0;
    const priorPrediction = JSON.stringify(context?.flight?.lastPricePrediction || null);
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Conversation: ${conversationId} | Turn ${turnNumber}`);
    console.log(`User: ${userInput}`);
    console.log('='.repeat(80));

    const result = await runGatewayAgent({
      input: userInput,
      context: context || undefined,
      now: new Date('2026-09-20T10:00:00Z'),
      workflowName: `OpenAI-${conversationId}-turn${turnNumber}`, // Unique workflow name per turn
    });

    context = result.context;

    // Extract Manager's tool calls and Flight Agent's nested tool calls
    const managerCalls: string[] = result.specialistsUsed || [];
    const flightTools: Array<{ toolName: string; payload: unknown; result: string }> = [];

    // Extract Flight Agent's internal tool calls from context.toolCallLog
    if (managerCalls.includes('flight_agent') && context && typeof context === 'object') {
      const toolLog = (context as any).toolCallLog;
      if (Array.isArray(toolLog)) {
        // Persisted context keeps earlier turns. Validate only this turn's calls.
        const currentTurnLog = toolLog.length >= priorToolCount
          ? toolLog.slice(priorToolCount) : toolLog;
        for (const entry of currentTurnLog) {
          if (entry && typeof entry === 'object' && entry.tool) {
            // Different tools store payload differently:
            // - flight_search: uses entry.input
            // - apply_filter: stores data directly on entry (entry.filters, entry.finalFilterPayload)
            // - getGeneratedContractsContext: uses entry.mode, entry.indexes
            let payload: any = entry.input || {};

            // For apply_filter, copy filter-specific fields to payload
            if (entry.tool === 'apply_filter') {
              payload = {
                filters: entry.filters || [],
                finalFilterPayload: entry.finalFilterPayload || [],
                feedback: entry.feedback || [],
              };
            }

            flightTools.push({
              toolName: entry.tool,
              payload,
              result: entry.ok === false ? 'failed' : 'success',
            });
          }
        }
      }
      // Successful prediction calls persist their result but do not enter
      // toolCallLog; failed calls do. Capture the state change for this turn.
      const prediction = context.flight?.lastPricePrediction as
        | { status?: string } | null | undefined;
      if (prediction && JSON.stringify(prediction) !== priorPrediction &&
          !flightTools.some((entry) => entry.toolName === 'price_prediction_tool')) {
        flightTools.push({
          toolName: 'price_prediction_tool',
          payload: {},
          result: prediction.status === 'SUCCESS' ? 'success' : 'failed',
        });
      }
    }

    const turnCapture: TurnCapture = {
      turnNumber,
      userInput,
      interpretation: analyzeTurnIntent(userInput, turnNumber),
      managerCalled: managerCalls,
      flightToolsCalled: flightTools,
      managerOutput: result.output || '',
      verdict: 'PASS',
      reason: '',
    };

    // Validate turn
    const validation = validateTurn(turnCapture, context, userInput, turnNumber);
    turnCapture.verdict = validation.verdict;
    turnCapture.reason = validation.reason;

    turns.push(turnCapture);

    console.log(`\nManager Tools: ${managerCalls.join(', ') || 'none'}`);
    console.log(`Flight Tools: ${flightTools.length}`);
    flightTools.forEach((tool, idx) => {
      console.log(`  ${idx + 1}. ${tool.toolName}`);
      console.log(`     Payload: ${JSON.stringify(tool.payload).substring(0, 200)}`);
    });
    console.log(`\nManager Output: ${result.output?.substring(0, 300)}${result.output && result.output.length > 300 ? '...' : ''}`);
    console.log(`\nVerdict: ${turnCapture.verdict} - ${turnCapture.reason}`);
  }

  const issues = turns.filter(t => t.verdict === 'FAIL').map(t =>
    `Turn ${t.turnNumber}: ${t.reason}`
  );

  return {
    conversationId,
    description,
    turns,
    overallVerdict: issues.length === 0 ? 'PASS' : 'FAIL',
    issues,
  };
}

function analyzeTurnIntent(userInput: string, turnNumber: number): string {
  const lower = userInput.toLowerCase();

  if (turnNumber === 1 && /to/.test(lower)) return 'Initial flight search';
  if (/direct|nonstop|non-stop/.test(lower)) return 'Apply nonstop filter';
  if (/evening|night|afternoon|morning/.test(lower)) return 'Apply time filter';
  if (/remove.*direct|remove.*nonstop/.test(lower)) return 'Remove stops filter';
  if (/remove.*all|clear.*filter/.test(lower)) return 'Clear all filters';
  if (/cheaper.*date|flexible.*date|best.*price.*when/.test(lower)) return 'Price prediction';
  if (/search.*that|book.*that/.test(lower)) return 'Search predicted dates';
  if (/airline/.test(lower)) return 'Apply airline filter';

  return 'Follow-up request';
}

function validateTurn(
  turn: TurnCapture,
  context: FlightAppContext,
  userInput: string,
  turnNumber: number
): { verdict: 'PASS' | 'FAIL'; reason: string } {
  const lower = userInput.toLowerCase();

  // Manager should call flight_agent for flight-related requests
  if (turnNumber === 1 || /flight|search|filter|nonstop|direct|evening|morning|airline|cheaper|price/.test(lower)) {
    if (!turn.managerCalled.includes('flight_agent')) {
      return { verdict: 'FAIL', reason: 'Manager did not call flight_agent for flight request' };
    }
  }

  // Initial search
  if (turnNumber === 1) {
    const searchTool = turn.flightToolsCalled.find(t => t.toolName === 'flight_search');
    if (!searchTool) {
      return { verdict: 'FAIL', reason: 'Flight Agent did not call flight_search for initial request' };
    }
    const payload = searchTool.payload as any;
    if (!payload.onds?.[0]?.origin || !payload.onds?.[0]?.destination) {
      return { verdict: 'FAIL', reason: 'flight_search missing origin/destination' };
    }
    return { verdict: 'PASS', reason: 'Initial search executed correctly via Manager' };
  }

  // Filter requests
  if (/direct|nonstop|non-stop/i.test(lower) && !/remove/i.test(lower)) {
    const filterTool = turn.flightToolsCalled.find(t => t.toolName === 'apply_filter');
    if (!filterTool) {
      return { verdict: 'FAIL', reason: 'Flight Agent did not call apply_filter for nonstop request' };
    }
    const payload = filterTool.payload as any;
    const filters = payload.filters || [];
    const stopsFilter = filters.find((f: any) => f.filterType === 'stops' || f.rawUserFilter?.includes('stop'));
    if (!stopsFilter || stopsFilter.filterCode !== '0') {
      return { verdict: 'FAIL', reason: 'Nonstop filter not correctly applied' };
    }
    return { verdict: 'PASS', reason: 'Nonstop filter applied correctly via Manager' };
  }

  // Remove all filters
  if (/remove.*all|clear.*filter/i.test(lower)) {
    const filterCalls = turn.flightToolsCalled.filter(t => t.toolName === 'apply_filter');
    if (filterCalls.length !== 1) {
      return { verdict: 'FAIL', reason: 'Clear-all requires exactly one apply_filter reset call' };
    }
    const payload = filterCalls[0].payload as any;
    const reset = payload.finalFilterPayload || [];
    if ((payload.filters || []).length !== 0 || reset.length !== 1 ||
        reset[0]?.filterType !== 'reset' || reset[0]?.Values?.length !== 0) {
      return { verdict: 'FAIL', reason: 'Clear-all did not produce an atomic reset payload' };
    }
    return { verdict: 'PASS', reason: 'All filters cleared with one reset call' };
  }

  // Price prediction
  if (/cheaper.*date|flexible.*date|best.*price.*when/i.test(lower)) {
    const priceTool = turn.flightToolsCalled.find(t => t.toolName === 'price_prediction_tool');
    if (!priceTool) {
      return { verdict: 'FAIL', reason: 'Flight Agent did not call price_prediction_tool' };
    }
    return { verdict: 'PASS', reason: 'Price prediction requested correctly' };
  }

  return { verdict: 'PASS', reason: 'Turn behavior acceptable' };
}

async function saveReport(reports: ConversationReport[], outputPath: string) {
  const summary = {
    totalConversations: reports.length,
    passedConversations: reports.filter(r => r.overallVerdict === 'PASS').length,
    failedConversations: reports.filter(r => r.overallVerdict === 'FAIL').length,
    totalTurns: reports.reduce((sum, r) => sum + r.turns.length, 0),
    passedTurns: reports.reduce((sum, r) => sum + r.turns.filter(t => t.verdict === 'PASS').length, 0),
    failedTurns: reports.reduce((sum, r) => sum + r.turns.filter(t => t.verdict === 'FAIL').length, 0),
    reports,
  };

  await writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf8');

  const markdown = generateMarkdownReport(summary);
  await writeFile(outputPath.replace('.json', '.md'), markdown, 'utf8');

  console.log(`\n${'='.repeat(80)}`);
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total Conversations: ${summary.totalConversations}`);
  console.log(`  Passed: ${summary.passedConversations}`);
  console.log(`  Failed: ${summary.failedConversations}`);
  console.log(`Total Turns: ${summary.totalTurns}`);
  console.log(`  Passed: ${summary.passedTurns}`);
  console.log(`  Failed: ${summary.failedTurns}`);
  console.log(`\nReports saved to: ${outputPath}`);
  console.log('='.repeat(80));

  return summary;
}

function generateMarkdownReport(summary: any): string {
  let md = '# Manager → Flight Agent Tool Intelligence Report\n\n';
  md += `**Manager Model:** GPT-5.4-mini  \n`;
  md += `**Flight Agent Model:** GPT-5.2  \n`;
  md += `**Workflow Name:** OpenAI  \n`;
  md += `**Date:** ${new Date().toISOString()}  \n\n`;

  md += '## Summary\n\n';
  md += `- **Conversations:** ${summary.totalConversations} (${summary.passedConversations} passed, ${summary.failedConversations} failed)\n`;
  md += `- **Turns:** ${summary.totalTurns} (${summary.passedTurns} passed, ${summary.failedTurns} failed)\n\n`;

  md += '## Conversations\n\n';

  for (const report of summary.reports) {
    md += `### ${report.conversationId}: ${report.description}\n\n`;
    md += `**Verdict:** ${report.overallVerdict}\n\n`;

    if (report.issues.length > 0) {
      md += '**Issues:**\n';
      for (const issue of report.issues) {
        md += `- ❌ ${issue}\n`;
      }
      md += '\n';
    }

    md += '| Turn | User Input | Manager Tools | Flight Tools | Verdict |\n';
    md += '|------|------------|---------------|--------------|----------|\n';

    for (const turn of report.turns) {
      const managerTools = turn.managerCalled.join(', ') || 'none';
      const flightTools = turn.flightToolsCalled.map(t => t.toolName).join(', ') || 'none';
      const verdict = turn.verdict === 'PASS' ? '✅' : '❌';
      md += `| ${turn.turnNumber} | ${turn.userInput.substring(0, 40)} | ${managerTools} | ${flightTools} | ${verdict} ${turn.reason.substring(0, 50)} |\n`;
    }

    md += '\n---\n\n';
  }

  return md;
}

test('Manager → Flight Agent Tool Intelligence - GPT 5.2', async () => {
  const timestamp = Date.now();
  const resultsDir = resolve('tests/results/manager-flight-intelligence');
  await mkdir(resultsDir, { recursive: true });

  const conversations = [
    {
      id: 'filter_progression',
      description: 'Apply, modify, and remove filters through Manager',
      messages: [
        'Delhi to Dubai October 27 one-way, 1 adult economy',
        'direct only',
        'evening flights',
        'remove direct filter',
        'remove all filters',
      ],
    },

    {
      id: 'price_prediction',
      description: 'Price prediction workflow via Manager',
      messages: [
        'NYC to London round-trip November 5-12, 2 adults economy',
        'any cheaper dates?',
        'search those dates',
      ],
    },

    {
      id: 'complex_filters',
      description: 'Multiple filters through Manager',
      messages: [
        'LA to Miami September 21 one-way, 1 adult economy',
        'nonstop Delta only',
        'remove airline filter',
        'evening departures',
      ],
    },

    {
      id: 'context_inference',
      description: 'Short prompts with context building',
      messages: [
        'SFO to Boston September 27 one-way, 1 adult economy',
        'make it business class',
        'add a return on October 1',
      ],
    },

    {
      id: 'filter_replacement',
      description: 'Replace filter values',
      messages: [
        'Chicago to Seattle September 28-30 round-trip, 2 adults economy',
        'morning departure',
        'actually afternoon departure',
        'nonstop only',
      ],
    },
  ];

  const reports: ConversationReport[] = [];

  for (const conv of conversations) {
    const report = await runConversation(conv.id, conv.description, conv.messages);
    reports.push(report);
  }

  const summary = await saveReport(reports, resolve(resultsDir, `report-${timestamp}.json`));

  // Output failures
  console.log('\n\n');
  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(20) + 'FAILURES AND PATTERNS' + ' '.repeat(37) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');
  console.log('\n');

  if (summary.failedTurns === 0) {
    console.log('🎉 All turns passed!\n');
  } else {
    for (const report of reports) {
      if (report.overallVerdict === 'FAIL') {
        console.log(`\n📋 ${report.conversationId}: ${report.description}`);
        for (const issue of report.issues) {
          console.log(`   ❌ ${issue}`);
        }
      }
    }

    // Group failure patterns
    console.log('\n\n📊 FAILURE PATTERNS:\n');
    const patterns = new Map<string, number>();
    for (const report of reports) {
      for (const turn of report.turns) {
        if (turn.verdict === 'FAIL') {
          const pattern = turn.reason.split(':')[0];
          patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
        }
      }
    }

    for (const [pattern, count] of Array.from(patterns.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`   • ${pattern}: ${count}x`);
    }
  }

  console.log('\n');
});
