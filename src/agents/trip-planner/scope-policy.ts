import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import { getTripPlannerFormattingRules, tripPlannerFeedbackSchema, tripPlannerManagerOutputSchema, type TripPlannerManagerOutput } from './manager-output.js';
import { canonicalTripPlannerQuestionKeys } from './context/planning-brief.js';

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

/** Scope-check, then strip links from, the Trip Planner's final text. */
export function sanitizeTripPlannerOutput(output = '', context: Record<string, any> = {}) {
  const scope = sanitizeTripPlannerFinalOutput(output, { context });
  const links = sanitizeNoLinks(scope.text, { preserveCardImageUrls: true });
  assertNoLinks(links.text, { allowCardImageUrls: true });
  context.tripPlannerScopeGuardrail = {
    applied: true,
    changed: scope.changed,
    violationCount: scope.violationCount,
    categories: scope.categories,
  };
  context.tripPlannerLinkGuardrail = { applied: true, changed: links.changed, removedCount: links.removedCount };
  return {
    output: links.text,
    guardrail: context.tripPlannerLinkGuardrail,
    scopeGuardrail: context.tripPlannerScopeGuardrail,
  };
}

/** A failed result has nothing to present, so its rules must not invite a question. */
function failureRules(rules: TripPlannerManagerOutput['formattingRules']) {
  return { ...rules, maxQuestions: 0, questionPriority: [] };
}

/** Typed failure for a result the guard cannot pass on; never raw error text the Manager would retry. */
export function tripPlannerFailureFeedback(context: Record<string, any>) {
  return tripPlannerManagerOutputSchema.parse({
    status: 'failure', mode: 'answer', destinationCards: [], itineraryDays: [], recommendation: null,
    notes: [], tables: [], nextQuestions: [], formattingRules: failureRules(getTripPlannerFormattingRules(context)),
    limitations: ['This trip planning update could not be completed just now.'],
  });
}

