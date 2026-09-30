function summary(value: any = {}) {
  return {
    origin: value.origin || { city: null, iata: null },
    destination: value.destination || { city: null, iata: null },
    outbound_date: value.outbound_date ?? null,
    return_date: value.return_date ?? null,
    duration_days: value.duration_days ?? null,
    budget: {
      amount: value.budget?.amount ?? null,
      currency: value.budget?.currency ?? null,
      per_person: value.budget?.per_person ?? null,
      total: value.budget?.total ?? null,
    },
    tripType: value.tripType || [],
    placesOfInterest: value.placesOfInterest || [],
    passengerData: {
      total: value.passengerData?.total ?? null,
      adults: value.passengerData?.adults ?? null,
      seniors: value.passengerData?.seniors ?? null,
      children: value.passengerData?.children ?? null,
      lapInfants: value.passengerData?.lapInfants ?? null,
      seatInfants: value.passengerData?.seatInfants ?? null,
      childrenAges: value.passengerData?.childrenAges || [],
    },
  };
}

const romePlan = summary({
  destination: { city: 'Rome', iata: 'ROM' },
  outbound_date: '2026-09-10',
  return_date: '2026-09-15',
  duration_days: 5,
  tripType: ['couple', 'food', 'relaxed'],
  placesOfInterest: [
    { placeName: 'Colosseum', description: 'A confirmed morning stop in the Rome plan.' },
    { placeName: 'Trastevere', description: 'A confirmed food-focused evening area.' },
  ],
  passengerData: { total: 2, adults: 2 },
});

const romeFoodPlan = summary({
  ...romePlan,
  placesOfInterest: [
    ...romePlan.placesOfInterest,
    { placeName: 'Testaccio Market', description: 'Added to the revised food-focused day.' },
  ],
});

const romeBudgetPlan = summary({
  ...romeFoodPlan,
  budget: { amount: 900, currency: 'EUR', per_person: true, total: 1800 },
});

const parisPlan = summary({
  ...romeBudgetPlan,
  destination: { city: 'Paris', iata: 'PAR' },
  placesOfInterest: [
    { placeName: 'Eiffel Tower', description: 'A confirmed stop in the new Paris plan.' },
    { placeName: 'Montmartre', description: 'A confirmed relaxed Paris neighborhood walk.' },
  ],
});

const flightRoute = summary({
  origin: { city: 'New York', iata: 'JFK' },
  destination: { city: 'Delhi', iata: 'DEL' },
  passengerData: { total: 2 },
});

const oneWayFlight = summary({
  ...flightRoute,
  outbound_date: '2026-08-29',
  tripType: ['oneway'],
});

const familyFlight = summary({
  ...oneWayFlight,
  passengerData: {
    total: 3,
    adults: 2,
    children: 1,
    childrenAges: [8],
  },
});

const roundTripFlight = summary({
  ...familyFlight,
  return_date: '2026-09-12',
  tripType: ['roundtrip'],
});

const tokyoIdea = summary({
  destination: { city: 'Tokyo', iata: 'TYO' },
  tripType: ['solo', 'anime', 'food'],
  passengerData: { total: 1 },
});

const tokyoPlan = summary({
  ...tokyoIdea,
  origin: { city: 'San Francisco', iata: 'SFO' },
  outbound_date: '2026-10-03',
  return_date: '2026-10-08',
  duration_days: 5,
  placesOfInterest: [
    { placeName: 'Shibuya Crossing', description: 'A confirmed stop in the Tokyo itinerary.' },
    { placeName: 'Tsukiji Outer Market', description: 'A confirmed food stop in the Tokyo itinerary.' },
  ],
});

const tokyoFlight = summary({
  ...tokyoPlan,
  tripType: ['solo', 'anime', 'food', 'roundtrip'],
  passengerData: { total: 1, adults: 1 },
});

const tokyoTwoTravelers = summary({
  ...tokyoFlight,
  tripType: ['anime', 'food', 'roundtrip'],
  passengerData: { total: 2, adults: 1 },
});

const initialParis = summary({
  origin: { city: 'Delhi', iata: 'DEL' },
  destination: { city: 'Paris', iata: 'PAR' },
  outbound_date: '2026-11-04',
  return_date: '2026-11-10',
  duration_days: 6,
  budget: { amount: 2400, currency: 'EUR', per_person: false, total: 2400 },
  tripType: ['couple', 'cultural', 'balanced'],
  placesOfInterest: [
    { placeName: 'Louvre Museum', description: 'A confirmed place in the existing Paris plan.' },
  ],
  passengerData: {
    total: 2,
    adults: 2,
    seniors: 0,
    children: 0,
    lapInfants: 0,
    seatInfants: 0,
  },
});

