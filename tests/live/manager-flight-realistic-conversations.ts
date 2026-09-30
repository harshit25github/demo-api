/**
 * Manager Agent Flight Conversation Test Suite
 *
 * Tests realistic user behavior with:
 * - Short/lazy prompts
 * - Incomplete information
 * - Context carryover
 * - Changing requirements
 * - Ambiguous follow-ups
 * - Filter chains
 * - Existing result queries
 * - Price prediction
 * - Recovery scenarios
 *
 * Run: $env:RUN_MANAGER_FLIGHT_LIVE='1'; npx tsx tests/live/manager-flight-realistic-conversations.ts
 * Single chat: add --chat <chat_id>
 * Limit turns: add --limit-turns <number>
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

if (process.env.RUN_MANAGER_FLIGHT_LIVE !== '1') {
  throw new Error('Set RUN_MANAGER_FLIGHT_LIVE=1 to run this test suite.');
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required.');
}

process.env.ORCHESTRATION_MODE = 'manager';
process.env.FLIGHT_AGENT_LOG_LEVEL = 'error';
delete process.env.OPENAI_AGENTS_DISABLE_TRACING;

const traceExportStatuses: number[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const response = await originalFetch(input, init);
  if (String(input).includes('/v1/traces/ingest')) traceExportStatuses.push(response.status);
  return response;
}) as typeof fetch;

const [
  { OpenAIConversationsSession },
  { generateTraceId, getGlobalTraceProvider },
  { runGatewayAgentTextStream },
  { hydrateGatewayContext, snapshotGatewayContext }
] = await Promise.all([
  import('@openai/agents-openai'),
  import('@openai/agents'),
  import('../../src/agents/manager-orchestrator/streaming.js'),
  import('../../src/api/chat/context-hydration.js'),
]);

/**
 * Test Scenarios: 5 realistic conversations covering different user patterns
 */
const scenarios = [
  {
    id: 'lazy_incomplete_prompts',
    description: 'User provides minimal info, requires inference and clarification',
    expectedBehavior: [
      'Ask for missing origin when only destination given',
      'Infer "next weekend" correctly',
      'Apply filters without re-searching',
      'Answer cheapest question from existing results',
      'Handle option number reference correctly',
    ],
    turns: [
      'Delhi to Dubai',
      'next weekend',
      'only direct',
      'cheapest',
      'show me option 2',
      'one day later',
      'evening flights',
    ],
  },
  {
    id: 'price_prediction_flexible_dates',
    description: 'User explores cheapest dates before committing to search',
    expectedBehavior: [
      'Use price_prediction_tool for cheapest date query',
      'Search on recommended date',
      'Filter without re-searching',
      'Compare options from existing contracts',
      'Change passengers and re-search',
    ],
    turns: [
      'when is cheapest to fly Mumbai to Goa in October?',
      'ok search that date',
      'with checked bag',
      'which is faster, option 1 or 3?',
      'make it 2 people',
      'any morning flights?',
      'what about option 4',
    ],
  },
  {
    id: 'context_heavy_changes',
    description: 'User makes incremental changes to search, testing context preservation',
    expectedBehavior: [
      'Initial search with complete info',
      'Change only destination, keep dates/passengers',
      'Apply multiple filters sequentially',
      'Clear one filter without losing others',
      'Change date and re-search with preserved filters',
      'Answer duration comparison from contracts',
    ],
    turns: [
      'Find flights NYC to London Nov 3 to Nov 12 for 2 adults',
      'actually make it Paris',
      'nonstop only',
      'also show only morning departures',
      'remove the morning filter',
      'change return to Nov 15',
      'is the shortest flight cheaper than the fastest?',
      '2 adults in business class',
    ],
  },
  {
    id: 'ambiguous_followups_resolution',
    description: 'Vague follow-ups requiring strong context understanding',
    expectedBehavior: [
      'Initial search',
      'Understand "earlier" means earlier departure',
      'Understand "cheaper" queries existing results',
      'Handle "that one" with recent option reference',
      'Understand "different airline" is a filter',
      'Handle relative date "tomorrow" from context',
    ],
    turns: [
      'LA to Vegas Oct 10',
      'earlier one',
      'any cheaper?',
      'show that one',
      'different airline',
      'what about tomorrow',
      'best value',
      '2 people instead',
    ],
  },
  {
    id: 'recovery_stale_missing_state',
    description: 'Test recovery when context is stale, missing, or ambiguous',
    expectedBehavior: [
      'Initial search',
      'Filter on existing results',
      'Ask option question on contracts',
      'Change core search param, invalidating filters',
      'Handle request for non-existent option gracefully',
      'Recover from ambiguous "cheapest date" with no month given',
      'Handle multi-part request (search + filter)',
    ],
    turns: [
      'SFO to Tokyo Nov 7 for 1 adult',
      'under $800',
      'option 3 have wifi?',
      'make it from LAX',
      'show option 12',
      'cheapest date to fly there',
      'search Nov 15 and show only Super Saver',
      'one stop max',
    ],
  },
] as const;

