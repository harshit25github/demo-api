import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '4';

const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const SUGGESTED_TOOL = 'update_flight_suggested_questions';
const scenarioId = `suggested-questions-variation-${Date.now()}`;
const resultsDir = path.resolve('tests/results');
const jsonReportPath = path.join(resultsDir, 'flight-agent-suggested-questions-variation-latest.json');
const textReportPath = path.join(resultsDir, 'flight-agent-suggested-questions-variation-latest.txt');

const turns = [
  "I'm looking for a flight to Delhi",
  'Actually, make it Bangalore',
  'Add 2 adults',
  'Make it round trip',
];

function normalizeSuggestion(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function suggestionsAreSame(left = [], right = []) {
  return (
    left.length === right.length &&
    left.every((value, index) => normalizeSuggestion(value) === normalizeSuggestion(right[index]))
  );
}

function suggestionSetOverlap(left = [], right = []) {
  const previous = new Set(left.map(normalizeSuggestion));
  return right.filter((suggestion) => previous.has(normalizeSuggestion(suggestion))).length;
}

function validateSuggestions({ suggestions, previousSuggestions, response, turnNumber, user }) {
  const issues = [];

  if (suggestions.length !== 3) {
    issues.push(`Expected exactly 3 suggested questions, got ${suggestions.length}.`);
  }

  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      issues.push(`Invalid suggestion: ${JSON.stringify(suggestion)}.`);
    }
    if (response.includes(suggestion)) {
      issues.push(`Assistant response exposed suggested question: ${suggestion}.`);
    }
    if (/^(would you|do you want|should i|can i|shall i)\b/i.test(suggestion)) {
      issues.push(`Assistant-style suggestion: ${suggestion}.`);
    }
    if (
      /\b(origin|departure city|departing city|from city|destination|arrival city|travel date|return date|date range)\b/i.test(
        suggestion,
      ) ||
      /where should i fly/i.test(suggestion)
    ) {
      issues.push(`Mandatory-field loop suggestion: ${suggestion}.`);
    }
    if (/\b(suggest|pick|recommend|choose)\s+(?:a\s+)?(?:travel\s+)?date/i.test(suggestion)) {
      issues.push(`Suggestion asks agent to choose a date: ${suggestion}.`);
    }
    if (/\bapply|show flights|compare current|which flight|fare differences|cheapest|best\b/i.test(suggestion)) {
      issues.push(`Advanced suggestion appeared before searchKey exists: ${suggestion}.`);
    }
  }

  if (previousSuggestions.length > 0 && suggestionsAreSame(previousSuggestions, suggestions)) {
    issues.push('Suggested questions repeated exactly from the previous turn.');
  }

  if (previousSuggestions.length > 0 && suggestionSetOverlap(previousSuggestions, suggestions) === 3) {
    issues.push('All three suggestion intents repeated from the previous turn.');
  }

  if (turnNumber >= 2 && suggestions.some((suggestion) => /\bdelhi\b/i.test(suggestion))) {
    issues.push('Suggestion still references Delhi after the destination changed to Bangalore.');
  }

  if (/add 2 adults/i.test(user) && suggestions.some((suggestion) => /^add 2 adults$/i.test(suggestion))) {
    issues.push('Suggestion repeated the passenger action that was just provided.');
  }

  if (/round trip/i.test(user) && suggestions.some((suggestion) => /make (it|this) (a )?round trip/i.test(suggestion))) {
    issues.push('Suggestion repeated the trip-type action that was just provided.');
  }

  return issues;
}

function buildTextReport(report) {
  const lines = [
    '# Flight Agent Suggested Questions Variation Report',
    `Generated: ${report.summary.generatedAt}`,
    `Model: ${report.summary.model}`,
    `Passed turns: ${report.summary.passedTurns}/${report.summary.totalTurns}`,
    `Success: ${report.summary.successPercentage}%`,
    '',
  ];

  for (const turn of report.turns) {
    lines.push(`## Turn ${turn.turn}: ${turn.user}`);
    lines.push(`Response: ${turn.agentResponse}`);
    lines.push(`Tools: ${turn.actualTools.join(' -> ') || '(none)'}`);
    lines.push(`Suggestions: ${JSON.stringify(turn.suggestedQuestions)}`);
    lines.push(`Previous overlap: ${turn.previousOverlap}`);
    lines.push(`Result: ${turn.pass ? 'PASS' : `FAIL - ${turn.issues.join(' | ')}`}`);
    lines.push('');
  }

  return lines.join('\n');
}

await clearFlightAgentSession(scenarioId);

const context: any = {
  UID: scenarioId,
  uid: scenarioId,
  toolCallLog: [],
};

const results = [];
let previousSuggestions = [];

for (let index = 0; index < turns.length; index += 1) {
  const beforeCallCount = context.toolCallLog.length;
  const result = await runFlightAgent({
    input: turns[index],
    sessionId: scenarioId,
    requestId: `${scenarioId}-turn-${index + 1}`,
    context,
  });
  const calls = context.toolCallLog.slice(beforeCallCount);
  const actualTools = calls.map((call) => call.tool);
  const suggestedQuestions = context.flight?.suggestedQuestions || [];
  const issues = [];

  if (!actualTools.includes(SUGGESTED_TOOL)) {
    issues.push('update_flight_suggested_questions was not called.');
  }

  if (actualTools.some((toolName) => toolName !== SUGGESTED_TOOL)) {
    issues.push(`Unexpected task tool before mandatory search fields: ${actualTools.join(' -> ')}.`);
  }

  issues.push(
    ...validateSuggestions({
      suggestions: suggestedQuestions,
      previousSuggestions,
      response: result.output || '',
      turnNumber: index + 1,
      user: turns[index],
    }),
  );

  results.push({
    turn: index + 1,
    user: turns[index],
    agentResponse: result.output || '',
    actualTools,
    suggestedQuestions,
    previousSuggestedQuestions: previousSuggestions,
    previousOverlap: suggestionSetOverlap(previousSuggestions, suggestedQuestions),
    pass: issues.length === 0,
    issues,
  });

  previousSuggestions = [...suggestedQuestions];
}

await clearFlightAgentSession(scenarioId);

const passedTurns = results.filter((turn) => turn.pass).length;
const report = {
  summary: {
    generatedAt: new Date().toISOString(),
    model: flightAgentConfig.model,
    totalTurns: results.length,
    passedTurns,
    failedTurns: results.length - passedTurns,
    successPercentage: Number(((passedTurns / results.length) * 100).toFixed(1)),
  },
  turns: results,
};

await mkdir(resultsDir, { recursive: true });
await writeFile(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(textReportPath, `${buildTextReport(report)}\n`);

console.log(buildTextReport(report));

if (passedTurns !== results.length) {
  process.exitCode = 1;
}