const selectedRome = summary({
  ...initialParis,
  destination: { city: 'Rome', iata: 'ROM' },
  placesOfInterest: [
    { placeName: 'Piazza Navona', description: 'A confirmed place in the selected Rome plan.' },
  ],
});

const relaxedRome = summary({
  ...selectedRome,
  tripType: ['couple', 'cultural', 'relaxed', 'food'],
  placesOfInterest: [
    { placeName: 'Piazza Navona', description: 'Preserved because it was not removed by the revision.' },
    { placeName: 'Campo de Fiori', description: 'A confirmed food stop in the relaxed revision.' },
    { placeName: 'Trastevere', description: 'A confirmed relaxed evening area.' },
  ],
});

const threeTravelerRome = summary({
  ...relaxedRome,
  tripType: ['cultural', 'relaxed', 'food'],
  passengerData: { total: 3, adults: 2 },
});

const legacySingapore = {
  ...summary({
    origin: { city: 'Mumbai', iata: 'BOM' },
    destination: { city: 'Singapore', iata: 'SIN' },
    tripType: ['family', 'food'],
  }),
  pax: 2,
  upcomingEvents: [{ name: 'Old event that must be dropped' }],
};

const migratedSingapore = summary({
  origin: { city: 'Mumbai', iata: 'BOM' },
  destination: { city: 'Singapore', iata: 'SIN' },
  tripType: ['family', 'food'],
  passengerData: { total: 2 },
});

const singaporePlan = summary({
  ...migratedSingapore,
  outbound_date: '2026-09-20',
  return_date: '2026-09-24',
  duration_days: 4,
  placesOfInterest: [
    { placeName: 'Gardens by the Bay', description: 'A confirmed stop in the delivered itinerary.' },
    { placeName: 'Maxwell Food Centre', description: 'A confirmed food stop in the delivered itinerary.' },
  ],
});

const shorterSingaporePlan = summary({
  ...singaporePlan,
  return_date: '2026-09-23',
  duration_days: 3,
});

const budgetSingaporePlan = summary({
  ...shorterSingaporePlan,
  budget: { amount: 500, currency: 'SGD', per_person: false, total: 500 },
});

const conflictStart = summary({
  origin: { city: 'Los Angeles', iata: 'LAX' },
  destination: { city: 'New York', iata: 'JFK' },
  outbound_date: '2026-09-05',
  return_date: '2026-09-10',
  duration_days: 5,
  budget: { amount: 2000, currency: 'USD', per_person: false, total: 2000 },
  tripType: ['roundtrip', 'couple', 'fast'],
  placesOfInterest: [
    { placeName: 'Times Square', description: 'A confirmed place in the New York plan.' },
  ],
  passengerData: {
    total: 2,
    adults: 2,
    seniors: 0,
    children: 0,
    lapInfants: 0,
    seatInfants: 0,
  },
});

const bostonCorrection = summary({
  ...conflictStart,
  destination: { city: 'Boston', iata: null },
  placesOfInterest: [],
});

const newYorkCorrection = summary({
  ...bostonCorrection,
  destination: { city: 'New York', iata: null },
  placesOfInterest: [],
});

const relaxedNewYork = summary({
  ...newYorkCorrection,
  tripType: ['roundtrip', 'relaxed'],
});

const threePersonNewYork = summary({
  ...relaxedNewYork,
  passengerData: {
    total: 3,
    adults: 2,
    seniors: 1,
  },
});

const vagueFlightRoute = summary({
  origin: { city: null, iata: 'DEL' },
  destination: { city: null, iata: 'BOM' },
});

const exactOneWayFlight = summary({
  ...vagueFlightRoute,
  outbound_date: '2026-09-14',
  tripType: ['oneway'],
  passengerData: { total: 1, adults: 1 },
});

const exactRoundTripFlight = summary({
  ...exactOneWayFlight,
  return_date: '2026-09-18',
  tripType: ['roundtrip'],
});