// CLI args
const limitIndex = process.argv.indexOf('--limit-turns');
const limitTurns = limitIndex < 0 ? Infinity : Number(process.argv[limitIndex + 1]);
const chatIndex = process.argv.indexOf('--chat');
const chatId = chatIndex < 0 ? null : process.argv[chatIndex + 1];

if (!(limitTurns === Infinity || (Number.isInteger(limitTurns) && limitTurns > 0))) {
  throw new Error('--limit-turns must be a positive integer.');
}
if (chatId && !scenarios.some((s) => s.id === chatId)) {
  throw new Error(`Unknown chat: ${chatId}. Available: ${scenarios.map(s => s.id).join(', ')}`);
}

type ValidationCheck = {
  category: 'routing' | 'context' | 'response_quality' | 'tool_selection' | 'recovery' | 'leakage';
  severity: 'error' | 'warning' | 'info';
  message: string;
};

type TurnReport = {
  chat: string;
  turn: number;
  traceId: string;
  user: string;
  output: string;
  outputPreview: string;
  finalAgent: string | null;
  specialistsUsed: string[];
  flightTools: string[];
  managerResults: Array<{
    status: string;
    summary: string;
    completedTask: string | null;
    missingInformation: string[];
    presentation: string | null;
  }>;
  toolFeedback: Array<{
    tool: string;
    ok: boolean | null;
    code: string | null;
    affectedFields: string[];
  }>;
  predictionStatus: string | null;
  renderFlightOptions: boolean;
  resultCount: number;
  noteCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  modelCalls: number;
  latencyMs: number;
  validationChecks: ValidationCheck[];
  passedValidation: boolean;
  error?: string;
};

type ConversationReport = {
  id: string;
  description: string;
  turns: TurnReport[];
  overallPass: boolean;
  errorCount: number;
  warningCount: number;
  summary: string;
};

const fixedNow = new Date('2026-09-19T10:00:00.000Z');
let attempted = 0;
const conversationReports: ConversationReport[] = [];

/**
 * Validation rules for each turn
 */
