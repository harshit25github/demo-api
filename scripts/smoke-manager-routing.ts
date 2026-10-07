/**
 * Minimal LIVE routing smoke test for the Manager.
 *
 * Two real turns — one Flight, one Trip — to confirm the production path routes,
 * composes and cleans up end to end. Deliberately the smallest check that still
 * exercises both specialists, because it makes billable API calls.
 *
 *   npm run smoke:manager
 */
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

/** Inspect SDK evidence locally; production does not track specialist usage. */
function specialistCalls(result: any): string[] {
  return (result?.newItems || [])
    .filter((item: any) => item?.type === 'tool_call_item')
    .map((item: any) => String(item.rawItem?.name || ''))
    .filter((name: string) => ['flight_agent', 'trip_planner_agent'].includes(name));
}

const cases = [
  {
    id: 'flight',
    input: 'Find flights from Delhi to Dubai on 20 October 2026',
    expectSpecialist: 'flight_agent',
  },
  {
    id: 'trip',
    input: 'Plan 3 days of things to do in Dubai',
    expectSpecialist: 'trip_planner_agent',
  },
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
    sessionId: `smoke-${testCase.id}`,
    now: new Date('2026-09-29T10:00:00Z'),
    timeZone: 'Asia/Kolkata',
  });

  const calledSpecialists = specialistCalls(done.result);
  console.log(`   traceId ${done.traceId} | ${done.latencyMs}ms | specialists ${JSON.stringify(calledSpecialists)}`);
  console.log(`   showFlight=${done.context.flight?.showFlight}`);
  console.log(`   output: ${String(done.output).replace(/\s+/g, ' ').slice(0, 240)}...`);

  check('produced an answer', String(done.output).trim().length > 0);
  check(`routed to ${testCase.expectSpecialist}`,
    calledSpecialists.includes(testCase.expectSpecialist),
    JSON.stringify(calledSpecialists));
  check('no unresolved render marker', !/\[\[render:/.test(done.output));
  check('no SDK tool-error sentinel', !/An error occurred while running the tool/.test(done.output));
  check('no generic failure line', !/couldn.{0,3}t finish that part of your request/.test(done.output));
  check('no internal wording',
    !/\bspecialist|tool call|flight_agent|trip_planner_agent\b/i.test(done.output));
  const notes = String(done.output).match(/Note: Prices shown are per person\./g)?.length ?? 0;
  check('per-person note never duplicated', notes <= 1, `${notes}`);
}

console.log(`\n${failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