const optionalSingaporeStart = summary({
  origin: { city: 'Mumbai', iata: 'BOM' },
  destination: { city: 'Singapore', iata: 'SIN' },
  outbound_date: '2026-12-02',
  return_date: '2026-12-07',
  duration_days: 5,
  tripType: ['family', 'food', 'relaxed'],
  placesOfInterest: [
    { placeName: 'Gardens by the Bay', description: 'A confirmed place in the itinerary.' },
    { placeName: 'Maxwell Food Centre', description: 'A confirmed food stop.' },
  ],
  passengerData: {
    total: 2,
    adults: 2,
    seniors: 0,
    children: 0,
    lapInfants: 0,
    seatInfants: 0,
  },
});

const sentosaSingapore = summary({
  ...optionalSingaporeStart,
  placesOfInterest: [
    { placeName: 'Maxwell Food Centre', description: 'Preserved from the existing itinerary.' },
    { placeName: 'Sentosa', description: 'Explicitly added to the itinerary.' },
  ],
});

const infantSingapore = summary({
  ...sentosaSingapore,
  budget: { amount: 300, currency: 'SGD', per_person: true, total: 900 },
  passengerData: {
    total: 3,
    adults: 2,
    lapInfants: 1,
  },
});

const clearingStart = summary({
  origin: { city: 'London', iata: 'LHR' },
  destination: { city: 'Paris', iata: 'PAR' },
  outbound_date: '2027-01-12',
  return_date: '2027-01-17',
  duration_days: 5,
  budget: { amount: 1200, currency: 'GBP', per_person: false, total: 1200 },
  tripType: ['roundtrip', 'food', 'cultural'],
  placesOfInterest: [
    { placeName: 'Louvre Museum', description: 'A confirmed place in the current plan.' },
    { placeName: 'Le Marais', description: 'A confirmed food and culture area.' },
  ],
  passengerData: { total: 1, adults: 1 },
});

const noPlacesPlan = summary({
  ...clearingStart,
  placesOfInterest: [],
});

const noBudgetPlan = summary({
  ...noPlacesPlan,
  budget: { amount: null, currency: null, per_person: null, total: null },
});

const oneWayClearedPlan = summary({
  ...noBudgetPlan,
  return_date: null,
  tripType: ['oneway', 'food', 'cultural'],
});

const tomorrowFlight = summary({
  origin: { city: null, iata: 'DEL' },
  destination: { city: null, iata: 'BOM' },
  outbound_date: '2026-08-24',
});

const nextFridayFlight = summary({
  ...tomorrowFlight,
  outbound_date: '2026-08-28',
});

const weekendRoundTrip = summary({
  ...nextFridayFlight,
  return_date: '2026-08-30',
  tripType: ['roundtrip'],
});

const weekendTwoTravelers = summary({
  ...weekendRoundTrip,
  passengerData: { total: 2 },
});

const broadMonthRoute = summary({
  origin: { city: null, iata: 'JFK' },
  destination: { city: null, iata: 'LAX' },
});

const firstMondayFlight = summary({
  ...broadMonthRoute,
  outbound_date: '2026-09-07',
});

const septemberThirtyFlight = summary({
  ...firstMondayFlight,
  outbound_date: '2026-09-30',
});

const todayFlight = summary({
  origin: { city: null, iata: 'DEL' },
  destination: { city: null, iata: 'GOI' },
  outbound_date: '2026-08-23',
});

const dayAfterTomorrowFlight = summary({
  ...todayFlight,
  outbound_date: '2026-08-25',
});

const comingThursdayFlight = summary({
  ...dayAfterTomorrowFlight,
  outbound_date: '2026-08-27',
});

const nextMondayReturnFlight = summary({
  ...comingThursdayFlight,
  return_date: '2026-08-31',
  tripType: ['roundtrip'],
});

const internationalTwoKids = summary({
  outbound_date: '2026-10-01',
  return_date: '2026-10-07',
  tripType: ['family', 'international'],
  passengerData: { total: 3, adults: 1, children: 2 },
});

const tokyoTwoKids = summary({
  ...internationalTwoKids,
  destination: { city: 'Tokyo', iata: 'TYO' },
  outbound_date: '2026-10-04',
  return_date: '2026-10-10',
  duration_days: 6,
});

const tokyoTwoKidsWithAges = summary({
  ...tokyoTwoKids,
  passengerData: { total: 3, adults: 1, children: 2, childrenAges: [6, 9] },
});

const couplePassengers = summary({
  tripType: ['couple'],
  passengerData: { total: 2, adults: 2 },
});

