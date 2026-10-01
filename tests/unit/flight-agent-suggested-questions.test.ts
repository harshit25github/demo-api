import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
  UpdateFlightSuggestedQuestionsTool as UpdateFlightSuggestedQuestionsToolDefinition,
  beginFlightSuggestionTurn,
  finalizeFlightSuggestedQuestions,
  findSuggestedQuestionIssues,
  markFlightSuggestionRun,
  previousFlightSuggestions,
  updateFlightSuggestedQuestions,
} from '../../src/agents/flight/tools/suggested-questions-tool.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import { flightTools } from '../../src/agents/flight/tools/index.js';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import { FLIGHT_MANAGER_INSTRUCTIONS } from '../../src/agents/flight/manager-output.js';

process.env.OPENAI_API_KEY ||= 'test-key';

const UpdateFlightSuggestedQuestionsTool: any = UpdateFlightSuggestedQuestionsToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;

const FRESH = ['Show nonstop flights only', 'Which option is fastest?', 'Any cheaper dates nearby?'];
const SEARCH_PAYLOAD = {
  onds: [{ origin: 'DEL', destination: 'BOM', outbound_date: '2026-08-20', return_date: null }],
  trip_type: 'oneway',
  passengers: { adults: 1, children: 0, infants: 0 },
  cabin_class: 'economy',
};

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function activeSearchContext(requestId: string, suggestedQuestions: string[] = []): any {
  return {
    requestId,
    flight: { uid: `${requestId}-user`, searchKey: `${requestId}-search`, suggestedQuestions },
    toolCallLog: [],
  };
}

async function callTool(context: any, suggestedQuestions: string[]) {
  return parseToolResult(await UpdateFlightSuggestedQuestionsTool.invoke(
    { context },
    JSON.stringify({ suggestedQuestions }),
    {},
  ));
}

test('suggested questions tool is registered with Flight Agent tools', () => {
  assert.equal(
    UpdateFlightSuggestedQuestionsTool.name,
    UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
  );
  assert.ok(
    flightTools.some(
      (registeredTool) =>
        registeredTool.name === UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
    ),
  );
});

test('helper stores provided suggested questions exactly', () => {
  const context: any = {
    flight: {
      searchKey: 'search-helper-123',
      suggestedQuestions: ['Old stale suggestion'],
    },
  };
  const suggestedQuestions = [
    'Show cheaper flights',
    'Apply non-stop filter',
    'Compare current options',
  ];

  const output = updateFlightSuggestedQuestions({
    currentFlightContext: context,
    suggestedQuestions,
  });

  assert.deepEqual(output, {
    ok: true,
    suggestedQuestions,
  });
  assert.deepEqual(context.flight.suggestedQuestions, suggestedQuestions);
});

test('tool stores provided suggested questions exactly and logs the call', async () => {
  const context: any = {
    flight: { uid: 'suggestion-user', searchKey: 'search-123' },
    toolCallLog: [],
  };
  const suggestedQuestions = [
    'Show flights with checked baggage',
    'Which flight is best?',
    'Show fare differences',
  ];

  const output = await callTool(context, suggestedQuestions);

  assert.deepEqual(output, {
    ok: true,
    suggestedQuestions,
  });
  assert.deepEqual(context.flight.suggestedQuestions, suggestedQuestions);
  assert.deepEqual(context.toolCallLog.at(-1), {
    tool: UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
    requestId: null,
    searchKey: 'search-123',
    input: { suggestedQuestions },
    suggestedQuestions,
    ok: true,
    code: null,
  });
});

test('tool is disabled after one successful update in the same request', async () => {
  const context: any = {
    requestId: 'suggestions-turn-1',
    flight: { searchKey: 'search-once-per-turn' },
    toolCallLog: [],
  };
  const runContext = { context };
  const suggestedQuestions = [
    'Show cheaper flights',
    'Apply non-stop filter',
    'Compare current options',
  ];

  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), true);
  await UpdateFlightSuggestedQuestionsTool.invoke(
    runContext,
    JSON.stringify({ suggestedQuestions }),
    {},
  );
  assert.equal('suggestedQuestionsUpdatedRequestId' in context.flight, false);
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), false);

  context.requestId = 'suggestions-turn-2';
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), true);
});

test('flight search updates nested searchKey before suggestions are stored', async () => {
  const context: any = {
    flight: { uid: 'search-then-suggestions-user' },
    toolCallLog: [],
  };
  await FlightSearchTool.invoke({ context }, JSON.stringify(SEARCH_PAYLOAD), {});

  const suggestedQuestions = [
    'Show cheaper flights',
    'Apply non-stop filter',
    'Compare current options',
  ];
  const output = await callTool(context, suggestedQuestions);

  assert.match(context.flight.searchKey, /^search_search-then-suggestions-user_/);
  assert.deepEqual(output.suggestedQuestions, suggestedQuestions);
  assert.deepEqual(context.flight.suggestedQuestions, suggestedQuestions);
});