function validateTurn(turn: TurnReport, expectedBehavior: readonly string[]): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const output = turn.output;

  // 1. Response Quality Checks
  if (!output.trim()) {
    checks.push({
      category: 'response_quality',
      severity: 'error',
      message: 'Empty output returned to user',
    });
  }

  if (/^\\s*\\{\\s*"status"\\s*:/.test(output)) {
    checks.push({
      category: 'leakage',
      severity: 'error',
      message: 'Raw JSON leaked to user instead of natural response',
    });
  }

  // Check for robotic language
  const roboticPatterns = [
    /flight search completed/i,
    /tool executed successfully/i,
    /agent returned/i,
    /task completed/i,
    /processing request/i,
    /calling specialist/i,
    /routing to/i,
  ];
  roboticPatterns.forEach(pattern => {
    if (pattern.test(output)) {
      checks.push({
        category: 'response_quality',
        severity: 'warning',
        message: `Robotic language detected: ${pattern.source}`,
      });
    }
  });

  // Check for backend leakage
  const leakagePatterns = [
    /flight_search/,
    /apply_filter/,
    /price_prediction_tool/,
    /getGeneratedContractsContext/,
    /searchKey/,
    /toolCallLog/,
    /flight_agent/i,
    /trip_planner_agent/i,
    /manager agent/i,
  ];
  leakagePatterns.forEach(pattern => {
    if (pattern.test(output)) {
      checks.push({
        category: 'leakage',
        severity: 'error',
        message: `Backend implementation leaked: ${pattern.source}`,
      });
    }
  });

  // Check for proper emoji usage (should have some, but not overused)
  const emojiCount = (output.match(/[✈️📍🗓️💰✅🔄🎒🪑🗺️ℹ️]/g) || []).length;
  const outputLength = output.length;
  if (outputLength > 100 && emojiCount === 0) {
    checks.push({
      category: 'response_quality',
      severity: 'info',
      message: 'No icons used in substantial response (consider adding for visual appeal)',
    });
  }
  if (emojiCount > outputLength / 50) {
    checks.push({
      category: 'response_quality',
      severity: 'warning',
      message: `Emoji overuse detected (${emojiCount} emojis in ${outputLength} chars)`,
    });
  }

  // 2. Routing Checks
  if (turn.finalAgent !== 'Manager Agent') {
    checks.push({
      category: 'routing',
      severity: 'error',
      message: `Final agent was ${turn.finalAgent}, expected Manager Agent`,
    });
  }

  if (turn.specialistsUsed.some(name => name !== 'flight_agent')) {
    checks.push({
      category: 'routing',
      severity: 'error',
      message: `Wrong specialist used: ${turn.specialistsUsed.join(', ')}`,
    });
  }

  // 3. Tool Selection Checks
  const hasSearch = turn.flightTools.includes('flight_search');
  const hasFilter = turn.flightTools.includes('apply_filter');
  const hasPrediction = turn.flightTools.includes('price_prediction_tool');
  const hasContracts = turn.flightTools.includes('getGeneratedContractsContext');

  // Check per-person note consistency
  if (turn.renderFlightOptions && hasSearch && turn.noteCount !== 1) {
    checks.push({
      category: 'response_quality',
      severity: 'error',
      message: `New search rendered but note count is ${turn.noteCount}, expected exactly 1`,
    });
  }
  if (!hasSearch && turn.noteCount > 0) {
    checks.push({
      category: 'response_quality',
      severity: 'warning',
      message: 'Per-person price note added without current-turn search',
    });
  }

  // 4. Context & Recovery Checks
  turn.managerResults.forEach((result, idx) => {
    if (result.status === 'failed' || result.status === 'unavailable') {
      checks.push({
        category: 'recovery',
        severity: 'error',
        message: `Specialist ${idx + 1} failed: ${result.summary}`,
      });
    }
    if (result.missingInformation.length > 0 && !output.includes('?')) {
      checks.push({
        category: 'recovery',
        severity: 'warning',
        message: `Missing info reported (${result.missingInformation.join(', ')}) but no question asked`,
      });
    }
  });

  // 5. Unnecessary Tool Call Checks
  if (turn.flightTools.length > 3) {
    checks.push({
      category: 'tool_selection',
      severity: 'warning',
      message: `Potentially excessive tool calls: ${turn.flightTools.length} tools used`,
    });
  }

  return checks;
}

/**
 * Run all scenarios
 */
