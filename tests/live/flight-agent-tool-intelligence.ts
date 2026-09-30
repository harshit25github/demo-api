/**
 * Flight Agent Tool Intelligence Test Suite (GPT-5.2)
 *
 * Tests core tool selection, payload correctness, and context inference across:
 * - flight_search
 * - apply_filter
 * - price_prediction_tool
 *
 * All workflows use name "OpenAI" for easy trace debugging.
 */

import { test } from 'node:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runFlightAgent } from '../../src/agents/flight/runner.js';
import type { FlightAppContext } from '../../src/agents/flight/types.js';

interface TurnCapture {
  turnNumber: number;
  userInput: string;
  interpretation: string;
  toolsCalled: Array<{
    toolName: string;
    payload: unknown;
    result: {
      status: string;
      summary?: string;
      error?: string;
    };
  }>;
  agentOutput: string;
  nextAction: string;
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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Conversation: ${conversationId} | Turn ${turnNumber}`);
    console.log(`User: ${userInput}`);
    console.log('='.repeat(80));

    const priorToolCount = context?.toolCallLog?.length || 0;
    const priorPrediction = JSON.stringify(context?.flight?.lastPricePrediction || null);
    const result = await runFlightAgent({
      input: userInput,
      context: context || undefined,
      now: new Date('2026-09-20T10:00:00Z'),
    });

    context = result.context;
    const currentLog = context.toolCallLog.slice(priorToolCount) as Array<Record<string, any>>;
    const toolsCalled: TurnCapture['toolsCalled'] = currentLog.map((entry) => ({
      toolName: String(entry.tool || 'unknown'),
      payload: entry.tool === 'apply_filter'
        ? { filters: entry.filters || [], finalFilterPayload: entry.finalFilterPayload || [] }
        : entry.input || {},
      result: { status: entry.ok === false ? 'error' : 'success',
        summary: String(entry.code || '') },
    }));
    const prediction = context.flight.lastPricePrediction as Record<string, any> | null;
    if (prediction && JSON.stringify(prediction) !== priorPrediction &&
        !toolsCalled.some((entry) => entry.toolName === 'price_prediction_tool')) {
      toolsCalled.push({
        toolName: 'price_prediction_tool',
        payload: prediction.route || {},
        result: { status: prediction.status === 'SUCCESS' ? 'success' : 'error' },
      });
    }

    // Analyze the turn
    const turnCapture: TurnCapture = {
      turnNumber,
      userInput,
      interpretation: analyzeTurnIntent(userInput, turnNumber),
      toolsCalled,
      agentOutput: result.output || '',
      nextAction: determineNextAction(result.output || '', context),
      verdict: 'PASS',
      reason: '',
    };

    // Validate turn
    const validation = validateTurn(turnCapture, context, userInput, turnNumber);
    turnCapture.verdict = validation.verdict;
    turnCapture.reason = validation.reason;

    turns.push(turnCapture);

    console.log(`\nTools Called: ${toolsCalled.length}`);
    toolsCalled.forEach((tool, idx) => {
      console.log(`  ${idx + 1}. ${tool.toolName}`);
      console.log(`     Payload: ${JSON.stringify(tool.payload, null, 2).substring(0, 300)}`);
      console.log(`     Result: ${tool.result.status} - ${tool.result.summary}`);
    });
    console.log(`\nAgent Output: ${result.output}`);
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

  if (turnNumber === 1 && /to/.test(lower)) return 'Initial search request';
  if (/direct|nonstop|non-stop/.test(lower)) return 'Filter: stops = 0';
  if (/evening|night|afternoon|morning/.test(lower)) return 'Filter: time slot';
  if (/remove.*direct|remove.*nonstop/.test(lower)) return 'Remove stops filter';
  if (/remove.*all|clear.*filter/.test(lower)) return 'Remove all filters';
  if (/cheaper.*date|flexible.*date|best.*price.*when/.test(lower)) return 'Price prediction request';
  if (/search.*that|book.*that|show.*that/.test(lower)) return 'Use predicted dates for search';
  if (/relax|loosen/.test(lower)) return 'Relax existing filter';
  if (/airline/.test(lower)) return 'Filter: airline';
  if (/bag|luggage/.test(lower)) return 'Filter: baggage';
  if (/duration|hour/.test(lower)) return 'Filter: duration';

  return 'Unclear intent';
}

function determineNextAction(output: string, context: FlightAppContext): string {
  if (!output) return 'No output generated';
  if (/found \d+ flight/i.test(output)) return 'Search completed, results shown';
  if (/narrow|applied.*filter/i.test(output)) return 'Filter applied';
  if (/cheaper.*\d{4}-\d{2}-\d{2}/i.test(output)) return 'Price prediction provided with dates';
  if (/remove|clear/i.test(output)) return 'Filter removed';
  if (/missing|need/i.test(output)) return 'Asking for clarification';
  return 'Response generated';
}

function validateTurn(
  turn: TurnCapture,
  context: FlightAppContext,
  userInput: string,
  turnNumber: number
): { verdict: 'PASS' | 'FAIL'; reason: string } {
  const lower = userInput.toLowerCase();
  const tools = turn.toolsCalled;

  // Turn 1: Initial search
  if (turnNumber === 1) {
    const searchTool = tools.find(t => t.toolName === 'flight_search');
    if (!searchTool) {
      return { verdict: 'FAIL', reason: 'No flight_search called for initial request' };
    }
    const payload = searchTool.payload as any;
    if (!payload.onds || payload.onds.length === 0) {
      return { verdict: 'FAIL', reason: 'flight_search payload missing onds' };
    }
    if (!payload.onds[0].origin || !payload.onds[0].destination) {
      return { verdict: 'FAIL', reason: 'Missing origin or destination in search' };
    }
    return { verdict: 'PASS', reason: 'Initial search executed correctly' };
  }

  // Direct/nonstop filter
  if (/direct|nonstop|non-stop/i.test(lower) && !/remove/i.test(lower)) {
    const filterTool = tools.find(t => t.toolName === 'apply_filter');
    if (!filterTool) {
      return { verdict: 'FAIL', reason: 'No apply_filter called for direct/nonstop request' };
    }
    const payload = filterTool.payload as any;
    const filters = payload.filters || [];
    const stopsFilter = filters.find((f: any) => f.filterType === 'stops' || f.rawUserFilter?.includes('stop'));
    if (!stopsFilter) {
      return { verdict: 'FAIL', reason: 'apply_filter payload missing stops filter' };
    }
    if (stopsFilter.filterCode !== '0') {
      return { verdict: 'FAIL', reason: `Incorrect stops filter code: ${stopsFilter.filterCode}, expected '0'` };
    }
    return { verdict: 'PASS', reason: 'Nonstop filter applied correctly' };
  }

  // Evening/time filter
  if (/evening|night|afternoon|morning/i.test(lower)) {
    const filterTool = tools.find(t => t.toolName === 'apply_filter');
    if (!filterTool) {
      return { verdict: 'FAIL', reason: 'No apply_filter called for time slot request' };
    }
    const payload = filterTool.payload as any;
    const filters = payload.filters || [];
    const timeFilter = filters.find((f: any) =>
      f.filterType?.includes('time') || f.rawUserFilter?.toLowerCase().includes(lower.match(/evening|night|afternoon|morning/)?.[0] || '')
    );
    if (!timeFilter) {
      return { verdict: 'FAIL', reason: 'apply_filter payload missing time slot filter' };
    }
    return { verdict: 'PASS', reason: 'Time slot filter applied correctly' };
  }

  // Remove specific filter
  if (/remove.*(?:direct|nonstop|evening|morning)/i.test(lower)) {
    const filterTool = tools.find(t => t.toolName === 'apply_filter');
    if (!filterTool) {
      return { verdict: 'FAIL', reason: 'No apply_filter called to remove filter' };
    }
    // Should call apply_filter with remaining filters only
    return { verdict: 'PASS', reason: 'Filter removal attempted' };
  }

  // Remove all filters
  if (/remove.*all|clear.*filter|reset.*filter/i.test(lower)) {
    const filterCalls = tools.filter(t => t.toolName === 'apply_filter');
    if (filterCalls.length !== 1) {
      return { verdict: 'FAIL', reason: 'Clear-all requires exactly one apply_filter reset call' };
    }
    const payload = filterCalls[0].payload as any;
    const reset = payload.finalFilterPayload || [];
    if ((payload.filters || []).length !== 0 || reset.length !== 1 ||
        reset[0]?.filterType !== 'reset' || reset[0]?.Values?.length !== 0) {
      return { verdict: 'FAIL', reason: 'Clear-all did not produce an atomic reset payload' };
    }
    return { verdict: 'PASS', reason: 'All filters removed with one reset call' };
  }

  // Price prediction
  if (/cheaper.*date|flexible.*date|best.*price.*when/i.test(lower)) {
    const priceTool = tools.find(t => t.toolName === 'price_prediction_tool');
    if (!priceTool) {
      return { verdict: 'FAIL', reason: 'No price_prediction_tool called for flexible date request' };
    }
    const payload = priceTool.payload as any;
    if (!payload.originCity || !payload.destinationCity) {
      return { verdict: 'FAIL', reason: 'price_prediction_tool missing origin/destination' };
    }
    return { verdict: 'PASS', reason: 'Price prediction requested correctly' };
  }

  // Search using predicted dates
  if (/search.*that|book.*that|show.*that/i.test(lower)) {
    const searchTool = tools.find(t => t.toolName === 'flight_search');
    if (!searchTool) {
      return { verdict: 'FAIL', reason: 'No flight_search called for "search that" request' };
    }
    // Should use dates from context (last price prediction)
    const payload = searchTool.payload as any;
    if (!payload.onds?.[0]?.outbound_date) {
      return { verdict: 'FAIL', reason: 'flight_search missing outbound_date from predicted dates' };
    }
    return { verdict: 'PASS', reason: 'Search executed with context dates' };
  }

  // Default: check if any tool was called
  if (tools.length === 0 && !/thank|thanks|ok|okay/i.test(lower)) {
    return { verdict: 'FAIL', reason: 'No tools called when action was expected' };
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

  // Generate markdown report
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
  let md = '# Flight Agent Tool Intelligence Test Report\n\n';
  md += `**Model:** GPT-5.2  \n`;
  md += `**Workflow Name:** OpenAI  \n`;
  md += `**Date:** ${new Date().toISOString()}  \n\n`;

  md += '## Summary\n\n';
  md += `- **Total Conversations:** ${summary.totalConversations}\n`;
  md += `- **Passed:** ${summary.passedConversations}\n`;
  md += `- **Failed:** ${summary.failedConversations}\n`;
  md += `- **Total Turns:** ${summary.totalTurns}\n`;
  md += `- **Passed Turns:** ${summary.passedTurns}\n`;
  md += `- **Failed Turns:** ${summary.failedTurns}\n\n`;

  md += '## Conversations\n\n';

  for (const report of summary.reports) {
    md += `### ${report.conversationId}: ${report.description}\n\n`;
    md += `**Verdict:** ${report.overallVerdict}\n\n`;

