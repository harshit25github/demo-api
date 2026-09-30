process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';

const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');

const FIXED_NOW = new Date('2026-07-31T10:00:00.000Z');
const TIME_ZONE = 'Asia/Kolkata';
const SEARCH_TOOL = 'flight_search';
const PRICE_TOOL = 'price_prediction_tool';
const SUGGESTIONS_TOOL = 'update_flight_suggested_questions';

function createContext(id) {
  return {
    UID: `date-routing-live-${id}`,
    flight: {},
    toolCallLog: [],
  };
}

const scenarios = [
  {
    id: 'normal-next-week',
    turns: [
      {
        input: 'Find flights from DEL to BOM next week',
        expectedTools: [SEARCH_TOOL],
        expectedSearchDate: '2026-08-03',
        forbidPricePrediction: true,
      },
    ],
  },
  {
    id: 'normal-next-weekend',
    turns: [
      {
        input: 'Show flights from JFK to LAX next weekend',
        expectedTools: [SEARCH_TOOL],
        expectedSearchDate: '2026-08-08',
        forbidPricePrediction: true,
      },
    ],
  },
  {
    id: 'normal-named-month',
    turns: [
      {
        input: 'Book a flight from DEL to BOM in August',
        expectedTools: [SEARCH_TOOL],
        expectedSearchDate: '2026-08-01',
        forbidPricePrediction: true,
      },
    ],
  },
  {
    id: 'exact-date-direct-search',
    turns: [
      {
        input: 'Find flights from DEL to BOM on 2026-08-15',
        expectedTools: [SEARCH_TOOL],
        expectedSearchDate: '2026-08-15',
        forbidPricePrediction: true,
      },
    ],
  },
  {
    id: 'price-advice-only',
    turns: [
      {
        input: "I'm flexible for DEL to BOM. Suggest the cheapest date next month.",
        expectedTools: [PRICE_TOOL],
        requirePricePrediction: true,
        forbidSearch: true,
      },
    ],
  },
  {
    id: 'price-intelligence-with-search',
    turns: [
      {
        input: 'Find the cheapest DEL to BOM flight next month and show flights',
        expectedTools: [PRICE_TOOL, SEARCH_TOOL],
        requirePricePrediction: true,
      },
    ],
  },
  {
    id: 'date-before-route',
    turns: [
      {
        input: 'next weekend',
        expectedTools: [],
        forbidPricePrediction: true,
        forbidSearch: true,
      },
      {
        input: 'DEL to BOM',
        expectedTools: [SEARCH_TOOL],
        expectedSearchDate: '2026-08-08',
        forbidPricePrediction: true,
      },
    ],
  },
  {
    id: 'price-route-missing',
    turns: [
      {
        input: 'What is the cheapest date to Delhi next month?',
        expectedTools: [],
        forbidPricePrediction: true,
        forbidSearch: true,
      },
    ],
  },
];

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

const report = [];

for (const scenario of scenarios as any[]) {
  const sessionId = `date-routing-${scenario.id}-${Date.now()}`;
  const context = createContext(scenario.id);
  const turns = [];

  for (const [index, turn] of scenario.turns.entries() as IterableIterator<[number, any]>) {
    const callStart = context.toolCallLog.length;
    const result = await runFlightAgent({
      input: turn.input,
      sessionId,
      context,
      now: FIXED_NOW,
      timeZone: TIME_ZONE,
    });
    const calls = result.context.toolCallLog.slice(callStart) as any[];
    const toolNames = calls.map((call) => call.tool);
    const coreToolNames = toolNames.filter((name) => name !== SUGGESTIONS_TOOL);
    const searchCall = calls.find((call) => call.tool === SEARCH_TOOL) || null;
    const issues = [];

    if (!sameArray(coreToolNames, turn.expectedTools)) {
      issues.push(
        `Expected ${turn.expectedTools.join(' -> ')}, got ${coreToolNames.join(' -> ') || 'none'}.`,
      );
    }
    if (turn.forbidPricePrediction && toolNames.includes(PRICE_TOOL)) {
      issues.push('Normal date/search intent incorrectly called price prediction.');
    }
    if (turn.requirePricePrediction && !toolNames.includes(PRICE_TOOL)) {
      issues.push('Explicit price intelligence did not call price prediction.');
    }
    if (turn.forbidSearch && searchCall) {
      issues.push('Flight search ran before required context was available.');
    }
    if (
      turn.expectedSearchDate &&
      searchCall?.input?.onds?.[0]?.outbound_date !== turn.expectedSearchDate
    ) {
      issues.push(
        `Expected search date ${turn.expectedSearchDate}, got ${searchCall?.input?.onds?.[0]?.outbound_date || 'none'}.`,
      );
    }
    turns.push({
      turn: index + 1,
      userInput: turn.input,
      expectedTools: turn.expectedTools,
      actualTools: toolNames,
      searchKey: result.context.flight?.searchKey || null,
      suggestions: result.context.flight?.suggestedQuestions || [],
      response: result.output,
      pass: issues.length === 0,
      issues,
    });
  }

  report.push({
    id: scenario.id,
    pass: turns.every((turn) => turn.pass),
    turns,
  });
  await clearFlightAgentSession(sessionId);
}

console.log(JSON.stringify(report, null, 2));

if (report.some((scenario) => !scenario.pass)) {
  process.exitCode = 1;
}