const coupleWithKids = summary({
  tripType: ['family'],
  passengerData: { total: 4, adults: 2, children: 2 },
});

const oneParentTwoKids = summary({
  tripType: ['family'],
  passengerData: { total: 3, adults: 1, children: 2 },
});

const oneParentOneKid = summary({
  tripType: ['family'],
  passengerData: { total: 2, adults: 1, children: 1 },
});

const familyOfFour = summary({
  tripType: ['family'],
  passengerData: { total: 4 },
});

const familyBreakdown = summary({
  tripType: ['family'],
  passengerData: { total: 4, adults: 2, children: 2, childrenAges: [7, 10] },
});

const familyWithSenior = summary({
  tripType: ['family'],
  passengerData: {
    total: 5,
    adults: 2,
    seniors: 1,
    children: 2,
    childrenAges: [7, 10],
  },
});

const adultsAndBaby = summary({
  passengerData: { total: 3, adults: 2 },
});

const adultsAndLapInfant = summary({
  passengerData: { total: 3, adults: 2, lapInfants: 1 },
});

const adultsAndSeatInfant = summary({
  passengerData: { total: 3, adults: 2, lapInfants: 0, seatInfants: 1 },
});

const existingFamilyFlight = summary({
  origin: { city: 'New York', iata: 'JFK' },
  destination: { city: 'Delhi', iata: 'DEL' },
  outbound_date: '2026-10-04',
  return_date: '2026-10-12',
  duration_days: 8,
  tripType: ['roundtrip', 'family', 'food'],
  passengerData: { total: 2, adults: 2 },
});

const existingFamilyWithKids = summary({
  ...existingFamilyFlight,
  passengerData: { total: 4, adults: 2, children: 2 },
});

const existingOneParentTwoKids = summary({
  ...existingFamilyWithKids,
  passengerData: { total: 3, adults: 1, children: 2 },
});

const existingOneParentOneKid = summary({
  ...existingOneParentTwoKids,
  passengerData: { total: 2, adults: 1, children: 1 },
});

const endOfNextMonthFlight = summary({
  origin: { city: null, iata: 'JFK' },
  destination: { city: null, iata: 'LAX' },
  outbound_date: '2026-09-30',
  tripType: ['solo'],
  passengerData: { total: 1 },
});

const firstWeekOctober = summary({
  outbound_date: '2026-10-01',
  return_date: '2026-10-07',
});

const secondSeptemberWeekend = summary({
  origin: { city: null, iata: 'DEL' },
  destination: { city: null, iata: 'BOM' },
  outbound_date: '2026-09-12',
  return_date: '2026-09-13',
});

const confirmedMidAugustWindow = summary({
  destination: { city: 'Rome', iata: 'ROM' },
  outbound_date: '2027-08-14',
  return_date: '2027-08-16',
  tripType: ['food'],
  passengerData: { total: 2 },
});

const novemberFirstWeek = summary({
  origin: { city: 'Delhi', iata: 'DEL' },
  destination: { city: 'Paris', iata: 'PAR' },
  outbound_date: '2026-11-01',
  return_date: '2026-11-07',
  budget: { amount: 1800, currency: 'EUR', per_person: false, total: 1800 },
  tripType: ['couple', 'food'],
  passengerData: { total: 2, adults: 2 },
});

const secondNovemberWeekend = summary({
  ...novemberFirstWeek,
  outbound_date: '2026-11-14',
  return_date: '2026-11-15',
});

const novemberDepartureOnly = summary({
  ...secondNovemberWeekend,
  return_date: null,
});

