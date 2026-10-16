import type { TripPlannerV2State } from './schema.js';

// Placeholder URLs for local runs.
const PLACEHOLDER_PHOTOS: Record<string, string> = {
  PAR: 'https://images.example.test/paris.jpg',
  LON: 'https://images.example.test/london.jpg',
  ROM: 'https://images.example.test/rome.jpg',
  TYO: 'https://images.example.test/tokyo.jpg',
  DXB: 'https://images.example.test/dubai.jpg',
  DPS: 'https://images.example.test/bali.jpg',
  NYC: 'https://images.example.test/new-york.jpg',
};

/**
 * Photos come only from the approved image source behind get_place_images_batch, by 3-letter
 * city code; never from the web, and the model never looks one up. Production replaces the
 * placeholder lookup below with that service. Fetched photos are cached on the trip.
 */
export async function fetchTripPhotos(trip: TripPlannerV2State, codes: Array<string | null>): Promise<void> {
  const photos = (trip.photos ??= {});
  for (const code of codes) {
    if (!code || photos[code]) continue;
    photos[code] = PLACEHOLDER_PHOTOS[code] ?? `https://images.example.test/fallback-${code.toLowerCase()}.jpg`;
  }
}

/**
 * A card may show only a photo the app supplied. The Manager copies image values into its
 * reply, so any other image link becomes "Photo unavailable" before the reply goes out.
 */
export function keepApprovedPhotos(text: string, photos: Record<string, string> | undefined): string {
  const approved = new Set(Object.values(photos ?? {}));
  return text.replace(/^(\s*image:\s*)(https?:\/\/\S+)[ \t]*$/gim, (line: string, prefix: string, url: string) =>
    (approved.has(url) ? line : `${prefix}Photo unavailable`));
}