/** Validate individual facts; whole-JSON link stripping would destroy image assets. */
export function sanitizeTripPlannerManagerOutput(
  value: unknown,
  context: Record<string, any>,
  newItems: Array<{ rawItem?: any }> = [],
) {
  const feedback = tripPlannerFeedbackSchema.parse(value);
  const state = context.tripPlanner || {};
  const brief = state.planningBrief;
  // The model writes findings only; the phase's deterministic rules are attached here.
  const rules = getTripPlannerFormattingRules(context);

  const violations = new Set<string>();
  const strays = (text: string | null) => {
    const { categories } = validateTripPlannerScopeText(text ?? '');
    categories.forEach((category) => violations.add(category));
    return categories.length > 0;
  };
  // Commentary that strays into an excluded topic is dropped; planning content must itself stay in scope.
  const commentary = {
    recommendation: strays(feedback.recommendation) ? null : feedback.recommendation,
    notes: feedback.notes.filter((note) => !strays(note.text)),
    limitations: feedback.limitations.filter((limitation) => !strays(limitation)),
  };
  let contentViolation = false;
  let removedCount = 0;
  const cleanFact = (text: string): string => {
    if (strays(text)) contentViolation = true;
    const links = sanitizeNoLinks(text);
    removedCount += links.removedCount;
    assertNoLinks(links.text);
    // Emphasis and internal labels such as "Anchor 1:" are stripped; cards, headings or code mean a
    // completed answer was smuggled in.
    const plain = links.text.replace(/\*\*/g, '').replace(/\banchor\s*\d*\s*(?:\([^)]*\))?\s*:\s*/gi, '');
    if (/\[\/?CARD\]|:::cards|```|^\s*#/im.test(plain)) {
      throw new Error('Trip feedback facts must be plain text, not a completed markdown answer.');
    }
    return plain;
  };
  // Link cleaning can empty a whole fact; an emptied optional value becomes null rather than failing the result.
  const nullableFact = (text: string | null) => text === null ? null : cleanFact(text) || null;
  const output = {
    ...feedback,
    destinationCards: feedback.destinationCards.map((card) => ({
      ...card,
      itemCode: cleanFact(card.itemCode),
      title: cleanFact(card.title),
      knownFor: cleanFact(card.knownFor),
      weather: cleanFact(card.weather),
      budget: cleanFact(card.budget),
    })),
    itineraryDays: feedback.itineraryDays.map((day) => ({
      ...day,
      title: nullableFact(day.title),
      morning: nullableFact(day.morning),
      afternoon: nullableFact(day.afternoon),
      evening: nullableFact(day.evening),
    })),
    recommendation: nullableFact(commentary.recommendation),
    notes: commentary.notes.map((note) => ({ ...note, text: cleanFact(note.text), sourceName: nullableFact(note.sourceName) }))
      .filter((note) => note.text),
    tables: feedback.tables.map((table) => ({
      ...table,
      title: nullableFact(table.title),
      columns: table.columns.map(cleanFact),
      rows: table.rows.map((row) => ({ ...row, cells: row.cells.map(cleanFact) })),
    })),
    nextQuestions: feedback.nextQuestions.map((question) => ({ ...question, purpose: cleanFact(question.purpose) })),
    limitations: commentary.limitations.map(cleanFact).filter(Boolean),
  };
  context.tripPlannerScopeGuardrail = {
    applied: true, changed: violations.size > 0,
    violationCount: violations.size, categories: [...violations],
  };
  context.tripPlannerLinkGuardrail = { applied: true, changed: removedCount > 0, removedCount };
  if (contentViolation || state.scopeClassification?.mode === 'excluded') {
    return {
      output: tripPlannerManagerOutputSchema.parse({
        ...output, status: 'failure', mode: 'answer', destinationCards: [], itineraryDays: [],
        recommendation: null, tables: [], nextQuestions: [], limitations: [],
        notes: [{ kind: 'capability', text: TRIP_PLANNER_SCOPE_FALLBACK, sourceName: null }],
        formattingRules: failureRules(rules),
      }),
      storePlanArtifact: false,
    };
  }

  for (const card of output.destinationCards) {
    const cached = state.placeImageCache?.[card.itemCode]?.imageUrl;
    if (card.imageUrl !== null && (card.imageUrl !== cached || !/^https?:\/\/\S+$/.test(card.imageUrl))) {
      throw new Error('Trip card image is not the matching tool asset.');
    }
    if (card.imageUrl === null && cached) {
      throw new Error('Trip card omitted an available matching image asset.');
    }
  }
  if (new Set(output.destinationCards.map((card) => card.itemCode)).size !== output.destinationCards.length) {
    throw new Error('Trip feedback contains duplicate destinations.');
  }
  const expectedMode = brief.responseStrategy.renderMode;
  const missing: string[] = [];
  if (output.mode !== 'answer' && output.mode !== expectedMode) {
    throw new Error('Trip feedback mode does not match the current planning phase.');
  }
  if (['answer', 'discovery_cards'].includes(output.mode) && output.itineraryDays.length > 0) {
    throw new Error('Trip feedback added an unrequested itinerary.');
  }
  if (output.mode === 'discovery_cards' && output.destinationCards.length !== 3) {
    missing.push('The requested destination comparison could not be completed.');
  }
  if (output.mode === 'compact_full') {
    const count = brief.derivedConstraints.date.effectiveDurationDays;
    if (output.itineraryDays.length !== count || output.itineraryDays.some((day, index) => day.day !== index + 1 || !day.title || !day.morning || !day.afternoon || !day.evening)) {
      missing.push('The complete day-wise plan could not be finished.');
    }
    if (output.destinationCards.length !== 1) missing.push('The selected destination card could not be completed.');
  }
  if (output.mode === 'compact_patch') {
    const requestedDays = rules.patchTargets.filter((target) => /^day_\d+$/.test(target)).map((target) => Number(target.slice(4)));
    if (output.itineraryDays.length > (rules.maxPatchDaySections || 2)
      || new Set(output.itineraryDays.map((day) => day.day)).size !== output.itineraryDays.length
      || output.itineraryDays.some((day) => requestedDays.length > 0 && !requestedDays.includes(day.day))) {
      throw new Error('Trip feedback patch exceeds the requested day scope.');
    }
    if (rules.cardPolicy === 'omit_unless_visuals_requested' && brief.toolStrategy.images.action === 'not_needed' && output.destinationCards.length > 0) {
      throw new Error('Trip feedback repeats unchanged cards in a patch.');
    }
  }
  for (const table of output.tables) {
    if (table.rows.some((row) => row.cells.length !== table.columns.length)
      || table.kind === 'budget' && (table.columns.length !== 2 || rules.budgetPolicy !== 'compact_two_column_table')) {
      throw new Error('Trip feedback table violates the current budget/comparison policy.');
    }
  }
  if (output.notes.some((note) => note.kind === 'season') && (rules.seasonPolicy === 'card_field_only'
    || rules.seasonPolicy === 'omit_unless_changed' && !rules.patchTargets.includes('dates_or_duration'))) {
    throw new Error('Trip feedback repeats seasonal guidance outside its allowed scope.');
  }
  const allowedQuestions = new Set(rules.questionPriority.flatMap(canonicalTripPlannerQuestionKeys));
  const asked = new Set((state.askedQuestionKeys || []).flatMap(canonicalTripPlannerQuestionKeys));
  const questionKeys = output.nextQuestions.flatMap((question) => canonicalTripPlannerQuestionKeys(question.key));
  if (output.nextQuestions.length > rules.maxQuestions || new Set(questionKeys).size !== questionKeys.length
    || questionKeys.some((key) => !allowedQuestions.has(key) || asked.has(key))) {
    throw new Error('Trip feedback asks an extra, known or repeated question.');
  }
  if (output.mode === 'discovery_cards' && !['failure', 'needs_input'].includes(output.status)
    && output.destinationCards.length > 0 && output.nextQuestions.length !== Math.min(1, rules.maxQuestions)) {
    throw new Error('Destination discovery requires one selection question.');
  }

  const calls = state.currentTurnToolCalls || [];
  const completed = (name: string) => calls.some((call: any) => call.tool === name && call.output?.ok === true);
  if (!state.turnState?.contextCaptured) missing.push('The requested trip preferences could not be saved.');
  if (output.mode !== 'answer' && ['call', 'call_after_selecting_suggestions'].includes(brief.toolStrategy.images.action) && !completed('get_place_images_batch')) {
    missing.push('The requested destination photos could not be obtained.');
  }
  if (brief.toolStrategy.contextDetails.action === 'call' && !completed('get_trip_planner_context_details')) {
    missing.push('The saved plan details needed for this request could not be retrieved.');
  }
  // Trip decides when to research; a researched fact still needs this turn's evidence.
  const researched = newItems.some(({ rawItem }) => rawItem?.type === 'hosted_tool_call'
    && ['web_search_call', 'web_search'].includes(rawItem.name) && rawItem.status === 'completed');
  const unresearched = (note: { kind: string; sourceName: string | null }) => note.kind === 'fact' && note.sourceName !== null;
  if (!researched && output.notes.some(unresearched)) {
    missing.push('The requested current information could not be verified.');
    output.notes = output.notes.filter((note) => !unresearched(note));
  }
  if (missing.length > 0) {
    if (output.status === 'success') output.status = 'partial';
    output.limitations = [...new Set([...output.limitations, ...missing])];
  }
  return {
    output: tripPlannerManagerOutputSchema.parse({
      ...output, formattingRules: output.status === 'failure' ? failureRules(rules) : rules,
    }),
    storePlanArtifact: missing.length === 0 && !['failure', 'needs_input'].includes(output.status),
  };
}
