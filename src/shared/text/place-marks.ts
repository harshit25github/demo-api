/**
 * Place marks (plan section 12.4): after the Manager's reply is finished, the backend marks the first mention of each
 * place a specialist named as [name](place:N), and the turn carries a places list the client reads to draw an icon for
 * each mark's kind and, where there is one, a photo. The model never writes a mark, so it can't invent a place.
 */

/** Something the reply may name: a place under any of its names, or the word "flight" or "flights". */
export interface PlaceCandidate {
  /** The names a mention can use, such as "Bali" and "Denpasar". The reply keeps the one it wrote. */
  names: string[];
  /** One of the eleven place kinds, or "flight". */
  kind: string;
  photo: string | null;
}

/** One mark in the turn's places list, in reply order. The name is the reply's own text, so the list doesn't repeat it. */
export interface PlaceMark {
  ref: string;
  kind: string;
  photo: string | null;
}

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text marks never touch: headings, struck text, fenced and inline code, and anything already a link. */
const PROTECTED = [/^[ \t]{0,3}#{1,6}[ \t].*$/gm, /~~[^~\n]+~~/g, /```[\s\S]*?```/g, /`[^`\n]*`/g, /\[[^\]\n]*\]\([^)\n]*\)/g];

/** A capitalized word other than "I" right after a name, on the same line: the name starts a longer one, such as "Tokyo Skytree". */
const LONGER_NAME = /[ \t ]+(?!I\b)\p{Lu}/uy;
const startsLongerName = (text: string, at: number) => { LONGER_NAME.lastIndex = at; return LONGER_NAME.test(text); };

/**
 * Marks the first mention of each candidate, keeping the words exactly as the reply wrote them and any bold around
 * them. Longer names win where names overlap, so "Tokyo Skytree" is the landmark, not Tokyo. A place name followed by
 * another capitalized word is part of a longer name the specialists didn't give, such as "Tokyo Station", and stays plain.
 */
export function markPlaces(markdown: string, candidates: readonly PlaceCandidate[]): { text: string; places: PlaceMark[] } {
  const byName = new Map<string, PlaceCandidate>();
  for (const candidate of candidates) {
    for (const name of candidate.names) {
      const key = name.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, candidate);
    }
  }
  if (!byName.size) return { text: markdown, places: [] };

  // Letters and digits on either side mean another word.
  const names = [...byName.keys()].sort((left, right) => right.length - left.length).map(escapeForPattern);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const spans = PROTECTED.flatMap((rule) => [...markdown.matchAll(rule)].map((match) => [match.index, match.index + match[0].length]));

  const marked = new Set<PlaceCandidate>();
  const places: PlaceMark[] = [];
  let text = '';
  let copied = 0;
  for (const match of markdown.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const candidate = byName.get(match[0].toLowerCase());
    if (!candidate || marked.has(candidate) || spans.some(([from, to]) => start < to && end > from)) continue;
    if (candidate.kind !== 'flight' && startsLongerName(markdown, end)) continue;
    marked.add(candidate);
    const ref = String(places.length + 1);
    places.push({ ref, kind: candidate.kind, photo: candidate.photo });
    text += `${markdown.slice(copied, start)}[${match[0]}](place:${ref})`;
    copied = end;
  }
  return { text: text + markdown.slice(copied), places };
}
