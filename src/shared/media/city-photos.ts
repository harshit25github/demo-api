import inventory from './city-photos.json' with { type: 'json' };

/** One destination city's photo (plan section 11: cities only, a bare .jpg link). */
export interface CityPhoto {
  /** The city's IATA codes, its city code first. */
  codes: string[];
  name: string;
  /** Other names a reply may use for the city, such as Denpasar for Bali. */
  aliases: string[];
  /** The .jpg the city's link points at. */
  photo: string;
}

/** A destination to look up: the IATA code Trip saved, if any, and its city name. */
export interface DestinationRef {
  iata: string | null;
  city: string | null;
}

const CITIES: readonly CityPhoto[] = inventory.cities;
const normalized = (value: string | null | undefined) => String(value ?? '').trim().toLowerCase();

/**
 * The photos the inventory has for these destinations: by IATA code, else by city name or alias. A destination the
 * inventory doesn't know is left out, so its name stays plain text (decision P6). This is the dummy inventory; the
 * real one is an image API, which answers the same question with one batched request per turn, hence the promise.
 */
export async function cityPhotosFor(destinations: readonly DestinationRef[]): Promise<CityPhoto[]> {
  const found = new Set<CityPhoto>();
  for (const { iata, city } of destinations) {
    const code = normalized(iata).toUpperCase();
    const name = normalized(city);
    const match = (code && CITIES.find((entry) => entry.codes.includes(code)))
      || (name && CITIES.find((entry) => [entry.name, ...entry.aliases].some((known) => normalized(known) === name)));
    if (match) found.add(match);
  }
  return [...found];
}