test('helper clears stale suggestions when latest context.flight.searchKey is missing', () => {
  const context: any = {
    searchKey: 'stale-root-search-key',
    flight: { suggestedQuestions: ['Old stale suggestion'] },
  };
  const suggestedQuestions = [
    'Compare current options',
    'Apply non-stop filter',
    'Which flight is best?',
  ];

  const output = updateFlightSuggestedQuestions({
    currentFlightContext: context,
    suggestedQuestions,
  });

  assert.equal(output.ok, true);
  assert.deepEqual(output.suggestedQuestions, []);
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('tool re-checks nested searchKey at execution time and clears stale suggestions', async () => {
  const context: any = {
    searchKey: 'stale-root-search-key',
    flight: {
      searchKey: null,
      suggestedQuestions: ['Old stale suggestion'],
    },
    toolCallLog: [],
  };

  const output = await callTool(context, FRESH);

  assert.deepEqual(output, { ok: true, suggestedQuestions: [] });
  assert.deepEqual(context.flight.suggestedQuestions, []);
  assert.equal(context.toolCallLog.at(-1).searchKey, null);
  assert.deepEqual(context.toolCallLog.at(-1).suggestedQuestions, []);
});

test('helper rejects invalid suggested question payloads without generating fallback questions', () => {
  const context: any = {
    flight: {
      searchKey: 'search-invalid-payload',
      suggestedQuestions: ['Keep existing'],
    },
  };

  const output = updateFlightSuggestedQuestions({
    currentFlightContext: context,
    suggestedQuestions: ['Only one'],
  });

  assert.equal(output.ok, false);
  assert.equal(output.code, 'INVALID_SUGGESTED_QUESTIONS');
  assert.deepEqual(context.flight.suggestedQuestions, ['Keep existing']);
});

test('a rejected draft can be corrected once, then the tool closes for the turn', async () => {
  const context = activeSearchContext('retry-turn');
  const runContext = { context };

  const first = await callTool(context, ['Only one suggestion']);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'INVALID_SUGGESTED_QUESTIONS');
  assert.equal(first.recovery.retrySafe, true);
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), true);

  const second = await callTool(context, []);
  assert.equal(second.ok, false);
  assert.equal(second.recovery.retrySafe, false);
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), false);
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('a corrected draft is stored after one rejection', async () => {
  const context = activeSearchContext('corrected-turn');

  assert.equal((await callTool(context, ['Would you like nonstop flights?', ...FRESH.slice(1)])).ok, false);
  const corrected = await callTool(context, FRESH);

  assert.equal(corrected.ok, true);
  assert.deepEqual(context.flight.suggestedQuestions, FRESH);
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled({ context }), false);
});

test('a search after the update reopens the tool for fresh suggestions', async () => {
  const context: any = { requestId: 'reopen-turn', flight: { uid: 'reopen-user' }, toolCallLog: [] };
  const runContext = { context };
  await FlightSearchTool.invoke({ context }, JSON.stringify(SEARCH_PAYLOAD), {});

  assert.equal((await callTool(context, FRESH)).ok, true);
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), false);

  await FlightSearchTool.invoke(
    { context },
    JSON.stringify({ ...SEARCH_PAYLOAD, cabin_class: 'business' }),
    {},
  );
  assert.equal(await UpdateFlightSuggestedQuestionsTool.isEnabled(runContext), true);
});

test('validator rejects assistant voice, route and date requests, internal names, overlong and duplicate suggestions', () => {
  const cases: Array<[string, RegExp]> = [
    ['Would you like nonstop flights?', /traveler/],
    ['Do you want to compare options?', /traveler/],
    ['Should I filter by airline?', /traveler/],
    ['Add a return date', /route or date field/],
    ['Suggest travel dates', /route or date field/],
    ['Change my destination to Goa', /route or date field/],
    ['Show flights from my origin', /route or date field/],
    ['Pick an arrival location', /route or date field/],
    ['Where should I fly from?', /route or date field/],
    ['Show me every nonstop and one-stop option departing in the morning under five hundred', /80 characters/],
  ];
  for (const [suggestion, problem] of cases) {
    const issues = findSuggestedQuestionIssues([suggestion, ...FRESH.slice(1)]);
    assert.ok(
      issues.some((issue) => issue.path === 'suggestedQuestions.0' && problem.test(issue.problem)),
      `expected "${suggestion}" to be rejected for ${problem}, got ${JSON.stringify(issues)}`,
    );
  }

  const duplicate = findSuggestedQuestionIssues([FRESH[0], `${FRESH[0].toLowerCase()}.`, FRESH[2]]);
  assert.ok(duplicate.some((issue) => /Duplicates/.test(issue.problem)));
});

