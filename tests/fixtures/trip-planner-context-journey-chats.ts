const DAY_MS = 24 * 60 * 60 * 1000;

const TOOLS = {
  date: 'validate_trip_date',
  image: 'get_place_images_batch',
  web: 'web_search',
  details: 'get_trip_planner_context_details',
  context: 'update_trip_planner_context',
  update: 'update_trip_planner_suggested_questions',
};

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function startOfUtcDay(value) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function futureMonthRange(now, monthOffset, startDay = 10, endDay = 14) {
  const today = startOfUtcDay(now);
  const outbound = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() + monthOffset,
      startDay,
    ),
  );
  const returnDate = new Date(
    Date.UTC(
      outbound.getUTCFullYear(),
      outbound.getUTCMonth(),
      endDay,
    ),
  );
  return {
    outbound: outbound.toISOString().slice(0, 10),
    return: returnDate.toISOString().slice(0, 10),
    label: `${MONTH_NAMES[outbound.getUTCMonth()]} ${startDay} to ${endDay}`,
    returnDay: endDay,
  };
}

function fullSummaryContext(overrides = {}) {
  return {
    pax: 2,
    budget: {
      total: 2200,
      amount: 2200,
      currency: 'USD',
      per_person: false,
    },
    origin: { city: 'Delhi', iata: 'DEL' },
    destination: { city: 'Paris', iata: 'PAR' },
    tripType: ['roundtrip', 'couple', 'balanced', 'food'],
    outbound_date: null,
    return_date: null,
    duration_days: 5,
    upcomingEvents: [],
    placesOfInterest: [],
    suggestedQuestions: [],
    ...overrides,
  };
}

function exact(path, value) {
  return { path, value };
}

function includes(path, value) {
  return { path, includes: value };
}

