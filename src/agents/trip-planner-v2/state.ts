import { createClientSummary } from './client-summary.js';
import type { ClientSummary, TripClock, TripDetailName, TripPlannerV2State } from './schema.js';
import { weekdayOf } from '../../shared/time/request-clock.js';

/** One plain line: no links, markdown emphasis or line breaks, which would break line-based cards. */
export function plainText(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function place(endpoint: ClientSummary['origin']): string {
  if (endpoint.city && endpoint.iata) return `${endpoint.city} (${endpoint.iata})`;
  return endpoint.city ?? endpoint.iata ?? 'not set';
}

function dates(summary: ClientSummary, dateHint: string | null | undefined): string {
  if (summary.outbound_date && summary.return_date) {
    const days = Math.round((Date.parse(summary.return_date) - Date.parse(summary.outbound_date)) / 86_400_000) + 1;
    return `${summary.outbound_date} to ${summary.return_date} (plan ${days} days)`;
  }
  const parts = [
    summary.outbound_date ? `from ${summary.outbound_date}` : null,
    summary.return_date ? `until ${summary.return_date}` : null,
    summary.duration_days ? `${summary.duration_days} days` : null,
    dateHint ? `timing "${dateHint}"` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'not set';
}

function travelers(passengers: ClientSummary['passengerData']): string {
  const breakdown = [
    passengers.adults !== null ? `${passengers.adults} adults` : null,
    passengers.seniors !== null ? `${passengers.seniors} seniors` : null,
    passengers.children !== null
      ? `${passengers.children} children${passengers.childrenAges.length ? ` aged ${passengers.childrenAges.join(', ')}` : ''}`
      : null,
    passengers.lapInfants !== null ? `${passengers.lapInfants} lap infants` : null,
    passengers.seatInfants !== null ? `${passengers.seatInfants} seat infants` : null,
  ].filter(Boolean);
  if (passengers.total === null && !breakdown.length) return 'not set';
  return [passengers.total !== null ? String(passengers.total) : 'total not set', breakdown.length ? `(${breakdown.join(', ')})` : null]
    .filter(Boolean)
    .join(' ');
}

function budget(value: ClientSummary['budget']): string {
  if (value.amount === null) return 'not set';
  const money = `${value.currency ?? 'currency not set'} ${value.amount}`;
  if (value.per_person === true) return `${money} per person${value.total !== null ? ` (total ${value.total})` : ''}`;
  return value.per_person === false ? `${money} total` : `${money}, per person or total not said`;
}

function exactDates(summary: ClientSummary): string {
  if (summary.outbound_date && summary.return_date) return `${summary.outbound_date} to ${summary.return_date}`;
  if (summary.outbound_date) return `from ${summary.outbound_date}`;
  return summary.return_date ? `until ${summary.return_date}` : 'not set';
}

/** One trip detail in plain words, for the report's was and now values. */
export function tripDetailText(detail: TripDetailName, summary: ClientSummary, dateHint: string | null | undefined): string {
  switch (detail) {
    case 'destination': return place(summary.destination);
    case 'origin': return place(summary.origin);
    case 'dates': return exactDates(summary);
    case 'timing': return dateHint || 'not set';
    case 'duration': return summary.duration_days ? `${summary.duration_days} days` : 'not set';
    case 'travelers': return travelers(summary.passengerData);
    case 'budget': return budget(summary.budget);
    case 'tripType': return summary.tripType.join(', ') || 'none';
  }
}

/** The chips the traveler saw: the combined list, or Trip's own in chats saved before it existed. */
export function chipsShown(summary: ClientSummary, trip: TripPlannerV2State): string[] {
  return summary.suggestedQuestions.length ? summary.suggestedQuestions : trip.suggestions ?? [];
}

/** What Trip reads each run, added to its input so the static instructions stay cached. */
export function describeTripForModel(context: Record<string, any>, clock: TripClock | null): string {
  const summary = createClientSummary(context.summaryContext);
  const trip: TripPlannerV2State = context.tripPlanner ?? {};
  const plan = trip.plan?.days.length
    ? [
        `plan for ${place(trip.plan.destination)}:`,
        ...trip.plan.days.map((day) =>
          `  Day ${day.day} ${day.title} | ${day.morning} | ${day.afternoon} | ${day.evening}`
          + `${day.notes?.length ? ` | notes: ${day.notes.join('; ')}` : ''}${day.places.length ? ` | places: ${day.places.join(', ')}` : ''}`),
      ]
    : ['plan: none'];
  const lines = [
    `destination: ${place(summary.destination)}`,
    `origin: ${place(summary.origin)}`,
    `dates: ${dates(summary, trip.dateHint)}`,
    `travelers: ${travelers(summary.passengerData)}`,
    `budget: ${budget(summary.budget)}`,
    `tripType: ${summary.tripType.join(', ') || 'none'}`,
    `options shown: ${trip.options?.length ? trip.options.map((option, index) => `${index + 1} ${option.city}, ${option.country}${option.code ? ` (${option.code})` : ''}`).join(' · ') : 'none'}`,
    ...plan,
    ...(trip.facts?.length ? ['researched facts:', ...trip.facts.map((fact) => `  ${fact.text} (${fact.source}, checked ${fact.checkedOn ?? 'earlier'})`)] : []),
    `last question: ${trip.lastQuestion ?? 'none'}`,
    `chips shown: ${chipsShown(summary, trip).join(' · ') || 'none'}`,
  ];
  return [
    `<today>${clock ? `${clock.localDate} (${weekdayOf(clock.localDate)}) · ${clock.timeZone}` : 'unknown'}</today>`,
    `<saved_trip>\n${lines.join('\n')}\n</saved_trip>`,
    `<traveler_said>${String(context.currentUserMessage || '').trim()}</traveler_said>`,
  ].join('\n');
}

function short(value: string, length = 40): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

/** The Manager's trip lines: enough to resolve "the second one" or "day 2" without the plan text in its history. */
export function describeTripForManager(context: Record<string, any>): string[] {
  const summary = createClientSummary(context.summaryContext);
  const trip: TripPlannerV2State = context.tripPlanner ?? {};
  const fact = (value: string | number | null) => (value === null || value === '' ? 'unknown' : short(String(value), 60));
  const days = trip.plan?.days ?? [];
  // With exact dates the length comes from them and the plan line; duration_days follows the
  // Summary Extractor's counting (Oct 4-10 is 6), so showing both would contradict the plan.
  const duration = summary.outbound_date && summary.return_date ? '' : `, duration ${fact(summary.duration_days)} days`;
  return [
    `- Current trip summary: ${fact(summary.origin.city)} to ${fact(summary.destination.city)}, outbound ${fact(summary.outbound_date)}, return ${fact(summary.return_date)}${duration}, travelers ${fact(summary.passengerData.total)}.`,
    `- Trip options shown: ${trip.options?.length ? trip.options.map((option, index) => `${index + 1} ${short(`${option.city}, ${option.country}`)}`).join('; ') : 'none'}.`,
    `- Current trip plan: ${days.length ? `${days.length} days (${days.slice(0, 14).map((day) => `D${day.day} ${short(day.title, 30)}`).join('; ')}${days.length > 14 ? '; …' : ''})` : 'none'}.`,
    `- Last Trip question: ${trip.lastQuestion ? `"${short(trip.lastQuestion, 120)}"` : 'none'}.`,
  ];
}
