import 'dotenv/config';

import { Runner } from '@openai/agents';
import { encode } from '@toon-format/toon';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SummaryExtractorAgent,
  createSummaryAgentRunContext,
  summaryAgentConfig,
} from '../../src/agents/summary/agent.js';
import { summaryAgentJourneys } from '../fixtures/summary-agent-live-eval-cases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dateOnly = process.argv.includes('--date-only');
const passengerOnly = process.argv.includes('--passenger-only');
const journeyFilter = process.argv
  .find((argument) => argument.startsWith('--journey='))
  ?.slice('--journey='.length);
const selectedJourneys = dateOnly
  ? summaryAgentJourneys.filter(
      (journey) =>
        journey.journeyId.startsWith('clock_') || journey.journeyId.startsWith('date_'),
    )
  : passengerOnly
    ? summaryAgentJourneys.filter((journey) => journey.journeyId.startsWith('passenger_'))
    : journeyFilter
      ? summaryAgentJourneys.filter((journey) => journey.journeyId === journeyFilter)
      : summaryAgentJourneys;
const resultPath = path.join(
  __dirname,
  'results',
  dateOnly
    ? 'summary-agent-date-clock-eval-latest.json'
    : passengerOnly
      ? 'summary-agent-passenger-eval-latest.json'
      : journeyFilter
        ? `summary-agent-${journeyFilter}-eval-latest.json`
        : 'summary-agent-live-eval-latest.json',
);
const evalClockOptions = {
  now: new Date('2026-08-23T10:00:00.000Z'),
  timeZone: 'Asia/Kolkata',
};
const evalClock = createSummaryAgentRunContext(evalClockOptions).summaryAgent.clock;

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the live Summary Agent eval.');
}

const runner = new Runner({
  workflowName: 'summary-agent-live-eval',
  traceIncludeSensitiveData: false,
});

const scalarPaths = [
  'origin.city',
  'origin.iata',
  'destination.city',
  'destination.iata',
  'outbound_date',
  'return_date',
  'duration_days',
  'budget.amount',
  'budget.currency',
  'budget.per_person',
  'budget.total',
  'passengerData.total',
  'passengerData.adults',
  'passengerData.seniors',
  'passengerData.children',
  'passengerData.lapInfants',
  'passengerData.seatInfants',
];

function valueAt(object, dottedPath) {
  return dottedPath.split('.').reduce((value, key) => value?.[key], object);
}

