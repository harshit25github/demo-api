/** End-to-end check of the refactored Manager through the production stream path. */
import 'dotenv/config';

const { runGatewayAgentTextStream } = await import('../src/agents/manager-orchestrator/streaming.js');

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
  const run = runGatewayAgentTextStream({
    input: testCase.input,
    sessionId: `e2e-${testCase.id}`,
    now: new Date('2026-09-29T10:00:00Z'),
    timeZone: 'Asia/Kolkata',
  });

  let streamed = '';
  for await (const chunk of run.stream) streamed += String(chunk);
  const done: any = await run.completed;

  const flightCount = countFlightResults(done.context.flight?.searchResults);
  console.log(`   traceId ${done.traceId ?? '(n/a)'} | ${done.latencyMs}ms | specialists ${JSON.stringify(done.specialistsUsed)}`);
  console.log(`   renderFlightOptions=${done.renderFlightOptions} | results=${flightCount}`);
  console.log(`   output: ${done.output.replace(/\s+/g, ' ').slice(0, 220)}...`);

  check('streamed text equals completed.output', streamed === done.output);
  check('finalAgentName is Manager Agent', done.finalAgentName === 'Manager Agent');
  check('no unresolved render marker', !/\[\[render:/.test(done.output));
  check('no SDK tool-error sentinel', !/An error occurred while running the tool/.test(done.output));
  check('no internal wording', !/\bspecialist|tool call|flight_agent|trip_planner_agent\b/i.test(done.output));

  if (testCase.id === 'flight' || testCase.id === 'mixed') {
    check('flight results in shared context', flightCount > 0, `${flightCount}`);
    check('renderFlightOptions true for the UI', done.renderFlightOptions === true);
    const notes = done.output.match(/Note: Prices shown are per person\./g)?.length ?? 0;
    check('per-person note appears exactly once', notes === 1, `${notes}`);
  }
  if (testCase.id === 'mixed') {
    check('trip planner ran', done.specialistsUsed.includes('trip_planner_agent'));
    const day1 = done.output.match(/Day 1/gi)?.length ?? 0;
    check('itinerary rendered once, not duplicated', day1 <= 1, `Day 1 x${day1}`);
  }
  if (testCase.id === 'declined') {
    check('no specialist called', done.specialistsUsed.length === 0, JSON.stringify(done.specialistsUsed));
    const fabricated = /\b\d{1,3}\s?(?:kg|lbs?)\b|[$€£₹]\s?\d|\b\d{1,3}\s?%|\b24[- ]hour\b/i.test(done.output);
    check('no fabricated policy figures', !fabricated);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
