const CARD_IMAGE_LINE = /^\s*image\s*:/i;

const PROHIBITED_PATTERNS = [
  {
    category: 'accommodation',
    pattern:
      /\b(?:hotels?|hostels?|lodging|accommodations?|resorts?)\b|\bwhere\s+(?:(?:should|can)\s+i\s+|to\s+)?stay\b|\bstay\s+(?:areas?|options?)\b/i,
  },
  {
    category: 'vehicle',
    pattern: /\b(?:cars?|vehicles?|chauffeurs?|drivers?)\b/i,
  },
  {
    category: 'local_transport',
    pattern:
      /\b(?:local|public)\s+transport(?:ation)?\b|\bcommut(?:e|ing)\b|\bgetting\s+around\b|\b(?:taxi|taxis|cab|cabs|rideshare|uber|lyft|metro|subway|tram|transit)\b/i,
  },
  {
    category: 'airport_transfer',
    pattern:
      /\bairport\s+(?:transfer|pickup|pick-up|dropoff|drop-off)\b|\btransfer\s+(?:to|from)\s+(?:the\s+)?airport\b/i,
  },
  {
    category: 'rental',
    pattern:
      /\b(?:car|vehicle|bike|bicycle|scooter)\s+rentals?\b|\brent(?:ing)?\s+(?:a\s+)?(?:car|vehicle|bike|bicycle|scooter)\b/i,
  },
  {
    category: 'bus_or_train',
    pattern:
      /\b(?:book|booking|tickets?|schedules?|routes?|travel\s+by|take)\s+(?:a\s+)?(?:bus|buses|coach|coaches|train|trains|rail|railway)\b|\b(?:bus|buses|coach|coaches|train|trains|rail|railway)\s+(?:tickets?|booking|routes?|schedules?|rides?|travel)\b/i,
  },
];

const ALLOWED_SCOPE_CONTENT_PATTERN =
  /\b(?:plan\s+(?:(?:my|the|a)\s+)?trip|trip\s+plan|itinerar(?:y|ies)|places?|attractions?|sightseeing|viewpoints?|food|cuisine|restaurants?|dishes|activities|budget|affordable|cheap|free|pace|relaxed|lighter|faster|fast[-\s]?paced|family|couple|solo|adventur(?:e|ous)|history|museums?|nature|beaches?|shopping|nightlife|day\s*\d+|(?:first|second|third|fourth|fifth)\s+day)\b/i;

const ASSISTANT_STYLE_PATTERN =
  /^\s*(?:would\s+you\s+like|do\s+you\s+want|should\s+i|can\s+i)\b/i;

export const TRIP_PLANNER_SCOPE_FALLBACK =
  'I can help with day-wise itineraries, places, food, activities, trip pace, and budget-friendly planning.';

const DISCOVERY_CARD_COPY: Record<string, { title: string; knownFor: string }> = {
  PAR: {
    title: 'Paris, France',
    knownFor:
      'Art, historic streets, classic cuisine, museums, and landmark-filled sightseeing days',
  },
  ROM: {
    title: 'Rome, Italy',
    knownFor:
      'Ancient history, lively piazzas, regional food, ruins, and layered cultural walks',
  },
  TYO: {
    title: 'Tokyo, Japan',
    knownFor:
      'Neighborhood food, historic shrines, modern culture, gardens, and varied day experiences',
  },
};

export function textWithoutCardImageUrls(value = '') {
  return String(value)
    .split(/\r?\n/)
    .filter((line) => !CARD_IMAGE_LINE.test(line))
    .join('\n');
}

export function findTripPlannerScopeViolations(value = '') {
  const text = textWithoutCardImageUrls(value);
  const categories = PROHIBITED_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ category }) => category,
  );
  return [...new Set(categories)];
}

export function validateTripPlannerScopeText(value = '') {
  const categories = findTripPlannerScopeViolations(value);
  return {
    ok: categories.length === 0,
    categories,
    violationCount: categories.length,
  };
}

