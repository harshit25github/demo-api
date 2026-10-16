/** Held-out Manager conversations; specialist facts and state effects are controlled fixtures. */
export interface ConversationTurn {
  user: string;
  specialist: 'flight_agent' | 'trip_planner_agent' | null;
  feedback?: Record<string, any>;
  flightState?: Record<string, any>;
  tripResult?: Record<string, any>;
  subtaskIncludes?: RegExp[];
  subtaskExcludes?: RegExp[];
  outputIncludes?: RegExp[];
  outputExcludes?: RegExp[];
  questions?: number;
}

const flight = (fields: Record<string, any>) => ({ status: 'success', completedTask: 'Checked the requested flights.',
  summary: 'The flight check is complete.', findings: [], limitations: [], missingInformation: [],
  nextStep: null, presentation: null, ...fields });
const passengers = { total: 2, adults: 2, seniors: 0, children: 0, lapInfants: 0, seatInfants: 0, childrenAges: [] };
const route = { resolvedOrigin: { userCity: 'Delhi', airportIATA: 'DEL' },
  resolvedDestination: { userCity: 'Goa', airportIATA: 'GOI' }, pax: 2, passengerData: passengers };
const searched = (date: string, count: number) => ({ ...route, searchKey: `conversation-fixture-${date}`,
  outboundDate: date, inboundDate: '', tripType: 'oneway', cabinClass: 'Economy',
  segments: [{ origin: 'Delhi', destination: 'Goa', origin_iata: 'DEL', destination_iata: 'GOI', date }],
  searchResults: Array.from({ length: count }, (_, index) => ({ id: `fixture-${date}-${index}`, display: true })),
  totalResultsFound: count, showFlight: true });
const trip = (fields: Record<string, any>) => ({ status: 'success', intent: 'revise', trip: null,
  dateHint: null, options: null, plan: null, facts: null, summary: 'Updated the requested part of the plan.',
  findings: [], limitations: [], nextStep: null, suggestions: [], ...fields });

