process.env.OPENAI_FLIGHT_MODEL =
  process.env.OPENAI_FLIGHT_DEEP_CHAT_MODEL ||
  process.env.OPENAI_FLIGHT_MODEL ||
  'gpt-5.4-mini';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '10';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { clearFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const SUGGESTED_TOOL = 'update_flight_suggested_questions';
const REASONING_TOOL = 'getGeneratedContractsContext';
const RESULTS_DIR = path.resolve('tests/results');
const REPORT_JSON = path.join(
  RESULTS_DIR,
  'flight-agent-intelligence-deep-chats-latest.json',
);
const REPORT_TEXT = path.join(
  RESULTS_DIR,
  'flight-agent-intelligence-deep-chats-latest.txt',
);
const DAY_MS = 24 * 60 * 60 * 1000;
const TURN_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.FLIGHT_DEEP_CHAT_TURN_DELAY_MS || '20000', 10) || 0,
);
const CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.FLIGHT_DEEP_CHAT_CHAT_LIMIT || '2', 10) || 2,
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startOfUtcDay(value = new Date()) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value, days) {
  return new Date(value.getTime() + days * DAY_MS);
}

function isoDate(value) {
  return value.toISOString().slice(0, 10);
}

function userDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

const today = startOfUtcDay();
const chat1Outbound = addDays(today, 35);
const chat1UpdatedOutbound = addDays(chat1Outbound, 2);
const chat1Return = addDays(chat1UpdatedOutbound, 7);
const chat2Outbound = addDays(today, 56);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sameSequence(actual, expected) {
  return actual.length === expected.length && actual.every((tool, index) => tool === expected[index]);
}

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function problem(category, message, rootCause, suggestedFix) {
  return { category, message, rootCause, suggestedFix };
}

const causes = {
  routing:
    'The model selected the wrong tool path or violated the required final suggestion-update call.',
  payload:
    'The model extracted the wrong fields, or tool normalization produced an unexpected API payload.',
  state:
    'Turn context was not carried forward, reset, or synchronized with the newest searchKey correctly.',
  suggestions:
    'The suggestion-generation prompt or update tool produced stale, unsafe, or malformed UI actions.',
  response:
    'The final response did not follow the concise mobile response contract.',
  runtime:
    'The Agents SDK/model request failed before the expected workflow could complete.',
};

const fixes = {
  routing: 'Tighten the intent precedence and required tool-chain examples in Flight Agent instructions.',
  payload: 'Tighten the tool schema/example and add deterministic normalization for the failed field.',
  state: 'Synchronize state in the runner/tool boundary and add a regression around the failing turn.',
  suggestions: 'Strengthen suggestion constraints and execution-time context checks.',
  response: 'Tighten the matching mobile response pattern and add a response guardrail.',
  runtime: 'Verify API connectivity, credentials, model access, and runner error handling.',
};

function issue(category, message) {
  return problem(category, message, causes[category], fixes[category]);
}

function firstOnd(input: any = {}) {
  return input.onds?.[0] || {};
}

function latestCall(calls, toolName) {
  return [...calls].reverse().find((call) => call.tool === toolName) || null;
}

function payloadFilter(payload = [], filterType) {
  return (payload || []).find((filter) => filter.filterType === filterType) || null;
}

function apiValues(calls, filterType) {
  return payloadFilter(latestCall(calls, 'apply_filter')?.finalFilterPayload, filterType)?.Values || null;
}