    if (report.issues.length > 0) {
      md += '**Issues:**\n';
      for (const issue of report.issues) {
        md += `- ${issue}\n`;
      }
      md += '\n';
    }

    md += '**Turns:**\n\n';
    for (const turn of report.turns) {
      md += `#### Turn ${turn.turnNumber}: ${turn.verdict}\n\n`;
      md += `- **User:** ${turn.userInput}\n`;
      md += `- **Interpretation:** ${turn.interpretation}\n`;
      md += `- **Tools Called:** ${turn.toolsCalled.length}\n`;

      for (let i = 0; i < turn.toolsCalled.length; i++) {
        const tool = turn.toolsCalled[i];
        md += `  ${i + 1}. **${tool.toolName}**\n`;
        md += `     - Payload: \`${JSON.stringify(tool.payload).substring(0, 150)}...\`\n`;
        md += `     - Result: ${tool.result.status}\n`;
      }

      md += `- **Agent Output:** ${turn.agentOutput.substring(0, 200)}${turn.agentOutput.length > 200 ? '...' : ''}\n`;
      md += `- **Reason:** ${turn.reason}\n\n`;
    }

    md += '---\n\n';
  }

  return md;
}

test('Flight Agent Tool Intelligence - GPT 5.2', async () => {
  const timestamp = Date.now();
  const resultsDir = resolve('tests/results/flight-tool-intelligence');
  await mkdir(resultsDir, { recursive: true });

  const conversations = [
    // Conversation 1: Filter progression
    {
      id: 'filter_progression',
      description: 'Apply, modify, and remove filters progressively',
      messages: [
        'Delhi to Dubai next week',
        'direct only',
        'evening flights',
        'remove direct filter',
        'show morning instead',
        'remove all filters',
      ],
    },

    // Conversation 2: Price prediction workflow
    {
      id: 'price_prediction',
      description: 'Use price prediction and search with predicted dates',
      messages: [
        'NYC to London',
        'any cheaper dates in the next 2 months?',
        'search those dates',
      ],
    },

    // Conversation 3: Complex filter updates
    {
      id: 'complex_filters',
      description: 'Multiple filters and selective removal',
      messages: [
        'Los Angeles to Miami tomorrow',
        'nonstop only',
        'Delta or United',
        'remove airline filter but keep nonstop',
        'also show evening departures',
      ],
    },

    // Conversation 4: Context inference
    {
      id: 'context_inference',
      description: 'Short prompts requiring context inference',
      messages: [
        'SFO to BOS',
        'next Friday',
        'add return Sunday',
        'business class',
        '2 passengers',
      ],
    },

    // Conversation 5: Filter replacement
    {
      id: 'filter_replacement',
      description: 'Replace one filter value with another',
      messages: [
        'Chicago to Seattle this weekend',
        'morning departure',
        'actually make it afternoon',
        'nonstop',
        'show 1 stop instead',
      ],
    },

    // Conversation 6: Recovery from invalid state
    {
      id: 'recovery',
      description: 'Recover from missing search state',
      messages: [
        'filter to nonstop',
        'Delhi to Paris next Tuesday',
        'apply nonstop filter',
      ],
    },

    // Conversation 7: Unnecessary search prevention
    {
      id: 'prevent_unnecessary_search',
      description: 'Avoid re-searching when not needed',
      messages: [
        'Boston to Atlanta March 15',
        'show me the cheapest',
        'what about option 2?',
        'filter to Delta',
      ],
    },

    // Conversation 8: Baggage and duration filters
    {
      id: 'baggage_duration',
      description: 'Test baggage and duration filters',
      messages: [
        'Denver to Orlando next month',
        'include checked bag',
        'under 4 hours',
        'remove duration filter',
      ],
    },
  ];

  const reports: ConversationReport[] = [];

  for (const conv of conversations) {
    const report = await runConversation(conv.id, conv.description, conv.messages);
    reports.push(report);
  }

  const summary = await saveReport(reports, resolve(resultsDir, `report-${timestamp}.json`));

  // Output failures prominently
  console.log('\n\n');
  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║' + ' '.repeat(25) + 'FAILURES AND PATTERNS' + ' '.repeat(32) + '║');
  console.log('╚' + '═'.repeat(78) + '╝');
  console.log('\n');

  if (summary.failedTurns === 0) {
    console.log('🎉 All turns passed! No issues found.\n');
  } else {
    for (const report of reports) {
      if (report.overallVerdict === 'FAIL') {
        console.log(`\n📋 Conversation: ${report.conversationId}`);
        console.log(`   Description: ${report.description}`);
        console.log(`   Issues:`);
        for (const issue of report.issues) {
          console.log(`     ❌ ${issue}`);
        }
      }
    }

    // Group failures by pattern
    console.log('\n\n📊 FAILURE PATTERNS:\n');
    const failurePatterns = new Map<string, number>();

    for (const report of reports) {
      for (const turn of report.turns) {
        if (turn.verdict === 'FAIL') {
          const pattern = turn.reason.split(':')[0]; // Get first part before colon
          failurePatterns.set(pattern, (failurePatterns.get(pattern) || 0) + 1);
        }
      }
    }

    for (const [pattern, count] of Array.from(failurePatterns.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`   • ${pattern}: ${count} occurrence(s)`);
    }
  }

  console.log('\n');
});
