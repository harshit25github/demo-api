import { tool } from '@openai/agents';
import { z } from 'zod';
import { log } from '../logger.js';

const generatedContractsContextSchema = z.object({
  indexes: z
    .array(z.number().int().min(1))
    .nullable()
    .describe(
      'Optional 1-based contract/option indexes to fetch. Use null to fetch every current option for ranking, comparison, cheapest, best, shortest-duration, or recommendation queries.',
    ),
});

function getFlightContext(runContext) {
  const appContext = runContext?.context || {};
  appContext.UID ||= appContext.uid || 'demo-user';
  appContext.uid ||= appContext.UID;
  appContext.searchKey ||= appContext.sid;
  appContext.sid ||= appContext.searchKey;
  appContext.toolCallLog ||= [];
  return appContext;
}

function getCurrentResultSet(appContext) {
  const filteredResults = Array.isArray(appContext.filteredFlightResults)
    ? appContext.filteredFlightResults
    : [];
  const searchResults = Array.isArray(appContext.flightResults) ? appContext.flightResults : [];
  const generatedContracts = Array.isArray(appContext.generatedContracts)
    ? appContext.generatedContracts
    : [];
  const contracts = Array.isArray(appContext.contracts) ? appContext.contracts : [];

  if (filteredResults.length > 0) {
    return { sourceName: 'filteredFlightResults', results: filteredResults };
  }
  if (searchResults.length > 0) {
    return { sourceName: 'flightResults', results: searchResults };
  }
  if (generatedContracts.length > 0) {
    return { sourceName: 'generatedContracts', results: generatedContracts };
  }
  return { sourceName: 'contracts', results: contracts };
}

function moneyLabel(price) {
  if (!price || typeof price.amount !== 'number') {
    return null;
  }
  return `${price.currency || 'USD'} ${price.amount}`;
}

function normalizeContract(contract, index) {
  return {
    optionNumber: index + 1,
    id: contract.id || contract.contractId || `option-${index + 1}`,
    airline: contract.airline || contract.airlineName || null,
    airline_code: contract.airline_code || contract.airlineCode || null,
    flight_number: contract.flight_number || contract.flightNumber || null,
    origin: contract.origin || null,
    destination: contract.destination || null,
    departure_airport_code: contract.departure_airport_code || null,
    arrival_airport_code: contract.arrival_airport_code || null,
    departure_time: contract.departure_time || contract.departureTime || null,
    arrival_time: contract.arrival_time || contract.arrivalTime || null,
    departure_time_window: contract.departure_time_window || null,
    arrival_time_window: contract.arrival_time_window || null,
    duration: contract.duration || null,
    total_duration_minutes:
      typeof contract.total_duration_minutes === 'number'
        ? contract.total_duration_minutes
        : null,
    layover_duration_minutes:
      typeof contract.layover_duration_minutes === 'number'
        ? contract.layover_duration_minutes
        : null,
    stops: typeof contract.stops === 'number' ? contract.stops : null,
    baggage: Array.isArray(contract.baggage) ? contract.baggage : null,
    cabin_class: contract.cabin_class || contract.cabinClass || null,
    price: contract.price || null,
    priceLabel: moneyLabel(contract.price),
  };
}

function lowestBy(contracts, selector) {
  return contracts.reduce((best, contract) => {
    const value = selector(contract);
    if (typeof value !== 'number') {
      return best;
    }
    if (!best || value < best.value) {
      return { value, contract };
    }
    return best;
  }, null)?.contract;
}

function getBestValueContract(contracts) {
  const pricedContracts = contracts.filter(
    (contract) => typeof contract.price?.amount === 'number',
  );

  if (pricedContracts.length === 0) {
    return lowestBy(contracts, (contract) => contract.total_duration_minutes);
  }

  return [...pricedContracts].sort((a, b) => {
    const priceDiff = a.price.amount - b.price.amount;
    if (priceDiff !== 0) {
      return priceDiff;
    }

    const durationDiff =
      (a.total_duration_minutes ?? Number.MAX_SAFE_INTEGER) -
      (b.total_duration_minutes ?? Number.MAX_SAFE_INTEGER);
    if (durationDiff !== 0) {
      return durationDiff;
    }

    return (a.stops ?? Number.MAX_SAFE_INTEGER) - (b.stops ?? Number.MAX_SAFE_INTEGER);
  })[0];
}

