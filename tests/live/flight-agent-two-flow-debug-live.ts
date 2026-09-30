process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_FLOW_DEBUG_MODEL ||
  process.env.OPENAI_FLIGHT_MODEL ||
  'gpt-5.5';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');
const { buildFlightAgentInstructions } = await import(
  '../../src/agents/flight/agent.js'
);
const { prepareFlightAgentTurnContext } = await import(
  '../../src/agents/flight/context/flight-context.js'
);
const { clickHouseClient } = await import(
  '../../src/agents/flight/tools/price-prediction/tool.js'
);

const FIXED_NOW = new Date('2026-07-31T10:00:00.000Z');
const TIME_ZONE = 'Asia/Kolkata';
const RESULTS_FILE = path.resolve(
  'tests/results/flight-agent-two-flow-debug-latest.json',
);
const DAY_MS = 24 * 60 * 60 * 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isoDate(offset) {
  return new Date(FIXED_NOW.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

function makePredictionRow() {
  const predictions = {};
  for (let offset = 0; offset <= 89; offset += 1) {
    predictions[isoDate(offset)] = 500 + offset;
  }

  predictions['2026-08-12'] = 1;
  predictions['2026-08-19'] = 2;
  predictions['2026-08-25'] = 3;
  predictions['2026-08-05'] = 4;
  predictions['2026-08-28'] = 5;

  return {
    SearchDate: '2026-07-30',
    SearchDepartureFromCity: 'JFK',
    SearchDepartureToCity: 'DEL',
    IsRoundTrip: 0,
    TripPredictions: JSON.stringify(predictions),
  };
}

function summarizePrediction(result) {
  if (!result) {
    return null;
  }

  return {
    ok: result.ok,
    status: result.status,
    source: result.source,
    dataAsOf: result.dataAsOf || null,
    route: result.route,
    tripType: result.tripType,
    searchedDateRange: result.searchedDateRange,
    predictionCount: result.predictionCount || 0,
    cheapestDates: result.cheapestDates || [],
    cheapestCombinations: result.cheapestCombinations || [],
    recommendation: result.recommendation,
    formattedResponse: result.formattedResponse,
    message: result.message,
  };
}

function contextSnapshot(context: any = {}) {
  return {
    requestId: context.requestId || null,
    sessionId: context.sessionId || null,
    UID: context.UID || null,
    uid: context.uid || null,
    searchKey: context.searchKey || null,
    sid: context.sid || null,
    lastSearch: clone(context.lastSearch || null),
    flight: {
      searchKey: context.flight?.searchKey || null,
      currentUserMessage: context.flight?.currentUserMessage || null,
      clock: clone(context.flight?.clock || null),
      dateIntent: clone(context.flight?.dateIntent || null),
      dateRouting: clone(context.flight?.dateRouting || null),
      pricePredictionDateIntent: clone(
        context.flight?.pricePredictionDateIntent || null,
      ),
      lastPricePrediction: summarizePrediction(
        context.flight?.lastPricePrediction,
      ),
      suggestedQuestions: clone(context.flight?.suggestedQuestions || []),
      suggestedQuestionsUpdatedRequestId:
        context.flight?.suggestedQuestionsUpdatedRequestId || null,
    },
    flightResults: clone(context.flightResults || []),
  };
}

function summarizeToolCalls(context, offset) {
  return context.toolCallLog.slice(offset).map((call) => ({
    toolName: call.tool,
    inputPayload: clone(call.input || null),
    status: call.status || null,
    ok: call.ok ?? null,
    searchKey: call.searchKey || null,
    searchDate: call.searchDate || null,
    returnDate: call.returnDate || null,
    suggestedQuestions: clone(call.suggestedQuestions || []),
  }));
}

function initialPromptState(context, { input, requestId, sessionId }: any) {
  const prepared = clone(context);
  prepared.UID ||= prepared.uid || 'demo-user';
  prepared.uid ||= prepared.UID;
  prepared.searchKey ||= prepared.flight?.searchKey || prepared.sid;
  prepared.sid ||= prepared.searchKey;
  prepareFlightAgentTurnContext(prepared, {
    input,
    requestId,
    sessionId,
    now: FIXED_NOW,
    timeZone: TIME_ZONE,
  } as any);

  const instructions = buildFlightAgentInstructions({ context: prepared });
  return {
    contextInjected: contextSnapshot(prepared),
    dynamicPromptLines: instructions
      .split('\n')
      .filter((line) =>
        /Immutable turn clock|Active search exists|Existing search parameters|prediction window|booking window|Durable resolved date intent/i.test(
          line,
        ),
      ),
  };
}

async function runTurn({ context, sessionId, turn, userMessage }) {
  const requestId = `${sessionId}-turn-${turn}`;
  const before = contextSnapshot(context);
  const promptState = initialPromptState(context, {
    input: userMessage,
    requestId,
    sessionId,
  });
  const toolOffset = context.toolCallLog.length;
  const result = await runFlightAgent({
    input: userMessage,
    context,
    requestId,
    sessionId,
    now: FIXED_NOW,
    timeZone: TIME_ZONE,
  });

  return {
    turn,
    requestId,
    sessionId,
    userMessage,
    contextBefore: before,
    contextInjected: promptState.contextInjected,
    dynamicPromptLines: promptState.dynamicPromptLines,
    toolsCalled: summarizeToolCalls(context, toolOffset),
    agentResponse: result.output,
    latencyMs: result.latencyMs,
    error: Boolean(result.error),
    contextAfter: contextSnapshot(context),
  };
}

async function runScenario1() {
  const sessionId = 'flight-flow-debug-vague-search';
  const context = {
    UID: 'debug-user-vague',
    uid: 'debug-user-vague',
    flight: {},
    toolCallLog: [],
  };

  try {
    return {
      scenarioId: 'vague-date-to-flight-search',
      initialContext: contextSnapshot(context),
      turns: [
        await runTurn({
          context,
          sessionId,
          turn: 1,
          userMessage: 'Find flights from JFK to Delhi next weekend',
        }),
      ],
    };
  } finally {
    await clearFlightAgentSession(sessionId);
  }
}

async function runScenario2() {
  const sessionId = 'flight-flow-debug-prediction-search';
  const context = {
    UID: 'debug-user-prediction',
    uid: 'debug-user-prediction',
    flight: {},
    toolCallLog: [],
  };

  try {
    const turns = [];
    turns.push(
      await runTurn({
        context,
        sessionId,
        turn: 1,
        userMessage:
          'What is the cheapest date to fly from JFK to Delhi next month?',
      }),
    );
    turns.push(
      await runTurn({
        context,
        sessionId,
        turn: 2,
        userMessage: 'Search flights for the best one',
      }),
    );

    return {
      scenarioId: 'price-prediction-to-flight-search',
      initialContext: contextSnapshot({
        UID: 'debug-user-prediction',
        uid: 'debug-user-prediction',
        flight: {},
        toolCallLog: [],
      }),
      turns,
    };
  } finally {
    await clearFlightAgentSession(sessionId);
  }
}

const originalQuery = clickHouseClient.query;
clickHouseClient.query = async () => [makePredictionRow()];

try {
  const report = {
    generatedAt: new Date().toISOString(),
    model: flightAgentConfig.model,
    fixedClock: {
      instant: FIXED_NOW.toISOString(),
      localDate: '2026-07-31',
      timeZone: TIME_ZONE,
    },
    scenarios: [await runScenario1(), await runScenario2()],
  };

  await fs.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
  await fs.writeFile(RESULTS_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Model: ${report.model}`);
  console.log(`Report: ${RESULTS_FILE}`);
  for (const scenario of report.scenarios) {
    for (const turn of scenario.turns) {
      console.log(
        `${scenario.scenarioId} turn ${turn.turn}: ${turn.toolsCalled.map((call) => call.toolName).join(' -> ')}`,
      );
      console.log(`Response: ${turn.agentResponse}`);
    }
  }
} finally {
  clickHouseClient.query = originalQuery;
}
