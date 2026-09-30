import assert from 'node:assert/strict';
import test from 'node:test';
import { SUMMARY_AGENT_PROMPT } from '../../src/agents/summary/prompt.js';
import { SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE } from '../../src/agents/summary/schema.js';

test('summary extractor prompt is source-bound and not conversational', () => {
  const summaryPrompt = SUMMARY_AGENT_PROMPT;

  assert.match(summaryPrompt, /deterministic travel-context extractor/);
  assert.match(summaryPrompt, /Flight Agent and Trip Planner conversations/);
  assert.match(summaryPrompt, /Do not ask questions, explain your work, browse the web, call tools/);
  assert.match(summaryPrompt, /passengerData\.total is the only total traveler field/);
  assert.match(summaryPrompt, /Never assume all travelers are adults/);
  assert.match(summaryPrompt, /Do not independently convert unresolved phrases/);
  assert.match(summaryPrompt, /only an outbound date does not confirm oneway/);
  assert.match(summaryPrompt, /Do not infer tripType from destination stereotypes/);
  assert.doesNotMatch(summaryPrompt, /"pax":/);
  assert.doesNotMatch(summaryPrompt, /"upcomingEvents":/);
  assert.doesNotMatch(summaryPrompt, /fall back to internal travel knowledge/);
  assert.doesNotMatch(summaryPrompt, /MUST fetch events using web_search/);
  assert.doesNotMatch(summaryPrompt, /STEP-BY-STEP REASONING PROCESS/);

  assert.equal('pax' in SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE.summary, false);
  assert.equal(
    'upcomingEvents' in SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE.summary,
    false,
  );
  assert.equal(
    SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE.summary.passengerData.total,
    2,
  );
});