export function createTripPlannerContextJourneyChats({
  now = new Date(),
} = {}) {
  const emptyDates = futureMonthRange(now, 2);
  const fullDates = futureMonthRange(now, 3);
  const changedDates = futureMonthRange(now, 4, 20, 24);
  const baliDates = futureMonthRange(now, 2, 16, 21);
  const messyDates = futureMonthRange(now, 2, 10, 14);

  const chats = [
    {
      id: 'trip-context-empty',
      title: 'Empty context filled through short replies',
      initialState: 'empty',
      initialSummaryContext: {},
      turns: [
        {
          userMessage: 'need trip. food + history. paris/rome/tokyo?',
          expectedBehavior:
            'Keep destination unset, remember food/history, show exactly three destination cards, and ask only for a selection.',
          expectedTools: [TOOLS.image, TOOLS.update],
          expectedRenderMode: 'discovery_cards',
          expectedCards: 3,
          expectedContext: [
            exact('destination.city', null),
            includes('tripType', 'food'),
            includes('tripType', 'history'),
          ],
          responsePatterns: [/Paris/i, /Rome/i, /Tokyo/i],
        },
        {
          userMessage: 'rome',
          expectedBehavior:
            'Treat the one-word reply as destination selection, retain interests, and produce a compact starter plan.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [
            exact('destination.city', 'Rome'),
            includes('tripType', 'food'),
            includes('tripType', 'history'),
          ],
          preserve: ['tripType'],
          responsePatterns: [/Rome/i],
        },
        {
          userMessage: '5 days',
          expectedBehavior:
            'Add duration, preserve Rome and interests, and patch only duration-affected content.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            exact('duration_days', 5),
            exact('destination.city', 'Rome'),
          ],
          preserve: ['destination.city', 'tripType'],
          responsePatterns: [/\b5\b|five/i],
        },
        {
          userMessage: emptyDates.label.toLowerCase(),
          expectedBehavior:
            'Resolve the natural date range, preserve the current trip, and validate the new outbound date once.',
          expectedTools: [TOOLS.date, TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            exact('outbound_date', emptyDates.outbound),
            exact('return_date', emptyDates.return),
            exact('duration_days', 5),
          ],
          preserve: ['destination.city', 'duration_days', 'tripType'],
          responsePatterns: [new RegExp(MONTH_NAMES[new Date(`${emptyDates.outbound}T00:00:00Z`).getUTCMonth()], 'i')],
        },
        {
          userMessage: '2 ppl',
          expectedBehavior:
            'Add two travelers without asking again for destination, dates, duration, or interests.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [exact('pax', 2)],
          preserve: [
            'destination.city',
            'outbound_date',
            'return_date',
            'duration_days',
            'tripType',
          ],
          responsePatterns: [/\b2\b|two|couple|travelers?/i],
        },
        {
          userMessage: 'make it chill',
          expectedBehavior:
            'Add relaxed pace while retaining every established trip fact and return only pacing changes.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [includes('tripType', 'relaxed')],
          preserve: [
            'destination.city',
            'outbound_date',
            'return_date',
            'duration_days',
            'pax',
          ],
          responsePatterns: [/relax|chill|easy|lighter/i],
        },
      ],
    },
    {
      id: 'trip-context-partial',
      title: 'Partial route context with vague date and preferences',
      initialState: 'partial',
      initialSummaryContext: {
        origin: { city: 'Delhi', iata: 'DEL' },
        destination: { city: 'Tokyo', iata: 'TYO' },
      },
      turns: [
        {
          userMessage: 'next month',
          expectedBehavior:
            'Use the known route, validate the vague month intent, avoid inventing exact dates, and ask only for useful missing detail.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [
            exact('origin.iata', 'DEL'),
            exact('destination.iata', 'TYO'),
            exact('outbound_date', null),
            exact('return_date', null),
          ],
          preserve: ['origin.city', 'origin.iata', 'destination.city', 'destination.iata'],
          responsePatterns: [/Tokyo/i, /month|date|day/i],
          notes:
            'A relative month is not stored as an exact outbound/return date because the production schema has no vague-range field.',
        },
        {
          userMessage: '4 days',
          expectedBehavior:
            'Persist duration and preserve the known route without requesting either endpoint again.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [exact('duration_days', 4)],
          preserve: ['origin.city', 'origin.iata', 'destination.city', 'destination.iata'],
          responsePatterns: [/\b4\b|four/i],
        },
        {
          userMessage: 'with wife',
          expectedBehavior:
            'Infer two travelers and couple intent while retaining route and duration.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            exact('pax', 2),
            includes('tripType', 'couple'),
          ],
          preserve: ['origin.city', 'destination.city', 'duration_days'],
          responsePatterns: [/couple|two|2|together/i],
        },
        {
          userMessage: 'not too costly',
          expectedBehavior:
            'Store budget-conscious intent without inventing a numeric budget and return affordable itinerary adjustments.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            includes('tripType', 'budget-conscious'),
            exact('budget.amount', null),
          ],
          preserve: ['origin.city', 'destination.city', 'duration_days', 'pax'],
          responsePatterns: [/budget|affordable|free|low-cost|value/i],
        },
      ],
    },
    {
      id: 'trip-context-full',
      title: 'Fully filled context used without repeated questions',
      initialState: 'full',
      initialSummaryContext: fullSummaryContext({
        outbound_date: fullDates.outbound,
        return_date: fullDates.return,
        tripType: ['roundtrip', 'couple', 'relaxed', 'food', 'culture'],
      }),
      turns: [
        {
          userMessage: 'plan my trip',
          expectedBehavior:
            'Use all existing facts directly, create the complete five-day plan, and ask no missing-field questions.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          maxQuestions: 0,
          expectedContext: [
            exact('destination.iata', 'PAR'),
            exact('outbound_date', fullDates.outbound),
            exact('return_date', fullDates.return),
            exact('pax', 2),
            exact('budget.total', 2200),
            includes('tripType', 'relaxed'),
          ],
          preserve: [
            'origin',
            'destination',
            'outbound_date',
            'return_date',
            'duration_days',
            'pax',
            'budget',
            'tripType',
          ],
          responsePatterns: [/Paris/i, /food|cuisine/i, /culture|museum|historic/i],
        },
      ],
    },
    {
      id: 'trip-context-destination-change',
      title: 'Destination and date overrides preserve unrelated context',
      initialState: 'filled_then_changed',
      initialSummaryContext: fullSummaryContext({
        destination: { city: 'Rome', iata: 'ROM' },
        outbound_date: fullDates.outbound,
        return_date: fullDates.return,
        upcomingEvents: [{ name: 'Old Rome event' }],
        placesOfInterest: [
          { placeName: 'Colosseum', description: 'Old destination detail' },
        ],
      }),
      turns: [
        {
          userMessage: 'plan my trip',
          expectedBehavior:
            'Create the initial Rome plan from the complete context.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [exact('destination.iata', 'ROM')],
          responsePatterns: [/Rome/i],
        },
        {
          userMessage: 'change to paris',
          expectedBehavior:
            'Replace only the destination, clear Rome-specific knowledge, retain dates/passengers/budget/preferences, and make a fresh Paris plan.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [
            exact('destination.city', 'Paris'),
            exact('destination.iata', null),
            exact('upcomingEvents', []),
            exact('placesOfInterest', []),
          ],
          preserve: [
            'origin',
            'outbound_date',
            'return_date',
            'duration_days',
            'pax',
            'budget',
            'tripType',
          ],
          responsePatterns: [/Paris/i],
        },
        {
          userMessage: `change dates to ${changedDates.label}`,
          expectedBehavior:
            'Override only outbound and return dates, preserve Paris and all unrelated fields, and patch date-sensitive content.',
          expectedTools: [TOOLS.date, TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            exact('outbound_date', changedDates.outbound),
            exact('return_date', changedDates.return),
            exact('destination.city', 'Paris'),
          ],
          preserve: ['origin', 'destination', 'duration_days', 'pax', 'budget', 'tripType'],
          responsePatterns: [/date|day|season|arrival/i],
        },
      ],
    },
    {
      id: 'trip-context-style-change',
      title: 'Preference evolution keeps core trip state',
      initialState: 'full',
      initialSummaryContext: fullSummaryContext({
        destination: { city: 'Bali', iata: 'DPS' },
        outbound_date: baliDates.outbound,
        return_date: baliDates.return,
        duration_days: 6,
        tripType: ['roundtrip', 'couple', 'balanced', 'nature'],
      }),
      turns: [
        {
          userMessage: 'plan my trip',
          expectedBehavior:
            'Build the initial six-day Bali plan using couple, nature, and balanced context.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [
            exact('destination.iata', 'DPS'),
            includes('tripType', 'nature'),
          ],
          responsePatterns: [/Bali/i, /nature|scenic|beach|rice/i],
        },
        {
          userMessage: 'food focused now',
          expectedBehavior:
            'Add food focus and patch only food-related plan content.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [includes('tripType', 'food')],
          preserve: ['destination', 'outbound_date', 'return_date', 'duration_days', 'pax', 'budget'],
          responsePatterns: [/food|cuisine|meal|market/i],
        },
        {
          userMessage: 'make it chill',
          expectedBehavior:
            'Replace balanced pace with relaxed pace while preserving destination, dates, party, budget, nature, and food.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            includes('tripType', 'relaxed'),
            includes('tripType', 'food'),
            includes('tripType', 'nature'),
          ],
          forbiddenContextValues: [{ path: 'tripType', value: 'balanced' }],
          preserve: ['destination', 'outbound_date', 'return_date', 'duration_days', 'pax', 'budget'],
          responsePatterns: [/relax|chill|easy|lighter/i],
        },
        {
          userMessage: 'not too costly',
          expectedBehavior:
            'Add durable budget-conscious intent, preserve prior food/nature/relaxed preferences, and avoid inventing new prices.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            includes('tripType', 'budget-conscious'),
            includes('tripType', 'relaxed'),
            includes('tripType', 'food'),
          ],
          preserve: ['destination', 'outbound_date', 'return_date', 'duration_days', 'pax', 'budget'],
          responsePatterns: [/budget|affordable|free|low-cost|value/i],
        },
      ],
    },
    {
      id: 'trip-context-messy',
      title: 'Almost-complete context with typo-heavy partial inputs',
      initialState: 'almost_complete',
      initialSummaryContext: {
        destination: { city: 'Tokyo', iata: 'TYO' },
        outbound_date: messyDates.outbound,
        tripType: ['food'],
      },
      turns: [
        {
          userMessage: `to ${messyDates.returnDay}`,
          expectedBehavior:
            'Interpret the short reply as the return day in the known outbound month, retain Tokyo and food, and produce a starter plan.',
          expectedTools: [TOOLS.date, TOOLS.image, TOOLS.update],
          expectedRenderMode: 'compact_full',
          expectedContext: [
            exact('return_date', messyDates.return),
            exact('destination.iata', 'TYO'),
            includes('tripType', 'food'),
          ],
          preserve: ['destination', 'outbound_date', 'tripType'],
          responsePatterns: [/Tokyo/i],
        },
        {
          userMessage: '5 dys',
          expectedBehavior:
            'Understand the duration typo, store five days, and preserve the date range and destination.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [exact('duration_days', 5)],
          preserve: ['destination', 'outbound_date', 'return_date', 'tripType'],
          responsePatterns: [/\b5\b|five/i],
        },
        {
          userMessage: '2 ppl',
          expectedBehavior:
            'Understand the traveler shorthand and update only party context.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [exact('pax', 2)],
          preserve: ['destination', 'outbound_date', 'return_date', 'duration_days', 'tripType'],
          responsePatterns: [/\b2\b|two|travelers?/i],
        },
        {
          userMessage: 'frm delhi',
          expectedBehavior:
            'Understand the origin typo, add Delhi, and preserve the established Tokyo trip.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [exact('origin.city', 'Delhi')],
          preserve: ['destination', 'outbound_date', 'return_date', 'duration_days', 'pax', 'tripType'],
          responsePatterns: [/Delhi|arrival|first day|light/i],
        },
        {
          userMessage: 'add adventur',
          expectedBehavior:
            'Understand the preference typo, add adventure, and retain food plus all core context.',
          expectedTools: [TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedContext: [
            includes('tripType', 'adventure'),
            includes('tripType', 'food'),
          ],
          preserve: ['origin', 'destination', 'outbound_date', 'return_date', 'duration_days', 'pax'],
          responsePatterns: [/adventure|active|outdoor/i],
        },
        {
          userMessage: 'day 3 easy pls',
          expectedBehavior:
            'Treat the terse day reference as a refinement, load the saved plan, and patch only day 3.',
          expectedTools: [TOOLS.details, TOOLS.update],
          expectedRenderMode: 'compact_patch',
          expectedDetailSections: ['last_plan'],
          expectedContext: [
            includes('tripType', 'adventure'),
            exact('destination.iata', 'TYO'),
          ],
          preserve: [
            'origin',
            'destination',
            'outbound_date',
            'return_date',
            'duration_days',
            'pax',
            'tripType',
          ],
          responsePatterns: [/day 3/i, /easy|light|relax|slower/i],
          maxDaySections: 1,
        },
      ],
    },
  ];
  return chats.map((chat) => ({
    ...chat,
    turns: chat.turns.map((turn) => ({
      ...turn,
      expectedTools: [
        TOOLS.context,
        ...turn.expectedTools.filter((toolName) => toolName !== TOOLS.context),
      ],
    })),
  }));
}

export const TRIP_PLANNER_CONTEXT_JOURNEY_TOOLS = TOOLS;
