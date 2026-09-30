import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSummaryAgentInstructions,
  createSummaryAgentRunContext,
} from '../../src/agents/summary/agent.js';
import { SUMMARY_AGENT_PROMPT } from '../../src/agents/summary/prompt.js';
import {
  SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE,
  summaryAgentInputSchema,
  summaryAgentOutputSchema,
} from '../../src/agents/summary/schema.js';

test('input schema accepts only the three Summary Agent inputs', () => {
  const input = summaryAgentInputSchema.parse({
    oldSummaryContext: 'origin:\n  city: New York\n  iata: JFK',
    currentUserMessage: 'Make it 3 people',
    currentAgentResponse: 'Updated for 3 travelers.',
  });

  assert.deepEqual(Object.keys(input), [
    'oldSummaryContext',
    'currentUserMessage',
    'currentAgentResponse',
  ]);
  assert.match(input.oldSummaryContext, /origin:/);
  assert.throws(() =>
    summaryAgentInputSchema.parse({
      ...input,
      webSearchResults: [],
    }),
  );
});

test('canonical example satisfies the strict Summary Agent output schema', () => {
  assert.doesNotThrow(() =>
    summaryAgentOutputSchema.parse(SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE),
  );
  assert.equal('pax' in SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE.summary, false);
  assert.equal('upcomingEvents' in SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE.summary, false);
});

test('schema accepts total-only passenger data without inventing a breakdown', () => {
  const candidate = structuredClone(SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE);
  candidate.summary.passengerData = {
    total: 3,
    adults: null,
    seniors: null,
    children: null,
    lapInfants: null,
    seatInfants: null,
    childrenAges: [],
  };

  const output = summaryAgentOutputSchema.parse(candidate);
  assert.equal(output.summary.passengerData.total, 3);
  assert.equal(output.summary.passengerData.adults, null);
});

test('strict schema rejects legacy pax and upcomingEvents output fields', () => {
  const withPax: any = structuredClone(SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE);
  withPax.summary.pax = 2;
  assert.throws(() => summaryAgentOutputSchema.parse(withPax));

  const withEvents: any = structuredClone(SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE);
  withEvents.summary.upcomingEvents = [];
  assert.throws(() => summaryAgentOutputSchema.parse(withEvents));
});

test('schema rejects an inconsistent confirmed passenger breakdown', () => {
  const candidate = structuredClone(SUMMARY_AGENT_OUTPUT_FORMAT_EXAMPLE);
  candidate.summary.passengerData.total = 3;
  assert.throws(() => summaryAgentOutputSchema.parse(candidate));
});

