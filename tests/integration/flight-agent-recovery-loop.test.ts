import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, Runner } from '@openai/agents';
import { OpenAIProvider } from '@openai/agents-openai';
import { ensureFlightRuntimeContext } from '../../src/agents/flight/context/flight-context.js';
import { buildFlightCoreSuccessFallback } from '../../src/agents/flight/context/recovery-outcome.js';
import { FLIGHT_PROMPT } from '../../src/agents/flight/prompt.js';
import {
  buildManagerInstructions,
  MANAGER_PROMPT,
} from '../../src/agents/manager-orchestrator/manager-prompt.js';
import { FLIGHT_MANAGER_INSTRUCTIONS } from '../../src/agents/flight/manager-output.js';
import { flightAgentConfig } from '../../src/agents/flight/config.js';
import { FlightSearchTool } from '../../src/agents/flight/tools/search-tool.js';
import { ApplyFilterTool } from '../../src/agents/flight/tools/filter/tool.js';
import { GetGeneratedContractsContextTool } from '../../src/agents/flight/tools/contracts-tool.js';
import { PricePredictionTool } from '../../src/agents/flight/tools/price-prediction/tool.js';
import { UpdateFlightSuggestedQuestionsTool } from '../../src/agents/flight/tools/suggested-questions-tool.js';
import { createFlightToolSchemaErrorFunction } from '../../src/agents/flight/tools/recovery.js';
import { createRequestContext } from '../../src/shared/runtime/request-context.js';
import { createRequestClock } from '../../src/shared/time/request-clock.js';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const NOW = new Date('2026-09-16T10:00:00.000Z');

function searchPayload(outboundDate: string) {
  return {
    onds: [{
      origin: 'DEL',
      destination: 'DXB',
      outbound_date: outboundDate,
      return_date: null,
    }],
    trip_type: 'oneway',
    passengers: { adults: 1, children: 0, infants: 0 },
    cabin_class: 'economy',
  };
}

function nonstopFilterPayload() {
  return { filters: [{
    filterType: 'stops',
    filterCode: '0',
    minDurationMinutes: null,
    maxDurationMinutes: null,
    minPrice: null,
    maxPrice: null,
    airlineNames: null,
    layoverAirportNames: null,
    departureAirportNames: null,
    arrivalAirportNames: null,
    rawUserFilter: 'non-stop',
  }] };
}

function functionCall(id: string, name: string, args: unknown) {
  return {
    type: 'function_call',
    id: `item_${id}`,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  };
}

function message(id: string, text: string) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function scriptedClient(outputs: any[][]) {
  const requests: any[] = [];
  let responseNumber = 0;
  return {
    requests,
    client: {
      responses: {
        create: async (body: any) => {
          requests.push(structuredClone(body));
          const output = outputs.shift();
          assert.ok(output, 'unexpected model request');
          return {
            id: `response_${++responseNumber}`,
            object: 'response',
            status: 'completed',
            model: body.model,
            output,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          };
        },
      },
    },
  };
}

function recoveryContext() {
  const context = ensureFlightRuntimeContext({
    requestId: 'recovery-turn',
    sessionId: 'recovery-session',
    flight: { uid: 'recovery-user' },
    toolCallLog: [],
  });
  return {
    context,
    requestContext: createRequestContext(
      context,
      createRequestClock({ now: NOW, timeZone: 'Asia/Kolkata' }),
    ),
  };
}

async function runScripted(
  tools: any[],
  outputs: any[][],
  input: string,
  setup?: (state: ReturnType<typeof recoveryContext>) => Promise<void>,
) {
  const mock = scriptedClient(outputs);
  const runner = new Runner({
    tracingDisabled: true,
    modelProvider: new OpenAIProvider({ openAIClient: mock.client as any }),
  });
  const agent = new Agent({
    name: 'Flight recovery test',
    model: 'gpt-5.5',
    instructions: FLIGHT_PROMPT,
    tools,
  });
  const state = recoveryContext();
  await setup?.(state);
  const result = await runner.run(agent, input, {
    context: state.requestContext,
    maxTurns: 6,
  });
  return { ...state, result, requests: mock.requests };
}

