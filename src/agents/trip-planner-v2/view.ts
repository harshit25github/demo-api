import { fetchTripPhotos } from './photos.js';
import type { TripCost, TripPlannerV2State, TripView } from './schema.js';

const COST_LABELS: Record<TripCost, string> = { $: 'Budget-friendly', $$: 'Mid-range', $$$: 'Splurge' };

function buildTripView(trip: TripPlannerV2State, turnView: NonNullable<TripPlannerV2State['turnView']>): TripView | null {
  if (turnView.presentation === 'trip_options') {
    const cards = (trip.options ?? []).map((option) => ({
      code: option.code,
      title: `${option.city}, ${option.country}`,
      imageUrl: null,
      knownFor: option.why,
      bestTime: option.bestTime,
      cost: COST_LABELS[option.cost],
    }));
    return cards.length ? { presentation: turnView.presentation, cards, days: [] } : null;
  }
  const plan = trip.plan;
  if (!plan?.days.length) return null;
  if (turnView.presentation === 'trip_days') {
    const days = plan.days.filter((day) => turnView.presentationDays.includes(day.day));
    return days.length ? { presentation: turnView.presentation, cards: [], days } : null;
  }
  const title = [plan.destination.city, plan.card?.country].filter(Boolean).join(', ');
  const cards = plan.card && title
    ? [{
        code: plan.destination.iata,
        title,
        imageUrl: null,
        knownFor: plan.card.knownFor,
        bestTime: plan.card.bestTime,
        cost: COST_LABELS[plan.card.cost],
      }]
    : [];
  return { presentation: turnView.presentation, cards, days: plan.days };
}

/** Today's client contract: one :::cards block, then **Day N — Theme** with Morning, Afternoon and Evening lines. */
function renderTripMarkdown(view: TripView): string {
  const blocks: string[] = [];
  if (view.cards.length) {
    blocks.push([
      ':::cards',
      ...view.cards.map((card) => [
        '[CARD]',
        `title: ${card.title}`,
        `image: ${card.imageUrl ?? 'Photo unavailable'}`,
        `known_for: ${card.knownFor}`,
        `weather: ${card.bestTime}`,
        `budget: ${card.cost}`,
        '[/CARD]',
      ].join('\n')),
      ':::cards',
    ].join('\n'));
  }
  for (const day of view.days) {
    blocks.push([
      `**Day ${day.day} — ${day.title}**`,
      `🌅 **Morning:** ${day.morning}`,
      `☀️ **Afternoon:** ${day.afternoon}`,
      `🌙 **Evening:** ${day.evening}`,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * This turn's reply: the Manager's words plus the trip view the app renders from saved state,
 * under the Manager's first paragraph, or after the reply when Flight also answered.
 */
export async function composeTripTurnReply(
  context: Record<string, any>,
  managerText: string,
): Promise<{ text: string; tripView: TripView | null }> {
  const trip = context.tripPlanner as TripPlannerV2State | undefined;
  if (!trip?.turnView) return { text: managerText, tripView: null };
  const tripView = buildTripView(trip, trip.turnView);
  // A view goes out with one reply only.
  delete trip.turnView;
  if (!tripView) return { text: managerText, tripView: null };
  await fetchTripPhotos(trip, tripView.cards.map((card) => card.code));
  for (const card of tripView.cards) card.imageUrl = (card.code && trip.photos?.[card.code]) || null;

  const markdown = renderTripMarkdown(tripView);
  const reply = managerText.trim();
  const split = reply.search(/\n\s*\n/);
  const text = !reply
    ? markdown
    : context.flightRanThisTurn === true || split < 0
      ? `${reply}\n\n${markdown}`
      : `${reply.slice(0, split).trimEnd()}\n\n${markdown}\n\n${reply.slice(split).trim()}`;
  return { text, tripView };
}
