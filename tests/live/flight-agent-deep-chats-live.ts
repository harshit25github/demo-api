process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_E2E_MODEL || process.env.OPENAI_FLIGHT_MODEL || 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '10';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const REPORT_JSON = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-deep-chats-latest.json',
);
const REPORT_TXT = path.join(
  process.cwd(),
  'tests',
  'results',
  'flight-agent-deep-chats-latest.txt',
);

const RESULT_REASONING_TOOL = 'getGeneratedContractsContext';

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function codesFromPayload(payload = [], filterType) {
  const filter = (payload || []).find((item) => item.filterType === filterType);
  if (!filter) {
    return [];
  }

  return (filter.Values || [])
    .flatMap((value) => String(value).split(','))
    .map((code) => code.trim())
    .filter(Boolean);
}

function latestApplyCall(calls = []) {
  return [...calls].reverse().find((call) => call.tool === 'apply_filter') || null;
}

function latestSearchCall(calls = []) {
  return [...calls].reverse().find((call) => call.tool === 'flight_search') || null;
}

function finalPayloadFromTurn(calls, context) {
  return latestApplyCall(calls)?.finalFilterPayload || context.lastFinalFilterPayload || [];
}

function optionCodes(options = [], mode = 'all') {
  return (Array.isArray(options) ? options : [])
    .filter((option) => {
      if (!option) {
        return false;
      }
      if (mode === 'nearby') {
        return option.IsNearby === true;
      }
      if (mode === 'main') {
        return option.IsNearby !== true;
      }
      return true;
    })
    .map((option) => option.Code)
    .filter(Boolean);
}

function airportOptionsFor(context, filterType) {
  if (filterType === 'outbounddepart') {
    return context.DepartAirports || context.departureAirportFilterOptions || [];
  }
  if (filterType === 'outboundarrival') {
    return context.DepLandAirports || context.arrivalAirportFilterOptions || [];
  }
  return [];
}

function valuesInclude(payload, filterType, expectedCode) {
  return codesFromPayload(payload, filterType).includes(String(expectedCode));
}

function formatCalls(calls) {
  return calls.map((call) => ({
    tool: call.tool,
    searchKey: call.searchKey || null,
    input: call.input || null,
    indexes: call.indexes ?? null,
    filters: call.filters || null,
    finalFilterPayload: call.finalFilterPayload || null,
    feedback: call.feedback || null,
  }));
}

function snapshotContext(context) {
  return {
    searchKey: context.searchKey || null,
    sid: context.sid || null,
    lastSearch: context.lastSearch || null,
    filteredCount: context.filteredFlightResults?.length || 0,
    flightCount: context.flightResults?.length || 0,
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    airlineCodes: optionCodes(context.airlineFilterOptions || context.airlineFilters),
    layoverCodes: optionCodes(
      context.layoverAirportFilterOptions || context.layoverAirportFilters,
    ),
    departureAirportCodes: optionCodes(context.DepartAirports || []),
    arrivalAirportCodes: optionCodes(context.DepLandAirports || []),
    nearbyDepartureAirportCodes: optionCodes(context.DepartAirports || [], 'nearby'),
    nearbyArrivalAirportCodes: optionCodes(context.DepLandAirports || [], 'nearby'),
  };
}

function expectTools(expectedTools) {
  return ({ actualTools }) =>
    sameSequence(actualTools, expectedTools)
      ? []
      : [
          `Expected tools ${expectedTools.join(' -> ') || '(none)'}, got ${
            actualTools.join(' -> ') || '(none)'
          }.`,
        ];
}

