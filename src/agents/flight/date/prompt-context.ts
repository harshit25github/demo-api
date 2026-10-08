import {
  addDays,
  dateLimitsFromLocalDate,
  FLIGHT_SEARCH_WINDOW_DAYS,
  PRICE_PREDICTION_WINDOW_DAYS,
  toIsoDate,
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
    `- Current flight-search booking window: ${toIsoDate(addDays(searchWindow.today, 1))} through ${searchWindow.maxDateString}, inclusive. Same-day flight searches are not supported.`,
    `- No departure or return date after ${searchWindow.maxDateString} can be searched or predicted. When the traveler's exact date, or all of their flexible range, falls after it, call no search or prediction tool and never offer to search or predict it: say flights can be booked through ${searchWindow.maxDateString} and ask for a date on or before it, without moving their date yourself.`,
    '- Interpret relative dates against this immutable local clock and time zone, including week/month/year boundaries.',
    '- Resolve next week as the next Monday-Sunday calendar week; this weekend as the nearest Saturday-Sunday interval still containing a future day; next weekend as the following Saturday-Sunday interval. Resolve next month as the full next calendar month. A named month or a date without a year means its next valid future occurrence, unless an explicit year or other reliable context determines it. After N days/weeks means the turn local date plus N days or 7*N days.',
    '- A bounded interval that permits multiple travel dates is flexible-date intelligence, even without cheapest, best-date, price, or prediction wording. Preserve the full user-allowed bracket for price_prediction_tool instead of collapsing it to the first valid day. Examples include any day next week, between two dates, sometime next month, during or within a stated period, and explicit flexible-date wording.',
    '- For a requested search with flexible timing, run price prediction first and search the strongest returned in-window date. If prediction cannot verify a date and the user still requested results, the earliest valid date in the allowed interval may be used for the single disclosed fallback search; never present that fallback as the cheapest or better date. Exact or single-day timing searches directly and is never shifted.',
    '- For a round trip with a stated stay duration, derive the return date from the selected outbound date. Never shift an exact user date; if no safe valid date remains, ask one narrow date question. Respect flight_search validation feedback.',
    '- Preserve the original allowed interval and any derived date in feedback when route or return timing is still missing. A later duration-only or route-only reply completes that intent; it does not reset timing or turn a flexible interval into an exact-date preference.',
  ].join('\n');
}
