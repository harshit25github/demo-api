import {
  dateLimitsFromLocalDate,
  FLIGHT_SEARCH_WINDOW_DAYS,
  PRICE_PREDICTION_WINDOW_DAYS,
} from './calendar.js';
import type { RequestClock } from '../../../shared/time/request-clock.js';

export function buildFlightDateDynamicPromptContext(clock: RequestClock | null): string {
  if (!clock?.localDate) {
    return '- Flight turn clock is not initialized.';
  }

  const predictionWindow = dateLimitsFromLocalDate(
    clock.localDate,
    PRICE_PREDICTION_WINDOW_DAYS,
  );
  const searchWindow = dateLimitsFromLocalDate(
    clock.localDate,
    FLIGHT_SEARCH_WINDOW_DAYS,
  );

  return [
    `- Immutable turn clock: localDate=${clock.localDate}; localDateTime=${clock.localDateTime}; timeZone=${clock.timeZone}.`,
    `- Current price prediction window: ${predictionWindow.todayString} through ${predictionWindow.maxDateString}, inclusive.`,
    `- Current flight-search booking window: ${searchWindow.todayString} through ${searchWindow.maxDateString}, inclusive.`,
    '- Interpret relative dates against this immutable local clock and time zone, including week/month/year boundaries.',
    '- When the user allows a day range, weekend, week, or month, choose the earliest valid date in that interval within the booking window, search it, and state the chosen date. Do not ask which day solely because that allowed interval contains multiple dates.',
    '- For a round trip with a stated stay duration, derive the return date from the selected outbound date. Never shift an exact user date; if no safe valid date remains, ask one narrow date question. Respect flight_search validation feedback.',
  ].join('\n');
}
