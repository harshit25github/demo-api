export interface ClickHouseClient {
  query(input: { query: string; format: 'JSONEachRow' }): Promise<unknown>;
}

// Replace this placeholder with the configured production ClickHouse client.
export const clickHouseClient: ClickHouseClient = {
  async query() {
    return [];
  },
};

export interface PricePredictionCriteria {
  searchDate: string;
  originCity: string;
  destinationCity: string;
  isRoundTrip: boolean;
}

function assertQueryValue(value: unknown, pattern: RegExp, fieldName: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${fieldName} supplied to the price prediction query builder.`);
  }
}

export function buildPricePredictionQuery(criteria: PricePredictionCriteria): string {
  const { searchDate, originCity, destinationCity } = criteria;
  assertQueryValue(searchDate, /^\d{4}-\d{2}-\d{2}$/, 'searchDate');
  assertQueryValue(originCity, /^[A-Z]{3}$/, 'originCity');
  assertQueryValue(destinationCity, /^[A-Z]{3}$/, 'destinationCity');

  return `SELECT *
  FROM price_predictions
LIMIT 1`;
}

async function rowsFromClickHouseResponse(response: any): Promise<Record<string, any>[]> {
  if (!response) {
    return [];
  }
  if (Array.isArray(response)) {
    return response;
  }
  if (typeof response.json === 'function') {
    const rows = await response.json();
    return Array.isArray(rows) ? rows : rows?.data || [];
  }
  if (Array.isArray(response.data)) {
    return response.data;
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  }
  return [];
}

export class ClickHousePricePredictionRepository {
  readonly client: ClickHouseClient;
  readonly source = 'clickhouse';

  constructor({ client }: { client: ClickHouseClient }) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('A ClickHouse client with a query method is required.');
    }
    this.client = client;
  }

  async findCityPrediction(criteria: PricePredictionCriteria) {
    const query = buildPricePredictionQuery(criteria);
    const response = await this.client.query({ query, format: 'JSONEachRow' });
    const rows = await rowsFromClickHouseResponse(response);
    return rows[0] || null;
  }
}

export type PricePredictionRepository = Pick<
  ClickHousePricePredictionRepository,
  'findCityPrediction' | 'source'
>;

export const defaultPricePredictionRepository =
  new ClickHousePricePredictionRepository({ client: clickHouseClient });
