import { mergeTripPlannerSummaryContext } from './summary-context.js';
import { CITY_IATA_CODE_BY_NAME } from '../../../shared/travel/city-codes.js';

const DAY_MS = 24 * 60 * 60 * 1000;
type TripPlannerRecord = Record<string, any>;

const JOURNEY_TRIP_TYPES = new Set(['oneway', 'roundtrip', 'multicity']);
const PARTY_TRIP_TYPES = new Set(['solo', 'couple', 'family', 'friends', 'business']);
const PACE_TRIP_TYPES = new Set(['relaxed', 'balanced', 'fast-paced']);

const PACE_RULES = {
  relaxed: { label: 'relaxed', minAnchorsPerFullDay: 1, maxAnchorsPerFullDay: 2, bufferStyle: 'generous', maxNeighborhoodsPerDay: 1 },
  balanced: { label: 'balanced', minAnchorsPerFullDay: 2, maxAnchorsPerFullDay: 3, bufferStyle: 'standard', maxNeighborhoodsPerDay: 2 },
  'fast-paced': { label: 'fast-paced', minAnchorsPerFullDay: 3, maxAnchorsPerFullDay: 4, bufferStyle: 'short', maxNeighborhoodsPerDay: 3 },
};
type PaceName = keyof typeof PACE_RULES;

export interface ImageAsset {
  itemCode: string;
  imageUrl: string;
}

interface ToolStrategyInput {
  summaryContext: TripPlannerRecord;
  latestPatch: TripPlannerRecord;
  tripPlannerState: TripPlannerRecord;
  currentUserMessage: string;
  availableImageAssets: ImageAsset[];
  responseMode: string;
}

interface PatchTargetInput {
  latestPatch: TripPlannerRecord;
  latestPreferenceSignals: TripPlannerRecord;
  currentUserMessage: string;
}

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedTripTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizedString).filter((item): item is string => Boolean(item)))];
}

