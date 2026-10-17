/**
 * The chips the client shows after a turn, kept in summary.suggestedQuestions. Each specialist
 * keeps its own list (flight.suggestedQuestions, tripPlanner.suggestions); this joins the lists of
 * the specialists that ran. It runs at the end of the turn, because the Manager can run both in
 * parallel and Trip can finish before Flight writes its chips.
 */

// Words that don't decide whether a chip offers what the reply's question already offers.
const FILLER_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'it', 'me', 'my', 'us', 'our', 'and', 'or', 'with']);

function words(value: string): string[] {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((word) => word && !FILLER_WORDS.has(word));
}

/** The reply's last question. A flight reply can end with the price note after it. */
function closingQuestion(reply: string): string {
  return reply.match(/[^.!?\n]*\?/g)?.at(-1) ?? '';
}

export function combineSuggestedQuestions({ flight, trip, previous, reply }: {
  /** Flight's chips when Flight ran this turn, otherwise null. */
  flight: readonly string[] | null;
  /** Trip's chips when its result was saved this turn, otherwise null. */
  trip: readonly string[] | null;
  /** The combined list shown before this turn. */
  previous: readonly string[];
  reply: string;
}): string[] {
  if (!flight && !trip) return [...previous];
  // Two from each when both wrote chips, three from the one that did.
  const share = flight?.length && trip?.length ? 2 : 3;
  const offered = new Set(words(closingQuestion(reply)));
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const chips of [flight ?? [], trip ?? []]) {
    let taken = 0;
    for (const chip of chips) {
      if (taken === share) break;
      const chipWords = words(chip);
      const key = chipWords.join(' ');
      // A repeat, or the offer the reply's closing question already makes.
      if (!key || seen.has(key) || chipWords.every((word) => offered.has(word))) continue;
      seen.add(key);
      combined.push(chip);
      taken += 1;
    }
  }
  return combined;
}