test('validator accepts traveler-voice actions on the current search', () => {
  for (const set of [
    FRESH,
    ['Show only Emirates flights', 'Compare options 1 and 2', 'Switch to business class'],
    ['Remove the morning filter', 'Show all airlines again', 'Use nearby arrival airports'],
    ['Depart from Midway only', 'Make it a round trip', 'Add one more adult'],
  ]) {
    assert.deepEqual(findSuggestedQuestionIssues(set), [], JSON.stringify(set));
  }
});

test('the set shown before the turn cannot be resent, even reordered after a search cleared it', async () => {
  const context = activeSearchContext('anti-repeat-turn', [...FRESH]);
  beginFlightSuggestionTurn(context, { flightRan: true });
  context.flight.suggestedQuestions = [];

  const output = await callTool(context, [FRESH[2], FRESH[0], FRESH[1]]);

  assert.equal(output.ok, false);
  assert.ok(output.recovery.fieldIssues.some((issue: any) => /Identical/.test(issue.problem)));
  assert.deepEqual(previousFlightSuggestions(context), FRESH);
});

test('finalize keeps suggestions written this turn', async () => {
  const context = activeSearchContext('finalize-written', ['Old one', 'Old two', 'Old three']);
  beginFlightSuggestionTurn(context, { flightRan: true });
  await callTool(context, FRESH);

  const outcome = finalizeFlightSuggestedQuestions(context);

  assert.equal(outcome.written, true);
  assert.equal(outcome.cleared, false);
  assert.deepEqual(context.flight.suggestedQuestions, FRESH);
});

