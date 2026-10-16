import type { TripPlannerV2State } from './schema.js';

// The same placeholder URLs v1's get_place_images_batch returns locally.
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
 * city code; never from the web, and the model never sees or writes a photo URL. Production
 * replaces the placeholder lookup below with that service. Fetched photos are cached on the trip.
 */
export async function fetchTripPhotos(trip: TripPlannerV2State, codes: Array<string | null>): Promise<void> {
  const photos = (trip.photos ??= {});
  for (const code of codes) {
    if (!code || photos[code]) continue;
    photos[code] = PLACEHOLDER_PHOTOS[code] ?? `https://images.example.test/fallback-${code.toLowerCase()}.jpg`;
  }
}