for (const scenario of scenarios.filter(s => !chatId || s.id === chatId)) {
  if (attempted >= limitTurns) break;

  console.log(`\n${'='.repeat(80)}\nStarting conversation: ${scenario.id}\n${'='.repeat(80)}`);

  const session = new OpenAIConversationsSession();
  let runtimeContext: any = {};
  const turnReports: TurnReport[] = [];

  for (const [index, user] of scenario.turns.entries()) {
    if (attempted >= limitTurns) break;
    attempted += 1;

    const started = Date.now();
    const traceId = generateTraceId();

    console.log(`\n--- Turn ${index + 1}/${scenario.turns.length} ---`);
    console.log(`User: ${user}`);

    try {
      const context = hydrateGatewayContext(runtimeContext);
      const run = runGatewayAgentTextStream({
        input: user,
        requestId: `manager-realistic-${scenario.id}-${index + 1}`,
        traceId,
        sessionId: `manager-realistic-${scenario.id}`,
        context,
        session,
        now: fixedNow,
        timeZone: 'Asia/Kolkata',
        maxTurns: 12,
      });

      let streamed = '';
      const streamDone = (async () => {
        for await (const chunk of run.stream) streamed += String(chunk);
      })();

      const [streamResult, completionResult] = await Promise.allSettled([streamDone, run.completed]);
      if (completionResult.status === 'rejected') throw completionResult.reason;
      if (streamResult.status === 'rejected') throw streamResult.reason;

      const result = completionResult.value;
      runtimeContext = snapshotGatewayContext(result.context);

      const output = String(result.output || '');
      const flightTools = (result.context.toolCallLog || [])
        .map((entry: any) => String(entry?.tool || ''))
        .filter(Boolean);

      const managerResults = (result.result?.newItems || [])
        .filter((item: any) => item?.type === 'tool_call_output_item')
        .flatMap((item: any) => {
          try {
            const value = JSON.parse(String(item.output || ''));
            return typeof value.status === 'string' && typeof value.summary === 'string'
              ? [{
                  status: value.status,
                  summary: value.summary,
                  completedTask: typeof value.completedTask === 'string' ? value.completedTask : null,
                  missingInformation: Array.isArray(value.missingInformation) ? value.missingInformation : [],
                  presentation: typeof value.presentation === 'string' ? value.presentation : null,
                }]
              : [];
          } catch {
            return [];
          }
        });

      const toolFeedback = (result.context.toolCallLog || []).map((entry: any) => ({
        tool: String(entry?.tool || ''),
        ok: typeof entry?.ok === 'boolean' ? entry.ok : null,
        code: typeof entry?.code === 'string' ? entry.code : null,
        affectedFields: Array.isArray(entry?.affectedFields) ? entry.affectedFields : [],
      }));

      const prediction = result.context.flight.lastPricePrediction as { status?: unknown } | null;
      const predictionStatus = typeof prediction?.status === 'string' ? prediction.status : null;
      const resultCount = Array.isArray(result.context.flight.searchResults)
        ? result.context.flight.searchResults.length
        : 0;
      const noteCount = (output.match(/Note: Prices shown are per person\./g) || []).length;

      const turnReport: TurnReport = {
        chat: scenario.id,
        turn: index + 1,
        traceId,
        user,
        output,
        outputPreview: output.slice(0, 200),
        finalAgent: result.finalAgentName,
        specialistsUsed: result.specialistsUsed || [],
        flightTools,
        managerResults,
        toolFeedback,
        predictionStatus,
        renderFlightOptions: Boolean(result.renderFlightOptions),
        resultCount,
        noteCount,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        modelCalls: result.usage?.calls?.length || 0,
        latencyMs: Date.now() - started,
        validationChecks: [],
        passedValidation: true,
      };

      // Validate turn
      turnReport.validationChecks = validateTurn(turnReport, scenario.expectedBehavior);
      turnReport.passedValidation = !turnReport.validationChecks.some(c => c.severity === 'error');

      turnReports.push(turnReport);

      // Console output
      console.log(`Assistant: ${output.slice(0, 150)}${output.length > 150 ? '...' : ''}`);
      console.log(`Tools: ${flightTools.join(', ') || 'none'}`);
      console.log(`Results: ${resultCount}, Render: ${turnReport.renderFlightOptions}`);
      console.log(`Validation: ${turnReport.passedValidation ? '✅ PASS' : '❌ FAIL'}`);
      if (turnReport.validationChecks.length > 0) {
        turnReport.validationChecks.forEach(check => {
          const icon = check.severity === 'error' ? '❌' : check.severity === 'warning' ? '⚠️' : 'ℹ️';
          console.log(`  ${icon} [${check.category}] ${check.message}`);
        });
      }

    } catch (error) {
      const failure = error as Error & { code?: string };
      const turnReport: TurnReport = {
        chat: scenario.id,
        turn: index + 1,
        traceId,
        user,
        output: '',
        outputPreview: '',
        finalAgent: null,
        specialistsUsed: [],
        flightTools: [],
        managerResults: [],
        toolFeedback: [],
        predictionStatus: null,
        renderFlightOptions: false,
        resultCount: 0,
        noteCount: 0,
        inputTokens: null,
        outputTokens: null,
        modelCalls: 0,
        latencyMs: Date.now() - started,
        validationChecks: [{
          category: 'recovery',
          severity: 'error',
          message: `Turn failed: ${failure.name || 'Error'}:${failure.code || ''}:${String(failure.message || '').slice(0, 150)}`,
        }],
        passedValidation: false,
        error: `${failure.name || 'Error'}:${failure.code || ''}:${String(failure.message || '').slice(0, 220)}`,
      };

      turnReports.push(turnReport);
      console.log(`❌ TURN FAILED: ${turnReport.error}`);

      if (/\b(?:401|403|429|insufficient_quota|invalid_api_key)\b/i.test(turnReport.error || '')) {
        console.log('Critical API error, stopping test suite.');
        break;
      }
    }
  }

  // Conversation summary
  const errorCount = turnReports.reduce((sum, t) => sum + t.validationChecks.filter(c => c.severity === 'error').length, 0);
  const warningCount = turnReports.reduce((sum, t) => sum + t.validationChecks.filter(c => c.severity === 'warning').length, 0);
  const overallPass = turnReports.every(t => t.passedValidation);

  const conversationReport: ConversationReport = {
    id: scenario.id,
    description: scenario.description,
    turns: turnReports,
    overallPass,
    errorCount,
    warningCount,
    summary: overallPass
      ? `✅ All ${turnReports.length} turns passed`
      : `❌ ${errorCount} errors, ${warningCount} warnings across ${turnReports.length} turns`,
  };

  conversationReports.push(conversationReport);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Conversation Summary: ${scenario.id}`);
  console.log(conversationReport.summary);
  console.log(`${'='.repeat(80)}\n`);
}

/**
 * Generate final report
 */
const outputDir = 'artifacts';
const outputPath = path.resolve(
  chatId
    ? `${outputDir}/manager-realistic-${chatId}.json`
    : `${outputDir}/manager-realistic-conversations.json`
);

await fs.mkdir(outputDir, { recursive: true });

// Detailed JSON report
const detailedReport = {
  testSuite: 'Manager Agent Realistic Flight Conversations',
  timestamp: new Date().toISOString(),
  fixedNow: fixedNow.toISOString(),
  totalConversations: conversationReports.length,
  totalTurns: conversationReports.reduce((sum, c) => sum + c.turns.length, 0),
  conversationsPassedAll: conversationReports.filter(c => c.overallPass).length,
  totalErrors: conversationReports.reduce((sum, c) => sum + c.errorCount, 0),
  totalWarnings: conversationReports.reduce((sum, c) => sum + c.warningCount, 0),
  totalInputTokens: conversationReports.reduce(
    (sum, c) => sum + c.turns.reduce((s, t) => s + (t.inputTokens || 0), 0),
    0
  ),
  totalOutputTokens: conversationReports.reduce(
    (sum, c) => sum + c.turns.reduce((s, t) => s + (t.outputTokens || 0), 0),
    0
  ),
  traceExportStatuses,
  conversations: conversationReports,
};

await fs.writeFile(outputPath, JSON.stringify(detailedReport, null, 2));

// Human-readable summary
const summaryPath = path.resolve(
  chatId
    ? `${outputDir}/manager-realistic-${chatId}-summary.md`
    : `${outputDir}/manager-realistic-summary.md`
);

let summaryMd = `# Manager Agent Realistic Conversation Test Report\n\n`;
summaryMd += `**Generated:** ${new Date().toISOString()}\n`;
summaryMd += `**Test Date:** ${fixedNow.toISOString()}\n`;
summaryMd += `**Conversations:** ${conversationReports.length}\n`;
summaryMd += `**Total Turns:** ${detailedReport.totalTurns}\n`;
summaryMd += `**Overall Pass Rate:** ${conversationReports.filter(c => c.overallPass).length}/${conversationReports.length}\n`;
summaryMd += `**Total Errors:** ${detailedReport.totalErrors}\n`;
summaryMd += `**Total Warnings:** ${detailedReport.totalWarnings}\n`;
summaryMd += `**Input Tokens:** ${detailedReport.totalInputTokens.toLocaleString()}\n`;
summaryMd += `**Output Tokens:** ${detailedReport.totalOutputTokens.toLocaleString()}\n\n`;

summaryMd += `---\n\n`;

// Per-conversation details
for (const conv of conversationReports) {
  summaryMd += `## ${conv.id}\n\n`;
  summaryMd += `**Description:** ${conv.description}\n\n`;
  summaryMd += `**Result:** ${conv.overallPass ? '✅ PASS' : '❌ FAIL'}\n`;
  summaryMd += `**Turns:** ${conv.turns.length}\n`;
  summaryMd += `**Errors:** ${conv.errorCount}, **Warnings:** ${conv.warningCount}\n\n`;

  // Group issues by category
  const issuesByCategory = new Map<string, ValidationCheck[]>();
  conv.turns.forEach(turn => {
    turn.validationChecks.forEach(check => {
      const category = check.category;
      if (!issuesByCategory.has(category)) issuesByCategory.set(category, []);
      issuesByCategory.get(category)!.push(check);
    });
  });

  if (issuesByCategory.size > 0) {
    summaryMd += `### Issues Found\n\n`;
    for (const [category, checks] of issuesByCategory) {
      const errors = checks.filter(c => c.severity === 'error');
      const warnings = checks.filter(c => c.severity === 'warning');
      if (errors.length > 0 || warnings.length > 0) {
        summaryMd += `#### ${category}\n`;
        if (errors.length > 0) {
          summaryMd += `- **Errors:** ${errors.length}\n`;
          errors.slice(0, 3).forEach(e => summaryMd += `  - ${e.message}\n`);
        }
        if (warnings.length > 0) {
          summaryMd += `- **Warnings:** ${warnings.length}\n`;
          warnings.slice(0, 3).forEach(w => summaryMd += `  - ${w.message}\n`);
        }
        summaryMd += `\n`;
      }
    }
  }

  summaryMd += `### Turn-by-Turn\n\n`;
  conv.turns.forEach(turn => {
    const status = turn.passedValidation ? '✅' : '❌';
    summaryMd += `**Turn ${turn.turn}** ${status}\n`;
    summaryMd += `- User: \`${turn.user}\`\n`;
    summaryMd += `- Tools: ${turn.flightTools.join(', ') || 'none'}\n`;
    summaryMd += `- Output: ${turn.outputPreview}${turn.output.length > 200 ? '...' : ''}\n`;
    if (turn.validationChecks.length > 0) {
      summaryMd += `- Issues:\n`;
      turn.validationChecks.forEach(check => {
        const icon = check.severity === 'error' ? '❌' : check.severity === 'warning' ? '⚠️' : 'ℹ️';
        summaryMd += `  ${icon} [${check.category}] ${check.message}\n`;
      });
    }
    summaryMd += `\n`;
  });

  summaryMd += `---\n\n`;
}

// Overall recommendations
summaryMd += `## Recommendations\n\n`;

const allIssues = conversationReports.flatMap(c => c.turns.flatMap(t => t.validationChecks));
const issuesByCategory = new Map<string, ValidationCheck[]>();
allIssues.forEach(check => {
  const category = check.category;
  if (!issuesByCategory.has(category)) issuesByCategory.set(category, []);
  issuesByCategory.get(category)!.push(check);
});

for (const [category, checks] of issuesByCategory) {
  const errors = checks.filter(c => c.severity === 'error');
  if (errors.length > 0) {
    summaryMd += `### ${category} (${errors.length} errors)\n\n`;
    const uniqueMessages = [...new Set(errors.map(e => e.message))];
    uniqueMessages.slice(0, 5).forEach(msg => {
      const count = errors.filter(e => e.message === msg).length;
      summaryMd += `- **[${count}x]** ${msg}\n`;
    });
    summaryMd += `\n`;
  }
}

await fs.writeFile(summaryPath, summaryMd);

// Flush traces
await getGlobalTraceProvider().forceFlush();

// Console summary
console.log(`\n${'='.repeat(80)}`);
console.log('TEST SUITE COMPLETE');
console.log(`${'='.repeat(80)}`);
console.log(`Conversations: ${conversationReports.length}`);
console.log(`Turns: ${detailedReport.totalTurns}`);
console.log(`Pass Rate: ${conversationReports.filter(c => c.overallPass).length}/${conversationReports.length}`);
console.log(`Errors: ${detailedReport.totalErrors}`);
console.log(`Warnings: ${detailedReport.totalWarnings}`);
console.log(`Tokens: ${detailedReport.totalInputTokens.toLocaleString()} in, ${detailedReport.totalOutputTokens.toLocaleString()} out`);
console.log(`\nReports saved:`);
console.log(`  JSON: ${outputPath}`);
console.log(`  Summary: ${summaryPath}`);
console.log(`${'='.repeat(80)}\n`);