export function classifyTripPlannerScopeRequest(value = '') {
  const text = String(value || '');
  const categories = findTripPlannerScopeViolations(text);
  if (categories.length === 0) {
    return { mode: 'in_scope', categories };
  }
  const inScopeText = PROHIBITED_PATTERNS.reduce((remaining, { pattern }) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return remaining.replace(new RegExp(pattern.source, flags), ' ');
  }, text);
  return {
    mode: ALLOWED_SCOPE_CONTENT_PATTERN.test(inScopeText) ? 'mixed' : 'excluded',
    categories,
  };
}

export function isProhibitedTripPlannerPreference(value = '') {
  return findTripPlannerScopeViolations(String(value)).length > 0;
}

function suggestionWordCount(value: unknown): number {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function normalizedText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateTripPlannerSuggestedQuestions(
  value: unknown,
  { previousSuggestions = [] }: { previousSuggestions?: string[] } = {},
) {
  const suggestions = Array.isArray(value) ? value.map((item) => String(item).trim()) : [];
  const issues: string[] = [];
  const previous = new Set(previousSuggestions.map(normalizedText));

  if (suggestions.length !== 3) {
    issues.push('exactly_three_required');
  }

  suggestions.forEach((suggestion, index) => {
    const wordCount = suggestionWordCount(suggestion);
    if (!suggestion || wordCount < 3 || wordCount > 8) {
      issues.push(`invalid_length_${index}`);
    }
    if (ASSISTANT_STYLE_PATTERN.test(suggestion)) {
      issues.push(`assistant_style_${index}`);
    }
    if (findTripPlannerScopeViolations(suggestion).length > 0) {
      issues.push(`scope_violation_${index}`);
    }
    if (previous.has(normalizedText(suggestion))) {
      issues.push(`stale_suggestion_${index}`);
    }
  });

  if (new Set(suggestions.map((item) => item.toLowerCase())).size !== suggestions.length) {
    issues.push('duplicate_suggestions');
  }

  return {
    ok: issues.length === 0,
    suggestions,
    issues: [...new Set(issues)],
  };
}

function buildSafeDiscoveryFallback(context: Record<string, any> = {}) {
  const state = context.tripPlanner || {};
  if (state.planningBrief?.responseStrategy?.renderMode !== 'discovery_cards') {
    return null;
  }
  const imageEntries = Object.entries(state.placeImageCache || {}) as Array<
    [string, { imageUrl?: string }]
  >;
  const usableImageEntries = imageEntries
    .filter(([, image]) => typeof image.imageUrl === 'string' && image.imageUrl)
    .slice(0, 3);
  if (usableImageEntries.length !== 3) {
    return null;
  }

  const cards = usableImageEntries.map(([itemCode, image]) => {
    const copy = DISCOVERY_CARD_COPY[itemCode] || {
      title: itemCode,
      knownFor:
        'Food, history, local character, attractions, and flexible day-wise exploration ideas',
    };
    return [
      '[CARD]',
      `title: ${copy.title}`,
      `image: ${image.imageUrl}`,
      `known_for: ${copy.knownFor}`,
      'weather: Check current conditions after choosing travel dates',
      'budget: Budget estimate unavailable',
      '[/CARD]',
    ].join('\n');
  });

  return [
    ':::cards',
    ...cards,
    ':::cards',
    '',
    'Which destination should I plan?',
  ].join('\n');
}

export function sanitizeTripPlannerFinalOutput(value = '', { context = {} } = {}) {
  const validation = validateTripPlannerScopeText(value);
  if (validation.ok) {
    return {
      text: String(value || ''),
      changed: false,
      ...validation,
    };
  }
  const discoveryFallback = buildSafeDiscoveryFallback(context);
  return {
    text: discoveryFallback || TRIP_PLANNER_SCOPE_FALLBACK,
    changed: true,
    ...validation,
  };
}