test('current-option comparison reads generated contracts without a new search or visibility change', async () => {
  let previousSearchKey = '';
  let previousVisibility: boolean[] = [];
  const run = await runScripted(
    [FlightSearchTool, GetGeneratedContractsContextTool],
    [
      [functionCall('read_contracts', 'getGeneratedContractsContext', { mode: 'read', indexes: null })],
      [message('compared', 'Option 3 is the cheapest of the current flights.')],
    ],
    'Which of the current flights is cheapest?',
    async ({ context, requestContext }) => {
      await (FlightSearchTool as any).invoke(
        { context: requestContext },
        JSON.stringify(searchPayload('2026-09-20')),
        {},
      );
      previousSearchKey = context.flight.searchKey;
      previousVisibility = (context.flight.searchResults as Array<{ display: boolean }>).map(
        (contract) => contract.display,
      );
    },
  );

  assert.deepEqual(run.context.toolCallLog.map((entry: any) => entry.tool), [
    'flight_search', 'getGeneratedContractsContext',
  ]);
  assert.equal(run.context.flight.searchKey, previousSearchKey);
  assert.deepEqual(
    (run.context.flight.searchResults as Array<{ display: boolean }>).map(
      (contract) => contract.display,
    ),
    previousVisibility,
  );
  const readOutput = run.requests[1].input.find((item: any) => item.type === 'function_call_output');
  const readResult = JSON.parse(readOutput.output);
  assert.equal(readResult.ok, true);
  assert.deepEqual(readResult.selectedIndexes, []);
  assert.ok(readResult.summary.totalAvailable > 0);
});

test('explicit existing-option display selects without a new search', async () => {
  let previousSearchKey = '';
  const run = await runScripted(
    [FlightSearchTool, GetGeneratedContractsContextTool],
    [
      [functionCall('select_contract', 'getGeneratedContractsContext', { mode: 'select', indexes: [2] })],
      [message('selected', 'Showing option 2.')],
    ],
    'Show option 2.',
    async ({ context, requestContext }) => {
      await (FlightSearchTool as any).invoke(
        { context: requestContext },
        JSON.stringify(searchPayload('2026-09-20')),
        {},
      );
      previousSearchKey = context.flight.searchKey;
    },
  );

  assert.deepEqual(run.context.toolCallLog.map((entry: any) => entry.tool), [
    'flight_search', 'getGeneratedContractsContext',
  ]);
  assert.equal(run.context.flight.searchKey, previousSearchKey);
  assert.deepEqual(
    (run.context.flight.searchResults as Array<{ display: boolean }>).map(
      (contract) => contract.display,
    ),
    [false, true, false],
  );
});

test('missing filter search state recovers by searching before applying the requested filter', async () => {
  const run = await runScripted(
    [FlightSearchTool, ApplyFilterTool],
    [
      [functionCall('filter_missing_search', 'apply_filter', nonstopFilterPayload())],
      [functionCall('create_search', 'flight_search', searchPayload('2026-09-20'))],
      [functionCall('filter_after_search', 'apply_filter', nonstopFilterPayload())],
      [message('filtered', 'I found nonstop flights in your search.')],
    ],
    'Find nonstop flights from DEL to DXB on Sep 20.',
  );

  assert.deepEqual(run.context.toolCallLog.map((entry: any) => entry.tool), [
    'apply_filter', 'flight_search', 'apply_filter',
  ]);
  assert.equal((run.context.toolCallLog[0] as any).code, 'MISSING_SEARCH');
  assert.equal((run.context.toolCallLog[2] as any).ok, true);
  const failureOutput = run.requests[1].input.find((item: any) => item.type === 'function_call_output');
  assert.deepEqual(JSON.parse(failureOutput.output).recovery.requiredState, ['context.flight.searchKey']);
});