function apiCodes(calls, filterType) {
  return (apiValues(calls, filterType) || [])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function activeCodes(context: any, key, predicate: (option: any) => boolean = () => true) {
  return (Array.isArray(context[key]) ? context[key] : [])
    .filter((option) => option && predicate(option))
    .map((option) => option.Code)
    .filter(Boolean);
}

function summarizePrediction(prediction) {
  if (!prediction) {
    return null;
  }
  return {
    status: prediction.status || null,
    route: prediction.route || null,
    tripType: prediction.tripType || null,
    searchedDateRange: prediction.searchedDateRange || null,
    cheapestDates: prediction.cheapestDates || [],
    cheapestCombinations: prediction.cheapestCombinations || [],
    priceRangeSummary: prediction.priceRangeSummary || null,
    recommendation: prediction.recommendation || null,
  };
}

function snapshotContext(context: any = {}) {
  return {
    searchKey: context.searchKey || null,
    flightSearchKey: context.flight?.searchKey || null,
    sid: context.sid || null,
    lastSearch: context.lastSearch || null,
    lastAppliedFilters: context.lastAppliedFilters || [],
    lastFinalFilterPayload: context.lastFinalFilterPayload || [],
    filteredCount: context.filteredFlightResults?.length || 0,
    resultCount: context.flightResults?.length || 0,
    suggestedQuestions: context.flight?.suggestedQuestions || [],
    lastPricePrediction: summarizePrediction(context.flight?.lastPricePrediction),
  };
}

function formatCalls(calls = []) {
  return calls.map((call) => ({
    tool: call.tool,
    searchKey: call.searchKey || null,
    input: call.input || null,
    indexes: call.indexes ?? null,
    status: call.status || call.code || null,
    filters: call.filters || null,
    finalFilterPayload: call.finalFilterPayload || null,
    feedback: call.feedback || null,
    predictionCount: call.predictionCount ?? null,
    suggestedQuestions: call.suggestedQuestions || null,
  }));
}

function expectSearch(expected) {
  return ({ calls }) => {
    const call = latestCall(calls, 'flight_search');
    if (!call) {
      return [issue('payload', 'Expected a flight_search payload but no search call was recorded.')];
    }

    const input = call.input || {};
    const ond = firstOnd(input);
    const errors = [];
    const checks = [
      ['origin', ond.origin],
      ['destination', ond.destination],
      ['outboundDate', ond.outbound_date],
      ['returnDate', ond.return_date],
      ['tripType', input.trip_type],
      ['cabin', input.cabin_class],
      ['adults', input.passengers?.adults],
      ['children', input.passengers?.children],
    ];

    for (const [field, actual] of checks) {
      if (!(field in expected)) {
        continue;
      }
      const wanted = expected[field];
      const matches = wanted instanceof RegExp ? wanted.test(compact(actual)) : actual === wanted;
      if (!matches) {
        errors.push(issue('payload', `Expected search ${field} ${String(wanted)}, got ${String(actual)}.`));
      }
    }
    return errors;
  };
}

function expectApiFilter(filterType, expectedValues, { includes = false } = {}) {
  return ({ calls }) => {
    const actual = apiValues(calls, filterType);
    if (!actual) {
      return [issue('payload', `Expected ${filterType} in the final filter payload.`)];
    }
    const matches = includes
      ? expectedValues.every((value) => actual.some((item) => String(item).includes(String(value))))
      : sameArray(actual, expectedValues);
    return matches
      ? []
      : [
          issue(
            'payload',
            `Expected ${filterType} values ${JSON.stringify(expectedValues)}, got ${JSON.stringify(actual)}.`,
          ),
        ];
  };
}

function expectNoActiveFilterType(filterType) {
  return ({ context }) =>
    (context.lastAppliedFilters || []).some((filter) => filter.filterType === filterType)
      ? [issue('state', `Expected active ${filterType} state to be removed.`)]
      : [];
}

function expectResetState() {
  return ({ calls, context }) => {
    const errors = expectApiFilter('reset', [])({ calls });
    if ((context.lastAppliedFilters || []).length > 0) {
      errors.push(issue('state', 'Reset left active filter state in context.'));
    }
    return errors;
  };
}

function expectReasoningIndexes(expectedIndexes) {
  return ({ calls }) => {
    const call = latestCall(calls, REASONING_TOOL);
    if (!call) {
      return [issue('routing', `Expected ${REASONING_TOOL} for current-result reasoning.`)];
    }
    const matches =
      expectedIndexes === null
        ? call.indexes === null
        : sameArray(call.indexes, expectedIndexes);
    return matches
      ? []
      : [issue('payload', `Expected reasoning indexes ${JSON.stringify(expectedIndexes)}, got ${JSON.stringify(call.indexes)}.`)];
  };
}

function expectPrediction({ status, origin, destination, tripType = 'oneway', duration, flexibility }: any) {
  return ({ calls, context }) => {
    const call = latestCall(calls, 'price_prediction_tool');
    const prediction = context.flight?.lastPricePrediction;
    const errors = [];
    if (!call || !prediction) {
      return [issue('routing', 'Expected price_prediction_tool and a stored prediction result.')];
    }
    const intentWindow = context.flight?.pricePredictionDateIntent?.predictionWindow;
    if (
      call.input?.startDate !== intentWindow?.startDate ||
      call.input?.endDate !== intentWindow?.endDate
    ) {
      errors.push(issue('payload', 'Prediction did not use the complete rolling 89-day window.'));
    }
    if (prediction.status !== status) {
      errors.push(issue('payload', `Expected prediction status ${status}, got ${prediction.status}.`));
    }
    if (prediction.route?.originCity !== origin || prediction.route?.destinationCity !== destination) {
      errors.push(issue('payload', `Expected prediction route ${origin}-${destination}, got ${JSON.stringify(prediction.route)}.`));
    }
    if (prediction.tripType !== tripType) {
      errors.push(issue('payload', `Expected prediction tripType ${tripType}, got ${prediction.tripType}.`));
    }
    if (tripType === 'roundtrip') {
      if (
        call.input?.returnStartDate !== intentWindow?.startDate ||
        call.input?.returnEndDate !== intentWindow?.endDate
      ) {
        errors.push(issue('payload', 'Round-trip prediction did not use the full return window.'));
      }
      if (duration !== undefined && call.input?.tripDuration !== duration) {
        errors.push(issue('payload', `Expected tripDuration ${duration}, got ${call.input?.tripDuration}.`));
      }
      if (flexibility !== undefined && call.input?.tripDurationFlexibility !== flexibility) {
        errors.push(issue('payload', `Expected tripDurationFlexibility ${flexibility}, got ${call.input?.tripDurationFlexibility}.`));
      }
    }
    return errors;
  };
}

function expectSearchUsesPreviousPrediction(kind) {
  return ({ calls, before }) => {
    const call = latestCall(calls, 'flight_search');
    const prediction = before.lastPricePrediction;
    if (!call || !prediction) {
      return [issue('state', 'Expected search to reuse the immediately previous prediction result.')];
    }
    const ond = firstOnd(call.input);
    if (kind === 'roundtrip') {
      const best = prediction.cheapestCombinations?.[0];
      return best && ond.outbound_date === best.outboundDate && ond.return_date === best.returnDate
        ? []
        : [issue('state', `Search did not use the best predicted round-trip combination ${JSON.stringify(best)}.`)];
    }
    const best = prediction.cheapestDates?.[0];
    return best && ond.outbound_date === best.departureDate
      ? []
      : [issue('state', `Search did not use the best predicted date ${JSON.stringify(best)}.`)];
  };
}

function expectNewSearchKey() {
  return ({ calls, before, after }) => {
    const search = latestCall(calls, 'flight_search');
    const errors = [];
    if (!search?.searchKey || after.searchKey !== search.searchKey) {
      errors.push(issue('state', 'Context did not adopt the searchKey created by the latest search.'));
    }
    if (before.searchKey && before.searchKey === after.searchKey) {
      errors.push(issue('state', `Expected a fresh searchKey, but ${after.searchKey} was reused.`));
    }
    return errors;
  };
}

function expectSearchResetOldFilters() {
  return ({ context }) => {
    const errors = [];
    if ((context.lastAppliedFilters || []).length > 0) {
      errors.push(issue('state', 'A new search retained stale active filters.'));
    }
    if ((context.lastFinalFilterPayload || []).length > 0) {
      errors.push(issue('state', 'A new search retained the previous final filter payload.'));
    }
    return errors;
  };
}

function expectResponse(pattern, message = '') {
  return ({ response }) =>
    pattern.test(response) ? [] : [issue('response', message || `Response did not match ${pattern}.`)];
}

function expectNoPriceInFallback() {
  return ({ response, context }) => {
    const errors = [];
    const fallbackDate =
      context.flight?.dateIntent?.priceFallbackDate ||
      context.flight?.pricePredictionDateIntent?.fallbackDate ||
      null;
    if (!fallbackDate) {
      errors.push(issue('payload', 'No internal non-predicted fallback date was retained.'));
    }
    if (/\$\s?\d|USD\s?\d|INR\s?\d/i.test(response)) {
      errors.push(issue('response', 'Fallback response invented or exposed an exact fare.'));
    }
    return errors;
  };
}

function combine(...checks) {
  return (args) => checks.flatMap((check) => check(args));
}

const chats = [
  {
    id: 'intelligence-chat-1-progressive-search',
    title: 'Progressive details, context carry-forward, search changes, filter, reset, and comparison',
    turns: [
      {
        user: 'Uh, I need to get to Mumbai. Business class for me and my wife.',
        expectedBehavior: 'Acknowledge known details, do not search, and ask naturally for missing route/date information.',
        expectedTools: [SUGGESTED_TOOL],
        expectedPayload: { suggestedQuestions: [], search: 'not called' },
        check: expectResponse(/from|origin|departure|date|when/i, 'Partial-search response did not ask for missing travel details.'),
      },
      {
        user: `Delhi, and let's go on ${userDate(chat1Outbound)}.`,
        expectedBehavior: 'Search one-way Delhi to Mumbai using carried business cabin and two adults.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: {
          origin: 'Delhi', destination: 'Mumbai', outboundDate: isoDate(chat1Outbound), adults: 2, cabin: 'business',
        },
        check: combine(
          expectSearch({
            origin: /delhi|del/i,
            destination: /mumbai|bom/i,
            outboundDate: isoDate(chat1Outbound),
            adults: 2,
            children: 0,
            cabin: 'business',
            tripType: 'oneway',
          }),
          expectNewSearchKey(),
        ),
      },
      {
        user: "Actually economy, and our 8-year-old is coming too. Same route and date.",
        expectedBehavior: 'Run a fresh search while carrying route/date and updating cabin/passengers only.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { adults: 2, children: 1, cabin: 'economy', carriedRouteAndDate: true },
        check: combine(
          expectSearch({
            origin: /delhi|del/i,
            destination: /mumbai|bom/i,
            outboundDate: isoDate(chat1Outbound),
            adults: 2,
            children: 1,
            cabin: 'economy',
          }),
          expectNewSearchKey(),
        ),
      },
      {
        user: `Push it to ${userDate(chat1UpdatedOutbound)}. Same everything else.`,
        expectedBehavior: 'Run a fresh search with only the outbound date changed.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { outboundDate: isoDate(chat1UpdatedOutbound), carriedRouteCabinPassengers: true },
        check: combine(
          expectSearch({
            origin: /delhi|del/i,
            destination: /mumbai|bom/i,
            outboundDate: isoDate(chat1UpdatedOutbound),
            adults: 2,
            children: 1,
            cabin: 'economy',
          }),
          expectNewSearchKey(),
        ),
      },
      {
        user: `Make it round trip; we'll return ${userDate(chat1Return)}.`,
        expectedBehavior: 'Run a fresh round-trip search and preserve all unchanged details.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { tripType: 'roundtrip', returnDate: isoDate(chat1Return) },
        check: combine(
          expectSearch({
            outboundDate: isoDate(chat1UpdatedOutbound),
            returnDate: isoDate(chat1Return),
            tripType: 'roundtrip',
            adults: 2,
            children: 1,
            cabin: 'economy',
          }),
          expectNewSearchKey(),
        ),
      },
      {
        user: 'Okay, show morning departures, non-stop only, with a carry-on.',
        expectedBehavior: 'Apply all three filters to the latest round-trip search without re-searching.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { stop: ['0'], departtimeslotfilter: ['MORNING'], baggage: ['1'] },
        check: combine(
          expectApiFilter('stop', ['0']),
          expectApiFilter('departtimeslotfilter', ['MORNING']),
          expectApiFilter('baggage', ['1']),
        ),
      },
      {
        user: 'Which one is the best value now?',
        expectedBehavior: 'Fetch current contracts using the active filtered result set and recommend from tool data.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: null, searchKey: 'latest' },
        check: combine(
          expectReasoningIndexes(null),
          expectResponse(/option|best|value|air canada|price|\$|USD/i),
        ),
      },
      {
        user: 'Clear all filters. I want the full list back.',
        expectedBehavior: 'Reset all filters on the current search.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { reset: [] },
        check: expectResetState(),
      },
      {
        user: 'Compare option 1 and option 3 for me.',
        expectedBehavior: 'Fetch only options 1 and 3 from current results and compare them.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: [1, 3], searchKey: 'latest' },
        check: combine(
          expectReasoningIndexes([1, 3]),
          expectResponse(/option 1|option 3|air canada|emirates/i),
        ),
      },
    ],
  },
  {
    id: 'intelligence-chat-2-filter-lifecycle',
    title: 'Dense filter lifecycle, partial removal, full removal, reset, airports, and latest searchKey',
    turns: [
      {
        user: `Find NYC to LAX flights on ${userDate(chat2Outbound)}, economy, just me.`,
        expectedBehavior: 'Create the active search context used by every later filter turn.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { origin: 'NYC', destination: 'LAX', outboundDate: isoDate(chat2Outbound), adults: 1 },
        check: combine(
          expectSearch({
            origin: /nyc|new york/i,
            destination: /lax|los angeles/i,
            outboundDate: isoDate(chat2Outbound),
            adults: 1,
            cabin: 'economy',
          }),
          expectNewSearchKey(),
        ),
      },
      {
        user: 'Pile these on: one stop, Air Canada and Emirates, checked baggage, morning departure, evening arrival, layover in Dubai, depart JFK, arrive LAX.',
        expectedBehavior: 'Apply every stated filter in one call using the active searchKey and report no-match feedback naturally if needed.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: {
          stop: ['2'], airline: ['AC', 'AC+', 'EK'], baggage: ['0'], departure: ['MORNING'], arrival: ['EVENING'], layover: ['DXB'], departAirport: ['JFK'], arrivalAirport: ['LAX'],
        },
        failedActionPattern: /one[- ]?stop.*morning.*dubai|dubai.*morning.*one[- ]?stop/i,
        check: combine(
          expectApiFilter('stop', ['2']),
          expectApiFilter('airline', ['AC', 'AC+', 'EK'], { includes: true }),
          expectApiFilter('baggage', ['0']),
          expectApiFilter('departtimeslotfilter', ['MORNING']),
          expectApiFilter('departlandtimeslotfilter', ['EVENING']),
          expectApiFilter('outboundlayover', ['DXB']),
          expectApiFilter('outbounddepart', ['JFK']),
          expectApiFilter('outboundarrival', ['LAX']),
        ),
      },
      {
        user: 'That was too much. Drop Air Canada and remove the Dubai layover, but keep Emirates and the rest.',
        expectedBehavior: 'Partially remove airline values, clear the layover airport type, and preserve unrelated filters.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { airline: ['EK'], outboundlayover: ['all'], preserveOtherFilters: true },
        check: combine(
          expectApiFilter('airline', ['EK']),
          expectApiFilter('outboundlayover', ['all']),
          expectNoActiveFilterType('layoverAirport'),
          expectApiFilter('stop', ['2']),
          expectApiFilter('baggage', ['0']),
        ),
      },
      {
        user: 'Clear the baggage filter completely.',
        expectedBehavior: 'Clear the full baggage filter while preserving other active filters.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { baggage: [], preserveAirlineAndTimes: true },
        check: combine(
          expectApiFilter('baggage', []),
          expectNoActiveFilterType('baggage'),
          expectApiFilter('airline', ['EK']),
        ),
      },
      {
        user: 'Use nearby departure and nearby arrival airports instead.',
        expectedBehavior: 'Replace endpoint airport filters with the current search source options marked nearby.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { departureAirports: 'all nearby context codes', arrivalAirports: 'all nearby context codes' },
        check: ({ calls, context }) => {
          const departure = apiCodes(calls, 'outbounddepart');
          const arrival = apiCodes(calls, 'outboundarrival');
          const expectedDeparture = activeCodes(context, 'DepartAirports', (option) => option.IsNearby === true);
          const expectedArrival = activeCodes(context, 'DepLandAirports', (option) => option.IsNearby === true);
          const errors = [];
          if (!expectedDeparture.every((code) => departure.includes(code))) {
            errors.push(issue('payload', `Nearby departure payload missed context codes ${JSON.stringify(expectedDeparture)}.`));
          }
          if (!expectedArrival.every((code) => arrival.includes(code))) {
            errors.push(issue('payload', `Nearby arrival payload missed context codes ${JSON.stringify(expectedArrival)}.`));
          }
          return errors;
        },
      },
      {
        user: 'Reset every filter. Seriously, wipe the slate clean.',
        expectedBehavior: 'Emit the reset payload and clear all active filter state.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { reset: [] },
        check: expectResetState(),
      },
      {
        user: 'Now just Emirates, evening arrival, and layover under 3 hours.',
        expectedBehavior: 'Apply only the new post-reset filters using the unchanged current searchKey.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { airline: ['EK'], arrival: ['EVENING'], layoverDuration: [0, 180] },
        check: combine(
          expectApiFilter('airline', ['EK']),
          expectApiFilter('departlandtimeslotfilter', ['EVENING']),
          expectApiFilter('departlayoverfilter', [0, 180]),
        ),
      },
      {
        user: 'Remove only Emirates; keep the arrival-time and layover-duration filters.',
        expectedBehavior: 'Clear the sole airline value and preserve both unrelated filters.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { airline: ['all'], preserveArrivalAndDuration: true },
        check: combine(
          expectApiFilter('airline', ['all']),
          expectNoActiveFilterType('airline'),
          expectApiFilter('departlandtimeslotfilter', ['EVENING']),
          expectApiFilter('departlayoverfilter', [0, 180]),
        ),
      },
      {
        user: 'Clear the arrival-time filter too.',
        expectedBehavior: 'Clear arrival time only and leave layover duration active.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { arrivalTime: [], layoverDuration: [0, 180] },
        check: combine(
          expectApiFilter('departlandtimeslotfilter', []),
          expectNoActiveFilterType('arrivalTime'),
          expectApiFilter('departlayoverfilter', [0, 180]),
        ),
      },
      {
        user: 'Compare the current options and tell me which is best.',
        expectedBehavior: 'Fetch all current options using the same searchKey and provide grounded reasoning.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: null, searchKey: 'unchanged latest' },
        check: combine(
          expectReasoningIndexes(null),
          expectResponse(/option|best|compare|air canada|air china|emirates/i),
        ),
      },
    ],
  },
  {
    id: 'intelligence-chat-3-prediction-to-results',
    title: 'Prediction fallback, flexible dates, selected-date search, filters, and repeated current-result reasoning',
    turns: [
      {
        user: "I'm flexible for DEL to DXB. Any date next month; give me the cheapest.",
        expectedBehavior: 'Call prediction first, explain unsupported-route fallback, and avoid invented prices.',
        expectedTools: ['price_prediction_tool', SUGGESTED_TOOL],
        expectedPayload: { route: 'DEL-DXB', fullWindow: true, status: 'NO_PREDICTIONS', suggestedQuestions: [] },
        check: combine(
          expectPrediction({ status: 'NO_PREDICTIONS', origin: 'DEL', destination: 'DXB' }),
          expectNoPriceInFallback(),
          expectResponse(/unavailable|prediction|general|midweek|search/i),
        ),
      },
      {
        user: 'Fine, use JFK to LAX instead. Find the cheapest date next month.',
        expectedBehavior: 'Run supported prediction over the fixed window and rank only next-month dates.',
        expectedTools: ['price_prediction_tool', SUGGESTED_TOOL],
        expectedPayload: { route: 'JFK-LAX', fullWindow: true, status: 'SUCCESS', preference: 'next month' },
        check: combine(
          expectPrediction({ status: 'SUCCESS', origin: 'JFK', destination: 'LAX' }),
          expectResponse(/best|great deal|fair price|\$|search flights/i),
        ),
      },
      {
        user: 'Yep, search the cheapest one you found.',
        expectedBehavior: 'Search the exact best predicted one-way date and create the first active searchKey.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { route: 'JFK-LAX', outboundDate: 'previous cheapestDates[0]' },
        check: combine(
          expectSearchUsesPreviousPrediction('oneway'),
          expectSearch({ origin: 'JFK', destination: 'LAX', tripType: 'oneway' }),
          expectNewSearchKey(),
        ),
      },
      {
        user: 'Now only non-stop flights with a carry-on.',
        expectedBehavior: 'Filter the selected-date search using its current searchKey.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { stop: ['0'], baggage: ['1'] },
        check: combine(expectApiFilter('stop', ['0']), expectApiFilter('baggage', ['1'])),
      },
      {
        user: 'Which flight is cheapest now?',
        expectedBehavior: 'Fetch all current filtered options and identify the cheapest from tool context.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: null, searchKey: 'latest' },
        check: combine(expectReasoningIndexes(null), expectResponse(/cheapest|option|air canada|\$|USD/i)),
      },
      {
        user: 'Reset the filters; show me all options again.',
        expectedBehavior: 'Reset filters without changing the active searchKey.',
        expectedTools: ['apply_filter', SUGGESTED_TOOL],
        expectedPayload: { reset: [] },
        check: expectResetState(),
      },
      {
        user: 'Compare option 1 and option 3 instead.',
        expectedBehavior: 'Re-fetch the requested current options and compare them.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: [1, 3], searchKey: 'latest' },
        check: combine(expectReasoningIndexes([1, 3]), expectResponse(/option 1|option 3|air canada|emirates/i)),
      },
      {
        user: 'New thought: I can stay a week. Find low-fare round-trip dates NYC to LHR, plus or minus one day.',
        expectedBehavior: 'Run a fresh full-window round-trip prediction with seven-day duration flexibility, without reusing old route data.',
        expectedTools: ['price_prediction_tool', SUGGESTED_TOOL],
        expectedPayload: { route: 'NYC-LHR', tripType: 'roundtrip', duration: 7, flexibility: 1, fullWindow: true },
        check: expectPrediction({
          status: 'SUCCESS', origin: 'NYC', destination: 'LHR', tripType: 'roundtrip', duration: 7, flexibility: 1,
        }),
      },
      {
        user: 'Book search for the cheapest round-trip combo.',
        expectedBehavior: 'Start a new NYC-LHR round-trip search from the latest prediction and clear stale JFK-LAX filters.',
        expectedTools: ['flight_search', SUGGESTED_TOOL],
        expectedPayload: { route: 'NYC-LHR', dates: 'previous cheapestCombinations[0]', newSearchKey: true, filtersCleared: true },
        check: combine(
          expectSearchUsesPreviousPrediction('roundtrip'),
          expectSearch({ origin: 'NYC', destination: 'LHR', tripType: 'roundtrip' }),
          expectNewSearchKey(),
          expectSearchResetOldFilters(),
        ),
      },
      {
        user: 'Compare all current options and tell me the best value.',
        expectedBehavior: 'Reason over the new NYC-LHR result set using the newest searchKey, not the old JFK-LAX key.',
        expectedTools: [REASONING_TOOL, SUGGESTED_TOOL],
        expectedPayload: { indexes: null, searchKey: 'newest NYC-LHR search' },
        check: combine(expectReasoningIndexes(null), expectResponse(/option|best value|recommend|air canada|air china|emirates/i)),
      },
    ],
  },
];

