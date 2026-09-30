process.env.OPENAI_FLIGHT_MODEL = 'gpt-5.1';
process.env.FLIGHT_AGENT_LOG_LEVEL ||= 'error';
process.env.FLIGHT_AGENT_MAX_TURNS ||= '6';

import fs from 'node:fs/promises';
import path from 'node:path';

const { clearFlightAgentSession, getFlightAgentSession, runFlightAgent } = await import('../../src/agents/flight/runner.js');
const { flightAgentConfig } = await import('../../src/agents/flight/config.js');

const scenarios = [
  {
    id: 'session_complex_1',
    title: 'Search change plus filters and filter replacement',
    turns: [
      {
        user: 'Find flights from Delhi to Mumbai on 2026-07-10 for 1 adult economy',
        expectedTools: ['flight_search'],
        checks: [
          requireSearchKey(),
          requireLastSearch('onds.0.destination', /Mumbai/i),
          requireLastSearch('passengers.adults', 1),
        ],
      },
      {
        user: 'Change it to Delhi to Bangalore on 2026-07-12 for 2 adults, non-stop only, and under $250',
        expectedTools: ['flight_search', 'apply_filter'],
        checks: [
          requireSearchCallCount(2),
          requireSearchKeyChangedSinceTurn(1),
          requireLastSearch('onds.0.destination', /Bangalore/i),
          requireLastSearch('passengers.adults', 2),
          requireFilter('stops', '0'),
          requirePriceRange(0, 250),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
      {
        user: 'Add checked baggage and morning departure',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('baggage', '0'),
          requireFilter('departureTime', 'MORNING'),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
      {
        user: 'Remove checked baggage and price filter, use carry-on baggage and evening arrival instead',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('baggage', '1'),
          requireFilter('arrivalTime', 'EVENING'),
          requireNoFilter('baggage', '0'),
          requireNoPriceFilter(),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
    ],
  },
  {
    id: 'session_complex_2',
    title: 'Filter-only after search exists with baggage, stops, time, layover',
    turns: [
      {
        user: 'Find round trip flights from NYC to London departing 2026-08-01 returning 2026-08-10 for 2 adults premium economy',
        expectedTools: ['flight_search'],
        checks: [
          requireSearchKey(),
          requireLastSearch('trip_type', 'roundtrip'),
          requireLastSearch('onds.0.return_date', '2026-08-10'),
          requireLastSearch('passengers.adults', 2),
        ],
      },
      {
        user: 'Show one-stop flights with checked baggage and evening arrival',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('stops', '2'),
          requireFilter('baggage', '0'),
          requireFilter('arrivalTime', 'EVENING'),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
      {
        user: 'Add layover between 1 and 3 hours and price between 150 and 220 dollars',
        expectedTools: ['apply_filter'],
        checks: [
          requireDurationMax('layoverDuration', 180),
          requirePriceRange(0, 220),
          requireFeedback(/layover duration minimum of 60 minutes.*ignored/i),
          requireFeedback(/price minimum of 150.*ignored/i),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
    ],
  },
  {
    id: 'session_complex_3',
    title: 'Filter-only without searchKey then details supplied from session history',
    turns: [
      {
        user: 'Show me non-stop morning flights with carry-on baggage under $200',
        expectedTools: [],
        checks: [
          requireNoSearchKey(),
          requireResponse(/origin/i),
          requireResponse(/destination/i),
          requireResponse(/travel date|date/i),
        ],
      },
      {
        user: 'From Mumbai to Delhi on 2026-08-20',
        expectedTools: ['flight_search', 'apply_filter'],
        checks: [
          requireSearchKey(),
          requireLastSearch('onds.0.origin', /Mumbai/i),
          requireLastSearch('onds.0.destination', /Delhi/i),
          requireFilter('stops', '0'),
          requireFilter('departureTime', 'MORNING'),
          requireFilter('baggage', '1'),
          requirePriceRange(0, 200),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
    ],
  },
  {
    id: 'session_complex_4',
    title: 'New search after filters, then latest searchKey used for new filters',
    turns: [
      {
        user: 'Find business class flights from Dubai to Delhi on 2026-09-05 for 1 adult under $400',
        expectedTools: ['flight_search', 'apply_filter'],
        checks: [
          requireSearchKey(),
          requireLastSearch('onds.0.destination', /Delhi/i),
          requireLastSearch('cabin_class', 'business'),
          requirePriceRange(0, 400),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
      {
        user: 'Show non-stop morning departures with checked baggage',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('stops', '0'),
          requireFilter('departureTime', 'MORNING'),
          requireFilter('baggage', '0'),
        ],
      },
      {
        user: 'Change route to Dubai to Mumbai on 2026-09-06 for 3 adults in economy',
        expectedTools: ['flight_search'],
        checks: [
          requireSearchCallCount(2),
          requireSearchKeyChangedSinceTurn(1),
          requireLastSearch('onds.0.destination', /Mumbai/i),
          requireLastSearch('passengers.adults', 3),
          requireLastSearch('cabin_class', 'economy'),
        ],
      },
      {
        user: 'Now apply carry-on baggage, afternoon departure, and price above $150',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('baggage', '1'),
          requireFilter('departureTime', 'AFTERNOON'),
          requireNoPriceFilter(),
          requireFeedback(/no price update was applied/i),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
    ],
  },
  {
    id: 'session_complex_5',
    title: 'Vague follow-up then duration, baggage, stops, arrival changes',
    turns: [
      {
        user: 'Find flights from Bangalore to Singapore on 2026-10-01 for 2 adults',
        expectedTools: ['flight_search'],
        checks: [
          requireSearchKey(),
          requireLastSearch('onds.0.destination', /Singapore/i),
          requireLastSearch('passengers.adults', 2),
        ],
      },
      {
        user: 'Can you make these better?',
        expectedTools: [],
        checks: [requireSearchKey()],
      },
      {
        user: 'Actually use personal item only, total duration between 2 and 8 hours, and price under $200',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('baggage', '2'),
          requireDurationMax('totalDuration', 480),
          requireFeedback(/total duration minimum of 120 minutes.*ignored/i),
          requirePriceRange(0, 200),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
      {
        user: 'Change my mind, make it 1+ stops with night arrival instead and price between 150 and 250 dollars',
        expectedTools: ['apply_filter'],
        checks: [
          requireFilter('stops', '3'),
          requireFilter('arrivalTime', 'EVENING'),
          requirePriceRange(0, 250),
          requireFeedback(/price minimum of 150.*ignored/i),
          requireLatestApplyFilterUsesCurrentSearchKey(),
        ],
      },
    ],
  },
];

function getPath(value, pathExpression) {
  return pathExpression.split('.').reduce((current, part) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    return current[part];
  }, value);
}

function sameValue(actual, expected) {
  if (expected instanceof RegExp) {
    return expected.test(String(actual));
  }
  return actual === expected;
}

function requireSearchKey() {
  return ({ context }) => {
    if (!context.searchKey) {
      return 'Expected searchKey to exist.';
    }
    return null;
  };
}

function requireNoSearchKey() {
  return ({ context }) => {
    if (context.searchKey) {
      return `Expected no searchKey, got ${context.searchKey}.`;
    }
    return null;
  };
}

function requireLastSearch(pathExpression, expected) {
  return ({ context }) => {
    const actual = getPath(context.lastSearch, pathExpression);
    if (!sameValue(actual, expected)) {
      return `Expected lastSearch.${pathExpression}=${expected}, got ${actual}.`;
    }
    return null;
  };
}

function requireFilter(filterType, filterCode) {
  return ({ context }) => {
    const filters = context.lastAppliedFilters || [];
    const found = filters.some(
      (filter) => filter.filterType === filterType && filter.filterCode === filterCode,
    );
    if (!found) {
      return `Expected filter ${filterType}:${filterCode}, got ${JSON.stringify(filters)}.`;
    }
    return null;
  };
}

function requireNoFilter(filterType, filterCode) {
  return ({ context }) => {
    const filters = context.lastAppliedFilters || [];
    const found = filters.some(
      (filter) => filter.filterType === filterType && filter.filterCode === filterCode,
    );
    if (found) {
      return `Expected ${filterType}:${filterCode} to be removed, got ${JSON.stringify(filters)}.`;
    }
    return null;
  };
}

function requireDurationMax(filterType, expectedMaxMinutes) {
  return ({ context }) => {
    const filter = context.lastAppliedFilters?.find((item) => item.filterType === filterType);
    if (!filter) {
      return `Expected ${filterType} duration filter.`;
    }
    if (filter.maxDurationMinutes !== expectedMaxMinutes) {
      return `Expected ${filterType}.maxDurationMinutes=${expectedMaxMinutes}, got ${filter.maxDurationMinutes}.`;
    }
    if (filter.minDurationMinutes !== 0) {
      return `Expected ${filterType}.minDurationMinutes=0, got ${filter.minDurationMinutes}.`;
    }
    return null;
  };
}

function requirePriceRange(expectedMinPrice, expectedMaxPrice) {
  return ({ context }) => {
    const filter = context.lastAppliedFilters?.find((item) => item.filterType === 'price');
    if (!filter) {
      return 'Expected price filter.';
    }
    if (filter.minPrice !== expectedMinPrice || filter.maxPrice !== expectedMaxPrice) {
      return `Expected price range [${expectedMinPrice},${expectedMaxPrice}], got [${filter.minPrice},${filter.maxPrice}].`;
    }

    const payloadFilter = context.lastFinalFilterPayload?.find(
      (item) => item.filterType === 'price',
    );
    const expectedValues = [expectedMinPrice ?? 0, expectedMaxPrice ?? null];
    if (!payloadFilter || JSON.stringify(payloadFilter.Values) !== JSON.stringify(expectedValues)) {
      return `Expected final price payload ${JSON.stringify(expectedValues)}, got ${JSON.stringify(payloadFilter)}.`;
    }

    return null;
  };
}

function requireNoPriceFilter() {
  return ({ context }) => {
    const activeFilter = context.lastAppliedFilters?.some((item) => item.filterType === 'price');
    const payloadFilter = context.lastFinalFilterPayload?.some((item) => item.filterType === 'price');
    if (activeFilter || payloadFilter) {
      return `Expected price filter to be removed, got filters=${JSON.stringify(context.lastAppliedFilters)} payload=${JSON.stringify(context.lastFinalFilterPayload)}.`;
    }
    return null;
  };
}

function requireFeedback(pattern) {
  return ({ context }) => {
    const feedback = context.lastApplyFilterFeedback || [];
    if (!feedback.some((message) => pattern.test(message))) {
      return `Expected feedback matching ${pattern}, got ${JSON.stringify(feedback)}.`;
    }
    return null;
  };
}

function requireResponse(pattern) {
  return ({ response }) => {
    if (!pattern.test(response.output || '')) {
      return `Expected response to match ${pattern}, got ${response.output}.`;
    }
    return null;
  };
}

function requireSearchCallCount(expected) {
  return ({ context }) => {
    const actual = context.toolCallLog.filter((entry) => entry.tool === 'flight_search').length;
    if (actual !== expected) {
      return `Expected ${expected} flight_search calls, got ${actual}.`;
    }
    return null;
  };
}

function requireSearchKeyChangedSinceTurn(turnNumber) {
  return ({ context, previousTurns }) => {
    const previousSearchKey = previousTurns[turnNumber - 1]?.contextAfter?.searchKey;
    if (!previousSearchKey) {
      return `Expected turn ${turnNumber} to have a searchKey.`;
    }
    if (context.searchKey === previousSearchKey) {
      return `Expected new searchKey, still got ${context.searchKey}.`;
    }
    return null;
  };
}

function requireLatestApplyFilterUsesCurrentSearchKey() {
  return ({ context }) => {
    const applyFilterCall = [...context.toolCallLog]
      .reverse()
      .find((entry) => entry.tool === 'apply_filter');
    if (!applyFilterCall) {
      return 'Expected an apply_filter call.';
    }
    if (applyFilterCall.searchKey !== context.searchKey) {
      return `Expected apply_filter searchKey ${context.searchKey}, got ${applyFilterCall.searchKey}.`;
    }
    return null;
  };
}

function assertNoFlightDetailsWithoutTool(turn) {
  const flightDetailPattern =
    /Sample Air|Demo Airlines|Example Express|SA 101|DA 204|EE 309|USD\s+\d+/i;
  if (turn.actualTools.length === 0 && flightDetailPattern.test(turn.agentResponse)) {
    return 'Response appears to mention flight contract details without a tool call.';
  }
  return null;
}

function snapshotContext(context) {
  return {
    UID: context.UID || null,
    requestId: context.requestId || null,
    sessionId: context.sessionId || null,
    searchKey: context.searchKey || null,
    lastSearch: context.lastSearch || null,
    lastAppliedFilters: context.lastAppliedFilters || null,
    lastFinalFilterPayload: context.lastFinalFilterPayload || null,
    lastApplyFilterPayload: context.lastApplyFilterPayload || null,
    lastApplyFilterFeedback: context.lastApplyFilterFeedback || [],
    flightResultsCount: context.flightResults?.length || 0,
    filteredFlightResultsCount: context.filteredFlightResults?.length || 0,
    toolCallCount: context.toolCallLog?.length || 0,
    toolCallLog: (context.toolCallLog || []).map((entry) => ({
      tool: entry.tool,
      searchKey: entry.searchKey,
      input: entry.input || null,
      filters: entry.filters || null,
      finalFilterPayload: entry.finalFilterPayload || null,
      apiPayload: entry.apiPayload || null,
      feedback: entry.feedback || [],
    })),
  };
}

function toolSequenceText(tools) {
  return tools.length ? tools.join(' -> ') : '(none)';
}

function validateTurn({ turnConfig, actualTools, context, response, previousTurns }) {
  const errors = [];
  const expectedText = toolSequenceText(turnConfig.expectedTools);
  const actualText = toolSequenceText(actualTools);

  if (expectedText !== actualText) {
    errors.push(`Expected tools ${expectedText}, got ${actualText}.`);
  }

  for (const check of turnConfig.checks || []) {
    const error = check({ context, response, previousTurns });
    if (error) {
      errors.push(error);
    }
  }

  return errors;
}

async function runScenario(scenario, scenarioIndex) {
  await clearFlightAgentSession(scenario.id);

  const session = getFlightAgentSession(scenario.id);
  let context: any = {
    UID: scenario.id,
    toolCallLog: [],
  };
  const turns = [];

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const turnConfig = scenario.turns[index];
    const contextBefore = snapshotContext(context);
    const beforeToolCallCount = context.toolCallLog.length;
    const runInput: any = {
      input: turnConfig.user,
      requestId: `${scenario.id}-turn-${index + 1}`,
      sessionId: scenario.id,
    };

    if (index === 0) {
      runInput.context = context;
    }

    const response = await runFlightAgent(runInput);
    context = response.context;

    const sessionStillReused = getFlightAgentSession(scenario.id) === session;
    const actualTools = context.toolCallLog
      .slice(beforeToolCallCount)
      .map((entry) => entry.tool);
    const contextAfter = snapshotContext(context);
    const validationErrors = validateTurn({
      turnConfig,
      actualTools,
      context,
      response,
      previousTurns: turns,
    });

    if (!sessionStillReused) {
      validationErrors.push('Expected same MemorySession instance to be reused.');
    }

    const hallucinationError = assertNoFlightDetailsWithoutTool({
      actualTools,
      agentResponse: response.output,
    });
    if (hallucinationError) {
      validationErrors.push(hallucinationError);
    }

    turns.push({
      scenario: `Chat Scenario ${scenarioIndex + 1}`,
      scenarioTitle: scenario.title,
      turnNumber: index + 1,
      userInput: turnConfig.user,
      agentResponse: response.output,
      expectedTools: turnConfig.expectedTools,
      actualTools,
      contextBefore,
      contextAfter,
      searchKey: contextAfter.searchKey,
      appliedFilters: contextAfter.lastAppliedFilters || [],
      finalFilterPayload: contextAfter.lastFinalFilterPayload || [],
      feedback: contextAfter.lastApplyFilterFeedback || [],
      pass: validationErrors.length === 0,
      remarks: validationErrors.length ? validationErrors.join(' ') : 'OK',
    });
  }

  const result = {
    ...scenario,
    sessionId: scenario.id,
    turns,
    pass: turns.every((turn) => turn.pass),
    actualToolSequence: context.toolCallLog.map((entry) => entry.tool),
    finalContext: snapshotContext(context),
  };

  await clearFlightAgentSession(scenario.id);
  return result;
}

function getRecurringIssues(results) {
  const failedTurns = results.flatMap((result) => result.turns).filter((turn) => !turn.pass);
  const issues = [];

  if (failedTurns.some((turn) => /Expected tools/i.test(turn.remarks))) {
    issues.push('Tool routing mismatch in one or more turns.');
  }
  if (failedTurns.some((turn) => /searchKey/i.test(turn.remarks))) {
    issues.push('Search key creation or reuse issue.');
  }
  if (failedTurns.some((turn) => /filter/i.test(turn.remarks))) {
    issues.push('Filter mapping or apply-filter state issue.');
  }
  if (failedTurns.some((turn) => /lastSearch/i.test(turn.remarks))) {
    issues.push('Search payload mapping issue.');
  }
  if (failedTurns.some((turn) => /contract details/i.test(turn.remarks))) {
    issues.push('Possible hallucinated flight details in a no-tool turn.');
  }

  return issues.length ? issues : ['No recurring issues found.'];
}

function getSuggestedFixes(issues) {
  const joined = issues.join(' ');
  const fixes = [];

  if (/Tool routing/i.test(joined)) {
    fixes.push('Add more prompt examples for changed-search and filter-only follow-up turns.');
  }
  if (/Search key/i.test(joined)) {
    fixes.push('Review runner session context persistence and ensure searchKey is not lost between turns.');
  }
  if (/Filter mapping/i.test(joined)) {
    fixes.push('Tighten ApplyFilterTool examples for baggage, stops, time, and duration code mapping.');
  }
  if (/Search payload/i.test(joined)) {
    fixes.push('Add explicit prompt examples for route/date/passenger/cabin changes triggering new search.');
  }
  if (/hallucinated/i.test(joined)) {
    fixes.push('Tighten anti-hallucination rules for no-tool turns.');
  }

  return fixes.length ? fixes : ['No fixes needed based on this run.'];
}

function buildSummary(results) {
  const totalChats = results.length;
  const allTurns = results.flatMap((result) => result.turns);
  const totalTurns = allTurns.length;
  const passedTurns = allTurns.filter((turn) => turn.pass).length;
  const failedTurns = totalTurns - passedTurns;
  const successPercentage = totalTurns
    ? Number(((passedTurns / totalTurns) * 100).toFixed(1))
    : 0;
  const recurringIssues = getRecurringIssues(results);
  const suggestedFixes = getSuggestedFixes(recurringIssues);

  return {
    generatedAt: new Date().toISOString(),
    model: flightAgentConfig.model,
    totalChats,
    totalTurns,
    passedTurns,
    failedTurns,
    successPercentage,
    recurringIssues,
    suggestedFixes,
  };
}

function buildRowsForScenario(result, summary, index) {
  const rows = [];

  if (index === 0) {
    rows.push(['Final Summary']);
    rows.push(['Metric', 'Value']);
    rows.push(['Generated at', summary.generatedAt]);
    rows.push(['Model', summary.model]);
    rows.push(['Total chats tested', summary.totalChats]);
    rows.push(['Total turns tested', summary.totalTurns]);
    rows.push(['Passed turns', summary.passedTurns]);
    rows.push(['Failed turns', summary.failedTurns]);
    rows.push(['Success percentage', `${summary.successPercentage}%`]);
    rows.push(['Recurring issues', summary.recurringIssues.join(' | ')]);
    rows.push(['Suggested fixes', summary.suggestedFixes.join(' | ')]);
    rows.push([]);
  }

  rows.push(['Scenario', result.title]);
  rows.push(['Session ID', result.sessionId]);
  rows.push(['Scenario pass/fail', result.pass ? 'PASS' : 'FAIL']);
  rows.push(['Actual total tool sequence', toolSequenceText(result.actualToolSequence)]);
  rows.push([]);
  rows.push([
    'Turn number',
    'User input',
    'Agent response',
    'Expected tool call',
    'Actual tool call',
    'Context before turn',
    'Context after turn',
    'searchKey value',
    'Applied filters',
    'Final filter payload',
    'Feedback',
    'Pass/Fail',
    'Remarks',
  ]);

  for (const turn of result.turns) {
    rows.push([
      turn.turnNumber,
      turn.userInput,
      turn.agentResponse,
      toolSequenceText(turn.expectedTools),
      toolSequenceText(turn.actualTools),
      JSON.stringify(turn.contextBefore),
      JSON.stringify(turn.contextAfter),
      turn.searchKey || '',
      JSON.stringify(turn.appliedFilters),
      JSON.stringify(turn.finalFilterPayload),
      JSON.stringify(turn.feedback),
      turn.pass ? 'PASS' : 'FAIL',
      turn.remarks,
    ]);
  }

  return rows;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index) {
  let name = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => {
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function workbookXml(sheets) {
  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntries}</sheets>
</workbook>`;
}

function workbookRelsXml(sheets) {
  const relationships = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function contentTypesXml(sheets) {
  const sheetOverrides = sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}
</Types>`;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

const crc32Table = createCrc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateParts() {
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { dosTime, dosDate };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = zipDateParts();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const contentBuffer = Buffer.from(file.content, 'utf8');
    const checksum = crc32(contentBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contentBuffer.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contentBuffer.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + contentBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

async function writeWorkbook(outputPath, sheets) {
  const files = [
    { name: '[Content_Types].xml', content: contentTypesXml(sheets) },
    { name: '_rels/.rels', content: rootRelsXml() },
    { name: 'xl/workbook.xml', content: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml(sheets) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet.rows),
    })),
  ];

  const workbook = createZip(files);

  try {
    await fs.writeFile(outputPath, workbook);
    return outputPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EBUSY') {
      throw error;
    }

    const parsedPath = path.parse(outputPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fallbackPath = path.join(parsedPath.dir, `${parsedPath.name}-${timestamp}${parsedPath.ext}`);

    await fs.writeFile(fallbackPath, workbook);
    return fallbackPath;
  }
}

function printConsoleSummary(summary, reportPath, results) {
  console.log('# Flight Agent session complex report');
  console.log(`Model: ${summary.model}`);
  console.log(`Total chats tested: ${summary.totalChats}`);
  console.log(`Total turns tested: ${summary.totalTurns}`);
  console.log(`Passed turns: ${summary.passedTurns}`);
  console.log(`Failed turns: ${summary.failedTurns}`);
  console.log(`Success percentage: ${summary.successPercentage}%`);
  console.log(`Excel report: ${reportPath}`);
  console.log('');

  for (const result of results) {
    console.log(`## ${result.pass ? 'PASS' : 'FAIL'} - ${result.title}`);
    for (const turn of result.turns) {
      console.log(
        `- Turn ${turn.turnNumber}: expected ${toolSequenceText(turn.expectedTools)}, actual ${toolSequenceText(turn.actualTools)}, ${turn.pass ? 'PASS' : `FAIL - ${turn.remarks}`}`,
      );
    }
  }

  console.log('');
  console.log(`Recurring issues: ${summary.recurringIssues.join(' | ')}`);
  console.log(`Suggested fixes: ${summary.suggestedFixes.join(' | ')}`);
}

const results = [];
for (let index = 0; index < scenarios.length; index += 1) {
  results.push(await runScenario(scenarios[index], index));
}

const summary = buildSummary(results);
const sheets = results.map((result, index) => ({
  name: `Chat Scenario ${index + 1}`,
  rows: buildRowsForScenario(result, summary, index),
}));
const resultsDir = path.join(process.cwd(), 'tests', 'results');
const reportPath = path.join(resultsDir, 'flight-agent-session-complex-report.xlsx');

await fs.mkdir(resultsDir, { recursive: true });
const writtenReportPath = await writeWorkbook(reportPath, sheets);
printConsoleSummary(summary, writtenReportPath, results);
