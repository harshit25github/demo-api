import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
  UpdateFlightSuggestedQuestionsTool as UpdateFlightSuggestedQuestionsToolDefinition,
  updateFlightSuggestedQuestions,
} from '../../src/agents/flight/tools/suggested-questions-tool.js';
import { FlightSearchTool as FlightSearchToolDefinition } from '../../src/agents/flight/tools/search-tool.js';
import { flightTools } from '../../src/agents/flight/tools/index.js';

const UpdateFlightSuggestedQuestionsTool: any = UpdateFlightSuggestedQuestionsToolDefinition;
const FlightSearchTool: any = FlightSearchToolDefinition;

function parseToolResult(result): any {
  return typeof result === 'string' ? JSON.parse(result) : result;
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

  const output = parseToolResult(
    await UpdateFlightSuggestedQuestionsTool.invoke(
      { context },
      JSON.stringify({ suggestedQuestions }),
      {},
    ),
  );

  assert.deepEqual(output, {
    ok: true,
    suggestedQuestions,
  });
  assert.deepEqual(context.flight.suggestedQuestions, suggestedQuestions);
  assert.deepEqual(context.toolCallLog.at(-1), {
    tool: UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
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
  await FlightSearchTool.invoke(
    { context },
    JSON.stringify({
      onds: [
        {
          origin: 'DEL',
          destination: 'BOM',
          outbound_date: '2026-08-20',
          return_date: null,
        },
      ],
      trip_type: 'oneway',
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin_class: 'economy',
    }),
    {},
  );

  const suggestedQuestions = [
    'Show cheaper flights',
    'Apply non-stop filter',
    'Compare current options',
  ];
  const output = parseToolResult(
    await UpdateFlightSuggestedQuestionsTool.invoke(
      { context },
      JSON.stringify({ suggestedQuestions }),
      {},
    ),
  );

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
  const suggestedQuestions = [
    'Show cheaper flights',
    'Apply non-stop filter',
    'Compare current options',
  ];

  const output = parseToolResult(
    await UpdateFlightSuggestedQuestionsTool.invoke(
      { context },
      JSON.stringify({ suggestedQuestions }),
      {},
    ),
  );

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