function expectOneOfToolSequences(acceptedSequences) {
  return ({ actualTools }) =>
    acceptedSequences.some((sequence) => sameSequence(actualTools, sequence))
      ? []
      : [
          `Expected one of ${acceptedSequences
            .map((sequence) => sequence.join(' -> ') || '(none)')
            .join(' OR ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
        ];
}

function expectSearchKeyCreated() {
  return ({ after }) => (after.searchKey ? [] : ['Expected searchKey to be created.']);
}

function expectSearchKeyChanged() {
  return ({ before, after }) =>
    before.searchKey && before.searchKey === after.searchKey
      ? [`Expected new searchKey, but it stayed ${after.searchKey}.`]
      : [];
}

function expectApplyUsesLatestSearchKey() {
  return ({ before, calls }) => {
    const errors = [];
    let latestSearchKey = before.searchKey || null;

    for (const call of calls) {
      if (call.tool === 'flight_search') {
        latestSearchKey = call.searchKey || latestSearchKey;
      }

      if (call.tool === 'apply_filter') {
        if (!latestSearchKey) {
          errors.push('apply_filter ran before any valid searchKey existed.');
        } else if (call.searchKey !== latestSearchKey) {
          errors.push(
            `apply_filter used stale searchKey ${call.searchKey}; latest expected ${latestSearchKey}.`,
          );
        }
      }
    }

    return errors;
  };
}

function expectResultContextUsesLatestSearchKey() {
  return ({ before, calls }) => {
    const errors = [];
    let latestSearchKey = before.searchKey || null;

    for (const call of calls) {
      if (call.tool === 'flight_search') {
        latestSearchKey = call.searchKey || latestSearchKey;
      }
      if (call.tool === RESULT_REASONING_TOOL && latestSearchKey && call.searchKey !== latestSearchKey) {
        errors.push(
          `${RESULT_REASONING_TOOL} used stale searchKey ${call.searchKey}; latest expected ${latestSearchKey}.`,
        );
      }
    }

    return errors;
  };
}

function expectNoPricePrediction() {
  return ({ actualTools }) =>
    actualTools.includes('price_prediction_tool')
      ? ['price_prediction_tool should not be called in this suite.']
      : [];
}

function expectApplyPayloadNotEmpty() {
  return ({ calls, context }) => {
    if (!calls.some((call) => call.tool === 'apply_filter')) {
      return [];
    }

    const payload = finalPayloadFromTurn(calls, context);
    return payload.length > 0 ? [] : ['apply_filter produced an empty final filter payload.'];
  };
}

function expectPayloadIncludes(filterType, expectedCode) {
  return ({ calls, context }) => {
    const payload = finalPayloadFromTurn(calls, context);
    return valuesInclude(payload, filterType, expectedCode)
      ? []
      : [
          `Expected ${filterType} to include ${expectedCode}; got ${JSON.stringify(
            payload,
          )}.`,
        ];
  };
}

function expectContextAirportCodes(filterType, mode = 'all') {
  return ({ calls, context }) => {
    const payload = finalPayloadFromTurn(calls, context);
    const actualCodes = codesFromPayload(payload, filterType);
    const expectedCodes = optionCodes(airportOptionsFor(context, filterType), mode);
    const missing = expectedCodes.filter((code) => !actualCodes.includes(code));

    if (expectedCodes.length === 0) {
      return [`No expected ${mode} airport codes were available in context for ${filterType}.`];
    }

    return missing.length === 0
      ? []
      : [
          `Expected ${filterType} to include ${mode} context codes ${missing.join(
            ', ',
          )}; got ${actualCodes.join(', ') || '(none)'}.`,
        ];
  };
}

function expectDurationPayload(filterType, maxMinutes) {
  return ({ calls, context }) => {
    const payload = finalPayloadFromTurn(calls, context);
    const filter = (payload || []).find((item) => item.filterType === filterType);
    const values = filter?.Values || [];

    return values[0] === 0 && values[1] === maxMinutes
      ? []
      : [`Expected ${filterType} Values [0, ${maxMinutes}], got ${JSON.stringify(values)}.`];
  };
}

function expectNoStopValueAboveThree() {
  return ({ calls, context }) => {
    const payload = finalPayloadFromTurn(calls, context);
    const unsupported = codesFromPayload(payload, 'stop').filter((value) => Number(value) > 3);
    return unsupported.length > 0
      ? [`Stop payload contains unsupported values: ${unsupported.join(', ')}.`]
      : [];
  };
}

function expectSearchInputMatches(checks) {
  return ({ calls }) => {
    const search = latestSearchCall(calls);
    if (!search) {
      return ['Expected a flight_search call to inspect search input.'];
    }

    const input = search.input || {};
    const firstOnd = input.onds?.[0] || {};
    const lastOnd = input.onds?.[input.onds.length - 1] || {};
    const errors = [];

    if (checks.origin && !checks.origin.test(compact(firstOnd.origin))) {
      errors.push(`Expected origin to match ${checks.origin}; got ${firstOnd.origin || '(missing)'}.`);
    }
    if (checks.destination && !checks.destination.test(compact(lastOnd.destination))) {
      errors.push(
        `Expected destination to match ${checks.destination}; got ${
          lastOnd.destination || '(missing)'
        }.`,
      );
    }
    if (checks.tripType && input.trip_type !== checks.tripType) {
      errors.push(`Expected trip_type ${checks.tripType}; got ${input.trip_type || '(missing)'}.`);
    }
    if (checks.cabinClass && input.cabin_class !== checks.cabinClass) {
      errors.push(
        `Expected cabin_class ${checks.cabinClass}; got ${input.cabin_class || '(missing)'}.`,
      );
    }
    if (typeof checks.adults === 'number' && input.passengers?.adults !== checks.adults) {
      errors.push(`Expected adults ${checks.adults}; got ${input.passengers?.adults}.`);
    }
    if (typeof checks.children === 'number' && input.passengers?.children !== checks.children) {
      errors.push(`Expected children ${checks.children}; got ${input.passengers?.children}.`);
    }

    return errors;
  };
}

function expectAirportContextRefreshedForLaxSearch() {
  return ({ context }) => {
    const departureCodes = optionCodes(context.DepartAirports || []);
    const arrivalCodes = optionCodes(context.DepLandAirports || []);
    const errors = [];

    if (!departureCodes.includes('JFK') || !departureCodes.includes('EWR')) {
      errors.push(
        `Expected refreshed NYC departure airports after re-search; got ${departureCodes.join(
          ', ',
        )}.`,
      );
    }
    if (!arrivalCodes.includes('LAX') || !arrivalCodes.includes('ONT')) {
      errors.push(
        `Expected refreshed LAX arrival airports after re-search; got ${arrivalCodes.join(', ')}.`,
      );
    }

    return errors;
  };
}

function expectResponseMentionsAny(patterns) {
  return ({ response }) =>
    patterns.some((pattern) => pattern.test(response))
      ? []
      : [`Expected response to mention one of ${patterns.map(String).join(', ')}.`];
}

function countQuestions(response) {
  return (response.match(/\?/g) || []).length;
}

function expectOneFocusedClarification() {
  return ({ response, actualTools }) => {
    const errors = [];
    if (actualTools.length > 0) {
      errors.push('Expected clarification without tool calls.');
    }
    if (countQuestions(response) !== 1) {
      errors.push(`Expected one focused question, got ${countQuestions(response)}.`);
    }
    return errors;
  };
}

function expectMissingSearchResponse() {
  return ({ response }) => {
    const errors = [];
    if (!/origin|departure|departing|flying from|fly from|from/i.test(response)) {
      errors.push('Missing-search response should ask for origin.');
    }
    if (!/destination|going|flying to|fly to|to/i.test(response)) {
      errors.push('Missing-search response should ask for destination.');
    }
    if (!/date|travel date/i.test(response)) {
      errors.push('Missing-search response should ask for travel date.');
    }
    if (/passenger|adult|child|infant|cabin|class/i.test(response)) {
      errors.push('Missing-search response should not ask for optional passenger/cabin details.');
    }
    return errors;
  };
}

function responseQualityCheck() {
  return ({ response, actualTools }) => {
    const text = response.trim();
    const errors = [];

    if (!text) {
      errors.push('Expected a non-empty final response.');
    }
    if (/\b(flight_search|apply_filter|getGeneratedContractsContext|searchKey|payload|FINAL_APPLY_FILTER_PAYLOAD)\b/i.test(text)) {
      errors.push('Response exposed internal tool, payload, or searchKey details.');
    }
    if (text.length > 1200) {
      errors.push(`Response is too long for mobile UX (${text.length} chars).`);
    }
    if (text.split(/\r?\n/).some((line) => /^\s*\|.+\|\s*$/.test(line))) {
      errors.push('Response used a markdown table.');
    }
    if (
      actualTools.includes('apply_filter') &&
      !/\b(applied|added|allowed|enabled|set|using|showing|updated|filters?|filtered|focused|limited|match|matches|matching|results?|yield|relax|not available|couldn't find|try|non[- ]?stop|morning|evening|arrival|departure|baggage|carry[- ]?on|layover|duration|airline)\b/i.test(text)
    ) {
      errors.push('Filter response should state what changed or why nothing matched.');
    }
    if (
      actualTools.includes(RESULT_REASONING_TOOL) &&
      !/\b(option|flight|cheapest|best|shortest|compare|value|recommend)\b/i.test(text)
    ) {
      errors.push('Current-results response should include option-level reasoning.');
    }

    return errors;
  };
}

const commonChecks = [
  expectApplyUsesLatestSearchKey(),
  expectResultContextUsesLatestSearchKey(),
  expectNoPricePrediction(),
  expectApplyPayloadNotEmpty(),
  responseQualityCheck(),
];

const scenarios = [
  {
    id: 'deep-chat-1-filter-airports-research',
    title: 'Filter before search, airport apply-all flow, re-search, and reasoning',
    turns: [
      {
        user: 'Show non-stop Emirates with checked baggage and layover in Dubia.',
        expectedTools: [],
        expectedPayload: { blocked: 'missing active search' },
        checks: [expectTools([]), expectMissingSearchResponse()],
      },
      {
        user: 'From NYC to LAX on Dec 20 for 1 adult economy.',
        expectedTools: ['flight_search', 'apply_filter'],
        expectedPayload: {
          search: 'NYC -> LAX, Dec 20, 1 adult economy',
          filters: { airline: 'EK', baggage: '0', layover: 'DXB', stop: '0' },
        },
        checks: [
          expectTools(['flight_search', 'apply_filter']),
          expectSearchKeyCreated(),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('baggage', '0'),
          expectPayloadIncludes('outboundlayover', 'DXB'),
          expectPayloadIncludes('stop', '0'),
        ],
      },
      {
        user: 'What alternate arrival airports can I use around LA?',
        expectedTools: [],
        expectedPayload: { answerFromContext: 'arrival airport options' },
        checks: [
          expectTools([]),
          expectResponseMentionsAny([/\bBUR\b/i, /\bONT\b/i, /\bSNA\b/i, /Burbank/i]),
        ],
      },
      {
        user: 'Apply all these airports.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: 'all previously shown arrival airports' },
        checks: [expectTools(['apply_filter']), expectContextAirportCodes('outboundarrival')],
      },
      {
        user: 'Use nearby departure and nearby arrival airports only.',
        expectedTools: ['apply_filter'],
        expectedPayload: {
          outbounddepart: 'nearby departure codes',
          outboundarrival: 'nearby arrival codes',
        },
        checks: [
          expectTools(['apply_filter']),
          expectContextAirportCodes('outbounddepart', 'nearby'),
          expectContextAirportCodes('outboundarrival', 'nearby'),
        ],
      },
      {
        user: 'Change departure airport to Newark only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outbounddepart: ['EWR'] },
        checks: [expectTools(['apply_filter']), expectPayloadIncludes('outbounddepart', 'EWR')],
      },
      {
        user: 'Show morning departures and night arrivals.',
        expectedTools: ['apply_filter'],
        expectedPayload: { departtimeslotfilter: ['MORNING'], departlandtimeslotfilter: ['EVENING'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('departtimeslotfilter', 'MORNING'),
          expectPayloadIncludes('departlandtimeslotfilter', 'EVENING'),
        ],
      },
      {
        user: 'Also air canda and emrates only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['AC', 'AC+', 'EK'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'AC'),
          expectPayloadIncludes('airline', 'AC+'),
          expectPayloadIncludes('airline', 'EK'),
        ],
      },
      {
        user: 'Make layover under 4 hours.',
        expectedTools: ['apply_filter'],
        expectedPayload: { departlayoverfilter: [0, 240] },
        checks: [expectTools(['apply_filter']), expectDurationPayload('departlayoverfilter', 240)],
      },
      {
        user: 'Which is cheapest now?',
        expectedTools: [RESULT_REASONING_TOOL],
        expectedPayload: { indexes: null },
        checks: [expectTools([RESULT_REASONING_TOOL])],
      },
      {
        user: 'Actually change date to Dec 22 and show two or more stops.',
        expectedTools: ['flight_search', 'apply_filter'],
        expectedPayload: { newSearch: 'Dec 22', stop: ['3'] },
        checks: [
          expectTools(['flight_search', 'apply_filter']),
          expectSearchKeyChanged(),
          expectPayloadIncludes('stop', '3'),
          expectNoStopValueAboveThree(),
        ],
      },
      {
        user: 'Make it 2 adults and business class.',
        expectedTools: ['flight_search'],
        expectedPayload: { passengers: { adults: 2 }, cabin_class: 'business' },
        checks: [
          expectTools(['flight_search']),
          expectSearchKeyChanged(),
          expectSearchInputMatches({ adults: 2, cabinClass: 'business' }),
        ],
      },
      {
        user: 'Keep Emirates only and total duration under 20 hours.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['EK'], departdurationfilter: [0, 1200] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'EK'),
          expectDurationPayload('departdurationfilter', 1200),
        ],
      },
      {
        user: 'What departure and arrival airport options do I have now?',
        expectedTools: [],
        expectedPayload: { answerFromContext: 'departure and arrival airports' },
        checks: [
          expectTools([]),
          expectResponseMentionsAny([/\bJFK\b/i, /\bEWR\b/i, /\bLAX\b/i, /\bONT\b/i]),
        ],
      },
      {
        user: 'Apply all departure airports and all arrival airports.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outbounddepart: 'all context codes', outboundarrival: 'all context codes' },
        checks: [
          expectTools(['apply_filter']),
          expectContextAirportCodes('outbounddepart'),
          expectContextAirportCodes('outboundarrival'),
        ],
      },
      {
        user: 'Compare current contracts.',
        expectedTools: [RESULT_REASONING_TOOL],
        expectedPayload: { indexes: null },
        checks: [expectTools([RESULT_REASONING_TOOL])],
      },
    ],
  },
  {
    id: 'deep-chat-2-core-changes-misspellings-ambiguity',
    title: 'Core changes, misspellings, airport filters, ambiguity, and latest context',
    turns: [
      {
        user: 'Find flights from Delhi to New York on Dec 20.',
        expectedTools: ['flight_search'],
        expectedPayload: { search: 'Delhi -> New York, Dec 20' },
        checks: [
          expectTools(['flight_search']),
          expectSearchKeyCreated(),
          expectSearchInputMatches({ origin: /delhi|del/i, destination: /new york|nyc|jfk/i }),
        ],
      },
      {
        user: 'Make it round trip returning Jan 8.',
        expectedTools: ['flight_search'],
        expectedPayload: { trip_type: 'roundtrip', return_date: 'Jan 8' },
        checks: [
          expectTools(['flight_search']),
          expectSearchKeyChanged(),
          expectSearchInputMatches({ tripType: 'roundtrip' }),
        ],
      },
      {
        user: 'Show Qatar airwys or emrates with carry on.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['QR', 'EK'], baggage: ['1'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'QR'),
          expectPayloadIncludes('airline', 'EK'),
          expectPayloadIncludes('baggage', '1'),
        ],
      },
      {
        user: 'Layover in amsterdem and arrival in morning.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundlayover: ['AMS'], departlandtimeslotfilter: ['MORNING'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('outboundlayover', 'AMS'),
          expectPayloadIncludes('departlandtimeslotfilter', 'MORNING'),
        ],
      },
      {
        user: 'What departure and arrival airport options do I have?',
        expectedTools: [],
        expectedPayload: { answerFromContext: 'airport options' },
        checks: [
          expectTools([]),
          expectResponseMentionsAny([/\bDEL\b/i, /\bJFK\b/i, /\bEWR\b/i, /Newark/i]),
        ],
      },
      {
        user: 'Apply all arrival airports and checked baggage only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: 'all current arrival codes', baggage: ['0'] },
        checks: [
          expectTools(['apply_filter']),
          expectContextAirportCodes('outboundarrival'),
          expectPayloadIncludes('baggage', '0'),
        ],
      },
      {
        user: 'Use main arrival airports only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: 'main arrival codes only' },
        checks: [expectTools(['apply_filter']), expectContextAirportCodes('outboundarrival', 'main')],
      },
      {
        user: 'Change arrival airport to Newark.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: ['EWR'] },
        checks: [expectTools(['apply_filter']), expectPayloadIncludes('outboundarrival', 'EWR')],
      },
      {
        user: 'Show flights with 5 stops.',
        expectedTools: ['apply_filter'],
        expectedPayload: { stop: ['3'] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('stop', '3'),
          expectNoStopValueAboveThree(),
        ],
      },
      {
        user: 'Best value option?',
        expectedTools: [RESULT_REASONING_TOOL],
        expectedPayload: { indexes: null },
        checks: [expectTools([RESULT_REASONING_TOOL])],
      },
      {
        user: 'Actually change origin to NYC and destination to LAX on Dec 25 with non-stop only.',
        expectedTools: ['flight_search', 'apply_filter'],
        expectedPayload: { search: 'NYC -> LAX, Dec 25', stop: ['0'] },
        checks: [
          expectTools(['flight_search', 'apply_filter']),
          expectSearchKeyChanged(),
          expectSearchInputMatches({ origin: /nyc|new york|jfk/i, destination: /lax|los angeles/i }),
          expectAirportContextRefreshedForLaxSearch(),
          expectPayloadIncludes('stop', '0'),
        ],
      },
      {
        user: 'Apply all nearby airports.',
        expectedTools: ['apply_filter'],
        expectedPayload: {
          outbounddepart: 'nearby current departure codes',
          outboundarrival: 'nearby current arrival codes',
        },
        checks: [
          expectTools(['apply_filter']),
          expectContextAirportCodes('outbounddepart', 'nearby'),
          expectContextAirportCodes('outboundarrival', 'nearby'),
        ],
      },
      {
        user: 'I mean arrival airport Santa Ana only.',
        expectedTools: ['apply_filter'],
        expectedPayload: { outboundarrival: ['SNA'] },
        checks: [expectTools(['apply_filter']), expectPayloadIncludes('outboundarrival', 'SNA')],
      },
      {
        user: 'Make it 3 adults, 1 child, economy.',
        expectedTools: ['flight_search'],
        expectedPayload: { adults: 3, children: 1, cabin_class: 'economy' },
        checks: [
          expectTools(['flight_search']),
          expectSearchKeyChanged(),
          expectSearchInputMatches({ adults: 3, children: 1, cabinClass: 'economy' }),
        ],
      },
      {
        user: 'Now show Air Canda, evening departure, layover under 3 hours.',
        expectedTools: ['apply_filter'],
        expectedPayload: { airline: ['AC', 'AC+'], departtimeslotfilter: ['EVENING'], departlayoverfilter: [0, 180] },
        checks: [
          expectTools(['apply_filter']),
          expectPayloadIncludes('airline', 'AC'),
          expectPayloadIncludes('airline', 'AC+'),
          expectPayloadIncludes('departtimeslotfilter', 'EVENING'),
          expectDurationPayload('departlayoverfilter', 180),
        ],
      },
      {
        user: 'Make it cheaper.',
        expectedTools: [],
        expectedPayload: { clarification: 'price filter threshold vs cheapest recommendation' },
        checks: [expectTools([]), expectOneFocusedClarification()],
      },
      {
        user: 'Okay, show shortest duration among these.',
        expectedTools: [RESULT_REASONING_TOOL],
        expectedPayload: { indexes: null },
        checks: [expectTools([RESULT_REASONING_TOOL])],
      },
      {
        user: 'Not this one, compare current options instead.',
        expectedTools: [RESULT_REASONING_TOOL],
        expectedPayload: { indexes: null },
        checks: [expectTools([RESULT_REASONING_TOOL])],
      },
    ],
  },
];

async function runTurn({ context, scenario, turn, turnNumber }) {
  const before = snapshotContext(context);
  const beforeCallCount = context.toolCallLog.length;
  const startedAt = Date.now();
  const result = await runFlightAgent({
    input: turn.user,
    sessionId: scenario.id,
    requestId: `${scenario.id}-turn-${turnNumber}`,
    context,
  });
  const latencyMs = Date.now() - startedAt;
  const calls = context.toolCallLog.slice(beforeCallCount);
  const actualTools = calls.map((call) => call.tool);
  const after = snapshotContext(context);
  const checkArgs = {
    scenario,
    turn,
    before,
    after,
    context,
    calls,
    actualTools,
    response: result.output || '',
  };
  const errors = [...commonChecks, ...(turn.checks || [])].flatMap((check) => check(checkArgs));
  const latestApply = latestApplyCall(calls);

  return {
    turnNumber,
    user: turn.user,
    expectedTools: turn.expectedTools,
    actualTools,
    expectedPayload: turn.expectedPayload,
    actualPayload: formatCalls(calls),
    searchKeyBefore: before.searchKey,
    searchKeyAfter: after.searchKey,
    searchKeyUsed: calls
      .filter((call) => call.tool === 'apply_filter' || call.tool === RESULT_REASONING_TOOL)
      .map((call) => call.searchKey || null),
    latestSearchKeyUsed: errors.every((error) => !/stale searchKey|before any valid searchKey/i.test(error)),
    finalFilterPayload: latestApply?.finalFilterPayload || null,
    response: result.output || '',
    responseQuality: errors.filter((error) =>
      /response|mobile|table|internal|question|origin|destination|date/i.test(error),
    ),
    latencyMs,
    pass: errors.length === 0,
    errors,
  };
}

async function runScenario(scenario) {
  await clearFlightAgentSession(scenario.id);
  const context = {
    UID: `deep-${scenario.id}`,
    uid: `deep-${scenario.id}`,
    toolCallLog: [],
  };
  const turns = [];

  for (const [index, turn] of scenario.turns.entries()) {
    turns.push(await runTurn({ context, scenario, turn, turnNumber: index + 1 }));
  }

  return {
    id: scenario.id,
    title: scenario.title,
    totalTurns: turns.length,
    passedTurns: turns.filter((turn) => turn.pass).length,
    failedTurns: turns.filter((turn) => !turn.pass).length,
    pass: turns.every((turn) => turn.pass),
    finalContext: snapshotContext(context),
    turns,
  };
}

const startedAt = Date.now();
const scenarioReports = [];

for (const scenario of scenarios) {
  scenarioReports.push(await runScenario(scenario));
}

const allTurns = scenarioReports.flatMap((scenario) => scenario.turns);
const failedTurns = allTurns.filter((turn) => !turn.pass);
const wrongToolCalls = failedTurns.filter((turn) =>
  turn.errors.some((error) => /^Expected tools|^Expected one of/.test(error)),
);
const emptyFilterPayloads = failedTurns.filter((turn) =>
  turn.errors.some((error) => /empty final filter payload/i.test(error)),
);
const staleSearchKeyIssues = failedTurns.filter((turn) =>
  turn.errors.some((error) => /stale searchKey|before any valid searchKey/i.test(error)),
);
const missedContextIssues = failedTurns.filter((turn) =>
  turn.errors.some((error) => /context|refreshed|Expected .* codes/i.test(error)),
);
const responseQualityIssues = failedTurns.filter((turn) => turn.responseQuality.length > 0);

const summary = {
  generatedAt: new Date().toISOString(),
  model: flightAgentConfig.model,
  totalScenarios: scenarioReports.length,
  passedScenarios: scenarioReports.filter((scenario) => scenario.pass).length,
  failedScenarios: scenarioReports.filter((scenario) => !scenario.pass).length,
  totalTurns: allTurns.length,
  passedTurns: allTurns.filter((turn) => turn.pass).length,
  failedTurns: failedTurns.length,
  wrongToolCallTurns: wrongToolCalls.length,
  emptyFilterPayloadTurns: emptyFilterPayloads.length,
  staleSearchKeyIssueTurns: staleSearchKeyIssues.length,
  missedContextIssueTurns: missedContextIssues.length,
  responseQualityIssueTurns: responseQualityIssues.length,
  totalLatencyMs: Date.now() - startedAt,
  averageTurnLatencyMs: Math.round(
    allTurns.reduce((sum, turn) => sum + turn.latencyMs, 0) / Math.max(allTurns.length, 1),
  ),
};

function issueLine(turn) {
  return turn.pass ? 'PASS' : `FAIL: ${turn.errors.join(' | ')}`;
}

const textLines = [
  '# Flight Agent deep multi-turn chat report',
  `Generated: ${summary.generatedAt}`,
  `Model: ${summary.model}`,
  `Scenarios: ${summary.passedScenarios}/${summary.totalScenarios} passed`,
  `Turns: ${summary.passedTurns}/${summary.totalTurns} passed`,
  `Wrong tool-call turns: ${summary.wrongToolCallTurns}`,
  `Empty filter payload turns: ${summary.emptyFilterPayloadTurns}`,
  `Stale searchKey issue turns: ${summary.staleSearchKeyIssueTurns}`,
  `Missed context issue turns: ${summary.missedContextIssueTurns}`,
  `Response quality issue turns: ${summary.responseQualityIssueTurns}`,
  `Average turn latency: ${summary.averageTurnLatencyMs}ms`,
  '',
  ...scenarioReports.flatMap((scenario) => [
    `## ${scenario.pass ? 'PASS' : 'FAIL'} - ${scenario.title}`,
    ...scenario.turns.map(
      (turn) =>
        `Turn ${turn.turnNumber}: ${turn.user} -> ${
          turn.actualTools.join(' -> ') || '(none)'
        } - ${issueLine(turn)}`,
    ),
    '',
  ]),
];

await fs.mkdir(path.dirname(REPORT_JSON), { recursive: true });
await fs.writeFile(REPORT_JSON, JSON.stringify({ summary, scenarios: scenarioReports }, null, 2));
await fs.writeFile(REPORT_TXT, textLines.join('\n'));

console.log(textLines.join('\n'));
console.log(`JSON report: ${REPORT_JSON}`);
console.log(`Text report: ${REPORT_TXT}`);

if (summary.failedTurns > 0) {
  process.exitCode = 1;
}