function stableValues(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function compareSetField({ path: fieldPath, expected, actual, missedFields, hallucinatedFields }) {
  const expectedValues = stableValues(expected || []);
  const actualValues = stableValues(actual || []);

  for (const value of expectedValues) {
    if (!actualValues.includes(value)) missedFields.push(`${fieldPath}:${value}`);
  }
  for (const value of actualValues) {
    if (!expectedValues.includes(value)) hallucinatedFields.push(`${fieldPath}:${value}`);
  }
}

function gradeSummary(expected, actual) {
  const missedFields = [];
  const hallucinatedFields = [];
  const incorrectUpdates = [];

  if (!actual) {
    return {
      score: 0,
      grade: 'F',
      missedFields: ['summary'],
      hallucinatedFields,
      incorrectUpdates,
      pass: false,
    };
  }

  for (const fieldPath of scalarPaths) {
    const expectedValue = valueAt(expected, fieldPath);
    const actualValue = valueAt(actual, fieldPath);

    if (Object.is(expectedValue, actualValue)) continue;
    if (expectedValue === null && actualValue !== null) {
      hallucinatedFields.push(`${fieldPath}:${JSON.stringify(actualValue)}`);
    } else if (expectedValue !== null && actualValue === null) {
      missedFields.push(fieldPath);
    } else {
      incorrectUpdates.push(
        `${fieldPath}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actualValue)}`,
      );
    }
  }

  compareSetField({
    path: 'tripType',
    expected: expected.tripType,
    actual: actual.tripType,
    missedFields,
    hallucinatedFields,
  });
  compareSetField({
    path: 'passengerData.childrenAges',
    expected: expected.passengerData.childrenAges,
    actual: actual.passengerData.childrenAges,
    missedFields,
    hallucinatedFields,
  });
  compareSetField({
    path: 'placesOfInterest.placeName',
    expected: expected.placesOfInterest.map((place) => place.placeName),
    actual: actual.placesOfInterest.map((place) => place.placeName),
    missedFields,
    hallucinatedFields,
  });

  if (Object.hasOwn(actual, 'pax')) hallucinatedFields.push('pax');
  if (Object.hasOwn(actual, 'upcomingEvents')) hallucinatedFields.push('upcomingEvents');

  const issueCount = missedFields.length + hallucinatedFields.length + incorrectUpdates.length;
  const checkCount = scalarPaths.length + 3;
  const score = Math.max(0, Math.round(((checkCount - Math.min(issueCount, checkCount)) / checkCount) * 100));

  return {
    score,
    grade: score === 100 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'F',
    missedFields,
    hallucinatedFields,
    incorrectUpdates,
    pass: issueCount === 0,
  };
}

function buildAgentInput(previousSummary, userMessage, agentResponse) {
  const oldSummaryContextToon = encode(previousSummary);
  return {
    oldSummaryContextToon,
    input: `Old Summary Context (TOON):
\`\`\`toon
${oldSummaryContextToon}
\`\`\`

Current User Message:
${userMessage}

Current Agent Response:
${agentResponse}`,
  };
}

async function runTurn({ journeyId, turn, previousSummary }) {
  const { oldSummaryContextToon, input } = buildAgentInput(
    previousSummary,
    turn.userMessage,
    turn.agentResponse,
  );
  const startedAt = Date.now();

  try {
    const result = await runner.run(SummaryExtractorAgent, input, {
      context: createSummaryAgentRunContext(evalClockOptions),
      maxTurns: 1,
    });
    const actualSummary = result.finalOutput?.summary || null;
    const grading = gradeSummary(turn.expectedSummary, actualSummary);

    return {
      journeyId,
      turn: turn.turn,
      previousSummary,
      oldSummaryContextToon,
      userMessage: turn.userMessage,
      agentResponse: turn.agentResponse,
      expectedSummary: turn.expectedSummary,
      actualSummary,
      missedFields: grading.missedFields,
      hallucinatedFields: grading.hallucinatedFields,
      incorrectUpdates: grading.incorrectUpdates,
      score: grading.score,
      grade: grading.grade,
      pass: grading.pass,
      latencyMs: Date.now() - startedAt,
      error: null,
    };
    } catch (error) {
    return {
      journeyId,
      turn: turn.turn,
      previousSummary,
      oldSummaryContextToon,
      userMessage: turn.userMessage,
      agentResponse: turn.agentResponse,
      expectedSummary: turn.expectedSummary,
      actualSummary: null,
      missedFields: ['summary'],
      hallucinatedFields: [],
      incorrectUpdates: [],
      score: 0,
      grade: 'F',
      pass: false,
      latencyMs: Date.now() - startedAt,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function main() {
  const journeyReports = [];
  let totalTurns = 0;
  let passedTurns = 0;
  let scoreTotal = 0;

  for (const journey of selectedJourneys) {
    let previousSummary = structuredClone(journey.initialSummary);
    const turns = [];

    for (const [index, turn] of journey.turns.entries()) {
      const report = await runTurn({
        journeyId: journey.journeyId,
        turn: { ...turn, turn: index + 1 },
        previousSummary,
      });
      turns.push(report);
      totalTurns += 1;
      scoreTotal += report.score;
      if (report.pass) passedTurns += 1;
      if (report.actualSummary) previousSummary = report.actualSummary;

      process.stdout.write(
        `${journey.journeyId} turn ${index + 1}: ${report.pass ? 'PASS' : 'FAIL'} (${report.score})\n`,
      );
    }

    journeyReports.push({
      journeyId: journey.journeyId,
      category: journey.category,
      initialSummary: journey.initialSummary,
      turns,
      pass: turns.every((turn) => turn.pass),
    });
  }

  const failedTurns = totalTurns - passedTurns;
  const report = {
    generatedAt: new Date().toISOString(),
    model: summaryAgentConfig.model,
    agent: 'Summary Extractor Agent only',
    tools: [],
    webSearchUsed: false,
    oldSummaryInputFormat: 'TOON 4.1.1',
    currentDateReference: evalClock,
    gradingMethod:
      'Deterministic scalar comparison plus order-insensitive tripType, child-age, and place-name comparison. Place descriptions are schema-validated but not exact-text graded.',
    summary: {
      journeys: journeyReports.length,
      totalTurns,
      passedTurns,
      failedTurns,
      passRate: Number(((passedTurns / totalTurns) * 100).toFixed(2)),
      averageScore: Number((scoreTotal / totalTurns).toFixed(2)),
      overallPass: failedTurns === 0,
    },
    journeys: journeyReports,
  };

  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`Report: ${resultPath}\n`);
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);

  if (!report.summary.overallPass) process.exitCode = 1;
}

await main();