function validateToolSequence(actualTools, expectedTools) {
  return sameSequence(actualTools, expectedTools)
    ? []
    : [
        issue(
          'routing',
          `Expected tools ${expectedTools.join(' -> ')}, got ${actualTools.join(' -> ') || '(none)'}.`,
        ),
      ];
}

function validateLatestSearchKey({ calls, before, after }) {
  const errors = [];
  let latest = before.searchKey;
  for (const call of calls) {
    if (call.tool === 'flight_search') {
      latest = call.searchKey;
    }
    if (
      (call.tool === 'apply_filter' || call.tool === REASONING_TOOL || call.tool === SUGGESTED_TOOL) &&
      call.searchKey !== latest
    ) {
      errors.push(
        issue(
          'state',
          `${call.tool} used searchKey ${call.searchKey || '(none)'}; latest was ${latest || '(none)'}.`,
        ),
      );
    }
  }
  if (after.searchKey !== after.flightSearchKey) {
    errors.push(issue('state', 'context.searchKey and context.flight.searchKey diverged.'));
  }
  if (latest !== after.searchKey) {
    errors.push(issue('state', `Final context searchKey ${after.searchKey} did not match latest tool key ${latest}.`));
  }
  return errors;
}

function validateSuggestions({ turn, before, after, response }) {
  const suggestions = after.suggestedQuestions;
  const errors = [];
  if (!after.searchKey) {
    if (!Array.isArray(suggestions) || suggestions.length !== 0) {
      errors.push(issue('suggestions', 'Suggestions were not cleared while searchKey was missing.'));
    }
    return errors;
  }

  if (!Array.isArray(suggestions) || suggestions.length !== 3) {
    errors.push(issue('suggestions', `Expected exactly 3 suggestions, got ${suggestions?.length ?? 'none'}.`));
    return errors;
  }

  const blockedMandatory = /\b(origin|destination|departure city|arrival city|travel date|return date|date range)\b/i;
  const assistantStyle = /^(would you like|do you want|should i)\b/i;
  for (const suggestion of suggestions) {
    if (typeof suggestion !== 'string' || !suggestion.trim()) {
      errors.push(issue('suggestions', `Invalid suggestion ${JSON.stringify(suggestion)}.`));
      continue;
    }
    if (suggestion.length > 80) {
      errors.push(issue('suggestions', `Suggestion is not mobile-friendly: ${suggestion}`));
    }
    if (assistantStyle.test(suggestion)) {
      errors.push(issue('suggestions', `Suggestion uses assistant-style wording: ${suggestion}`));
    }
    if (blockedMandatory.test(suggestion)) {
      errors.push(issue('suggestions', `Suggestion asks for a blocked mandatory search field: ${suggestion}`));
    }
    if (response.includes(suggestion)) {
      errors.push(issue('suggestions', `Final response exposed internal UI suggestion text: ${suggestion}`));
    }
    if (turn.failedActionPattern?.test(suggestion)) {
      errors.push(issue('suggestions', `Suggestion repeated the failed combined action: ${suggestion}`));
    }
  }
  if (sameArray(before.suggestedQuestions, suggestions)) {
    errors.push(issue('suggestions', 'The exact same 3 suggestions were repeated from the previous turn.'));
  }
  return errors;
}

