import { log } from '../../shared/logging/logger.js';
import { getTripState } from './state.js';

/**
 * The approved image source behind get_place_images_batch: 3-letter city code to photo URL.
 * Photos never come from the web, and the model never sees or writes a photo URL.
 */
export interface TripPhotoSource {
  lookup(codes: string[]): Promise<Record<string, string | null | undefined>>;
}

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

export const placeholderTripPhotoSource: TripPhotoSource = {
  async lookup(codes) {
    return Object.fromEntries(codes.map((code) => [
      code,
      PLACEHOLDER_PHOTOS[code] ?? `https://images.example.test/fallback-${code.toLowerCase()}.jpg`,
    ]));
  },
};

let photoSource: TripPhotoSource = placeholderTripPhotoSource;

/** Production plugs its approved image service in here. */
export function configureTripPhotoSource(source: TripPhotoSource): void {
  photoSource = source;
}

// Request-local lookups, keyed by the request state; a Promise never enters the persisted state.
const pendingLookups = new WeakMap<object, Promise<void>>();

/** Starts fetching photos for codes the trip has not cached. The reply waits for it only when it shows them. */
export function startTripPhotoLookup(context: Record<string, any>, codes: Array<string | null | undefined>): void {
  const cache = (getTripState(context).photos ??= {});
  const missing = [...new Set(codes)]
    .filter((code): code is string => typeof code === 'string' && /^[A-Z]{3}$/.test(code))
    .filter((code) => !cache[code]);
  if (!missing.length) return;
  const lookup = (pendingLookups.get(context) ?? Promise.resolve())
    .then(() => photoSource.lookup(missing))
    .then((found) => {
      for (const code of missing) {
        const url = found[code];
        if (typeof url === 'string' && /^https:\/\/\S+$/.test(url)) cache[code] = url;
      }
    })
    .catch((error: unknown) => {
      log('warn', 'trip_planner_v2.photo_lookup_failed', { requestId: context.requestId, codes: missing, reason: String(error) });
    });
  pendingLookups.set(context, lookup);
}

export async function awaitTripPhotos(context: object): Promise<void> {
  await pendingLookups.get(context);
}
