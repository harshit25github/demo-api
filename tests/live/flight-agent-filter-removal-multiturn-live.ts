import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const SUGGESTED_TOOL = 'update_flight_suggested_questions';
const scenarioId = `filter-removal-multiturn-${Date.now()}`;
const resultsDir = path.resolve('tests/results');
const jsonReportPath = path.join(resultsDir, 'flight-agent-filter-removal-multiturn-latest.json');
const textReportPath = path.join(resultsDir, 'flight-agent-filter-removal-multiturn-latest.txt');

function payloadFilter(payload = [], filterType) {
  return payload.find((filter) => filter.filterType === filterType);
}

function latestApplyCall(calls = []) {
  return [...calls].reverse().find((call) => call.tool === 'apply_filter') || null;
}

function latestApplyPayload(calls = [], context: any = {}) {
  return latestApplyCall(calls)?.finalFilterPayload || context.lastFinalFilterPayload || [];
}

function snapshotContext(context: any = {}) {
  return {
    searchKey: context.searchKey || null,
    sid: context.sid || null,
    lastSearch: context.lastSearch || null,
    flightCount: context.flightResults?.length || 0,
    filteredCount: context.filteredFlightResults?.length || 0,
    lastAppliedFilters: context.lastAppliedFilters || [],
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    lastApplyFilterFeedback: context.lastApplyFilterFeedback || [],
    suggestedQuestions: context.flight?.suggestedQuestions || [],
    toolCallLogCount: context.toolCallLog?.length || 0,
  };
}

function formatCalls(calls = []) {
  return calls.map((call) => ({
    tool: call.tool,
    searchKey: call.searchKey || null,
    input: call.input || null,
    filters: call.filters || null,
    finalFilterPayload: call.finalFilterPayload || null,
    feedback: call.feedback || null,
  }));
}

function sameToolSequence(actual, expected) {
  return actual.join(' -> ') === expected.join(' -> ');
}

function expectTools(expectedTools) {
  return ({ actualTools }) =>
    sameToolSequence(actualTools, expectedTools)
      ? []
      : [`Expected tools ${expectedTools.join(' -> ')}, got ${actualTools.join(' -> ') || '(none)'}.`];
}

function expectPayload(filterType, expectedValues) {
  return ({ calls, context }) => {
    const payload = latestApplyPayload(calls, context);
    const found = payloadFilter(payload, filterType);
    assert.deepEqual(
      found,
      { filterType, Values: expectedValues },
      `Expected ${filterType} payload ${JSON.stringify(expectedValues)}, got ${JSON.stringify(found)}.`,
    );
    return [];
  };
}

function expectPayloadIncludes(filterType, expectedValues) {
  return ({ calls, context }) => {
    const payload = latestApplyPayload(calls, context);
    const found = payloadFilter(payload, filterType);
    if (!found) {
      return [`Expected ${filterType} payload, got ${JSON.stringify(payload)}.`];
    }

    const actualValues = found.Values || [];
    const missing = expectedValues.filter((expectedValue) => {
      if (Array.isArray(actualValues)) {
        return !actualValues.some((actualValue) => String(actualValue).includes(String(expectedValue)));
      }
      return !String(actualValues).includes(String(expectedValue));
    });

    return missing.length === 0
      ? []
      : [`Expected ${filterType} to include ${missing.join(', ')}, got ${JSON.stringify(found)}.`];
  };
}

function expectNoPayload(filterType) {
  return ({ calls, context }) => {
    const payload = latestApplyPayload(calls, context);
    return payloadFilter(payload, filterType)
      ? [`Expected no ${filterType} payload, got ${JSON.stringify(payloadFilter(payload, filterType))}.`]
      : [];
  };
}

function expectSuggestions(context, response) {
  const suggestions = context.flight?.suggestedQuestions || [];
  const errors = [];

  if (suggestions.length !== 3) {
    errors.push(`Expected exactly 3 suggested questions, got ${suggestions.length}.`);
  }

  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      errors.push(`Invalid suggested question: ${JSON.stringify(suggestion)}.`);
    }
    if (suggestion && response.includes(suggestion)) {
      errors.push(`Response exposed suggested question: ${suggestion}.`);
    }
  }

  return errors;
}

function combineChecks(...checks) {
  return (args) =>
    checks.flatMap((check) => {
      try {
        return check(args);
      } catch (error: any) {
        return [error.message];
      }
    });
}