function normalizedPreferenceList(value: unknown): string[] {
  return normalizedTripTypes(value).map((item) => item.toLowerCase());
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function calendarDayDifference(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

function roundedAmount(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function normalizedIata(value: unknown): string | null {
  const code = normalizedString(value)?.toUpperCase() || null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

export function resolveTripPlannerDestinationIata(endpoint: TripPlannerRecord = {}) {
  const explicitCode = normalizedIata(endpoint?.iata);
  if (explicitCode) {
    return explicitCode;
  }
  const city = normalizedString(endpoint?.city)?.toLowerCase() || null;
  return city ? CITY_IATA_CODE_BY_NAME[city] || null : null;
}

export function mergeTripPlannerPreferenceSignals(
  current: TripPlannerRecord = {},
  incoming: TripPlannerRecord = {},
) {
  const positive = new Set(normalizedPreferenceList(current.positive));
  const negative = new Set(normalizedPreferenceList(current.negative));

  for (const preference of normalizedPreferenceList(incoming.positive)) {
    negative.delete(preference);
    positive.add(preference);
  }
  for (const preference of normalizedPreferenceList(incoming.negative)) {
    positive.delete(preference);
    negative.add(preference);
  }

  return { positive: [...positive], negative: [...negative] };
}

export function buildTripPlannerDateValidationFingerprint(input: TripPlannerRecord = {}) {
  const candidateDate = normalizedString(input.candidateDate);
  if (candidateDate) {
    return `date:${candidateDate}`;
  }
  const eventKeyword = normalizedString(input.eventKeyword);
  return eventKeyword
    ? `event:${eventKeyword.toLowerCase().replace(/\s+/g, ' ')}`
    : null;
}

function isEventStyleOnlyRequest(text: string): boolean {
  return (
    /\b(?:festival|event)[-\s]?like\b/i.test(text) ||
    /\b(?:festival|event)\s+(?:vibe|atmosphere|energy|style|feel)\b/i.test(text) ||
    /\b(?:not|without)\b[^.?!]{0,60}\b(?:specific\s+)?(?:festival|festivals|event|events)\b/i.test(
      text,
    )
  );
}

export function deriveTripPlannerFreshnessIntent(currentUserMessage = '') {
  const text = String(currentUserMessage || '');
  const categories: string[] = [];
  const addCategory = (category: string, pattern: RegExp): void => {
    if (pattern.test(text)) {
      categories.push(category);
    }
  };

  addCategory(
    'operating_status',
    /\b(?:opening|closing)\s+(?:hours?|times?)\b|\b(?:latest|current)\s+(?:hours?|timings?|schedule|status|availability)\b|\bopen\s+(?:now|today|tonight|late)\b/i,
  );
  addCategory(
    'temporary_disruption',
    /\b(?:temporar(?:y|ily)\s+closed|closures?|closed|maintenance|renovation|strike|disruption|suspended)\b/i,
  );
  addCategory(
    'weather',
    /\b(?:weather|forecast|rain|rainy|storm|storms|heatwave|heat wave|air quality|snow|snowfall|temperature)\b/i,
  );
  addCategory(
    'new_opening',
    /\b(?:newly|recently)\s+opened\b|\bnew\s+openings?\b/i,
  );
  addCategory(
    'travel_advisory',
    /\b(?:visa|entry requirements?|travel advisories?|travel advisory|security advisories?|border rules?|passport requirements?)\b/i,
  );
  addCategory(
    'price_or_reservation',
    /\b(?:current|latest|today'?s?)\s+(?:admission|ticket|entry)\s+prices?\b|\b(?:admission|ticket)\s+prices?\b|\b(?:reservation|booking)\s+requirements?\b|\bsold\s+out\b/i,
  );

  const namedEvent = text.match(
    /\b(?:oktoberfest|coachella|olympics|cherry blossoms?)\b/i,
  )?.[0];
  const generalEvent = text.match(/\b(?:festivals?|events?)\b/i)?.[0];
  const eventStyleOnly = isEventStyleOnlyRequest(text);
  if ((namedEvent || generalEvent) && !eventStyleOnly) {
    categories.push('event');
  }

  return {
    requiresFreshness: categories.length > 0,
    categories: [...new Set(categories)],
    eventKeyword: eventStyleOnly ? null : namedEvent || generalEvent || null,
    eventStyleOnly,
  };
}

function extractDateValidationInput(
  summaryContext: TripPlannerRecord,
  latestPatch: TripPlannerRecord,
  currentUserMessage: string,
): TripPlannerRecord | null {
  const text = String(currentUserMessage || '');
  const exactDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || null;
  const relativeDateIntent = text.match(
    /\b(?:today|tomorrow|tonight|this week|next week|this weekend|next weekend|next month|this month)\b/i,
  )?.[0];
  const calendarIntent =
    text.match(
      /\b(?:spring|summer|autumn|fall|winter|january|february|march|april|june|july|august|september|october|november|december)\b/i,
    )?.[0] ||
    text.match(/\bMay\b/)?.[0] ||
    text.match(/\b(?:in|during|around|for)\s+(may)\b/i)?.[1];
  const freshnessIntent = deriveTripPlannerFreshnessIntent(text);
  const dateIntent = relativeDateIntent || calendarIntent;

  if (freshnessIntent.eventKeyword && !latestPatch?.outbound_date) {
    const destination = summaryContext.destination.city;
    return {
      candidateDate: null,
      eventKeyword: [freshnessIntent.eventKeyword, dateIntent, destination]
        .filter(Boolean)
        .join(' '),
    };
  }
  if (
    freshnessIntent.categories.includes('weather') &&
    relativeDateIntent &&
    !latestPatch?.outbound_date
  ) {
    const destination = summaryContext.destination.city;
    return {
      candidateDate: null,
      eventKeyword: ['weather forecast', relativeDateIntent, destination]
        .filter(Boolean)
        .join(' '),
    };
  }
  if (dateIntent && !latestPatch?.outbound_date) {
    const destination = summaryContext.destination.city;
    return {
      candidateDate: null,
      eventKeyword: [dateIntent, destination].filter(Boolean).join(' '),
    };
  }
  if (latestPatch?.outbound_date || exactDate || summaryContext.outbound_date) {
    return {
      candidateDate:
        latestPatch?.outbound_date || exactDate || summaryContext.outbound_date,
      eventKeyword: null,
    };
  }
  return null;
}

function deriveDateConstraints(summaryContext: TripPlannerRecord): TripPlannerRecord {
  const outbound = parseIsoDate(summaryContext.outbound_date);
  const returnDate = parseIsoDate(summaryContext.return_date);
  const dateRangeDuration =
    outbound && returnDate && returnDate >= outbound
      ? calendarDayDifference(returnDate, outbound) + 1
      : null;
  const effectiveDurationDays = summaryContext.duration_days || dateRangeDuration || 4;
  const durationSource = summaryContext.duration_days
    ? 'summary_context'
    : dateRangeDuration
      ? 'date_range'
      : 'starter_assumption';
  const conflicts: string[] = [];

  if (summaryContext.outbound_date && !outbound) {
    conflicts.push('outbound_date_invalid');
  }
  if (summaryContext.return_date && !returnDate) {
    conflicts.push('return_date_invalid');
  }
  if (outbound && returnDate && returnDate < outbound) {
    conflicts.push('return_date_before_outbound');
  }
  if (
    summaryContext.duration_days &&
    dateRangeDuration &&
    summaryContext.duration_days !== dateRangeDuration
  ) {
    conflicts.push('duration_does_not_match_date_range');
  }

  const travelMonths = [...new Set(
    [outbound, returnDate]
      .filter((date): date is Date => Boolean(date))
      .map((date) => date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })),
  )];

  return {
    outbound_date: summaryContext.outbound_date,
    return_date: summaryContext.return_date,
    dateRangeDurationDays: dateRangeDuration,
    effectiveDurationDays,
    durationSource,
    travelMonths,
    conflicts,
  };
}

function deriveBudgetConstraints(
  summaryContext: TripPlannerRecord,
  effectiveDurationDays: number,
): TripPlannerRecord {
  const { amount, currency, per_person: perPerson, total } = summaryContext.budget;
  let basis = 'missing';
  if (amount !== null || total !== null) {
    if (perPerson === true) {
      basis = 'per_person';
    } else if (total !== null || perPerson === false) {
      basis = 'total';
    } else {
      basis = 'unspecified';
    }
  }

  const totalBudget =
    basis === 'total'
      ? total || amount
      : basis === 'per_person' && summaryContext.pax
        ? total || amount * summaryContext.pax
        : null;
  const perPersonBudget =
    basis === 'per_person'
      ? amount
      : basis === 'total' && summaryContext.pax
        ? totalBudget / summaryContext.pax
        : null;
  return {
    amount,
    currency,
    basis,
    totalBudget: roundedAmount(totalBudget),
    perPersonBudget: roundedAmount(perPersonBudget),
    dailyTotalBudget: roundedAmount(
      totalBudget && effectiveDurationDays ? totalBudget / effectiveDurationDays : null,
    ),
    dailyPerPersonBudget: roundedAmount(
      perPersonBudget && effectiveDurationDays ? perPersonBudget / effectiveDurationDays : null,
    ),
    planningGuidance: {
      food: 'Use a value, balanced, or flexible tier.',
      activities: 'Use a free, mixed, or paid tier.',
      flexibleReserve: 'Keep part of the budget unallocated.',
    },
    presentationRule:
      totalBudget === null
        ? 'Use cost tiers; no grounded numeric daily budget reference is available.'
        : 'Use the daily amount only as a budget reference, not as a full-trip category allocation.',
  };
}

function derivePartyConstraints(summaryContext: TripPlannerRecord): TripPlannerRecord {
  const normalizedTypes = summaryContext.tripType.map((value: string) => value.toLowerCase());
  const travelerStyle = normalizedTypes.find((value: string) => PARTY_TRIP_TYPES.has(value)) || null;
  const journeyType = normalizedTypes.find((value: string) => JOURNEY_TRIP_TYPES.has(value)) || null;
  const groupLabel =
    summaryContext.pax === 1
      ? 'solo traveler count'
      : summaryContext.pax === 2
        ? 'pair'
        : summaryContext.pax
          ? 'group'
          : 'unknown';

  return {
    pax: summaryContext.pax,
    groupLabel,
    travelerStyle,
    journeyType,
    compositionKnown: Boolean(travelerStyle),
    childrenKnown: false,
    mobilityNeedsKnown: false,
  };
}

function derivePaceConstraints(summaryContext: TripPlannerRecord): TripPlannerRecord {
  const normalizedPace =
    summaryContext.tripType
      .map((value: string) => value.toLowerCase())
      .find((value: string) => PACE_TRIP_TYPES.has(value)) as PaceName | undefined;
  const configured = normalizedPace ? PACE_RULES[normalizedPace] : PACE_RULES.balanced;
  return {
    ...configured,
    source: normalizedPace ? 'summary_context' : 'starter_assumption',
  };
}

function inferAskedQuestionKeys(output = '') {
  const text = String(output || '');
  if (!text.includes('?')) {
    return [];
  }
  const patterns = {
    destination: /(?:where|which destination|where.*go)[^?]*\?/i,
    dates: /(?:what|which|any).*?(?:date|month|when)[^?]*\?/i,
    duration: /(?:how many days|how long)[^?]*\?/i,
    party: /(?:who.*travel|how many.*(?:people|traveler)|kids|children|seniors)[^?]*\?/i,
    budget: /(?:budget|spend|per person|total)[^?]*\?/i,
    interests: /(?:interest|prefer|food|history|nature|nightlife)[^?]*\?/i,
    pace: /(?:pace|relaxed|packed)[^?]*\?/i,
  };
  return Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
}

export function mergeTripPlannerAskedQuestionKeys(
  current: string[] = [],
  output = '',
): string[] {
  return [...new Set([...current, ...inferAskedQuestionKeys(output)])];
}

function relevantImageAssets(
  summaryContext: TripPlannerRecord,
  tripPlannerState: TripPlannerRecord,
): ImageAsset[] {
  const itemCode = resolveTripPlannerDestinationIata(summaryContext.destination);
  const cached = tripPlannerState.placeImageCache || {};
  if (!itemCode || !cached[itemCode]?.imageUrl) {
    return [];
  }
  return [{ itemCode, imageUrl: cached[itemCode].imageUrl }];
}

function deriveToolStrategy({
  summaryContext,
  latestPatch,
  tripPlannerState,
  currentUserMessage,
  availableImageAssets,
  responseMode,
}: ToolStrategyInput): TripPlannerRecord {
  const scopeMode = tripPlannerState.scopeClassification?.mode || 'in_scope';
  if (scopeMode === 'excluded') {
    return {
      dateValidation: { action: 'not_needed', input: null, fingerprint: null },
      webSearch: {
        action: 'not_needed',
        reason: 'The latest request is outside Trip Planner scope.',
        categories: [],
      },
      images: { action: 'not_needed', itemCodes: [] },
      contextDetails: { action: 'not_needed', sections: [] },
      contextUpdate: { action: 'always_call_last' },
    };
  }

  const validationInput = extractDateValidationInput(
    summaryContext,
    latestPatch,
    currentUserMessage,
  );
  const validationFingerprint = buildTripPlannerDateValidationFingerprint(
    validationInput || {},
  );
  const priorValidation = tripPlannerState.dateValidationState || null;
  const dateValidation = !validationInput
    ? { action: 'not_needed', input: null, fingerprint: null }
    : priorValidation?.fingerprint === validationFingerprint
      ? {
          action: 'reuse',
          input: validationInput,
          fingerprint: validationFingerprint,
          priorStatus: priorValidation.status || null,
        }
      : { action: 'call', input: validationInput, fingerprint: validationFingerprint };

  const itemCode = resolveTripPlannerDestinationIata(summaryContext.destination);
  const explicitlyRequestsVisuals =
    /\b(?:photo|photos|image|images|picture|pictures|visual|visuals|show|see|view)\b/i.test(
      currentUserMessage,
    );
  let images;
  if (responseMode === 'patch_existing_itinerary' && !explicitlyRequestsVisuals) {
    images = { action: 'not_needed', itemCodes: [] };
  } else if (!summaryContext.destination.city && !itemCode) {
    images = { action: 'call_after_selecting_suggestions', itemCodes: [] };
  } else if (!itemCode) {
    images = { action: 'resolve_code_before_call', itemCodes: [] };
  } else if (availableImageAssets.some((asset) => asset.itemCode === itemCode)) {
    images = { action: 'reuse', itemCodes: [itemCode] };
  } else {
    images = { action: 'call', itemCodes: [itemCode] };
  }

  const freshnessIntent = deriveTripPlannerFreshnessIntent(currentUserMessage);
  const requiresFreshness = freshnessIntent.requiresFreshness;
  const eventNeedsValidation = Boolean(validationInput?.eventKeyword);
  const detailSections: string[] = [];
  if (
    summaryContext.placesOfInterest.length > 0 &&
    /\b(?:known|saved|recommended|available|all)\s+(?:places?|attractions?)\b/i.test(
      currentUserMessage,
    )
  ) {
    detailSections.push('places');
  }
  if (
    summaryContext.upcomingEvents.length > 0 &&
    /\b(?:known|saved|available|upcoming|all)\s+events?\b/i.test(currentUserMessage)
  ) {
    detailSections.push('events');
  }
  if (
    tripPlannerState.lastPlanArtifact &&
    /\b(?:previous|current|existing|last)\s+(?:plan|itinerary)\b|\bday\s*\d+\b/i.test(
      currentUserMessage,
    )
  ) {
    detailSections.push('last_plan');
  }

  return {
    dateValidation,
    webSearch: {
      action: requiresFreshness
        ? eventNeedsValidation
          ? 'after_date_validation_if_required'
          : 'call_once_for_current_fact'
        : 'not_needed',
      reason: requiresFreshness
        ? `latest user request needs current information: ${freshnessIntent.categories.join(', ')}`
        : null,
      categories: freshnessIntent.categories,
    },
    images,
    contextDetails: {
      action: detailSections.length > 0 ? 'call' : 'not_needed',
      sections: detailSections,
    },
    contextCapture: { action: 'completed' },
    suggestedQuestions: { action: 'always_call_last' },
  };
}

function derivePatchTargets({
  latestPatch,
  latestPreferenceSignals,
  currentUserMessage,
}: PatchTargetInput): string[] {
  const targets = new Set<string>();
  const fieldTargets: Record<string, string> = {
    origin: 'travel_context',
    destination: 'destination',
    outbound_date: 'dates_or_duration',
    return_date: 'dates_or_duration',
    duration_days: 'dates_or_duration',
    date_hint: 'dates_or_duration',
    pax: 'party',
    budget: 'budget',
    upcomingEvents: 'events',
    placesOfInterest: 'activities',
  };

  for (const field of Object.keys(latestPatch || {})) {
    if (fieldTargets[field]) {
      targets.add(fieldTargets[field]);
    }
  }

  for (const value of normalizedTripTypes(latestPatch?.tripType)) {
    const normalized = value.toLowerCase();
    if (JOURNEY_TRIP_TYPES.has(normalized) || PARTY_TRIP_TYPES.has(normalized)) {
      targets.add('party');
    } else if (PACE_TRIP_TYPES.has(normalized)) {
      targets.add('pace');
    } else {
      targets.add('preferences');
    }
  }

  if (
    (latestPreferenceSignals?.positive?.length || 0) > 0 ||
    (latestPreferenceSignals?.negative?.length || 0) > 0
  ) {
    targets.add('preferences');
  }

  const dayMatch = String(currentUserMessage || '').match(/\bday\s*(\d{1,2})\b/i);
  if (dayMatch) {
    targets.add(`day_${dayMatch[1]}`);
  }
  if (/\b(?:food|cuisine|restaurant|meal|dish)\b/i.test(currentUserMessage)) {
    targets.add('food');
  }
  if (/\b(?:neighborhoods?|districts?|areas?\s+to\s+explore)\b/i.test(currentUserMessage)) {
    targets.add('places');
  }
  if (/\b(?:budget[-\s]?friendly|affordable|low[-\s]?cost|save money|cheaper)\b/i.test(currentUserMessage)) {
    targets.add('budget');
  }
  if (/\b(?:activity|activities|sightseeing|museums?|beaches?|nature|nightlife)\b/i.test(currentUserMessage)) {
    targets.add('activities');
  }

  return [...targets];
}

function questionKeyWasAsked(questionKey: string, askedQuestionKeys: string[] = []) {
  const asked = new Set<string>(askedQuestionKeys.map(String));
  const aliases: Record<string, string[]> = {
    date_or_duration_conflict: ['dates', 'duration'],
    travel_dates_or_duration: ['dates', 'duration'],
    traveler_count: ['party'],
    budget_basis: ['budget'],
    budget_currency: ['budget'],
  };
  return (aliases[questionKey] || [questionKey]).some((key) => asked.has(key));
}

export function buildTripPlannerPlanningBrief({
  summaryContext = {},
  latestPatch = {},
  tripPlannerState = {},
  currentUserMessage = '',
}: TripPlannerRecord = {}) {
  const effectiveContext = mergeTripPlannerSummaryContext(summaryContext, latestPatch);
  const date = deriveDateConstraints(effectiveContext);
  const budget = deriveBudgetConstraints(effectiveContext, date.effectiveDurationDays);
  const pace = derivePaceConstraints(effectiveContext);
  const party = derivePartyConstraints(effectiveContext);
  const contextPreferences = effectiveContext.tripType.filter((value) => {
    const normalized = value.toLowerCase();
    return !(
      JOURNEY_TRIP_TYPES.has(normalized) ||
      PARTY_TRIP_TYPES.has(normalized) ||
      PACE_TRIP_TYPES.has(normalized)
    );
  });
  const preferenceSignals = mergeTripPlannerPreferenceSignals(
    { positive: contextPreferences },
    mergeTripPlannerPreferenceSignals(
      tripPlannerState.preferenceSignals,
      tripPlannerState.latestPreferenceSignals,
    ),
  );
  const availableImageAssets = relevantImageAssets(effectiveContext, tripPlannerState);
  const known: string[] = [];
  const assumptions: string[] = [];
  const conflicts = [...date.conflicts];

  if (effectiveContext.origin.city || effectiveContext.origin.iata) known.push('origin');
  if (effectiveContext.destination.city || effectiveContext.destination.iata) {
    known.push('destination');
  }
  if (effectiveContext.outbound_date) known.push('outbound_date');
  if (effectiveContext.return_date) known.push('return_date');
  if (effectiveContext.duration_days) known.push('duration_days');
  if (effectiveContext.pax) known.push('traveler_count');
  if (effectiveContext.budget.amount || effectiveContext.budget.total) {
    known.push('budget_amount');
  }
  if (budget.basis === 'total' || budget.basis === 'per_person') known.push('budget_basis');
  if (effectiveContext.tripType.length > 0) known.push('trip_type');
  if (
    effectiveContext.tripType.some((value) =>
      PACE_TRIP_TYPES.has(value.toLowerCase()),
    )
  ) {
    known.push('pace');
  }
  if (effectiveContext.upcomingEvents.length > 0) known.push('upcoming_events');
  if (effectiveContext.placesOfInterest.length > 0) known.push('places_of_interest');
  if (preferenceSignals.positive.length || preferenceSignals.negative.length) {
    known.push('preferences');
  }

  if (date.durationSource === 'starter_assumption') {
    assumptions.push('Use a 4-day starter outline until dates or duration are known.');
  }
  if (pace.source === 'starter_assumption') {
    assumptions.push('Use a balanced pace with 2-3 anchor activities per full day.');
  }
  if (budget.basis === 'missing') {
    assumptions.push('Use cost tiers only; do not invent an exact budget or price.');
  }
  if (!effectiveContext.pax) {
    assumptions.push('Keep recommendations party-neutral; do not assume children or mobility needs.');
  }
  if (!effectiveContext.outbound_date && !effectiveContext.return_date) {
    assumptions.push('Avoid date-specific season or event claims until dates are known.');
  }

  if (budget.amount !== null && budget.basis === 'unspecified') {
    conflicts.push('budget_basis_unspecified');
  }
  if (budget.amount !== null && !budget.currency) {
    conflicts.push('budget_currency_missing');
  }

  const highImpactMissing: string[] = [];
  if (
    conflicts.some((conflict) =>
      [
        'outbound_date_invalid',
        'return_date_invalid',
        'return_date_before_outbound',
        'duration_does_not_match_date_range',
      ].includes(conflict),
    )
  ) {
    highImpactMissing.push('date_or_duration_conflict');
  }
  if (conflicts.includes('budget_basis_unspecified')) {
    highImpactMissing.push('budget_basis');
  }
  if (conflicts.includes('budget_currency_missing')) {
    highImpactMissing.push('budget_currency');
  }
  if (!known.includes('destination')) highImpactMissing.push('destination');
  if (
    !effectiveContext.outbound_date &&
    !effectiveContext.return_date &&
    !effectiveContext.duration_days
  ) {
    highImpactMissing.push('travel_dates_or_duration');
  }
  if (!known.includes('preferences')) highImpactMissing.push('interests');
  if (!effectiveContext.pax) highImpactMissing.push('traveler_count');
  if (budget.basis === 'missing') highImpactMissing.push('budget');
  if (budget.basis === 'unspecified' && !highImpactMissing.includes('budget_basis')) {
    highImpactMissing.push('budget_basis');
  }
  if (!known.includes('pace')) highImpactMissing.push('pace');

  const firstDayLoad =
    effectiveContext.origin.city || effectiveContext.origin.iata ? 'light' : 'standard';
  const lastDayLoad = effectiveContext.return_date ? 'light' : 'standard';
  const lightDayCount =
    date.effectiveDurationDays === 1 && firstDayLoad === 'light' && lastDayLoad === 'light'
      ? 1
      : (firstDayLoad === 'light' ? 1 : 0) + (lastDayLoad === 'light' ? 1 : 0);
  const anchorBudgetByDay = Array.from(
    { length: date.effectiveDurationDays },
    (_value, index) => {
      const day = index + 1;
      const isFirstLightDay = day === 1 && firstDayLoad === 'light';
      const isLastLightDay =
        day === date.effectiveDurationDays && lastDayLoad === 'light';
      const load = isFirstLightDay || isLastLightDay ? 'light' : 'full';
      return {
        day,
        load,
        maxNamedAnchors:
          load === 'light' ? 1 : pace.maxAnchorsPerFullDay,
      };
    },
  );
  const currentDestination =
    effectiveContext.destination.iata || effectiveContext.destination.city || null;
  const previousDestination =
    tripPlannerState.lastPlanSnapshot?.destination?.iata ||
    tripPlannerState.lastPlanSnapshot?.destination?.city ||
    null;
  const destinationChanged = Boolean(
    tripPlannerState.lastPlanSnapshot &&
      currentDestination &&
      currentDestination !== previousDestination,
  );
  const latestHasAdjustment =
    Object.keys(latestPatch || {}).length > 0 ||
    /\b(?:make|change|add|remove|skip|avoid|more|less|instead)\b/i.test(currentUserMessage) ||
    /\bday\s*\d{1,2}\b/i.test(currentUserMessage) ||
    (tripPlannerState.latestPreferenceSignals?.positive?.length || 0) > 0 ||
    (tripPlannerState.latestPreferenceSignals?.negative?.length || 0) > 0;
  const responseMode = !known.includes('destination')
    ? 'destination_suggestions'
    : destinationChanged
      ? 'new_destination_itinerary'
      : latestHasAdjustment && tripPlannerState.lastPlanSnapshot
        ? 'patch_existing_itinerary'
        : 'destination_itinerary';
  const renderMode =
    responseMode === 'destination_suggestions'
      ? 'discovery_cards'
      : responseMode === 'patch_existing_itinerary'
        ? 'compact_patch'
        : 'compact_full';
  const patchTargets = derivePatchTargets({
    latestPatch,
    latestPreferenceSignals: tripPlannerState.latestPreferenceSignals,
    currentUserMessage,
  });
  const askedQuestionKeys = [
    ...new Set<string>((tripPlannerState.askedQuestionKeys || []).map(String)),
  ];
  const unaskedHighImpactMissing = highImpactMissing.filter(
    (key) => !questionKeyWasAsked(key, askedQuestionKeys),
  );
  const questionLimit =
    renderMode === 'discovery_cards' || renderMode === 'compact_patch'
      ? 1
      : unaskedHighImpactMissing.length > 1
        ? 2
        : 1;
  const questionPriority =
    renderMode === 'discovery_cards'
      ? unaskedHighImpactMissing.includes('destination')
        ? ['destination']
        : []
      : unaskedHighImpactMissing.slice(0, questionLimit);
  const explicitlyRequestsSeasonComparison =
    /\b(?:compare|comparison|all|four|different)\s+seasons?\b|\bseason[-\s]?by[-\s]?season\b/i.test(
      currentUserMessage,
    );

  const toolStrategy = deriveToolStrategy({
    summaryContext: effectiveContext,
    latestPatch,
    tripPlannerState,
    currentUserMessage,
    availableImageAssets,
    responseMode,
  });

  return {
    version: 1,
    effectiveContext,
    latestOverrides: latestPatch || {},
    known,
    assumptions,
    conflicts: [...new Set(conflicts)],
    highImpactMissing,
    preferenceSignals,
    derivedConstraints: {
      date,
      pace,
      party,
      budget,
      dayShape: {
        firstDayLoad,
        lastDayLoad,
        fullPlanningDays: Math.max(0, date.effectiveDurationDays - lightDayCount),
        anchorBudgetByDay,
        arrivalPacingReason:
          firstDayLoad === 'light'
            ? 'Origin and destination are known; keep arrival day conservative without inventing journey duration.'
            : null,
      },
    },
    continuity: {
      previousPlanAvailable: Boolean(tripPlannerState.lastPlanSnapshot),
      destinationChanged,
      shouldPatchPreviousPlan:
        Boolean(tripPlannerState.lastPlanSnapshot) && latestHasAdjustment && !destinationChanged,
      askedQuestionKeys,
    },
    toolState: {
      availableImageAssets,
      dateValidation: tripPlannerState.dateValidationState || null,
      previousSuggestedQuestions: Array.isArray(tripPlannerState.previousSuggestedQuestions)
        ? tripPlannerState.previousSuggestedQuestions.slice(0, 3)
        : [],
    },
    toolStrategy,
    responseStrategy: {
      mode: responseMode,
      renderMode,
      provideValueBeforeQuestions: true,
      maxBodyWords:
        renderMode === 'discovery_cards' ? 90 : renderMode === 'compact_patch' ? 160 : 350,
      targetBodyWords:
        renderMode === 'discovery_cards' ? 75 : renderMode === 'compact_patch' ? 130 : 300,
      maxIntroSentences: 1,
      maxTimeBlockWords: renderMode === 'compact_full' ? 18 : null,
      maxPatchDaySections:
        renderMode === 'compact_patch'
          ? patchTargets.includes('budget') ||
            patchTargets.some((target) => /^day_\d+$/.test(target))
            ? 1
            : 2
          : null,
      patchPresentation:
        renderMode === 'compact_patch'
          ? 'one_change_summary_then_up_to_2_bullets_and_only_the_most_affected_day_sections'
          : null,
      cardPolicy:
        renderMode === 'discovery_cards'
          ? 'exactly_3_cards'
          : renderMode === 'compact_patch'
            ? 'omit_unless_visuals_requested'
            : 'render_once',
      seasonPolicy: explicitlyRequestsSeasonComparison
        ? 'season_comparison_requested'
        : renderMode === 'discovery_cards'
          ? 'card_field_only'
          : renderMode === 'compact_patch'
            ? 'omit_unless_changed'
            : 'one_relevant_trip_season_note',
      budgetPolicy:
        renderMode === 'discovery_cards'
          ? 'card_field_only'
          : renderMode === 'compact_patch' && !patchTargets.includes('budget')
            ? 'omit_unchanged'
            : 'compact_two_column_table',
      includeUnchangedContent: renderMode !== 'compact_patch',
      requiresAllTimeBlocks: renderMode === 'compact_full',
      patchTargets,
      maxQuestions: questionPriority.length,
      questionPriority,
    },
  };
}