test('same SDK run uses validation feedback, changes only the date, and retries successfully', async () => {
  const invalid = searchPayload('2026-09-16');
  const corrected = searchPayload('2026-09-17');
  const run = await runScripted(
    [FlightSearchTool],
    [
      [functionCall('search_invalid', 'flight_search', invalid)],
      [functionCall('search_repaired', 'flight_search', corrected)],
      [message('done', 'I found flexible flight options for Sep 17, 2026.')],
    ],
    'Find DEL to DXB flights; my dates are flexible.',
  );

  assert.equal(run.result.finalOutput, 'I found flexible flight options for Sep 17, 2026.');
  assert.equal(run.context.toolCallLog.length, 2);
  assert.equal((run.context.toolCallLog[0] as any).code, 'INVALID_SEARCH_INPUT');
  assert.equal((run.context.toolCallLog[0] as any).recovery.retrySafe, true);
  assert.deepEqual((run.context.toolCallLog[1] as any).input, corrected);
  const failureOutput = run.requests[1].input.find(
    (item: any) => item.type === 'function_call_output',
  );
  const feedback = JSON.parse(failureOutput.output);
  assert.equal(feedback.recovery.fieldIssues[0].acceptedValue, '2026-09-17');
  assert.deepEqual(
    { ...corrected, onds: corrected.onds.map(({ outbound_date: _date, ...segment }) => segment) },
    { ...invalid, onds: invalid.onds.map(({ outbound_date: _date, ...segment }) => segment) },
  );
});

test('strict-schema omission is model-visible and a corrected payload succeeds in the same run', async () => {
  const incomplete = {
    ...searchPayload('2026-09-20'),
    passengers: undefined,
  };
  delete (incomplete as any).passengers;
  const corrected = searchPayload('2026-09-20');
  const run = await runScripted(
    [FlightSearchTool],
    [
      [functionCall('search_incomplete', 'flight_search', incomplete)],
      [functionCall('search_complete', 'flight_search', corrected)],
      [message('done', 'Flight options are ready.')],
    ],
    'Search DEL to DXB on Sep 20 for one adult.',
  );

  const failureOutput = run.requests[1].input.find(
    (item: any) => item.type === 'function_call_output',
  );
  const feedback = JSON.parse(failureOutput.output);
  assert.equal(feedback.code, 'INVALID_TOOL_INPUT');
  assert.equal(feedback.recovery.fieldIssues.some((issue: any) => issue.path === 'passengers'), true);
  assert.deepEqual(run.context.toolCallLog.map((entry: any) => entry.tool), [
    'flight_search',
    'flight_search',
  ]);
  assert.equal(run.context.flight.outboundDate, '2026-09-20');
});

test('blocking ambiguity asks one question without speculative tool calls', async () => {
  const run = await runScripted(
    [FlightSearchTool, ApplyFilterTool],
    [[message('clarify', 'Do you want to change your departure location or filter the departure airport?')]],
    'Change departure to Ontario.',
  );

  assert.match(String(run.result.finalOutput), /change your departure location or filter/i);
  assert.deepEqual(run.context.toolCallLog, []);
  assert.equal(run.requests.length, 1);
});

test('a rejected suggestions draft is corrected once without replacing core results', async () => {
  const corrected = ['Show nonstop flights only', 'Which option is fastest?', 'Any cheaper dates nearby?'];
  const run = await runScripted(
    [FlightSearchTool, UpdateFlightSuggestedQuestionsTool],
    [
      [functionCall('search', 'flight_search', searchPayload('2026-09-20'))],
      [functionCall('suggestions', 'update_flight_suggested_questions', {
        suggestedQuestions: ['Only one suggestion'],
      })],
      [functionCall('suggestions_retry', 'update_flight_suggested_questions', {
        suggestedQuestions: corrected,
      })],
      [message('done', 'I found flight options. Note: Prices shown are per person.')],
    ],
    'Search DEL to DXB on Sep 20.',
  );

  assert.match(String(run.result.finalOutput), /I found flight options/);
  const attempts = run.context.toolCallLog.filter(
    (entry: any) => entry.tool === 'update_flight_suggested_questions',
  ) as any[];
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].ok, false);
  assert.equal(attempts[0].recovery.retrySafe, true);
  assert.equal(attempts[1].ok, true);
  assert.deepEqual(run.context.flight.suggestedQuestions, corrected);
  assert.equal(run.requests.length, 4);
});

