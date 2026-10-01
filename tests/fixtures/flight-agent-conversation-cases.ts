/**
 * Multi-turn Flight Agent conversation scripts.
 *
 * These are expectations for model behaviour, not a keyword router and not a
 * payload contract. Each turn says which core tools Flight should end up calling
 * and why; it deliberately does not say what arguments to send, so the agent has
 * to reason its way to route, dates, passengers, filter codes and ranges from the
 * conversation and its injected context.
 *
 * What each turn is checking:
 *   - `understanding`  what Flight should infer before it picks a tool
 *   - `expectedTools`  the core tools it should call, in order; `[]` means the
 *                      turn is answerable from context and calling anything is a
 *                      false positive
 *   - `why`            the reason that tool and not a plausible neighbour
 *
 * Comparing a run against `expectedTools`:
 *   - drop `NON_CORE_TOOLS` first — the suggested-questions tool fires
 *     opportunistically after core work and must never decide a pass or fail
 *   - collapse consecutive repeats of the same tool; Flight legitimately reads
 *     `getGeneratedContractsContext` more than once in a turn
 *   - treat order as meaningful only where a turn lists more than one tool
 *
 * Clock and date windows. Every script assumes a fixed turn clock of
 * Monday 2026-10-05. Bare dates in the user turns carry no year on purpose, so
 * resolving them forward is part of what is under test. Two real limits shape
 * which dates appear here:
 *   - `flight_search` reaches 359 days out, so to 2027-09-29
 *   - `price_prediction_tool` reaches 89 days out, so to 2027-01-02
 * Every script with a prediction turn stays inside the shorter window. A
 * prediction request past it fails input validation and tests nothing about
 * prediction reasoning, so keep that in mind before editing a date.
 *
 * These are fixtures only. Wiring them into a live harness is a separate step.
 */

/** The four tools whose selection these scripts exist to exercise. */
export type FlightConversationTool =
  | 'flight_search'
  | 'apply_filter'
  | 'price_prediction_tool'
  | 'getGeneratedContractsContext';

/** Ignored when scoring a turn: optional, and never part of the core outcome. */
export const NON_CORE_TOOLS = ['update_flight_suggested_questions'] as const;

/** The fixed turn clock every script is written against. */
export const FLIGHT_CONVERSATION_CLOCK = '2026-10-05T10:00:00.000Z';

export interface FlightConversationTurn {
  user: string;
  understanding: string;
  expectedTools: readonly FlightConversationTool[];
  /**
   * Tools that may also appear without failing the turn, for a preparatory read
   * that is sound reasoning rather than a defect — establishing the current fare
   * before asking whether another date beats it, for example.
   *
   * Occurrences are stripped from the actual sequence before it is compared, so
   * everything in `expectedTools` stays mandatory and ordered. Never set this on
   * a turn whose `expectedTools` is empty: those turns exist to catch a tool call
   * that should not have happened at all.
   */
  alsoAllowed?: readonly FlightConversationTool[];
  why: string;
}

export interface FlightConversationCase {
  id: string;
  /** The single capability this script is built to break. */
  focus: string;
  description: string;
  turns: readonly FlightConversationTurn[];
}

