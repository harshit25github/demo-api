import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  getFlightSearchState,
} from '../context/flight-context.js';
import { updateFlightSearchRuntime } from '../context/search-runtime-store.js';
import { log } from '../../../shared/logging/logger.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import type { FlightAppContext, FlightContract } from '../types.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  recordFlightToolFailure,
  recordFlightToolSuccess,
  type FlightToolFieldIssue,
} from './recovery.js';

const generatedContractsContextSchema = z.object({
  mode: z
    .enum(['read', 'select', 'show_all'])
    .describe(
      'Use read to inspect options, select to display only specific options, or show_all to display every current option.',
    ),
  indexes: z
    .array(z.number().int().min(1))
    .nullable()
    .describe(
      'Optional 1-based contract/option indexes. Use null with read-all or show_all.',
    ),
});

interface NormalizedContract extends Record<string, unknown> {
  optionNumber: number;
  price: { amount?: number; currency?: string } | null;
  priceLabel: string | null;
  total_duration_minutes: number | null;
  layover_duration_minutes: number | null;
  stops: number | null;
}

function getFlightContext(runContext: { context?: unknown } | undefined): FlightAppContext {
  return getRequestState(runContext?.context as FlightAppContext);
}

function getCurrentResultSet(appContext: FlightAppContext) {
  const searchResults = appContext.flight.searchResults as Record<string, any> | FlightContract[] | null;
  if (Array.isArray(searchResults)) {
    return {
      sourceName: 'searchResults',
      results: searchResults,
      replace(nextResults: FlightContract[]) {
        appContext.flight.searchResults = nextResults;
      },
    };
  }
  if (searchResults && typeof searchResults === 'object') {
    for (const key of ['flights', 'contracts', 'results', 'data']) {
      if (Array.isArray(searchResults[key])) {
        return {
          sourceName: `searchResults.${key}`,
          results: searchResults[key],
          replace(nextResults: FlightContract[]) {
            appContext.flight.searchResults = {
              ...searchResults,
              [key]: nextResults,
            };
          },
        };
      }
    }
  }
  return {
    sourceName: 'searchResults',
    results: [],
    replace(nextResults: FlightContract[]) {
      appContext.flight.searchResults = nextResults;
    },
  };
}

function visibleCount(contracts: FlightContract[]): number {
  return contracts.filter((contract) => contract.display !== false).length;
}

function moneyLabel(price: any): string | null {
  if (!price || typeof price.amount !== 'number') {
    return null;
  }
  return `${price.currency || 'USD'} ${price.amount}`;
}

function normalizeContract(contract: FlightContract, index: number): NormalizedContract {
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
    price: (contract.price as NormalizedContract['price']) || null,
    priceLabel: moneyLabel(contract.price),
  };
}