test('a second rejected suggestions draft withdraws the tool and keeps core results', async () => {
  const run = await runScripted(
    [FlightSearchTool, UpdateFlightSuggestedQuestionsTool],
    [
      [functionCall('search', 'flight_search', searchPayload('2026-09-20'))],
      [functionCall('suggestions', 'update_flight_suggested_questions', {
        suggestedQuestions: ['Only one suggestion'],
      })],
      [functionCall('suggestions_retry', 'update_flight_suggested_questions', {
        suggestedQuestions: ['Would you like nonstop flights?'],
      })],
      [message('done', 'I found flight options. Note: Prices shown are per person.')],
    ],
    'Search DEL to DXB on Sep 20.',
  );

  assert.match(String(run.result.finalOutput), /I found flight options/);
  const lastAttempt = run.context.toolCallLog.at(-1) as any;
  assert.equal(lastAttempt.ok, false);
  assert.equal(lastAttempt.recovery.retrySafe, false);
  const offeredLast = (run.requests.at(-1).tools || []).map((entry: any) => entry.name);
  assert.ok(offeredLast.includes('flight_search'));
  assert.equal(offeredLast.includes('update_flight_suggested_questions'), false);
  assert.ok(run.context.flight.searchKey);
});

test('tool contracts expose recoverable constraints without mutating state on failure', async () => {
  const state = recoveryContext();
  const before = structuredClone(state.context.flight);
  const invalidSearch = await (FlightSearchTool as any).invoke(
    { context: state.requestContext },
    JSON.stringify(searchPayload('2026-09-15')),
    {},
  );
  const searchFailure = typeof invalidSearch === 'string' ? JSON.parse(invalidSearch) : invalidSearch;
  assert.equal(searchFailure.ok, false);
  assert.equal(searchFailure.recovery.stateChanged, false);
  assert.equal(searchFailure.recovery.fieldIssues[0].acceptedValue, '2026-09-17');
  assert.equal(state.context.flight.searchKey, before.searchKey);

  const repeatedRaw = await (FlightSearchTool as any).invoke(
    { context: state.requestContext },
    JSON.stringify(searchPayload('2026-09-15')),
    {},
  );
  const repeated = typeof repeatedRaw === 'string' ? JSON.parse(repeatedRaw) : repeatedRaw;
  assert.equal(repeated.recovery.retrySafe, false);
  assert.equal((state.context.toolCallLog.at(-1) as any).retryCount, 1);

  const filterFailureRaw = await (ApplyFilterTool as any).invoke(
    { context: state.requestContext },
    JSON.stringify({ filters: [{
      filterType: 'stops',
      filterCode: '0',
      minDurationMinutes: null,
      maxDurationMinutes: null,
      minPrice: null,
      maxPrice: null,
      airlineNames: null,
      layoverAirportNames: null,
      departureAirportNames: null,
      arrivalAirportNames: null,
      rawUserFilter: 'non-stop',
    }] }),
    {},
  );
  const filterFailure = typeof filterFailureRaw === 'string'
    ? JSON.parse(filterFailureRaw)
    : filterFailureRaw;
  assert.deepEqual(filterFailure.recovery.requiredState, ['context.flight.searchKey']);
});

test('price failures expose safe repair facts and non-input failures are not retryable', async () => {
  const state = recoveryContext();
  const schemaFailureRaw = await (PricePredictionTool as any).invoke(
    { context: state.requestContext },
    JSON.stringify({ originCity: 'DEL' }),
    {
      toolCall: {
        type: 'function_call',
        callId: 'price_missing',
        name: 'price_prediction_tool',
        arguments: JSON.stringify({ originCity: 'DEL' }),
      },
    },
  );
  const schemaFailure = typeof schemaFailureRaw === 'string'
    ? JSON.parse(schemaFailureRaw)
    : schemaFailureRaw;
  assert.equal(schemaFailure.status, 'INVALID_INPUT');
  assert.equal(schemaFailure.recovery.fieldIssues.some((issue: any) => issue.path === 'destinationCity'), true);

  const formatFailure = createFlightToolSchemaErrorFunction('synthetic_tool');
  const internalFailure = JSON.parse(String(formatFailure(
    { context: state.context } as any,
    new Error('private database details'),
  )));
  assert.equal(internalFailure.code, 'TOOL_EXECUTION_ERROR');
  assert.equal(internalFailure.recovery.kind, 'internal');
  assert.equal(internalFailure.recovery.retrySafe, false);
  assert.doesNotMatch(internalFailure.message, /database|private/i);
});

