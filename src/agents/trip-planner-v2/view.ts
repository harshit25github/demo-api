import { isRecord } from '../../shared/types/json.js';
import { awaitTripPhotos } from './photos.js';
import type { TripCost, TripDay, TripPresentation } from './result.js';
import { planPhotoCode, type TripPlannerV2State } from './state.js';

export interface TripViewCard {
  code: string | null;
  title: string;
  imageUrl: string | null;
  knownFor: string;
  bestTime: string;
  cost: string;
}

/** What the client shows with this request's reply, built from saved trip state. */
export interface TripView {
  presentation: TripPresentation;
  cards: TripViewCard[];
  days: TripDay[];
}

const COST_LABELS: Record<TripCost, string> = { $: 'Budget-friendly', $$: 'Mid-range', $$$: 'Splurge' };

export function buildTripView(context: Record<string, any>): TripView | null {
  const trip = isRecord(context.tripPlanner) ? (context.tripPlanner as TripPlannerV2State) : null;
  const turn = trip?.turnView;
  if (!trip || !turn || turn.requestId !== (context.requestId ?? null)) return null;
  const photo = (code: string | null) => (code && trip.photos?.[code]) || null;
  if (turn.presentation === 'trip_options') {
    const cards = (trip.options ?? []).map((option) => ({
      code: option.code,
      title: `${option.city}, ${option.country}`,
      imageUrl: photo(option.code),
      knownFor: option.why,
      bestTime: option.bestTime,
      cost: COST_LABELS[option.cost],
    }));
    return cards.length ? { presentation: turn.presentation, cards, days: [] } : null;
  }
  const plan = trip.plan;
  if (!plan?.days.length) return null;
  if (turn.presentation === 'trip_plan') {
    const title = [plan.destination.city, plan.card?.country].filter(Boolean).join(', ');
    const code = planPhotoCode(plan);
    const cards = plan.card && title
      ? [{
          code,
          title,
          imageUrl: photo(code),
          knownFor: plan.card.knownFor,
          bestTime: plan.card.bestTime,
          cost: COST_LABELS[plan.card.cost],
        }]
      : [];
    return { presentation: turn.presentation, cards, days: plan.days };
  }
  const days = plan.days.filter((day) => turn.presentationDays.includes(day.day));
  return days.length ? { presentation: turn.presentation, cards: [], days } : null;
}

/** Today's client contract: one :::cards block, then **Day N — Theme** with Morning, Afternoon and Evening lines. */
export function renderTripMarkdown(view: TripView): string {
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

/** Puts the trip view under the Manager's first paragraph, or after the whole reply when Flight also answered. */
export function composeTripReply(managerText: string, viewMarkdown: string, { afterReply = false } = {}): string {
  const reply = managerText.trim();
  if (!viewMarkdown) return reply;
  if (!reply) return viewMarkdown;
  const split = reply.search(/\n\s*\n/);
  if (afterReply || split < 0) return `${reply}\n\n${viewMarkdown}`;
  return `${reply.slice(0, split).trimEnd()}\n\n${viewMarkdown}\n\n${reply.slice(split).trim()}`;
}

/** This request's reply: the Manager's words plus the app-rendered trip view, once its photos are in. */
export async function composeTripTurnReply(
  context: Record<string, any>,
  managerText: string,
): Promise<{ text: string; tripView: TripView | null }> {
  await awaitTripPhotos(context);
  const tripView = buildTripView(context);
  if (!tripView) return { text: managerText, tripView: null };
  const text = composeTripReply(managerText, renderTripMarkdown(tripView), { afterReply: context.flightRanThisTurn === true });
  return { text, tripView };
}