export const summaryAgentJourneys = [
  {
    journeyId: 'date_first_week_of_october',
    category: 'trip_planner',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'first week of october',
        agentResponse: 'The first week of October is noted for the trip.',
        expectedSummary: firstWeekOctober,
      },
    ],
  },
  {
    journeyId: 'date_end_of_next_month',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'jfk to lax at the end of next month, solo',
        agentResponse: 'JFK to LAX near the end of next month is noted for one solo traveler.',
        expectedSummary: endOfNextMonthFlight,
      },
    ],
  },
  {
    journeyId: 'date_second_weekend_of_september',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'del to bom second weekend of september',
        agentResponse: 'The second weekend of September is noted for DEL to BOM.',
        expectedSummary: secondSeptemberWeekend,
      },
    ],
  },
  {
    journeyId: 'date_fuzzy_mid_august_grounding',
    category: 'trip_planner',
    initialSummary: summary({
      destination: { city: 'Rome', iata: 'ROM' },
      tripType: ['food'],
      passengerData: { total: 2 },
    }),
    turns: [
      {
        userMessage: 'maybe around mid-august?',
        agentResponse: 'Would Aug 14-16 next year work for your Rome trip?',
        expectedSummary: summary({
          destination: { city: 'Rome', iata: 'ROM' },
          tripType: ['food'],
          passengerData: { total: 2 },
        }),
      },
      {
        userMessage: 'yes that works',
        agentResponse: 'Confirmed for Aug 14-16, 2027; the remaining Rome details are unchanged.',
        expectedSummary: confirmedMidAugustWindow,
      },
    ],
  },
  {
    journeyId: 'date_multiturn_range_changes',
    category: 'mixed',
    initialSummary: summary({
      ...novemberFirstWeek,
      outbound_date: '2026-10-10',
      return_date: '2026-10-16',
    }),
    turns: [
      {
        userMessage: 'move the whole trip to first week of november',
        agentResponse: 'The complete Paris trip is moved to the first week of November; everything else stays the same.',
        expectedSummary: novemberFirstWeek,
      },
      {
        userMessage: 'actually second weekend instead',
        agentResponse: 'Updated the whole trip to the second weekend of November.',
        expectedSummary: secondNovemberWeekend,
      },
      {
        userMessage: 'keep nov 14 departure but remove return for now',
        agentResponse: 'Nov 14 remains the departure date and the return date is cleared.',
        expectedSummary: novemberDepartureOnly,
      },
    ],
  },
  {
    journeyId: 'passenger_two_kids_and_vague_october',
    category: 'mixed',
    initialSummary: summary(),
    turns: [
      {
        userMessage: "I'm planning an international trip with my two kids, first week of October.",
        agentResponse:
          'I have a family trip for you and your two children in the first week of October. Which destination are you considering?',
        expectedSummary: internationalTwoKids,
      },
      {
        userMessage: 'tokyo. oct 4 to 10 works',
        agentResponse:
          'Tokyo (TYO) is selected for a six-day trip from Oct 4 to Oct 10, 2026, for one adult and two children.',
        expectedSummary: tokyoTwoKids,
      },
      {
        userMessage: 'kids are 6 and 9',
        agentResponse:
          'Updated the Tokyo trip with child ages 6 and 9; all route and date details remain unchanged.',
        expectedSummary: tokyoTwoKidsWithAges,
      },
    ],
  },
  {
    journeyId: 'passenger_relationship_add_and_remove',
    category: 'trip_planner',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'me and my wife',
        agentResponse: 'Noted for you and your wife, two adults traveling together.',
        expectedSummary: couplePassengers,
      },
      {
        userMessage: 'our 2 kids coming too',
        agentResponse: 'Updated to two adults and two children, four family travelers total.',
        expectedSummary: coupleWithKids,
      },
      {
        userMessage: "actually wife can't come",
        agentResponse: 'Updated to one adult and two children, three travelers total.',
        expectedSummary: oneParentTwoKids,
      },
      {
        userMessage: 'one kid stays back too',
        agentResponse: 'Updated again to one adult and one child, two travelers total.',
        expectedSummary: oneParentOneKid,
      },
    ],
  },
  {
    journeyId: 'passenger_family_total_then_breakdown',
    category: 'trip_planner',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'family of four',
        agentResponse: 'I have four family travelers. What destination do you have in mind?',
        expectedSummary: familyOfFour,
      },
      {
        userMessage: '2 adults, kids 7 and 10',
        agentResponse: 'Confirmed: two adults and two children, ages 7 and 10.',
        expectedSummary: familyBreakdown,
      },
      {
        userMessage: 'plus 1 senior',
        agentResponse: 'Updated to five travelers: two adults, one senior, and two children.',
        expectedSummary: familyWithSenior,
      },
    ],
  },
  {
    journeyId: 'passenger_baby_seat_ambiguity',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: '2 adults and a baby',
        agentResponse:
          'Noted three travelers: two adults and one baby. Will the baby travel on a lap or in a seat?',
        expectedSummary: adultsAndBaby,
      },
      {
        userMessage: 'on my lap',
        agentResponse: 'Confirmed for two adults and one lap infant, three travelers total.',
        expectedSummary: adultsAndLapInfant,
      },
      {
        userMessage: 'actually baby needs a seat',
        agentResponse:
          'Updated to two adults and one seat infant; the lap-infant count is now zero.',
        expectedSummary: adultsAndSeatInfant,
      },
    ],
  },
  {
    journeyId: 'passenger_existing_context_and_tentative_language',
    category: 'mixed',
    initialSummary: existingFamilyFlight,
    turns: [
      {
        userMessage: 'maybe kids will join',
        agentResponse: 'How many children might join? I have not changed the traveler count yet.',
        expectedSummary: existingFamilyFlight,
      },
      {
        userMessage: 'both my kids are coming',
        agentResponse: 'Updated to two adults and two children, four travelers total.',
        expectedSummary: existingFamilyWithKids,
      },
      {
        userMessage: 'wife not coming now',
        agentResponse: 'Updated to one adult and two children while preserving the flight details.',
        expectedSummary: existingOneParentTwoKids,
      },
      {
        userMessage: 'one child stays home',
        agentResponse: 'Updated to one adult and one child; route, dates, and preferences are unchanged.',
        expectedSummary: existingOneParentOneKid,
      },
    ],
  },
  {
    journeyId: 'trip_planner_context_build_and_destination_change',
    category: 'trip_planner',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'rome. sept 10-15. 5 days. with wife. food + relaxed',
        agentResponse:
          'Rome (ROM) works well for your five-day couple trip from Sep 10 to Sep 15, 2026. The relaxed food-focused plan includes the Colosseum and dinner time in Trastevere.',
        expectedSummary: romePlan,
      },
      {
        userMessage: 'more food focused pls',
        agentResponse:
          'I kept the Rome dates and relaxed pace, and revised the plan to include Testaccio Market alongside your existing Colosseum and Trastevere stops.',
        expectedSummary: romeFoodPlan,
      },
      {
        userMessage: 'not too costly. 900 eur each',
        agentResponse:
          'I’ll keep the itinerary budget-conscious at EUR 900 per person, or EUR 1,800 total for two travelers.',
        expectedSummary: romeBudgetPlan,
      },
      {
        userMessage: 'actually paris',
        agentResponse:
          'Destination updated to Paris (PAR) while keeping Sep 10-15, 2026, five days, two travelers, your relaxed food focus, and the same budget. The new plan includes the Eiffel Tower and Montmartre.',
        expectedSummary: parisPlan,
      },
    ],
  },
  {
    journeyId: 'flight_route_dates_passengers_and_trip_type',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'jfk to del next month, 2 ppl',
        agentResponse:
          'Got it: New York (JFK) to Delhi (DEL) for two travelers. What exact travel date should I use?',
        expectedSummary: flightRoute,
      },
      {
        userMessage: 'aug 29 one way economy',
        agentResponse:
          'I found one-way economy options from JFK to DEL for Aug 29, 2026, for two travelers. Note: Prices shown are per person.',
        expectedSummary: oneWayFlight,
      },
      {
        userMessage: 'make it 2 adults + 1 child age 8',
        agentResponse:
          'The Aug 29 one-way search is updated for two adults and one child, age 8.',
        expectedSummary: familyFlight,
      },
      {
        userMessage: 'round trip, back sep 12',
        agentResponse:
          'I found round-trip options from JFK to DEL, departing Aug 29 and returning Sep 12, for two adults and one child.',
        expectedSummary: roundTripFlight,
      },
    ],
  },
  {
    journeyId: 'trip_planner_to_flight_agent_handoff',
    category: 'mixed',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'tokyo in october. solo. anime and food',
        agentResponse:
          'I have Tokyo (TYO) for one solo traveler with anime and food interests. Which October dates should I plan around?',
        expectedSummary: tokyoIdea,
      },
      {
        userMessage: 'oct 3 to 8, from sfo',
        agentResponse:
          'Your five-day Tokyo plan runs Oct 3-8, 2026, from San Francisco (SFO), with Shibuya Crossing and Tsukiji Outer Market included.',
        expectedSummary: tokyoPlan,
      },
      {
        userMessage: 'show flights for this trip',
        agentResponse:
          'I found round-trip options from SFO to Tokyo (TYO), departing Oct 3 and returning Oct 8, for one adult.',
        expectedSummary: tokyoFlight,
      },
      {
        userMessage: 'business class and make it 2 people',
        agentResponse:
          'The same SFO-TYO round trip is updated to business class for two travelers.',
        expectedSummary: tokyoTwoTravelers,
      },
    ],
  },
  {
    journeyId: 'unselected_options_and_explicit_corrections',
    category: 'mixed',
    initialSummary: initialParis,
    turns: [
      {
        userMessage: 'rome or madrid, which better?',
        agentResponse:
          'Rome suits classic landmarks and food walks; Madrid suits art and late dining. Which one would you like to choose?',
        expectedSummary: initialParis,
      },
      {
        userMessage: 'rome',
        agentResponse:
          'Rome (ROM) selected. I kept your Delhi departure, Nov 4-10 dates, six-day duration, two travelers, budget, and preferences. Piazza Navona is included in the new plan.',
        expectedSummary: selectedRome,
      },
      {
        userMessage: 'make it chill, food places. not museums',
        agentResponse:
          'I changed the balanced pace to relaxed and added a food focus. Piazza Navona stays; Campo de Fiori and Trastevere replace the museum-heavy stops.',
        expectedSummary: relaxedRome,
      },
      {
        userMessage: 'we are 3 now',
        agentResponse:
          'The Rome plan is now for three travelers; all other trip details stay unchanged.',
        expectedSummary: threeTravelerRome,
      },
    ],
  },
  {
    journeyId: 'legacy_cleanup_questions_and_date_revision',
    category: 'trip_planner',
    initialSummary: legacySingapore,
    turns: [
      {
        userMessage: 'plan it',
        agentResponse:
          'I have Mumbai to Singapore for a family food trip. What dates should I use? Possible ideas include Marina Bay and Gardens by the Bay.',
        expectedSummary: migratedSingapore,
      },
      {
        userMessage: 'sep 20, 4 days',
        agentResponse:
          'Your four-day Singapore itinerary runs Sep 20-24, 2026, and includes Gardens by the Bay and Maxwell Food Centre.',
        expectedSummary: singaporePlan,
      },
      {
        userMessage: 'actually 3 days',
        agentResponse:
          'Updated to three days, Sep 20-23, while preserving the destination, travelers, interests, and confirmed places.',
        expectedSummary: shorterSingaporePlan,
      },
      {
        userMessage: 'budget 500 sgd total',
        agentResponse:
          'I’ll keep the complete three-day Singapore plan within a total budget of SGD 500.',
        expectedSummary: budgetSingaporePlan,
      },
    ],
  },
  {
    journeyId: 'conflicting_agent_response_and_user_corrections',
    category: 'mixed',
    initialSummary: conflictStart,
    turns: [
      {
        userMessage: 'change only arrival to boston, keep everything else',
        agentResponse:
          'Updated the arrival location to Chicago (ORD) and kept the existing dates, passengers, and budget.',
        expectedSummary: bostonCorrection,
      },
      {
        userMessage: 'actually not changing city, keep New York',
        agentResponse: 'Okay, Boston remains the arrival location and everything else is unchanged.',
        expectedSummary: newYorkCorrection,
      },
      {
        userMessage: 'make it relaxed, drop couple vibe',
        agentResponse:
          'The New York trip is now relaxed instead of fast, and the couple preference has been removed.',
        expectedSummary: relaxedNewYork,
      },
      {
        userMessage: "budget stays same, we're 3 now: 2 adults + senior",
        agentResponse:
          'Updated the trip to three adults while keeping the same USD 2,000 total budget.',
        expectedSummary: threePersonNewYork,
      },
    ],
  },
  {
    journeyId: 'vague_dates_questions_and_later_confirmation',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'del to bom sometime next month',
        agentResponse: 'I have DEL to BOM. What exact travel date should I use?',
        expectedSummary: vagueFlightRoute,
      },
      {
        userMessage: 'maybe sep 14?',
        agentResponse: 'Should I use Sep 14, 2026, for the flight search?',
        expectedSummary: vagueFlightRoute,
      },
      {
        userMessage: 'yes',
        agentResponse:
          'I found one-way options from DEL to BOM on Sep 14, 2026, for one adult.',
        expectedSummary: exactOneWayFlight,
      },
      {
        userMessage: 'not one way, return 18th',
        agentResponse:
          'Updated to a round trip departing Sep 14 and returning Sep 18, 2026.',
        expectedSummary: exactRoundTripFlight,
      },
    ],
  },
  {
    journeyId: 'optional_places_ambiguous_budget_and_infant',
    category: 'trip_planner',
    initialSummary: optionalSingaporeStart,
    turns: [
      {
        userMessage: 'what else can we do?',
        agentResponse:
          'You could consider Night Safari or Sentosa. Would you like me to add either one?',
        expectedSummary: optionalSingaporeStart,
      },
      {
        userMessage: 'add sentosa, remove gardens by the bay',
        agentResponse:
          'Sentosa is added. Gardens by the Bay remains for now, and Maxwell Food Centre stays.',
        expectedSummary: sentosaSingapore,
      },
      {
        userMessage: 'around 300 each maybe',
        agentResponse: 'Would you like SGD 300 per person or SGD 300 total?',
        expectedSummary: sentosaSingapore,
      },
      {
        userMessage: 'yes 300 sgd per person for 2 adults and lap infant',
        agentResponse:
          'Confirmed: SGD 300 per person for two adults and one lap infant, three travelers total.',
        expectedSummary: infantSingapore,
      },
    ],
  },
  {
    journeyId: 'explicit_clears_and_unselected_recommendations',
    category: 'mixed',
    initialSummary: clearingStart,
    turns: [
      {
        userMessage: "don't change anything, just show the plan",
        agentResponse:
          'The existing Paris plan is unchanged. You might consider Versailles or Disneyland later.',
        expectedSummary: clearingStart,
      },
      {
        userMessage: 'remove all places for now',
        agentResponse: 'All saved places have been removed; the remaining trip details are unchanged.',
        expectedSummary: noPlacesPlan,
      },
      {
        userMessage: 'no budget anymore',
        agentResponse: 'The budget has been cleared while preserving the route, dates, and preferences.',
        expectedSummary: noBudgetPlan,
      },
      {
        userMessage: 'switch to one way, same outbound',
        agentResponse:
          'Updated to one-way from London to Paris on Jan 12, 2027; the return date is removed.',
        expectedSummary: oneWayClearedPlan,
      },
    ],
  },
  {
    journeyId: 'clock_relative_weekday_and_return',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'del to bom tomorrow',
        agentResponse: 'I have DEL to BOM for tomorrow. Which cabin would you prefer?',
        expectedSummary: tomorrowFlight,
      },
      {
        userMessage: 'actually next Friday',
        agentResponse: 'Okay, I will use next Friday instead.',
        expectedSummary: nextFridayFlight,
      },
      {
        userMessage: 'round trip, return Sunday',
        agentResponse: 'Round trip noted with a Sunday return.',
        expectedSummary: weekendRoundTrip,
      },
      {
        userMessage: '2 ppl',
        agentResponse: 'Updated for two travelers; the route and dates stay unchanged.',
        expectedSummary: weekendTwoTravelers,
      },
    ],
  },
  {
    journeyId: 'clock_broad_month_then_exact_day',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'jfk to lax next month',
        agentResponse: 'I have JFK to LAX. What exact date next month should I use?',
        expectedSummary: broadMonthRoute,
      },
      {
        userMessage: 'first monday next month',
        agentResponse: 'The first Monday next month works.',
        expectedSummary: firstMondayFlight,
      },
      {
        userMessage: 'change it to sep 30',
        agentResponse: 'Sep 30 works for the outbound date.',
        expectedSummary: septemberThirtyFlight,
      },
      {
        userMessage: 'maybe around october instead?',
        agentResponse: 'What exact October date would you like to use?',
        expectedSummary: septemberThirtyFlight,
      },
    ],
  },
  {
    journeyId: 'clock_today_day_after_and_coming_weekday',
    category: 'flight_agent',
    initialSummary: summary(),
    turns: [
      {
        userMessage: 'fly today DEL to GOI',
        agentResponse: 'DEL to GOI for today is noted.',
        expectedSummary: todayFlight,
      },
      {
        userMessage: 'no, day after tomorrow',
        agentResponse: 'Updated to the day after tomorrow.',
        expectedSummary: dayAfterTomorrowFlight,
      },
      {
        userMessage: 'coming thursday',
        agentResponse: 'Coming Thursday is noted as the new outbound date.',
        expectedSummary: comingThursdayFlight,
      },
      {
        userMessage: 'return next monday, round trip',
        agentResponse: 'Updated to a round trip returning next Monday.',
        expectedSummary: nextMondayReturnFlight,
      },
    ],
  },
];
