/**
 * Gateway routing parity and mixed-intent cases for the opt-in Manager probe.
 * These are expectations for model behavior, not a keyword router.
 */
export type ManagerRoutingTool = 'flight_agent' | 'trip_planner_agent';

export interface ManagerRoutingCase {
  id: string;
  category: string;
  input: string;
  expectedTools: ManagerRoutingTool[];
  /** No specialist exists: the Manager must decline without inventing an answer. */
  declines?: boolean;
  context?: 'current_flight_options';
}

export const managerRoutingCases: ManagerRoutingCase[] = [
  {
    id: 'seats_without_booking', category: 'unconditional_seats',
    input: 'What are the best seats?', expectedTools: [], declines: true,
  },
  {
    id: 'seat_selection_later', category: 'unconditional_seats',
    input: 'Can I choose a window seat later?', expectedTools: [], declines: true,
  },
  {
    id: 'super_saver_flights', category: 'fare_filter_labels',
    input: 'Show Super Saver Fare flights', expectedTools: ['flight_agent'],
  },
  {
    id: 'saver_airline_filter', category: 'fare_filter_labels',
    input: 'Filter by Saver Airline', expectedTools: ['flight_agent'],
    context: 'current_flight_options',
  },
  {
    id: 'jsx_contract_filter', category: 'fare_filter_labels',
    input: 'JSX air contracts only', expectedTools: ['flight_agent'],
    context: 'current_flight_options',
  },
  {
    id: 'cheapest_current_option', category: 'current_option_reasoning',
    input: 'Which is the cheapest option among these results?',
    expectedTools: ['flight_agent'], context: 'current_flight_options',
  },
  {
    id: 'compare_numbered_options', category: 'current_option_reasoning',
    input: 'Compare option 1 and option 3',
    expectedTools: ['flight_agent'], context: 'current_flight_options',
  },
  {
    id: 'numbered_option_refund', category: 'selected_booking_benefits',
    input: 'Is option 3 refundable?',
    expectedTools: [], declines: true, context: 'current_flight_options',
  },
  {
    id: 'selected_promo_code', category: 'selected_booking_benefits',
    input: 'Can I use a promo code on this booking?',
    expectedTools: [], declines: true,
  },
  {
    id: 'selected_baggage_benefit', category: 'selected_booking_benefits',
    input: 'Does this fare include checked bags?',
    expectedTools: [], declines: true,
  },
  {
    id: 'fare_refund_upgrade', category: 'selected_booking_benefits',
    input: 'Can I upgrade this fare to get a refund?',
    expectedTools: [], declines: true,
  },
  {
    id: 'book_ticket_with_date', category: 'dated_flight_search',
    input: 'Book a ticket from NYC to Dubai next Friday',
    expectedTools: ['flight_agent'],
  },
  {
    id: 'fly_to_with_date', category: 'dated_flight_search',
    input: 'I want to fly to Paris on 12 Aug',
    expectedTools: ['flight_agent'],
  },
  {
    id: 'route_date_shorthand', category: 'dated_flight_search',
    input: 'DEL to DXB tomorrow', expectedTools: ['flight_agent'],
  },
  {
    id: 'listing_page_filter', category: 'page_context_flight_modification',
    input: 'On the listing page, show only non-stop flights',
    expectedTools: ['flight_agent'], context: 'current_flight_options',
  },
  {
    id: 'payment_page_filter', category: 'page_context_flight_modification',
    input: 'On the payment page, filter the flight results to checked baggage included',
    expectedTools: ['flight_agent'], context: 'current_flight_options',
  },
  {
    id: 'payment_page_workflow', category: 'page_context_workflow',
    input: 'On the payment page, what cards are accepted?',
    expectedTools: [], declines: true,
  },
  {
    id: 'privacy_policy', category: 'general_policy',
    input: 'What is CheapOair privacy policy?',
    expectedTools: [], declines: true,
  },
  {
    id: 'terms_cookies', category: 'general_policy',
    input: 'What do the CheapOair terms and cookie policy say?',
    expectedTools: [], declines: true,
  },
  {
    id: 'general_cancellation_policy', category: 'general_policy',
    input: 'What is the CheapOair cancellation policy?',
    expectedTools: [], declines: true,
  },
  {
    id: 'ambiguous_london_travel', category: 'ambiguous_travel',
    input: 'I want to go to London in July',
    expectedTools: ['trip_planner_agent'],
  },
  {
    id: 'london_trip_with_flights', category: 'ambiguous_travel',
    input: 'London trip with flights',
    expectedTools: ['trip_planner_agent'],
  },
  {
    id: 'flight_and_trip', category: 'mixed_intent',
    input: 'Find flights from NYC to Dubai next Friday and plan a 3-day trip there',
    expectedTools: ['flight_agent', 'trip_planner_agent'],
  },
  {
    id: 'flight_and_policy', category: 'mixed_intent',
    input: 'Find flights from NYC to Dubai next Friday and tell me CheapOair cancellation policy',
    expectedTools: ['flight_agent'], declines: true,
  },
];
