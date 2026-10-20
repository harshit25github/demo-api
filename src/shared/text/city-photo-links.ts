import type { CityPhoto } from '../media/city-photos.js';

/** At most this many photo links in one reply (decision P4). */
export const MAX_PHOTO_LINKS = 8;

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text the linker leaves alone: headings, fenced and inline code, and anything already a link. */
const PROTECTED = [/^[ \t]{0,3}#{1,6}[ \t].*$/gm, /```[\s\S]*?```/g, /`[^`\n]*`/g, /\[[^\]\n]*\]\([^)\n]*\)/g];

/** A capitalized word other than "I" right after a name, on the same line: the name starts a landmark such as "Tokyo Skytree". */
const LANDMARK_WORD = /[ \t ]+(?!I\b)\p{Lu}/uy;
const startsLandmark = (text: string, at: number) => { LANDMARK_WORD.lastIndex = at; return LANDMARK_WORD.test(text); };

/**
 * Turns the first mention of each destination city that has a photo into [name](photo.jpg), keeping the name exactly as
 * the Manager wrote it and any bold around it (decisions P1, P2 and P4). A city without a photo, or a mention in a
 * heading, code, an existing link or a longer name such as "Tokyo Skytree", is left as written (P6). Returns the links
 * it issued for the final link check.
 */
export function linkCityPhotos(markdown: string, photos: readonly CityPhoto[], maxLinks = MAX_PHOTO_LINKS): { text: string; issued: string[] } {
  const byName = new Map<string, CityPhoto>();
  for (const photo of photos) {
    for (const name of [photo.name, ...photo.aliases]) if (name.trim()) byName.set(name.trim().toLowerCase(), photo);
  }
  if (!byName.size || maxLinks < 1) return { text: markdown, issued: [] };

  // Longest names first, so "New York City" wins over "New York"; letters and digits on either side mean another word.
  const names = [...byName.keys()].sort((left, right) => right.length - left.length).map(escapeForPattern);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const spans = PROTECTED.flatMap((rule) => [...markdown.matchAll(rule)].map((match) => [match.index, match.index + match[0].length]));

  const linked = new Set<CityPhoto>();
  const issued: string[] = [];
  let text = '';
  let copied = 0;
  for (const match of markdown.matchAll(pattern)) {
    if (issued.length >= maxLinks) break;
    const start = match.index;
    const end = start + match[0].length;
    const photo = byName.get(match[0].toLowerCase());
    if (!photo || linked.has(photo) || spans.some(([from, to]) => start < to && end > from)) continue;
    // Case matters here, unlike in the name pattern: "Tokyo Skytree" is a landmark, "Tokyo station" is the city (P2).
    if (startsLandmark(markdown, end)) continue;
    linked.add(photo);
    issued.push(photo.photo);
    text += `${markdown.slice(copied, start)}[${match[0]}](${photo.photo})`;
    copied = end;
  }
  return { text: text + markdown.slice(copied), issued };
}
