/** Business scope: Trip plans places, food, activities, pace and budget, never lodging or getting around. */
const OUT_OF_SCOPE_PATTERNS = [
  /\b(?:hotels?|hostels?|lodging|accommodations?|resorts?)\b|\bwhere\s+(?:(?:should|can)\s+i\s+|to\s+)?stay\b/i,
  /\b(?:cars?|vehicles?|chauffeurs?|drivers?)\b/i,
  /\b(?:local|public)\s+transport(?:ation)?\b|\bcommut(?:e|ing)\b|\bgetting\s+around\b|\b(?:taxi|taxis|cab|cabs|rideshare|uber|lyft|metro|subway|tram|transit)\b/i,
  /\bairport\s+(?:transfer|pickup|pick-up|dropoff|drop-off)\b|\btransfer\s+(?:to|from)\s+(?:the\s+)?airport\b/i,
  /\b(?:car|vehicle|bike|bicycle|scooter)\s+rentals?\b|\brent(?:ing)?\s+(?:a\s+)?(?:car|vehicle|bike|bicycle|scooter)\b/i,
  /\b(?:book|booking|tickets?|schedules?|routes?|travel\s+by|take)\s+(?:a\s+)?(?:bus|buses|coach|coaches|train|trains|rail|railway)\b|\b(?:bus|buses|coach|coaches|train|trains|rail|railway)\s+(?:tickets?|booking|routes?|schedules?|rides?|travel)\b/i,
];

export function isOutOfTripScope(value: unknown): boolean {
  const text = String(value ?? '');
  return OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(text));
}