test('finalize clears suggestions from an earlier turn when Flight wrote none', () => {
  const context = activeSearchContext('finalize-skipped', [...FRESH]);
  beginFlightSuggestionTurn(context, { flightRan: true });

  const outcome = finalizeFlightSuggestedQuestions(context);

  assert.deepEqual(outcome, {
    flightRan: true, written: false, cleared: true, count: 0, calls: 0, rejected: 0,
  });
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('finalize leaves suggestions alone on a Manager turn Flight never ran', () => {
  const context = activeSearchContext('finalize-no-flight', [...FRESH]);
  beginFlightSuggestionTurn(context, { flightRan: false });

  assert.equal(finalizeFlightSuggestedQuestions(context).flightRan, false);
  assert.deepEqual(context.flight.suggestedQuestions, FRESH);

  beginFlightSuggestionTurn(context, { flightRan: false });
  markFlightSuggestionRun(context);
  assert.equal(finalizeFlightSuggestedQuestions(context).cleared, true);
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('finalize treats a search after the update as unwritten', async () => {
  const context: any = { requestId: 'finalize-search-after', flight: { uid: 'after-user' }, toolCallLog: [] };
  beginFlightSuggestionTurn(context, { flightRan: true });
  await FlightSearchTool.invoke({ context }, JSON.stringify(SEARCH_PAYLOAD), {});
  await callTool(context, FRESH);
  await FlightSearchTool.invoke(
    { context },
    JSON.stringify({ ...SEARCH_PAYLOAD, cabin_class: 'business' }),
    {},
  );

  assert.equal(finalizeFlightSuggestedQuestions(context).written, false);
  assert.deepEqual(context.flight.suggestedQuestions, []);
});

test('turn tracking survives another specialist trimming the shared tool log', async () => {
  const context = activeSearchContext('trimmed-log');
  context.toolCallLog = Array.from({ length: 25 }, (_value, index) => ({ tool: 'older', index }));
  beginFlightSuggestionTurn(context, { flightRan: true });
  await callTool(context, FRESH);
  // Trip Planner keeps only the newest entries; the turn's start marker is gone.
  context.toolCallLog = context.toolCallLog.slice(-1);

  assert.equal(finalizeFlightSuggestedQuestions(context).written, true);
  assert.deepEqual(context.flight.suggestedQuestions, FRESH);
});

test('the dynamic prompt shows the suggestions from the start of the turn', async () => {
  const { buildFlightAgentInstructions } = await import('../../src/agents/flight/agent.js');
  const context: any = {
    requestId: 'prompt-snapshot',
    flight: {
      searchKey: 'prompt-snapshot-search',
      suggestedQuestions: [...FRESH],
      clock: {
        localDate: '2026-08-03',
        localDateTime: '2026-08-03T10:00:00+05:30',
        timeZone: 'Asia/Calcutta',
      },
    },
    toolCallLog: [],
  };
  beginFlightSuggestionTurn(context, { flightRan: true });
  context.flight.suggestedQuestions = [];

  const dynamic = buildFlightAgentInstructions({ context }).slice(FLIGHT_PROMPT.length);

  assert.match(dynamic, /Previous suggested questions[^\n]*\n\nShow nonstop flights only\nWhich option is fastest\?\nAny cheaper dates nearby\?/);
  assert.match(dynamic, /a present search key counts even when not validated: pass three suggestions/);
  assert.match(dynamic, /End every turn with exactly one update_flight_suggested_questions call/);
  assert.doesNotMatch(dynamic, /Suggested questions are optional/);
});

test('prompt makes the update the required final step of every turn', () => {
  assert.match(FLIGHT_PROMPT, /required final step of every Flight turn/);
  assert.match(FLIGHT_PROMPT, /includes turns that only clarify, ask for missing details, answer from active source options, or take no action/);
  assert.match(FLIGHT_PROMPT, /stop core tool calls, make the required final update_flight_suggested_questions call, then return feedback/);
  assert.match(FLIGHT_PROMPT, /never let its failure discard or downgrade a completed result/);
  assert.match(FLIGHT_PROMPT, /Before your final output, check:.*update_flight_suggested_questions was this turn's last tool call/s);
  for (const phrase of [/optional, best-effort/i, /Optional suggestion enrichment/i, /over optional work/i, /final optional tool/i]) {
    assert.doesNotMatch(FLIGHT_PROMPT, phrase);
  }
});

test('prompt lists an approved chain ending in the update for every request class', () => {
  const chains = FLIGHT_PROMPT.match(/Approved chains, each ending with update_flight_suggested_questions:\n((?:- .*\n)+)/);
  assert.ok(chains, 'chain list missing');
  for (const requestClass of [
    /^- No core tool \(clarification, missing details, source-option answer, ambiguity, no action\): the update alone\.$/m,
    /^- New or changed search: flight_search\.$/m,
    /^- Search plus filters, including recovery from MISSING_SEARCH: flight_search, then apply_filter\.$/m,
    /^- Filter addition, removal, replacement, or reset: apply_filter\.$/m,
    /^- Option facts, comparisons, rankings, or recommendations: getGeneratedContractsContext read\.$/m,
    /^- Explicit display .*: getGeneratedContractsContext select or show_all\.$/m,
    /^- Price or date advice only: price_prediction_tool\.$/m,
    /^- Price or date advice plus requested results: price_prediction_tool, then flight_search/m,
    /^- Price advice about a current option: getGeneratedContractsContext read, then price_prediction_tool\.$/m,
  ]) {
    assert.match(chains[1], requestClass);
  }
  // Production's resolver chains do not apply: the tool is not registered.
  assert.doesNotMatch(FLIGHT_PROMPT, /resolve_flight_date/);
});

test('prompt carries the production content rules for suggestions', () => {
  for (const rule of [
    /"You might ask"/,
    /In the traveler's voice, 3-8 words and under 80 characters/,
    /Never assistant wording such as "Would you like", "Do you want", or "Should I"/,
    /Never a request to supply, choose, or change the departure location, arrival location, travel date, return date, or date range/,
    /"Add a return date", "Pick an arrival location", "Suggest travel dates", or "Where should I fly from\?"/,
    /Never use the words origin or destination/,
    /not a filter that is already active\. Active filters are the earlier applied filters in Current search state, replaced by the complete filters list of any apply_filter call this turn/,
    /never send the same three again, change the intent rather than the wording, and repeat at most one when the trip and results are unchanged/,
    /airlines and airports only from Active filter source options/,
    /Never mention the tool, its result, or the suggestions in your response or feedback/,
    /If a search key exists at that point .* pass exactly three suggestions, including on clarification and no-action turns\. Otherwise pass an empty array and never invent fallback suggestions/,
  ]) {
    assert.match(FLIGHT_PROMPT, rule);
  }
});

test('Manager instructions put the update before the structured feedback', () => {
  assert.match(FLIGHT_MANAGER_INSTRUCTIONS, /make the required final update_flight_suggested_questions call, and only then produce structured feedback/);
  assert.match(FLIGHT_MANAGER_INSTRUCTIONS, /A failed suggestions update never changes the status of the core task/);
  assert.match(FLIGHT_MANAGER_INSTRUCTIONS, /flight-card arrays, or the suggested questions/);
  assert.doesNotMatch(FLIGHT_MANAGER_INSTRUCTIONS, /Optional suggested-question work/);
});

test('the tool description names it the required final step', () => {
  assert.match(UpdateFlightSuggestedQuestionsTool.description, /^Required final step of every Flight turn\./);
  assert.match(UpdateFlightSuggestedQuestionsTool.description, /call no tool after it succeeds/);
  assert.doesNotMatch(UpdateFlightSuggestedQuestionsTool.description, /best-effort/i);
});
