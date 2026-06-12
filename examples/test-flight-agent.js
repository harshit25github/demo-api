import { runFlightAgent } from '../src/flight-agent/index.js';

const input =
  process.argv.slice(2).join(' ') ||
  'Find flights from Delhi to Dubai tomorrow.';

const result = await runFlightAgent({
  input,
  requestId: `req_${Date.now()}`,
  sessionId: 'example-session',
});

console.log('\nFinal output:');
console.log(result.output);