function validateResponse({ calls, response, result }) {
  const errors = [];
  if (result.error) {
    errors.push(issue('runtime', `Runner returned an error response: ${response}`));
    return errors;
  }
  if (!response.trim()) {
    errors.push(issue('response', 'Agent returned an empty response.'));
  }
  if (/\b(flight_search|apply_filter|getGeneratedContractsContext|price_prediction_tool|update_flight_suggested_questions|searchKey|FINAL_APPLY_FILTER_PAYLOAD)\b/i.test(response)) {
    errors.push(issue('response', 'Agent exposed internal tool or state names.'));
  }
  if (response.length > 1200) {
    errors.push(issue('response', `Response is too long for mobile (${response.length} characters).`));
  }
  if (response.split(/\r?\n/).some((line) => /^\s*\|.+\|\s*$/.test(line))) {
    errors.push(issue('response', 'Response used a markdown table.'));
  }
  const tools = calls.map((call) => call.tool);
  const priceNoteCount = (response.match(/Note: Prices shown are per person\./g) || []).length;
  if (tools.includes('flight_search') && !tools.includes('apply_filter') && priceNoteCount !== 1) {
    errors.push(issue('response', `Search response contained ${priceNoteCount} price notes instead of exactly one.`));
  }
  if (!tools.includes('flight_search') && priceNoteCount > 0) {
    errors.push(issue('response', 'A non-search response repeated the per-person price note.'));
  }
  return errors;
}