export const managerConversationCases: Array<{ id: string; title: string; turns: ConversationTurn[] }> = [
  {
    id: 'flight_preferences_and_correction', title: 'Missing date, remembered budget, then a date correction',
    turns: [
      {
        user: 'Delhi to Goa for two adults, under ₹12,000 each. Morning flights if possible.', specialist: 'flight_agent',
        flightState: route,
        feedback: flight({ status: 'needs_input', completedTask: 'Identified the route and preferences; no search yet.',
          summary: 'Only the departure date is needed to search Delhi to Goa for two adults.',
          findings: ['Pending preferences: under INR 12,000 per person and morning departures.'],
          missingInformation: ['What date would you like to leave?'], nextStep: 'What date would you like to leave?' }),
        subtaskIncludes: [/Delhi|\bDEL\b/i, /Goa|\bGOI\b/i, /two|2/, /12[,.]?000|12k/i, /morning/i],
        outputIncludes: [/date|when|day/i],
        outputExcludes: [/which airport|what.*(?:origin|destination)|how many|return date|which cabin/i], questions: 1,
      },
      {
        user: 'November 12, one-way.', specialist: 'flight_agent', flightState: searched('2026-11-12', 2),
        feedback: flight({ summary: 'Found two morning departures within the requested per-person budget.',
          findings: ['Delhi to Goa, 12 November 2026, one-way, two adults.',
            'Two morning options under INR 12,000 per person.'], presentation: 'flight_cards_with_price_note' }),
        subtaskIncludes: [/Delhi|\bDEL\b/i, /Goa|\bGOI\b/i, /Nov(?:ember)?\s*12|12\s+Nov|2026-11-12/i, /two|2/,
          /12[,.]?000|12k/i, /morning/i],
        subtaskExcludes: [/compare|rank|key differences|tradeoffs/i],
        outputIncludes: [/morning/i, /12[,.]?000|budget/i], questions: 0,
      },
      {
        user: 'Actually make it November 13; keep the budget and morning preference.', specialist: 'flight_agent',
        flightState: searched('2026-11-13', 1),
        feedback: flight({ summary: 'Found one morning flight on the corrected departure date within the same budget.',
          findings: ['Delhi to Goa, 13 November 2026, one-way, two adults.',
            'One morning option at INR 11,400 per person, below the INR 12,000 limit.'],
          presentation: 'flight_cards_with_price_note' }),
        subtaskIncludes: [/Delhi|\bDEL\b/i, /Goa|\bGOI\b/i, /Nov(?:ember)?\s*13|13\s+Nov|2026-11-13/i, /two|2/,
          /12[,.]?000|12k/i, /morning/i],
        subtaskExcludes: [/compare|rank|key differences|tradeoffs/i],
        outputIncludes: [/13/, /morning/i, /budget|12[,.]?000|11[,.]?400/i], questions: 0,
      },
    ],
  },
  {
    id: 'trip_pace_budget_and_edits', title: 'Food and history, an easier afternoon, then cheaper meals',
    turns: [
      {
        user: 'Plan two relaxed days in Rome for me and my partner. €250 total for food and activities; we like food and history, with no packed afternoons.',
        specialist: 'trip_planner_agent', subtaskIncludes: [/Rome/i, /plan|days/i],
        tripResult: trip({ intent: 'plan', summary: 'Built a relaxed two-day Rome plan around food and history.',
          trip: { origin: null, destination: { city: 'Rome', iata: 'ROM' }, outbound_date: null, return_date: null,
            duration_days: 2, budget: { amount: 250, currency: 'EUR', per_person: false },
            tripType: { add: ['couple', 'relaxed', 'food', 'history'], remove: [] }, passengerData: passengers, clear: [] },
          plan: { scope: 'full', card: { country: 'Italy', knownFor: 'Ancient history and Roman food', bestTime: 'Spring and autumn', cost: '$$' },
            days: [
              { day: 1, title: 'Old Rome at an easy pace', morning: 'Explore the Roman Forum', afternoon: 'Free time in Monti',
                evening: 'Simple Roman dinner', places: ['Roman Forum', 'Monti'] },
              { day: 2, title: 'Markets and riverside wandering', morning: 'Browse Campo de’ Fiori', afternoon: 'Visit a small museum',
                evening: 'Dinner in Trastevere', places: ['Campo de’ Fiori', 'Trastevere'] },
            ], removeDays: [] },
          findings: ['The EUR 250 total is for food and activities for both travelers.',
            'Afternoons leave room to slow down.'], limitations: ['Entry and meal costs are estimates, not confirmed prices.'] }),
        outputIncludes: [/250/, /estimat|not confirmed/i], questions: 0,
      },
      {
        user: 'Day 2 is still too busy. Keep its morning, leave the afternoon free, and keep everything else.',
        specialist: 'trip_planner_agent', subtaskIncludes: [/day\s*2/i, /afternoon/i, /free/i],
        tripResult: trip({ plan: { scope: 'days', card: null, removeDays: [], days: [
          { day: 2, title: null, morning: null, afternoon: 'Free time to wander at your own pace', evening: null, places: null },
        ] }, findings: ['Only day 2 afternoon changed; the morning and the rest of the plan are unchanged.'] }),
        outputIncludes: [/afternoon|day\s*2/i], questions: 0,
      },
      {
        user: 'Can we keep meals simple so more of that budget goes to activities?', specialist: 'trip_planner_agent',
        subtaskIncludes: [/meal|food/i, /budget|activities/i],
        tripResult: trip({ plan: { scope: 'days', card: null, removeDays: [], days: [
          { day: 1, title: null, morning: null, afternoon: null, evening: 'Budget-friendly pizza by the slice', places: null },
          { day: 2, title: null, morning: null, afternoon: null, evening: 'Simple market-food dinner', places: null },
        ] }, findings: ['Simpler dinners leave more of the same EUR 250 total budget for activities.',
          'The free afternoon on day 2 and all other activities are unchanged.'] }),
        outputIncludes: [/250|budget/i, /dinner|meal|food/i], questions: 0,
      },
    ],
  },
  {
    id: 'zero_matches_concern_and_boundary', title: 'A spending concern, preserved constraints, and unsupported seats',
    turns: [
      {
        user: 'Find New York to London flights on November 20 for two adults, nonstop and under $500 each. I’m worried this is getting expensive.',
        specialist: 'flight_agent', subtaskIncludes: [/New York|NYC/i, /London/i, /500/, /non[ -]?stop/i],
        flightState: { searchKey: 'conversation-fixture-zero', outboundDate: '2026-11-20',
          segments: [{ origin: 'New York', destination: 'London', date: '2026-11-20' }],
          resolvedOrigin: { userCity: 'New York', airportIATA: 'NYC' },
          resolvedDestination: { userCity: 'London', airportIATA: 'LON' }, pax: 2, passengerData: passengers,
          searchResults: [], totalResultsFound: 0, showFlight: false },
        feedback: flight({ summary: 'No nonstop options match the USD 500 per-person cap on 20 November 2026.',
          findings: ['The requested search returned zero matching options with both constraints.'],
          nextStep: 'Would you like to raise the USD 500 per-person limit?' }),
        outputIncludes: [/\b(?:no|none|zero|nothing|not|empty)\b|\w+['’]t\b/i, /500|budget|limit|cap/i,
          /raise|increase|higher|stretch/i], questions: 1,
        outputExcludes: [/one[ -]?stop|1[ -]?stop|different date/i],
      },
      {
        user: 'No, keep that limit. Which of the current options is best for us?', specialist: 'flight_agent',
        feedback: flight({ completedTask: 'Inspected the current constrained result set without changing it.',
          summary: 'There are no matching current options to recommend.',
          findings: ['The nonstop and USD 500 per-person constraints remain unchanged.'],
          limitations: ['A best option cannot be identified because the current result set is empty.'] }),
        subtaskIncludes: [/best|recommend/i],
        subtaskExcludes: [/clear filters|raise.*(?:cap|limit)|relax|new search|unfiltered|remove.*(?:cap|limit)/i],
        outputIncludes: [/\b(?:no|none|zero|nothing|not|empty)\b|\w+['’]t\b/i],
        outputExcludes: [/would you like|shall I|raise|relax|increase.*(?:cap|limit)/i], questions: 0,
      },
      {
        user: 'Can you pick us window seats instead?', specialist: null,
        outputIncludes: [/seat/i, /can.t|cannot|unable|don.t|not.*(?:available|support)|isn.t|not able/i],
        outputExcludes: [/assigned|reserved|selected.*seats|seats.*(?:free|available)/i,
          /more likely.*seat|comparing.*seat|once you tell me|tell me whether/i], questions: 0,
      },
    ],
  },
];