test('core-result fallback preserves useful results when the turn budget runs out', async () => {
  const state = recoveryContext();
  await (FlightSearchTool as any).invoke(
    { context: state.requestContext },
    JSON.stringify(searchPayload('2026-09-20')),
    {},
  );
  assert.equal(
    buildFlightCoreSuccessFallback(state.context, 0),
    'I found flight options from DEL to DXB for Sep 20, 2026. Note: Prices shown are per person.',
  );
  assert.equal(buildFlightCoreSuccessFallback(recoveryContext().context, 0), null);
});

test('runtime defaults favor reasoning quality without forcing tool calls', () => {
  assert.equal(flightAgentConfig.maxTurns, Number(process.env.FLIGHT_AGENT_MAX_TURNS || 10));
  assert.equal(flightAgentConfig.model, process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.2');
  assert.equal((flightAgentConfig.modelSettings.reasoning as any)?.effort, 'medium');
  assert.equal(flightAgentConfig.modelSettings.toolChoice, 'auto');
  assert.equal(flightAgentConfig.modelSettings.parallelToolCalls, false);
  assert.match(FLIGHT_PROMPT, /Current Existing Search Parameters.*Relevant conversation history.*Safe defaults/is);
  assert.match(FLIGHT_PROMPT, /Recoverable input failure.*Blocking ambiguity.*Non-input failure/is);
});

test('decision-loop instructions prefer existing results and verify outcomes before stopping', () => {
  const decisionLoop = FLIGHT_PROMPT.match(/### Internal decision loop([\s\S]*?)### flight_search/)?.[1];
  assert.ok(decisionLoop, 'expected one decision-loop section before tool-specific routing');
  for (const stage of ['Understand', 'Plan', 'Act', 'Verify', 'Recover', 'Stop']) {
    assert.match(decisionLoop, new RegExp(`^- ${stage}:`, 'm'));
  }
  assert.match(decisionLoop, /latest user input, hydrated context, relevant history carried by Manager or available in this run, then allowed defaults/i);
  assert.match(decisionLoop, /define what would satisfy that request, resolve dependencies/i);
  assert.match(decisionLoop, /apply_filter requires a valid active search, not merely a hydrated search key/i);
  assert.match(decisionLoop, /tool feedback takes precedence when it is missing, stale, or expired/i);
  assert.match(decisionLoop, /existing recovery policy; never blindly repeat the same action/i);
  assert.match(decisionLoop, /stop core tool calls/i);
  assert.match(FLIGHT_PROMPT, /least state-changing tool path/i);
  assert.match(FLIGHT_PROMPT, /do not start a new search solely because route and date are available/i);
  assert.match(FLIGHT_PROMPT, /Read without changing visibility for counts, comparisons, recommendations, and open-ended ranking/i);
  assert.match(FLIGHT_PROMPT, /Select only when the user explicitly asks to display particular existing option indexes/i);
  assert.match(FLIGHT_PROMPT, /Never call apply_filter, including reset, to obtain more options, bypass an empty filtered set/i);
  assert.match(MANAGER_PROMPT, /current-option fact, comparison, ranking, or recommendation is read-only/i);
  assert.match(MANAGER_PROMPT, /Never add "clear filters".*merely because the current filtered set previously had zero matches/is);
  assert.match(
    buildManagerInstructions({ context: {} }),
    /Never introduce a filter addition, removal, relaxation, reset, or unfiltered fallback.*Forbidden unless the user explicitly requested it/is,
  );
  assert.match(FLIGHT_MANAGER_INSTRUCTIONS, /search presentation wins even when prediction failed, status is partial, or apply_filter followed/i);
  assert.match(FLIGHT_MANAGER_INSTRUCTIONS, /filter followed the fallback search/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /For open-ended ranking, read all, choose 1-3 supported options, then select them/i);
  assert.match(FLIGHT_PROMPT, /For "make it cheaper\/faster," inspect and compare existing contracts/i);
  assert.match(FLIGHT_PROMPT, /concrete constraint/i);
  assert.match(FLIGHT_PROMPT, /check the returned options, count, and feedback against the user's actual request/i);
  assert.match(FLIGHT_PROMPT, /successful status alone does not mean an empty result or unapplied constraint satisfied it/i);
  assert.match(FLIGHT_PROMPT, /If MISSING_SEARCH is returned and complete search intent is already available, call flight_search and then retry apply_filter/i);
  assert.doesNotMatch(FLIGHT_PROMPT, /Treat every non-success status as internal/i);
});