async function runTurn({ chat, turn, turnNumber, context }) {
  const before = snapshotContext(context);
  const beforeCallCount = context.toolCallLog.length;
  const startedAt = Date.now();
  let result;

  try {
    result = await runFlightAgent({
      input: turn.user,
      sessionId: chat.id,
      requestId: `${chat.id}-turn-${turnNumber}`,
      context,
    });
  } catch (error: any) {
    result = { output: '', error: true, thrownError: error };
  }

  const calls = context.toolCallLog.slice(beforeCallCount);
  const actualTools = calls.map((call) => call.tool);
  const after = snapshotContext(context);
  const response = result.output || '';
  const args = { chat, turn, calls, actualTools, before, after, context, response, result };
  const issues = [
    ...validateToolSequence(actualTools, turn.expectedTools),
    ...validateLatestSearchKey(args),
    ...validateSuggestions(args),
    ...validateResponse(args),
  ];

  if (turn.check) {
    try {
      issues.push(...turn.check(args));
    } catch (error: any) {
      issues.push(issue('runtime', `Turn validator threw: ${error.message}`));
    }
  }

  return {
    turn: turnNumber,
    userMessage: turn.user,
    expectedAgentBehavior: turn.expectedBehavior,
    agentResponse: response,
    expectedToolCall: turn.expectedTools,
    actualToolCall: actualTools,
    expectedPayload: turn.expectedPayload,
    actualPayload: formatCalls(calls),
    searchKeyBefore: before.searchKey,
    latestSearchKey: after.searchKey,
    suggestedQuestions: after.suggestedQuestions,
    contextBefore: before,
    contextAfter: after,
    pass: issues.length === 0,
    issues,
    latencyMs: Date.now() - startedAt,
  };
}