test('prompt defines complete merge behavior without web or post-processing', () => {
  assert.match(
    SUMMARY_AGENT_PROMPT,
    /Start from Old Context and preserve every supported valid value/,
  );
  assert.match(SUMMARY_AGENT_PROMPT, /unselected recommendations are not updates/);
  assert.match(SUMMARY_AGENT_PROMPT, /Never assume all travelers are adults/);
  assert.match(SUMMARY_AGENT_PROMPT, /Capture every explicitly stated/);
  assert.match(SUMMARY_AGENT_PROMPT, /With my two kids.*total=3, adults=1, children=2/);
  assert.match(SUMMARY_AGENT_PROMPT, /International is an explicitly stated journey characteristic/);
  assert.match(SUMMARY_AGENT_PROMPT, /Me and my wife.*total=2 and adults=2/);
  assert.match(SUMMARY_AGENT_PROMPT, /Family of N.*confirms total=N/);
  assert.match(SUMMARY_AGENT_PROMPT, /does not identify lapInfants versus seatInfants/);
  assert.match(SUMMARY_AGENT_PROMPT, /set seatInfants=1 and lapInfants=0/);
  assert.match(SUMMARY_AGENT_PROMPT, /Tentative passengers do not update context/);
  assert.match(SUMMARY_AGENT_PROMPT, /clear old zero counts to null/);
  assert.match(SUMMARY_AGENT_PROMPT, /remove an old couple party-style value/);
  assert.match(SUMMARY_AGENT_PROMPT, /numeric passenger breakdown alone does not confirm family/);
  assert.match(SUMMARY_AGENT_PROMPT, /do not add roundtrip because no round-trip flight was confirmed/);
  assert.match(SUMMARY_AGENT_PROMPT, /the first Monday after outbound/);
  assert.match(SUMMARY_AGENT_PROMPT, /tripType must contain solo, anime, and food/);
  assert.match(SUMMARY_AGENT_PROMPT, /solo does not establish age category/);
  assert.match(SUMMARY_AGENT_PROMPT, /add Piazza Navona to placesOfInterest/);
  assert.match(SUMMARY_AGENT_PROMPT, /confirmation of one-way or round-trip results/);
  assert.match(SUMMARY_AGENT_PROMPT, /remove the incompatible solo tripType/);
  assert.match(SUMMARY_AGENT_PROMPT, /Prices shown are per person/);
  assert.match(SUMMARY_AGENT_PROMPT, /exactly oneway or roundtrip/);
  assert.match(SUMMARY_AGENT_PROMPT, /only an outbound date does not confirm oneway/);
  assert.match(SUMMARY_AGENT_PROMPT, /An agent question never confirms/);
  assert.match(SUMMARY_AGENT_PROMPT, /declarative confirmation and a follow-up question/);
  assert.match(SUMMARY_AGENT_PROMPT, /final question leaves only the date unresolved/);
  assert.match(SUMMARY_AGENT_PROMPT, /Do not derive a city name from an IATA code/);
  assert.match(SUMMARY_AGENT_PROMPT, /does not clear duration_days/);
  assert.match(SUMMARY_AGENT_PROMPT, /Do not derive duration_days from outbound and return dates alone/);
  assert.match(SUMMARY_AGENT_PROMPT, /Oct 3-8, five-day plan/);
  assert.match(SUMMARY_AGENT_PROMPT, /first week of <month>.*day 1 through day 7/);
  assert.match(SUMMARY_AGENT_PROMPT, /first <weekday> next month.*first actual occurrence/);
  assert.match(SUMMARY_AGENT_PROMPT, /September 1, 2026 is Tuesday/);
  assert.match(SUMMARY_AGENT_PROMPT, /second weekend of <month>.*second Saturday/);
  assert.match(SUMMARY_AGENT_PROMPT, /verify that outbound_date is actually Saturday/);
  assert.match(SUMMARY_AGENT_PROMPT, /November 2026 Saturdays are Nov 7, 14, 21, and 28/);
  assert.match(SUMMARY_AGENT_PROMPT, /end of next month.*final calendar day/);
  assert.match(SUMMARY_AGENT_PROMPT, /Fuzzy mid-month waits for concrete confirmation/);
  assert.match(SUMMARY_AGENT_PROMPT, /Multi-turn complete date-range replacement/);
  assert.match(SUMMARY_AGENT_PROMPT, /Do not store tentative budget proposals/);
  assert.match(SUMMARY_AGENT_PROMPT, /Do not independently convert unresolved phrases/);
  assert.match(
    SUMMARY_AGENT_PROMPT,
    /Do not ask questions, explain your work, browse the web, call tools/,
  );
  assert.doesNotMatch(SUMMARY_AGENT_PROMPT, /MUST fetch events using web_search/);
  assert.doesNotMatch(SUMMARY_AGENT_PROMPT, /STEP-BY-STEP REASONING PROCESS/);
});

test('dynamic instructions include the request clock without changing output schema', () => {
  const context = createSummaryAgentRunContext({
    now: new Date('2026-08-23T10:00:00.000Z'),
    timeZone: 'Asia/Kolkata',
  });
  const instructions = buildSummaryAgentInstructions({ context });

  assert.match(instructions, /localDate: 2026-08-23/);
  assert.match(instructions, /localDateTime: 2026-08-23T15:30:00\+05:30/);
  assert.match(instructions, /timeZone: Asia\/Calcutta|timeZone: Asia\/Kolkata/);
  assert.match(instructions, /following Monday-Sunday calendar week/);
});
