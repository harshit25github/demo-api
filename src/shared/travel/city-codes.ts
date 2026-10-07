/** Small set of city and metropolitan IATA codes already used by this app. */
export const CITY_IATA_CODE_BY_NAME: Record<string, string> = {
  bali: 'DPS',
  delhi: 'DEL',
  dubai: 'DXB',
  london: 'LON',
  mumbai: 'BOM',
  'new york': 'NYC',
  paris: 'PAR',
  rome: 'ROM',
  singapore: 'SIN',
  tokyo: 'TYO',
};

export function knownCityIataCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (/^[a-z]{3}$/.test(normalized)) return normalized.toUpperCase();
  return CITY_IATA_CODE_BY_NAME[normalized] || null;
}