async function runChat(chat) {
  await clearFlightAgentSession(chat.id);
  const context: any = {
    UID: chat.id,
    uid: chat.id,
    flight: {},
    toolCallLog: [],
  };
  const turns = [];

  for (const [index, turn] of chat.turns.entries()) {
    if (TURN_DELAY_MS > 0) {
      await sleep(TURN_DELAY_MS);
    }
    console.log(`[live-eval] ${chat.id} turn ${index + 1}/${chat.turns.length}`);
    const turnReport = await runTurn({ chat, turn, turnNumber: index + 1, context });
    turns.push(turnReport);
    console.log(`[live-eval] ${chat.id} turn ${index + 1}: ${turnReport.pass ? 'PASS' : 'FAIL'}`);
  }

  await clearFlightAgentSession(chat.id);
  return {
    id: chat.id,
    title: chat.title,
    pass: turns.every((turn) => turn.pass),
    passedTurns: turns.filter((turn) => turn.pass).length,
    failedTurns: turns.filter((turn) => !turn.pass).length,
    finalContext: snapshotContext(context),
    turns,
  };
}

function buildTextReport(report) {
  const lines = [
    '# Flight Agent Intelligence Deep Chats',
    `Generated: ${report.summary.generatedAt}`,
    `Model: ${report.summary.model}`,
    `Chats: ${report.summary.passedChats}/${report.summary.totalChats} passed`,
    `Turns: ${report.summary.passedTurns}/${report.summary.totalTurns} passed`,
    `Success: ${report.summary.successPercentage}%`,
    `Turn delay: ${report.summary.turnDelayMs}ms`,
    `Total latency: ${report.summary.totalLatencyMs}ms`,
    '',
  ];

  for (const chat of report.chats) {
    lines.push(`## ${chat.pass ? 'PASS' : 'FAIL'} - ${chat.title}`);
    for (const turn of chat.turns) {
      lines.push(`Turn ${turn.turn}: ${turn.userMessage}`);
      lines.push(`  Expected: ${turn.expectedToolCall.join(' -> ')}`);
      lines.push(`  Actual: ${turn.actualToolCall.join(' -> ') || '(none)'}`);
      lines.push(`  Latest searchKey: ${turn.latestSearchKey || '(none)'}`);
      lines.push(`  Suggestions: ${JSON.stringify(turn.suggestedQuestions)}`);
      lines.push(`  Result: ${turn.pass ? 'PASS' : 'FAIL'}`);
      for (const foundIssue of turn.issues) {
        lines.push(`  Issue [${foundIssue.category}]: ${foundIssue.message}`);
        lines.push(`  Root cause: ${foundIssue.rootCause}`);
        lines.push(`  Suggested fix: ${foundIssue.suggestedFix}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

const suiteStartedAt = Date.now();
const chatReports = [];
for (const chat of chats.slice(0, CHAT_LIMIT)) {
  chatReports.push(await runChat(chat));
}

const allTurns = chatReports.flatMap((chat) => chat.turns);
const passedTurns = allTurns.filter((turn) => turn.pass).length;
const report = {
  summary: {
    generatedAt: new Date().toISOString(),
    model: flightAgentConfig.model,
    totalChats: chatReports.length,
    passedChats: chatReports.filter((chat) => chat.pass).length,
    failedChats: chatReports.filter((chat) => !chat.pass).length,
    totalTurns: allTurns.length,
    passedTurns,
    failedTurns: allTurns.length - passedTurns,
    successPercentage: Number(((passedTurns / Math.max(allTurns.length, 1)) * 100).toFixed(1)),
    turnDelayMs: TURN_DELAY_MS,
    totalLatencyMs: Date.now() - suiteStartedAt,
    issueCounts: allTurns
      .flatMap((turn) => turn.issues)
      .reduce((counts, foundIssue) => {
        counts[foundIssue.category] = (counts[foundIssue.category] || 0) + 1;
        return counts;
      }, {}),
  },
  chats: chatReports,
};

await fs.mkdir(RESULTS_DIR, { recursive: true });
await fs.writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(REPORT_TEXT, buildTextReport(report));

console.log(buildTextReport(report));
console.log(`JSON report: ${REPORT_JSON}`);
console.log(`Text report: ${REPORT_TEXT}`);

if (report.summary.failedTurns > 0) {
  process.exitCode = 1;
}
