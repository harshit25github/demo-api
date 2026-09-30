import { runTripPlannerAgent } from '../src/index.js';
import { clearTripPlannerSession } from '../src/agents/trip-planner/runner.js';

const fullSummaryContext = {
  pax: 2,
  budget: {
    total: 2400,
    amount: 2400,
    currency: 'USD',
    per_person: false,
  },
  origin: { city: 'Delhi', iata: 'DEL' },
  destination: { city: 'Paris', iata: 'PAR' },
  tripType: ['roundtrip', 'couple', 'balanced', 'cultural', 'food'],
  outbound_date: '2026-09-10',
  return_date: '2026-09-14',
  duration_days: 5,
  upcomingEvents: [],
  placesOfInterest: [
    { placeName: 'Louvre Museum', description: 'Major art museum in central Paris' },
  ],
  suggestedQuestions: [],
};

const scenarios = [
  {
    id: 'full-context-plan',
    input: 'Plan my trip',
    summaryContext: fullSummaryContext,
  },
  {
    id: 'destination-only-plan',
    input: 'Plan my trip and keep it relaxed',
    summaryContext: {
      destination: { city: 'Tokyo', iata: 'TYO' },
    },
  },
  {
    id: 'destination-change-carry-forward',
    input: 'Change destination to Rome and keep the rest the same',
    summaryContext: fullSummaryContext,
  },
];

const customInput = process.argv.slice(2).join(' ').trim();
const casesToRun = customInput
  ? [{ id: 'custom', input: customInput, summaryContext: {} }]
  : scenarios;

for (const scenario of casesToRun) {
  const sessionId = `trip-planner-example-${scenario.id}`;
  await clearTripPlannerSession(sessionId);

  const result = await runTripPlannerAgent({
    input: scenario.input,
    summaryContext: scenario.summaryContext,
    requestId: `req-${scenario.id}-${Date.now()}`,
    sessionId,
  });

  console.log(`\n=== ${scenario.id} ===`);
  console.log(
    JSON.stringify(
      {
        model: result.model,
        input: scenario.input,
        inputSummaryContext: result.debug.inputSummaryContext,
        inferredContextPatch: result.debug.inferredContextPatch,
        toolsCalled: result.debug.toolsCalled.map((entry) => entry.tool),
        suggestedQuestions: result.debug.suggestedQuestions,
        finalResponse: result.output,
        error: Boolean(result.error),
      },
      null,
      2,
    ),
  );
}