export const flightAgentConversationCases: readonly FlightConversationCase[] = [
  {
    id: 'relative_dates_then_shift',
    focus: 'Resolving relative timing, then moving it twice without losing the rest of the search',
    description:
      'Timing arrives vague and changes twice. Tests that Flight commits to a concrete date from the clock instead of asking, and that a date change re-searches while an unchanged route does not.',
    turns: [
      {
        user: 'I need to get to Bengaluru from Delhi sometime next week',
        understanding:
          'Route is complete and the timing is vague but resolvable from the turn clock. Commit to a concrete outbound date inside that window; assume one-way, one adult, economy until told otherwise.',
        expectedTools: ['flight_search'],
        why: 'Ordinary search intent with timing the clock can settle. Asking the traveller which day, or reaching for price intelligence because the date is loose, both fail this turn.',
      },
      {
        user: 'make it Wednesday instead',
        understanding:
          'Only the outbound date moves, to the Wednesday of the window already established. Route, passengers and cabin carry over untouched.',
        expectedTools: ['flight_search'],
        why: 'A date is a search input, so the existing result set no longer describes the request. Only a fresh search can produce options for the new day; no filter expresses a date change.',
      },
      {
        user: 'what route and date are we on now?',
        understanding:
          'A restatement of the committed search parameters, which are already in context.',
        expectedTools: [],
        why: 'Route, date, passengers and cabin are stable search parameters injected into the prompt. Reading them back through a tool is unnecessary work and a false positive here.',
      },
      {
        user: 'push the whole thing a week later',
        understanding:
          'Shift the committed outbound date forward by seven days, keeping everything else.',
        expectedTools: ['flight_search'],
        why: 'Same reason as the earlier move: the date changed, so the results must be rebuilt rather than filtered.',
      },
      {
        user: 'morning departures only',
        understanding:
          'A narrowing of the current result set by departure time slot, with route and date unchanged.',
        expectedTools: ['apply_filter'],
        why: 'The search inputs did not move, so the existing results are still valid and a filter is enough. Re-searching would discard a usable result set to rebuild the same one.',
      },
      {
        user: 'which of these is cheapest?',
        understanding:
          'A ranking question about the options currently visible after the morning filter.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Prices live on the generated contracts, not in the search summary, and the filter changed which ones are visible. Only reading the current contracts can answer it.',
      },
      {
        user: 'any cheaper dates near that one?',
        understanding:
          'Explicit fare-and-date intelligence for the current route, built around the committed date and inside the prediction window. The date is already known, so a lookup that returns nothing is an answer — nothing cheaper was confirmed — not a reason to ask which dates to check.',
        expectedTools: ['price_prediction_tool'],
        alsoAllowed: ['getGeneratedContractsContext'],
        why: 'The prices of the options already found say nothing about other days. Comparing dates is what the prediction tool is for, and inventing a cheaper date from contract prices is the failure to catch.',
      },
    ],
  },

  {
    id: 'roundtrip_to_multicity_and_back',
    focus: 'Trip type and segment list as search inputs, and which state a new search destroys',
    description:
      'A round trip becomes multi-city and then reverts. Tests that segments are treated as search inputs rather than filters, and that Flight knows a new search clears the filters that belonged to the old one.',
    turns: [
      {
        user: 'New York to London, out on Nov 5 and back Nov 12, two adults',
        understanding:
          'A complete round trip: both directions dated, two adults, economy by default.',
        expectedTools: ['flight_search'],
        why: 'All required inputs are present, so the search can run without any clarification.',
      },
      {
        user: 'add a Paris stop before the London to New York leg',
        understanding:
          'The trip becomes multi-city: New York to London, then London to Paris, then Paris to New York. Passengers, cabin and both existing dates carry over, but the new middle leg has no date and nothing in context supplies one. Ask for that one detail.',
        expectedTools: [],
        why: 'Every other input is already known, so this is the single genuinely missing piece. Any day between the two existing dates would fit, which is exactly why choosing one invents input the traveller never gave.',
      },
      {
        user: "let's do London to Paris on the 9th",
        understanding:
          'The missing leg date arrives. Combine it with the itinerary already assembled and run the multi-city search.',
        expectedTools: ['flight_search'],
        why: 'The trip is now fully specified. Trip type and the segment list are search inputs, so only a search can produce multi-city results; no filter can add a leg, and treating this as a filter is the mistake worth catching.',
      },
      {
        user: 'how many options do we have now?',
        understanding: 'A count of the options the multi-city search produced.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'A result count is volatile and belongs to the current contracts. Quoting a number from an earlier turn is wrong once the search has changed underneath it.',
      },
      {
        user: 'nonstop only',
        understanding:
          'Narrow the current multi-city results to itineraries without stops.',
        expectedTools: ['apply_filter'],
        why: 'Route, dates and passengers are unchanged, so the result set stands and a stops filter is the whole request.',
      },
      {
        user: 'drop Paris, make it a plain round trip again',
        understanding:
          'Revert the segment list and trip type to the original two-way New York to London shape, keeping the dates and passengers already established.',
        expectedTools: ['flight_search'],
        why: 'Removing a leg changes the search, not the view of it. The nonstop filter belonged to the multi-city search and does not carry across.',
      },
      {
        user: 'is the nonstop setting still on?',
        understanding:
          'A question about which filters belong to the search that is current right now. The new search reset them, and the applied-filter list for the current search is in context.',
        expectedTools: [],
        why: 'Flight’s own context lists the filters attached to the current search and excludes any from a superseded one, so the answer is already there to read. Delegating to reach that context is fine; spending a domain tool call on it is the false positive.',
      },
      {
        user: 'put nonstop back on then',
        understanding: 'Re-apply a stops filter to the round-trip results now current.',
        expectedTools: ['apply_filter'],
        why: 'The results exist and only the view needs narrowing, so this is a filter rather than another search.',
      },
      {
        user: 'and cap it at $900',
        understanding:
          'Add a maximum-price filter on top of the nonstop one, keeping both active.',
        expectedTools: ['apply_filter'],
        why: 'Filters accumulate. Adding one must not silently drop the nonstop constraint, and it must not trigger a re-search.',
      },
    ],
  },

  {
    id: 'origin_change_midstream',
    focus: 'Replacing an endpoint after filters are already stacked',
    description:
      'Two filters are active when the origin changes. Tests that the endpoint change re-searches rather than filters, that constraints the traveller stated and never withdrew survive the change, and that a later removal takes out one of them without disturbing the other.',
    turns: [
      {
        user: 'Mumbai to Dubai on Dec 12',
        understanding: 'A complete one-way search with a concrete date.',
        expectedTools: ['flight_search'],
        why: 'Nothing is missing, so the search runs directly.',
      },
      {
        user: 'only with checked baggage',
        understanding:
          'A baggage filter on the current results, using the checked-baggage code rather than a remembered one.',
        expectedTools: ['apply_filter'],
        why: 'The search is unchanged, so this narrows the existing options.',
      },
      {
        user: 'and nothing over 8 hours total',
        understanding:
          'Add a maximum total-duration filter in minutes, keeping the baggage filter active.',
        expectedTools: ['apply_filter'],
        why: 'Total duration is a maximum-only filter on the current set, and the earlier baggage constraint must stay on.',
      },
      {
        user: "actually I'm leaving from Delhi, not Mumbai",
        understanding:
          'The origin is replaced; destination, date, passengers and cabin carry over. The traveller stated the baggage and duration constraints two turns ago and has not withdrawn them, so they are still requirements — but a new search discards the filters attached to the old results, so they have to be put back for the Delhi set.',
        expectedTools: ['flight_search', 'apply_filter'],
        why: 'An endpoint is a search input: filtering cannot change where a flight departs from, and the old results describe a route the traveller is no longer taking. Order matters, since filters need results to narrow. Dropping the two constraints silently would quietly widen a search the traveller had already narrowed.',
      },
      {
        user: 'are my baggage and duration filters still active?',
        understanding:
          'They were carried across to the Delhi search, and the applied-filter list for the current search shows that.',
        expectedTools: [],
        why: 'Flight’s own context lists the filters attached to the current search, so the answer is already there to read. Delegating to reach that context is fine; spending a domain tool call on it is the false positive.',
      },
      {
        user: 'drop the 8 hour limit but keep the bag',
        understanding:
          'Remove only the total-duration constraint, leaving the checked-baggage filter active on the Delhi results.',
        expectedTools: ['apply_filter'],
        why: 'A targeted removal, not a reset and not a re-search. Clearing both would discard a constraint the traveller just asked to keep, and re-searching would throw away results that are still valid.',
      },
      {
        user: 'show me the second option',
        understanding:
          'Inspect the option at that index in the current filtered set, which may hold fewer options than before.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Only the current contracts know what sits at that index, and whether the index exists at all after two filters.',
      },
      {
        user: 'does any of them land at DWC instead of DXB?',
        understanding:
          'A question about the arrival airports present in the options currently visible.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Per-option airport detail is contract data. Answering from the route codes in the search parameters would not distinguish the two Dubai airports in the actual results.',
      },
    ],
  },

  {
    id: 'reference_chain',
    focus: 'Ordinal and comparative references resolved against the live result set',
    description:
      'Every turn after the first refers to an option obliquely. Tests that Flight binds "option 2", "the cheaper one", "same flight" and "the first one" to the current contracts, and knows which of those needs a new search.',
    turns: [
      {
        user: 'San Francisco to Tokyo on Nov 7',
        understanding: 'A complete one-way search.',
        expectedTools: ['flight_search'],
        why: 'All inputs present.',
      },
      {
        user: 'show me option 2',
        understanding:
          'An ordinal reference into the current result set, which may or may not hold that many options.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Option numbering is a property of the generated contracts. Re-searching would renumber them, and answering from memory risks an index that no longer exists.',
      },
      {
        user: 'is the cheaper one also faster?',
        understanding:
          'A comparison between options already in view, on both price and duration.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Both attributes are per-contract. The search summary carries neither, so the contracts have to be read.',
      },
      {
        user: "stick with option 2's airline, but a day later",
        understanding:
          'Option 2 was named two turns ago, so resolve it to that carrier before delegating. The date moves forward one day, and the airline becomes a preference on the new results — it cannot be promised, because the new date may not offer it.',
        expectedTools: ['flight_search', 'apply_filter'],
        why: 'The date change forces a new search, and the airline is not a search input so it becomes a filter once results exist. Passing "option 2’s airline" through unresolved is the routing failure to catch: the specialist has no conversation to resolve it against, and will either guess or ask the traveller for something the Manager already knew.',
      },
      {
        user: 'what about the first one now?',
        understanding:
          'The first option in the result set as it stands after the new date and the airline filter.',
        expectedTools: ['getGeneratedContractsContext'],
        why: '"First" means first in the current list, which the re-search and filter have both changed.',
      },
      {
        user: 'go back to Nov 7',
        understanding:
          'Return the outbound date to the original day, keeping route and passengers.',
        expectedTools: ['flight_search'],
        why: 'A date revert is still a date change. The earlier results for that day were discarded and have to be rebuilt.',
      },
      {
        user: 'cheapest one there?',
        understanding:
          'A ranking question about the rebuilt result set for the original date.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'The options are freshly generated, so any price recalled from the first visit to this date is stale.',
      },
    ],
  },

  {
    id: 'filter_stacking_and_reset',
    focus: 'Stacking three filters, removing one by name, then clearing all in a single reset',
    description:
      'Tests the difference between a targeted removal and a full reset, and specifically that "clear everything" is one call with one reset entry rather than one call per active filter.',
    turns: [
      {
        user: 'Chennai to Singapore on Jan 20',
        understanding: 'A complete one-way search on a date that resolves into next year.',
        expectedTools: ['flight_search'],
        why: 'All inputs present; the bare date has to resolve forward from the clock.',
      },
      {
        user: 'at most one stop',
        understanding: 'A stops constraint on the current results.',
        expectedTools: ['apply_filter'],
        why: 'Search inputs are unchanged, so the existing options are narrowed rather than rebuilt.',
      },
      {
        user: 'and nothing over $600',
        understanding:
          'Add a maximum-price filter while the stops constraint stays active.',
        expectedTools: ['apply_filter'],
        why: 'Filters accumulate, and "and" is explicit that the first one stays. Price is a maximum-only filter.',
      },
      {
        user: 'carry-on included as well',
        understanding: 'Add a baggage constraint on top of the two already active.',
        expectedTools: ['apply_filter'],
        why: 'Third filter, same reasoning. Dropping either earlier constraint is a state-management bug.',
      },
      {
        user: "what's the price on the cheapest of those?",
        understanding:
          'A fare for a specific option within the set surviving all three filters.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'A per-option fare lives on the contracts and has never been stated, so unlike a result count it cannot be recalled from the previous turn.',
      },
      {
        user: 'drop the price cap but keep the rest',
        understanding:
          'Remove only the price filter, leaving the stops and baggage constraints in place.',
        expectedTools: ['apply_filter'],
        why: 'A targeted removal, not a reset and not a re-search. Clearing everything would discard two constraints the traveller just asked to keep, and re-searching would throw away results that are still valid.',
      },
      {
        user: 'actually clear everything',
        understanding:
          'Remove all active filters in one call carrying a single reset entry, and stop once it succeeds.',
        expectedTools: ['apply_filter'],
        why: 'The tool models "remove all" as one reset entry. One call per active filter, or starting a new search to get back to unfiltered results, are the two failures this turn exists to catch.',
      },
      {
        user: 'now which is cheapest?',
        understanding: 'A ranking question over the restored, unfiltered result set.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'The reset changed which options are visible, so the cheapest may differ from the filtered answer given earlier.',
      },
    ],
  },

  {
    id: 'prediction_then_commit',
    focus: 'Price intelligence before a date exists, and again once one is chosen',
    description:
      'Prediction opens the conversation and returns to it after a search and a filter. Tests that Flight separates "which date is cheapest" from "is this price good", and never answers either from contract prices.',
    turns: [
      {
        user: 'When is it cheapest to fly Bengaluru to Dubai in the next couple of months?',
        understanding:
          'Explicit cheapest-date intent over a vague window. Derive a bounded range from the turn clock that stays inside the prediction tool’s reach, and use the city codes for the route.',
        expectedTools: ['price_prediction_tool'],
        why: 'No search exists yet and none would help: a search prices one date, while the question spans a range. This is the tool’s core case.',
      },
      {
        user: 'then just search December 3',
        understanding:
          'The traveller supplies a concrete date instead. Search it for the route already established, with defaults for passengers and cabin.',
        expectedTools: ['flight_search'],
        why: 'Actual options for a specific day come only from a search: the prediction turn produced guidance at best, never bookable results. The date is given outright, so nothing here needs resolving or asking for.',
      },
      {
        user: 'make it business class',
        understanding: 'Cabin changes; route, date and passengers carry over.',
        expectedTools: ['flight_search'],
        why: 'Cabin is a search input, not a filter, so the economy result set cannot be narrowed into a business one.',
      },
      {
        user: 'nonstop',
        understanding: 'Narrow the business-class results to itineraries without stops.',
        expectedTools: ['apply_filter'],
        why: 'Search inputs are unchanged, so a filter is sufficient.',
      },
      {
        user: 'is this a good price or should I wait?',
        understanding:
          'Book-now-or-wait intent for the route and date now committed, answered from fare intelligence rather than the visible fares. Reading the current fare first to have something to compare against is fine; concluding from it alone is not.',
        expectedTools: ['price_prediction_tool'],
        alsoAllowed: ['getGeneratedContractsContext'],
        why: 'The options on screen show what today costs, not whether it is a good time to buy. Deciding from contract prices without asking the tool is the failure.',
      },
      {
        user: "what's the price on the top option?",
        understanding: 'The fare on the first option of the current filtered set.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'A specific option’s fare is contract data, and the prediction answer does not contain it.',
      },
      {
        user: 'what cabin are we searching?',
        understanding: 'A restatement of a stable search parameter.',
        expectedTools: [],
        why: 'Cabin is in the injected search parameters and has not moved since it was set. Any tool call here is a false positive.',
      },
    ],
  },

  {
    id: 'context_reuse_not_research',
    focus: 'Reading existing results instead of searching again, and answering from context instead of at all',
    description:
      'Six questions in a row about an unchanged search. Tests the two opposite failure modes directly: re-running a search that nothing invalidated, and calling a tool for a fact already in the prompt.',
    turns: [
      {
        user: 'Kolkata to Bangkok on Feb 10',
        understanding: 'A complete one-way search on a date that resolves into next year.',
        expectedTools: ['flight_search'],
        why: 'All inputs present.',
      },
      {
        user: 'how long is the shortest one?',
        understanding:
          'A duration question about the options that already exist; nothing about the search has changed.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Durations are per-contract. Re-running the search would discard a valid result set and rebuild the same one, which is the waste this script is built to expose.',
      },
      {
        user: 'which airlines showed up?',
        understanding: 'The carriers present across the current options.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'The airlines in the results are contract data. The airline filter source options describe what could be filtered on, which is a different question from what the results actually contain.',
      },
      {
        user: 'what date did I give you?',
        understanding: 'A restatement of the committed outbound date.',
        expectedTools: [],
        why: 'The date is a stable search parameter in the prompt. Reading it back through a tool is a false positive.',
      },
      {
        user: 'how many passengers is this for?',
        understanding: 'A restatement of the passenger count, which has never been changed.',
        expectedTools: [],
        why: 'Also an injected search parameter, and not volatile like a result count is.',
      },
      {
        user: 'filter to the airline on the shortest one',
        understanding:
          'The shortest option was identified earlier, but its airline may never have been named aloud. Establish which carrier it is, then filter to it against the current search’s source options.',
        expectedTools: ['apply_filter'],
        alsoAllowed: ['getGeneratedContractsContext'],
        why: 'The results are still valid and only the view narrows, so re-searching to "search that airline" is wrong — airline is not a search input. Reading the contracts first is allowed because the carrier is often not in the earlier duration answer, leaving nothing to resolve the reference against.',
      },
      {
        user: 'still Feb 10, right?',
        understanding:
          'A confirmation of the outbound date, which the filter did not touch.',
        expectedTools: [],
        why: 'A filter cannot move a date, so nothing needs checking. This catches a tool call made out of caution rather than need.',
      },
    ],
  },

  {
    id: 'missing_information_progression',
    focus: 'Asking for the smallest missing piece, once, and never re-asking',
    description:
      'The request arrives in fragments. Tests that Flight asks for what is genuinely absent without guessing an endpoint, and does not ask again for something just supplied.',
    turns: [
      {
        user: 'I want to fly to Amsterdam',
        understanding:
          'Destination only. Origin and timing are both absent and nothing in context supplies them. Ask for the smallest set needed, in one go.',
        expectedTools: [],
        why: 'No tool can run without an origin, and choosing one would return options for a route nobody asked for. Reporting what is missing is the whole turn.',
      },
      {
        user: 'from Hyderabad',
        understanding:
          'Origin now known, timing still absent with nothing in context to resolve it. Ask only for the date.',
        expectedTools: [],
        why: 'A search still cannot run, and re-asking for the origin just given is the specific failure to catch. Guessing a date is the other.',
      },
      {
        user: 'November 18',
        understanding:
          'The last missing input arrives. Combine it with the origin and destination already gathered and search, with default passengers and cabin.',
        expectedTools: ['flight_search'],
        why: 'The request is complete, so the turn should end in results rather than another question.',
      },
      {
        user: 'two adults and an infant',
        understanding:
          'Passenger counts change; route, date and cabin carry over.',
        expectedTools: ['flight_search'],
        why: 'Passenger mix is a search input that changes pricing and availability, so results have to be rebuilt rather than filtered.',
      },
      {
        user: 'cheapest option?',
        understanding: 'A ranking question over the results for the new passenger mix.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Fares moved with the passenger change, so any figure from before it is stale.',
      },
      {
        user: 'only flights with a checked bag',
        understanding: 'A baggage filter on the current results.',
        expectedTools: ['apply_filter'],
        why: 'Search inputs are unchanged, so the existing options can simply be narrowed.',
      },
      {
        user: "what's my passenger count again?",
        understanding: 'A restatement of the passenger mix set two turns ago.',
        expectedTools: [],
        why: 'Passengers are an injected search parameter. This turn exists to catch a tool call for something already in the prompt.',
      },
    ],
  },

  {
    id: 'prediction_unavailable_fallback',
    focus: 'Behaving well when the prediction tool returns nothing usable',
    description:
      'Prediction is asked three times and may return no data. Tests that Flight neither invents guidance nor quietly substitutes a date of its own, and that it stops re-asking once a date is known.',
    turns: [
      {
        user: "What's the cheapest date to fly Jaipur to Pune in December?",
        understanding:
          'Explicit cheapest-date intent over a month inside the prediction window. If the lookup returns nothing usable, the month cannot be answered: ask which dates to check.',
        expectedTools: ['price_prediction_tool'],
        why: 'Exactly this tool and nothing after it, even when it comes back empty. Falling back to a search on a self-chosen day would present one arbitrary date’s fare as an answer about December, which no hedge repairs.',
      },
      {
        user: 'check December 14',
        understanding:
          'A concrete date for the route already established; search it with default passengers and cabin.',
        expectedTools: ['flight_search'],
        why: 'A single named date is an ordinary search, not a prediction range.',
      },
      {
        user: 'is that a good price?',
        understanding:
          'Book-now-or-wait intent for a route and date both now known. If the lookup again returns nothing, say the recommendation could not be verified for that date, without asking for the date again.',
        expectedTools: ['price_prediction_tool'],
        why: 'Retrying with genuinely different input is legitimate where retrying the same failed call is not. It also tests the rule against re-asking for a detail already in hand.',
      },
      {
        user: 'nonstop only',
        understanding: 'Narrow the December 14 results to itineraries without stops.',
        expectedTools: ['apply_filter'],
        why: 'A failed prediction does not invalidate the search that succeeded, so its results are still there to filter.',
      },
      {
        user: 'cheapest of those?',
        understanding: 'A ranking question over the nonstop subset.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Per-option fares come from the contracts, and the filter changed which ones are visible.',
      },
      {
        user: 'any cheaper dates than the 14th?',
        understanding:
          'Date comparison around a known date, inside the prediction window.',
        expectedTools: ['price_prediction_tool'],
        why: 'The fares on screen are for one day and cannot rank other days. Answering this from the visible contracts is the failure.',
      },
      {
        user: 'what date are we on?',
        understanding: 'A restatement of the committed outbound date.',
        expectedTools: [],
        why: 'Stable search parameter, and unaffected by the filter or the failed predictions.',
      },
    ],
  },

  {
    id: 'filtered_option_out_of_range',
    focus: 'An index that exists before a filter and not after it',
    description:
      'The same option number is asked for on both sides of a filter. Tests that Flight reports the real current count, keeps the options that do exist visible, and resolves a layover airport against the live source options.',
    turns: [
      {
        user: 'Pune to Dubai on March 3',
        understanding: 'A complete one-way search on a date that resolves into next year.',
        expectedTools: ['flight_search'],
        why: 'All inputs present.',
      },
      {
        user: 'nonstop only',
        understanding:
          'A stops filter that will likely shrink the result set considerably.',
        expectedTools: ['apply_filter'],
        why: 'Search inputs unchanged, so the existing results are narrowed.',
      },
      {
        user: 'show me option 4',
        understanding:
          'An index that may no longer exist after filtering. Report the real current count and keep the options that do exist on screen rather than clearing the view.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Only the current contracts know how many options survived. Answering from the pre-filter count would claim an option that is not there, and showing nothing at all would leave a traveller who asked to see a flight with an empty screen.',
      },
      {
        user: 'remove the nonstop filter',
        understanding:
          'Drop the stops constraint, restoring the wider result set without re-searching.',
        expectedTools: ['apply_filter'],
        why: 'Removing a filter is a filter operation. A new search would also restore the options but discards and rebuilds state for no reason.',
      },
      {
        user: 'now show option 4',
        understanding:
          'The same index against the restored set, where it is likely to exist.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'The visible set changed again, so the index has to be resolved against the current contracts rather than either earlier answer.',
      },
      {
        user: 'only ones with a Muscat layover',
        understanding:
          'A layover-airport filter whose code must come from the current search’s layover source options. If Muscat is not among them, say so instead of inventing a code.',
        expectedTools: ['apply_filter'],
        why: 'Layover filtering is restricted to the source options attached to the live search. Fabricating an airport code, or re-searching to "add" the layover, are both wrong.',
      },
      {
        user: 'how many now?',
        understanding: 'The count surviving the layover filter.',
        expectedTools: ['getGeneratedContractsContext'],
        why: 'Volatile, and changed by the filter just applied.',
      },
      {
        user: 'clear that and show me the cheapest overall',
        understanding:
          'One request with two parts: reset the filters, then rank the restored set. The ranking has to run against the state after the reset.',
        expectedTools: ['apply_filter', 'getGeneratedContractsContext'],
        why: 'Order matters. Reading the contracts before clearing would rank the filtered subset and call it the cheapest overall, which is the sequencing bug this turn exists to catch.',
      },
    ],
  },
];
