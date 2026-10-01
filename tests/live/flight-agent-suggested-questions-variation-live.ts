/**
 * Live check of the "You might ask" suggestions across one standalone Flight
 * conversation.
 *
 * The first turns cannot search yet, because the departure location and date
 * are missing, so they must store no suggestions. Once a search exists, every
 * turn must refresh exactly three. Throughout, every turn must end with the
 * suggestions update, and the suggestions must stay in the traveler's voice,
 * never ask for route or date fields, never repeat what the traveler just did,
 * and change between turns.
 *
 *   npm run test:flight:suggested-questions-variation
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
// Room for the core tools, the required suggestions update, and the final answer.
process.env.FLIGHT_AGENT_MAX_TURNS ||= '5';

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
  'From Mumbai on November 12',
  'Show nonstop flights only',
  'Which option is cheapest?',
  'Make it a round trip, returning November 19',
];
/** Turns before this one cannot search: the departure location and date are still missing. */
const FIRST_SEARCH_TURN_INDEX = 3;

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

function validateSuggestions({ suggestions, previousSuggestions, response, turnNumber, user, searchActive }) {
  const issues = [];
  const expectedCount = searchActive ? 3 : 0;

  if (suggestions.length !== expectedCount) {
    issues.push(
      `Expected ${expectedCount} suggested questions ${searchActive ? 'with' : 'without'} an active search, got ${suggestions.length}.`,
    );
  }

  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      issues.push(`Invalid suggestion: ${JSON.stringify(suggestion)}.`);
      continue;
    }
    if (suggestion.length > 80) {
      issues.push(`Suggestion is too long for a chip: ${suggestion}.`);
    }
    if (response.includes(suggestion)) {
      issues.push(`Assistant response exposed suggested question: ${suggestion}.`);
    }
    if (/^(would you like|do you want|should i|shall i|want me to)\b/i.test(suggestion)) {
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
    if (normalizeSuggestion(suggestion) === normalizeSuggestion(user)) {
      issues.push(`Suggestion repeats what the traveler just asked: ${suggestion}.`);
    }
  }

  if (suggestions.length > 0 && previousSuggestions.length > 0) {
    if (suggestionsAreSame(previousSuggestions, suggestions)) {
      issues.push('Suggested questions repeated exactly from the previous turn.');
    }
    if (suggestionSetOverlap(previousSuggestions, suggestions) === 3) {
      issues.push('All three suggestion intents repeated from the previous turn.');
    }
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

  if (
    /nonstop/i.test(user) &&
    suggestions.some(
      (suggestion) =>
        /\b(non-?stop|direct)\b/i.test(suggestion) &&
        !/\b(remove|clear|drop|allow|include|any|instead)\b/i.test(suggestion),
    )
  ) {
    issues.push('Suggestion re-applies the nonstop filter that is already active.');
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
    lines.push(`Search active: ${turn.searchActive ? 'yes' : 'no'}`);
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
  const searchActive = Boolean(context.flight?.searchKey);
  const issues = [];

  if (actualTools.at(-1) !== SUGGESTED_TOOL) {
    issues.push(`The turn did not end with ${SUGGESTED_TOOL}: ${actualTools.join(' -> ') || '(no tools)'}.`);
  }

  if (index < FIRST_SEARCH_TURN_INDEX && actualTools.some((toolName) => toolName !== SUGGESTED_TOOL)) {
    issues.push(`Unexpected task tool before mandatory search fields: ${actualTools.join(' -> ')}.`);
  }

  issues.push(
    ...validateSuggestions({
      suggestions: suggestedQuestions,
      previousSuggestions,
      response: result.output || '',
      turnNumber: index + 1,
      user: turns[index],
      searchActive,
    }),
  );

  results.push({
    turn: index + 1,
    user: turns[index],
    agentResponse: result.output || '',
    actualTools,
    searchActive,
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
