/** End-to-end check of the refactored Manager through the production stream path. */
import 'dotenv/config';

const { runGatewayAgent } = await import('../src/agents/manager-orchestrator/runner.js');
const { ManagerAgent } = await import('../src/agents/manager-orchestrator/agent.js');
const { FlightManagerAgent } = await import('../src/agents/flight/agent.js');
const { TripPlannerAgent } = await import('../src/agents/trip-planner/agent.js');

// Live-test policy only, in this script process; leave production config intact.
for (const agent of [ManagerAgent, FlightManagerAgent, TripPlannerAgent]) {
  agent.model = 'gpt-5.2';
  agent.modelSettings = { ...agent.modelSettings, reasoning: { effort: 'low' } };
}

function countFlightResults(results: unknown): number {
  if (Array.isArray(results)) return results.length;
  if (!results || typeof results !== 'object') return 0;
  let count = 0;
  for (const key of ['flights', 'contracts', 'results', 'data']) {
    const records = (results as Record<string, unknown>)[key];
    if (Array.isArray(records)) count = Math.max(count, records.length);
  }
  return count;
}

/** Inspect SDK evidence locally; production does not track specialist usage. */
function specialistCalls(result: any): string[] {
  return (result?.newItems || [])
    .filter((item: any) => item?.type === 'tool_call_item')
    .map((item: any) => String(item.rawItem?.name || ''))
    .filter((name: string) => ['flight_agent', 'trip_planner_agent'].includes(name));
}

const cases = [
  { id: 'flight', input: 'Find flights from Delhi to Dubai on 20 October 2026' },
  { id: 'mixed', input: 'Find flights from Delhi to Dubai on 20 October 2026 and plan 3 days there' },
  { id: 'declined', input: 'What is the CheapOair cancellation policy?' },
];

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

for (const testCase of cases) {
  console.log(`\n=== [${testCase.id}] ${testCase.input}`);
  const done: any = await runGatewayAgent({
    input: testCase.input,
    sessionId: `e2e-${testCase.id}`,
    now: new Date('2026-09-29T10:00:00Z'),
    timeZone: 'Asia/Kolkata',
  });


  const flightCount = countFlightResults(done.context.flight?.searchResults);
  const calledSpecialists = specialistCalls(done.result);
  console.log(`   traceId ${done.traceId ?? '(n/a)'} | ${done.latencyMs}ms | specialists ${JSON.stringify(calledSpecialists)}`);
  console.log(`   showFlight=${done.context.flight?.showFlight} | results=${flightCount}`);
  console.log(`   output: ${done.output.replace(/\s+/g, ' ').slice(0, 220)}...`);

  check('finalAgentName is Manager Agent', done.finalAgentName === 'Manager Agent');
  check('no unresolved render marker', !/\[\[render:/.test(done.output));
  check('no SDK tool-error sentinel', !/An error occurred while running the tool/.test(done.output));
  check('no internal wording', !/\bspecialist|tool call|flight_agent|trip_planner_agent\b/i.test(done.output));

  if (testCase.id === 'flight' || testCase.id === 'mixed') {
    check('flight results in shared context', flightCount > 0, `${flightCount}`);
    check('shared context enables flight cards', done.context.flight?.showFlight === true);
    const notes = done.output.match(/Note: Prices shown are per person\./g)?.length ?? 0;
    check('per-person note appears exactly once', notes === 1, `${notes}`);
  }
  if (testCase.id === 'mixed') {
    check('trip planner ran', calledSpecialists.includes('trip_planner_agent'));
    const day1 = done.output.match(/Day 1/gi)?.length ?? 0;
    check('itinerary rendered once, not duplicated', day1 <= 1, `Day 1 x${day1}`);
  }
  if (testCase.id === 'declined') {
    check('no specialist called', calledSpecialists.length === 0, JSON.stringify(calledSpecialists));
    const fabricated = /\b\d{1,3}\s?(?:kg|lbs?)\b|[$€£₹]\s?\d|\b\d{1,3}\s?%|\b24[- ]hour\b/i.test(done.output);
    check('no fabricated policy figures', !fabricated);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