function lowestBy(
  contracts: NormalizedContract[],
  selector: (contract: NormalizedContract) => number | null | undefined,
): NormalizedContract | undefined {
  return contracts.reduce<{ value: number; contract: NormalizedContract } | null>((best, contract) => {
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

function getBestValueContract(contracts: NormalizedContract[]) {
  const pricedContracts = contracts.filter(
    (contract): contract is NormalizedContract & { price: { amount: number; currency?: string } } =>
      typeof contract.price?.amount === 'number',
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

function buildRankingSummary(contracts: NormalizedContract[]) {
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

function buildSearchParams(appContext: FlightAppContext) {
  const state = getFlightSearchState(appContext);
  return state.onds?.length
    ? {
        onds: state.onds,
        trip_type: state.trip_type,
        passengers: state.passengers,
        cabin_class: state.cabin_class,
      }
    : null;
}

export const GetGeneratedContractsContextTool = tool({
  name: 'getGeneratedContractsContext',
  description:
    'Inspect or select current generated flight contracts. Use mode=read without changing visibility, mode=select to display only supplied 1-based indexes, and mode=show_all with indexes=null to restore all. For ranking or recommendations, read all then select 1-3 options. Failures do not change visibility and include available-index or missing-search recovery facts. Retry only when a changed selection is unambiguously supported; ask when the user explicitly requested an unavailable option.',
  parameters: generatedContractsContextSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction('getGeneratedContractsContext', {
    requiredFields: ['mode', 'indexes'],
  }),
  execute(input, context) {
    const appContext = getFlightContext(context);
    const { sourceName, results, replace } = getCurrentResultSet(appContext);
    const contracts = results.map(normalizeContract);
    const requestedIndexes = input.indexes || null;
    const searchParams = buildSearchParams(appContext);
    const fail = ({
      code,
      message,
      fieldIssues = [],
      requiredState = [],
      details = {},
    }: {
      code: string;
      message: string;
      fieldIssues?: FlightToolFieldIssue[];
      requiredState?: string[];
      details?: Record<string, unknown>;
    }) => recordFlightToolFailure({
      appContext,
      toolName: 'getGeneratedContractsContext',
      input,
      failure: createFlightToolFailure({
        code,
        message,
        fieldIssues,
        requiredState,
        details: {
          source: 'dummy',
          UID: appContext.flight.uid,
          searchKey: appContext.flight.searchKey || null,
          searchParams,
          selectedIndexes: [],
          visibleCount: visibleCount(results),
          contracts: [],
          summary: buildRankingSummary(contracts),
          ...details,
        },
      }),
    });

    if (contracts.length === 0) {
      const output = fail({
        code: 'NO_CONTRACTS',
        message: 'No generated flight contracts are available. If complete search intent already exists, run flight_search; otherwise ask only for the missing blocking field.',
        requiredState: ['current generated flight contracts'],
        fieldIssues: [{
          path: 'context.flight.searchResults',
          problem: 'No current generated flight options are available to inspect or select.',
        }],
        details: {
          visibleCount: 0,
          summary: {
            totalAvailable: 0,
            cheapestOption: null,
            shortestDurationOption: null,
            bestValueOption: null,
          },
        },
      });

      log('info', 'generated_contracts_context.no_contracts', {
        requestId: appContext.requestId,
        sessionId: appContext.sessionId,
        UID: appContext.flight.uid,
        searchKey: appContext.flight.searchKey,
      });

      return output;
    }

    if (input.mode === 'select' && (!requestedIndexes || requestedIndexes.length === 0)) {
      return fail({
        code: 'INVALID_SELECTION',
        message: 'Select mode requires at least one flight option index.',
        fieldIssues: [{
          path: 'indexes',
          problem: 'At least one unique available option index is required for select mode.',
          constraint: `Available indexes are 1 through ${contracts.length}.`,
        }],
      });
    }

    if (input.mode === 'show_all' && input.indexes !== null) {
      return fail({
        code: 'INVALID_SELECTION',
        message: 'Show-all mode requires indexes to be null.',
        fieldIssues: [{
          path: 'indexes',
          problem: 'show_all does not accept selected indexes.',
          acceptedValue: null,
        }],
      });
    }

    const uniqueIndexes = requestedIndexes ? [...new Set(requestedIndexes)] : null;
    if (
      input.mode === 'select' &&
      requestedIndexes &&
      uniqueIndexes!.length !== requestedIndexes.length
    ) {
      return fail({
        code: 'INVALID_SELECTION',
        message: 'Select mode requires unique flight option indexes.',
        fieldIssues: [{
          path: 'indexes',
          problem: 'Duplicate option indexes are not allowed.',
          constraint: `Use unique indexes from 1 through ${contracts.length}.`,
        }],
      });
    }
    if (uniqueIndexes) {
      const missingIndexes = uniqueIndexes.filter(
        (index) => index < 1 || index > contracts.length,
      );

      if (missingIndexes.length > 0) {
        const output = fail({
          code: 'INDEX_OUT_OF_RANGE',
          message: 'One or more requested flight option indexes are not available.',
          fieldIssues: [{
            path: 'indexes',
            problem: `Unavailable option indexes: ${missingIndexes.join(', ')}.`,
            constraint: `Available indexes are 1 through ${contracts.length}.`,
          }],
          details: {
            totalAvailable: contracts.length,
            missingIndexes,
          },
        });

        log('info', 'generated_contracts_context.index_out_of_range', {
          requestId: appContext.requestId,
          sessionId: appContext.sessionId,
          UID: appContext.flight.uid,
          searchKey: appContext.flight.searchKey,
          requestedIndexes,
          missingIndexes,
          totalAvailable: contracts.length,
        });

        return output;
      }
    }

    let activeResults = results;
    if (input.mode === 'select' || input.mode === 'show_all') {
      const selectedIndexSet = new Set(uniqueIndexes || []);
      activeResults = results.map((contract, index) => ({
        ...contract,
        display: input.mode === 'show_all' || selectedIndexSet.has(index + 1),
      }));
      replace(activeResults);
      updateFlightSearchRuntime(appContext.flight.searchKey, {
        visibleFlights: activeResults,
      });
    }

    const selectedContracts = uniqueIndexes
      ? uniqueIndexes.map((index) => normalizeContract(activeResults[index - 1], index - 1))
      : contracts;
    const selectedIndexes =
      input.mode === 'show_all'
        ? contracts.map((_, index) => index + 1)
        : input.mode === 'select'
          ? uniqueIndexes
          : [];

    const output = {
      ok: true,
      source: 'dummy',
      resultSource: sourceName,
      message: 'Sample generated flight contract context only. No live API was called.',
      UID: appContext.flight.uid,
      searchKey: appContext.flight.searchKey || null,
      searchParams,
      selectedIndexes,
      visibleCount: visibleCount(activeResults),
      requestedIndexes: uniqueIndexes,
      contracts: selectedContracts,
      summary: buildRankingSummary(contracts),
    };

    const recovery = recordFlightToolSuccess({
      appContext,
      toolName: 'getGeneratedContractsContext',
    });
    appContext.toolCallLog.push({
      tool: 'getGeneratedContractsContext',
      ok: true,
      searchKey: appContext.flight.searchKey || null,
      mode: input.mode,
      indexes: uniqueIndexes,
      resultSource: sourceName,
      totalAvailable: contracts.length,
      returnedCount: selectedContracts.length,
      ...(recovery || {}),
    });

    log('info', 'generated_contracts_context.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      UID: appContext.flight.uid,
      searchKey: appContext.flight.searchKey,
      mode: input.mode,
      indexes: uniqueIndexes,
      resultSource: sourceName,
      returnedCount: selectedContracts.length,
      totalAvailable: contracts.length,
    });

    return output;
  },
});