function buildRankingSummary(contracts) {
  const cheapest = lowestBy(contracts, (contract) => contract.price?.amount);
  const shortest = lowestBy(contracts, (contract) => contract.total_duration_minutes);
  const bestValue = getBestValueContract(contracts);

  return {
    totalAvailable: contracts.length,
    cheapestOption: cheapest || null,
    shortestDurationOption: shortest || null,
    bestValueOption: bestValue || null,
  };
}

function buildSearchParams(appContext) {
  return appContext.lastSearch || appContext.searchParams || null;
}

export const GetGeneratedContractsContextTool = tool({
  name: 'getGeneratedContractsContext',
  description:
    'Load current generated flight contracts/results for follow-up reasoning. Use for cheapest, best, best value, shortest duration, compare, recommendation, or specific option questions about current results. Not for new searches or filters. Pass indexes for specific 1-based options or null for all options.',
  parameters: generatedContractsContextSchema,
  strict: true,
  execute(input, context) {
    const appContext = getFlightContext(context);
    const { sourceName, results } = getCurrentResultSet(appContext);
    const contracts = results.map(normalizeContract);
    const requestedIndexes = input.indexes || null;
    const searchParams = buildSearchParams(appContext);

    if (contracts.length === 0) {
      const output = {
        ok: false,
        code: 'NO_CONTRACTS',
        source: 'dummy',
        message:
          'No generated flight contracts are available in the current context. Run or load a flight search first.',
        UID: appContext.UID,
        searchKey: appContext.searchKey || null,
        searchParams,
        contracts: [],
        summary: {
          totalAvailable: 0,
          cheapestOption: null,
          shortestDurationOption: null,
          bestValueOption: null,
        },
      };

      appContext.lastGeneratedContractsContext = output;
      appContext.toolCallLog.push({
        tool: 'getGeneratedContractsContext',
        searchKey: appContext.searchKey || null,
        indexes: requestedIndexes,
        code: output.code,
        returnedCount: 0,
      });

      log('info', 'generated_contracts_context.no_contracts', {
        requestId: appContext.requestId,
        sessionId: appContext.sessionId,
        UID: appContext.UID,
        searchKey: appContext.searchKey,
      });

      return output;
    }

    if (requestedIndexes) {
      const missingIndexes = requestedIndexes.filter(
        (index) => index < 1 || index > contracts.length,
      );

      if (missingIndexes.length > 0) {
        const output = {
          ok: false,
          code: 'INDEX_OUT_OF_RANGE',
          source: 'dummy',
          message: 'One or more requested flight option indexes are not available.',
          UID: appContext.UID,
          searchKey: appContext.searchKey || null,
          searchParams,
          totalAvailable: contracts.length,
          missingIndexes,
          contracts: [],
          summary: buildRankingSummary(contracts),
        };

        appContext.lastGeneratedContractsContext = output;
        appContext.toolCallLog.push({
          tool: 'getGeneratedContractsContext',
          searchKey: appContext.searchKey || null,
          indexes: requestedIndexes,
          code: output.code,
          returnedCount: 0,
        });

        log('info', 'generated_contracts_context.index_out_of_range', {
          requestId: appContext.requestId,
          sessionId: appContext.sessionId,
          UID: appContext.UID,
          searchKey: appContext.searchKey,
          requestedIndexes,
          missingIndexes,
          totalAvailable: contracts.length,
        });

        return output;
      }
    }

    const selectedContracts = requestedIndexes
      ? requestedIndexes.map((index) => contracts[index - 1])
      : contracts;

    const output = {
      ok: true,
      source: 'dummy',
      resultSource: sourceName,
      message: 'Sample generated flight contract context only. No live API was called.',
      UID: appContext.UID,
      searchKey: appContext.searchKey || null,
      searchParams,
      requestedIndexes,
      contracts: selectedContracts,
      summary: buildRankingSummary(contracts),
    };

    appContext.lastGeneratedContractsContext = output;
    appContext.toolCallLog.push({
      tool: 'getGeneratedContractsContext',
      searchKey: appContext.searchKey || null,
      indexes: requestedIndexes,
      resultSource: sourceName,
      totalAvailable: contracts.length,
      returnedCount: selectedContracts.length,
    });

    log('info', 'generated_contracts_context.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID: appContext.UID,
      searchKey: appContext.searchKey,
      indexes: requestedIndexes,
      resultSource: sourceName,
      returnedCount: selectedContracts.length,
      totalAvailable: contracts.length,
    });

    return output;
  },
});