const turns = [
  {
    name: 'initiate flight search',
    user: 'Find flights from NYC to LAX on 2026-08-20 for 1 adult economy.',
    expectedTools: ['flight_search', SUGGESTED_TOOL],
    check: combineChecks(expectTools(['flight_search', SUGGESTED_TOOL])),
  },
  {
    name: 'apply all supported filters',
    user:
      'Apply these filters: one stop, Air Canada and Emirates, checked baggage, morning departure, evening arrival, layover in Dubai, depart from JFK, arrive at LAX, total duration under 20 hours, and layover under 4 hours.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayload('stop', ['2']),
      expectPayloadIncludes('airline', ['AC', 'AC+', 'EK']),
      expectPayload('baggage', ['0']),
      expectPayload('departtimeslotfilter', ['MORNING']),
      expectPayload('departlandtimeslotfilter', ['EVENING']),
      expectPayload('outboundlayover', ['DXB']),
      expectPayload('outbounddepart', ['JFK']),
      expectPayload('outboundarrival', ['LAX']),
      expectPayload('departdurationfilter', [0, 1200]),
      expectPayload('departlayoverfilter', [0, 240]),
    ),
  },
  {
    name: 'reset all filters',
    user: 'Reset filters.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayload('reset', []),
    ),
  },
  {
    name: 'apply two filters again',
    user: 'Now apply Air Canada and Emirates only with checked baggage.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayloadIncludes('airline', ['AC', 'AC+', 'EK']),
      expectPayload('baggage', ['0']),
    ),
  },
  {
    name: 'partial airline removal',
    user: 'Remove Air Canada only.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayload('airline', ['EK']),
      expectPayload('baggage', ['0']),
    ),
  },
  {
    name: 'complete airline removal',
    user: 'Clear airline filter.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayload('airline', ['all']),
      expectPayload('baggage', ['0']),
    ),
  },
  {
    name: 'complete baggage removal',
    user: 'Remove all baggage filters.',
    expectedTools: ['apply_filter', SUGGESTED_TOOL],
    check: combineChecks(
      expectTools(['apply_filter', SUGGESTED_TOOL]),
      expectPayload('baggage', []),
      expectNoPayload('airline'),
    ),
  },
];

async function runTurn({ context, turn, index }) {
  const before = snapshotContext(context);
  const beforeCallCount = context.toolCallLog.length;
  const result = await runFlightAgent({
    input: turn.user,
    sessionId: scenarioId,
    requestId: `${scenarioId}-turn-${index + 1}`,
    context,
  });
  const calls = context.toolCallLog.slice(beforeCallCount);
  const actualTools = calls.map((call) => call.tool);
  const response = result.output || '';
  const checkErrors = turn.check({ calls, context, actualTools, response });
  const suggestionErrors = expectSuggestions(context, response);
  const errors = [...checkErrors, ...suggestionErrors];
  const after = snapshotContext(context);

  return {
    turn: index + 1,
    name: turn.name,
    user: turn.user,
    agentResponse: response,
    expectedTool: turn.expectedTools.join(' -> '),
    actualTool: actualTools.join(' -> ') || '(none)',
    actualPayload: formatCalls(calls),
    contextBefore: before,
    contextAfter: after,
    latestSearchKey: after.searchKey,
    pass: errors.length === 0,
    issues: errors,
    latencyMs: result.latencyMs,
  };
}

function buildTextReport(summary, scenario) {
  const lines = [
    '# Flight Agent Filter Removal Multi-turn Report',
    `Generated: ${summary.generatedAt}`,
    `Model: ${summary.model}`,
    `Passed turns: ${summary.passedTurns}/${summary.totalTurns}`,
    `Success: ${summary.successPercentage}%`,
    '',
    `## ${scenario.pass ? 'PASS' : 'FAIL'} - ${scenario.title}`,
  ];

  for (const turn of scenario.turns) {
    lines.push(`- Turn ${turn.turn}: ${turn.user}`);
    lines.push(`  - Expected: ${turn.expectedTool}`);
    lines.push(`  - Actual: ${turn.actualTool}`);
    lines.push(`  - Payload: ${JSON.stringify(turn.contextAfter.lastFinalFilterPayload)}`);
    lines.push(`  - Result: ${turn.pass ? 'PASS' : `FAIL - ${turn.issues.join(' | ')}`}`);
  }

  return `${lines.join('\n')}\n`;
}

await clearFlightAgentSession(scenarioId);

const context: any = {
  UID: scenarioId,
  uid: scenarioId,
  toolCallLog: [],
};

const turnResults = [];
for (let index = 0; index < turns.length; index += 1) {
  turnResults.push(await runTurn({ context, turn: turns[index], index }));
}

await clearFlightAgentSession(scenarioId);

const scenario = {
  id: scenarioId,
  title: 'Search, apply filters, reset, reapply, partial removal, full removal',
  pass: turnResults.every((turn) => turn.pass),
  turns: turnResults,
};
const summary = {
  generatedAt: new Date().toISOString(),
  model: flightAgentConfig.model,
  totalTurns: turnResults.length,
  passedTurns: turnResults.filter((turn) => turn.pass).length,
  failedTurns: turnResults.filter((turn) => !turn.pass).length,
  successPercentage: Number(
    ((turnResults.filter((turn) => turn.pass).length / turnResults.length) * 100).toFixed(1),
  ),
};
const report = { summary, scenario };

await mkdir(resultsDir, { recursive: true });
await writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(textReportPath, buildTextReport(summary, scenario));

console.log(buildTextReport(summary, scenario));

if (!scenario.pass) {
  process.exitCode = 1;
}
