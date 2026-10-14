import { z } from 'zod';

const fact = z.string().trim().min(1);

export const tripPlannerFormattingRulesSchema = z.object({
  maxBodyWords: z.number().int().positive(),
  targetBodyWords: z.number().int().positive(),
  maxIntroSentences: z.number().int().nonnegative(),
  maxTimeBlockWords: z.number().int().positive().nullable(),
  maxPatchDaySections: z.number().int().positive().nullable(),
  maxQuestions: z.number().int().nonnegative(),
  questionPriority: z.array(fact),
  cardPolicy: z.enum(['exactly_3_cards', 'omit_unless_visuals_requested', 'render_once']),
  seasonPolicy: z.enum(['season_comparison_requested', 'card_field_only', 'omit_unless_changed', 'one_relevant_trip_season_note']),
  budgetPolicy: z.enum(['card_field_only', 'omit_unchanged', 'compact_two_column_table']),
  includeUnchangedContent: z.boolean(),
  requiresAllTimeBlocks: z.boolean(),
  patchTargets: z.array(fact),
  patchPresentation: fact.nullable(),
  cardMarkdown: fact,
  dayMarkdown: fact,
  tableMarkdown: fact,
}).strict();

/** Internal facts, never a prewritten traveler-facing answer. */
const findings = {
  status: z.enum(['success', 'partial', 'needs_input', 'failure']),
  mode: z.enum(['discovery_cards', 'compact_full', 'compact_patch', 'answer']),
  destinationCards: z.array(z.object({
    itemCode: z.string().regex(/^[A-Z]{3}$/),
    title: fact,
    imageUrl: fact.nullable(),
    knownFor: fact,
    weather: fact,
    budget: fact,
  }).strict()).max(3),
  itineraryDays: z.array(z.object({
    day: z.number().int().positive(),
    title: fact.nullable(),
    morning: fact.nullable(),
    afternoon: fact.nullable(),
    evening: fact.nullable(),
  }).strict()),
  recommendation: fact.nullable(),
  notes: z.array(z.object({
    kind: z.enum(['fit', 'assumption', 'season', 'change', 'fact', 'capability']),
    text: fact,
    sourceName: fact.nullable(),
  }).strict()),
  tables: z.array(z.object({
    kind: z.enum(['budget', 'comparison']),
    title: fact.nullable(),
    columns: z.array(fact).min(2).max(3),
    rows: z.array(z.object({
      cells: z.array(fact).min(2).max(3),
      recommended: z.boolean(),
    }).strict()),
  }).strict()),
  nextQuestions: z.array(z.object({
    key: z.enum(['destination', 'dates', 'duration', 'party', 'budget', 'interests', 'pace', 'date_or_duration_conflict', 'travel_dates_or_duration', 'traveler_count', 'budget_basis', 'budget_currency']),
    purpose: fact,
  }).strict()).max(2),
};

/** What the Trip model writes: dynamic findings only, never the deterministic rules. */
export const tripPlannerFeedbackSchema = z.object({ ...findings, limitations: z.array(fact) }).strict();

/** What the Manager receives: the same findings plus the formatting rules the application attaches. */
export const tripPlannerManagerOutputSchema = z.object({
  ...findings,
  formattingRules: tripPlannerFormattingRulesSchema,
  limitations: z.array(fact),
}).strict();

export type TripPlannerFeedback = z.infer<typeof tripPlannerFeedbackSchema>;
export type TripPlannerManagerOutput = z.infer<typeof tripPlannerManagerOutputSchema>;

/** Presentation rules fixed by phase. The brief adds the context-dependent values; the model never writes any. */
export const TRIP_PHASE_RULES = {
  discovery_cards: {
    maxBodyWords: 90,
    targetBodyWords: 75,
    maxIntroSentences: 1,
    maxTimeBlockWords: null,
    patchPresentation: null,
    cardPolicy: 'exactly_3_cards',
    seasonPolicy: 'card_field_only',
    budgetPolicy: 'card_field_only',
    includeUnchangedContent: true,
    requiresAllTimeBlocks: false,
  },
  compact_full: {
    maxBodyWords: 350,
    targetBodyWords: 300,
    maxIntroSentences: 1,
    maxTimeBlockWords: 18,
    patchPresentation: null,
    cardPolicy: 'render_once',
    seasonPolicy: 'one_relevant_trip_season_note',
    budgetPolicy: 'compact_two_column_table',
    includeUnchangedContent: true,
    requiresAllTimeBlocks: true,
  },
  compact_patch: {
    maxBodyWords: 160,
    targetBodyWords: 130,
    maxIntroSentences: 1,
    maxTimeBlockWords: null,
    patchPresentation: 'one_change_summary_then_up_to_2_bullets_and_only_the_most_affected_day_sections',
    cardPolicy: 'omit_unless_visuals_requested',
    seasonPolicy: 'omit_unless_changed',
    budgetPolicy: 'omit_unchanged',
    includeUnchangedContent: false,
    requiresAllTimeBlocks: false,
  },
} as const;

/** Markdown rules shared by every phase. */
const MARKDOWN_RULES = {
  cardMarkdown: 'One card block whose opening and closing lines are both exactly :::cards (never a bare :::); each [CARD] has exactly title, image, known_for, weather, budget in that order, then [/CARD]. Keep image URLs unchanged; when imageUrl is null write image: Photo unavailable. No Markdown images or other URLs.',
  dayMarkdown: 'Full: **Day N — Theme**, then 🌅 **Morning:**, ☀️ **Afternoon:**, 🌙 **Evening:**. Patch: each supplied day under the same **Day N — Theme** heading (keep the shown theme when title is null), then only its non-null blocks with the same labels; never repeat unchanged blocks. Plain facts become concise markdown, not extra activities.',
  tableMarkdown: 'Markdown pipe tables. Budget: exactly two columns. Comparison: at most three columns, short cells, ★ only on recommended rows. Render each table once.',
};

/** Attached by the application after the model answers; retrieved web pages cannot alter them. */
export function getTripPlannerFormattingRules(context: Record<string, any>) {
  const strategy = context.tripPlanner?.planningBrief?.responseStrategy;
  if (!strategy) throw new Error('Trip planning brief is required before final feedback.');
  const { mode: _mode, renderMode: _renderMode, ...rules } = strategy;
  return tripPlannerFormattingRulesSchema.parse({ ...rules, ...MARKDOWN_RULES });
}

export const TRIP_PLANNER_MANAGER_INSTRUCTIONS = `## Manager tool mode — structured planning feedback
You are the internal Trip planning specialist. Complete the scoped task and return structured facts to the Manager. Keep every domain, scope, context, research, pacing, continuity, and tool rule above.

Complete tools before returning facts: initially only context capture is visible by design. Hidden planning tools do NOT mean photos or research are unsupported. After update_trip_planner_context succeeds, reread the refreshed turn_plan and use the newly available planning tools. Discovery with images:call_after_selecting_suggestions requires one get_place_images_batch call for all three candidate cities NOW, not after the traveler chooses. Use cached assets when the refreshed plan says reuse. Perform required selective context retrieval, and any web_search the request needs, before finalizing. update_trip_planner_suggested_questions is the mandatory LAST tool; on success do not call any other tool. A schema is not permission to skip these operations.

Return every structured field, with null or [] for unused ones. All strings except imageUrl are concise plain planning facts or guidance: no greetings, complete answers, markdown, URLs, card markers, or literal questions. Do not expose tool names, diagnostics, private reasoning or JSON within a string. Write every fact in traveler language: never internal planning terms such as anchor, patch, block, phase or turn_plan, and never label activities with them.
Report only in-scope outcomes, including in fit and assumption notes. Do not mention excluded topics even to negate them or reconfirm their exclusion; retain the allowed budget basis and planning constraints instead. Describe geographic clustering without excluded transport advice. These text fields undergo the same scope checks as other planning facts.
- status: success only when requested work is fulfilled; partial for useful results with an unresolved requested outcome; needs_input only for a genuine traveler-only blocker; failure when no useful result can be delivered. Never report a planned tool call as completed. A missing required image/research/context call is incomplete execution, not evidence of a UI capability limitation.
- mode: discovery_cards for candidate comparison without an itinerary; compact_full for the selected destination's complete plan; compact_patch for requested changes only; answer for factual/detail/capability answers without inventing a new plan. For ordinary plans, honor turn_plan render.
- destinationCards: candidate order is the displayed selection order. Three in discovery, one selected card in full, none in a patch unless visuals were requested. title is "City, Country" with no codes or abbreviations. Each itemCode matches its image tool/cache asset exactly. imageUrl is that exact asset URL, or null only when actually unavailable; never invent a URL or declare photos unsupported merely because tools were initially hidden.
- itineraryDays: each block describes that part of the day for the traveler, never prefixed with labels such as "Anchor 1:". Full includes every planned day with title and all three blocks. In patches include only affected days and changed title/blocks; null means unchanged, NOT deleted. A changed block is the complete new plan for that time of day, never a note such as "keep the rest the same". Removing a stop requires an explicit replacement such as free time. Keep the original morning attraction when only afternoon/evening changes were requested. No itinerary days in discovery or answer.
- recommendation: one factual choice/fit rationale, not a completed reply. notes preserve relevant fit, assumptions, season, requested changes and researched facts; sourceName is the human-readable source name only, never a link. Put precise current research outcomes ONLY in fact notes with a named supporting source, not in recommendations, card fields or itinerary blocks. If current search does not establish the fact, put that unresolved outcome in limitations. A resolved date window is a constraint, not an extra season recap. Under card_field_only, seasonal guidance belongs in card.weather and there are no season notes.
- tables: preserve requested comparisons and relevant budget guidance under turn_plan policies. Budget has two columns, comparison at most three. Rows have one cell per column; recommended marks only the genuinely recommended row. Do not add an itinerary, comparison, or unchanged budget beyond the request.
- nextQuestions: key is an intent listed in turn_plan questions (including its canonical aliases), purpose describes the needed choice/detail, not a literal question. One destination-selection intent for discovery when turn_plan questions allows it; up to two only for genuinely incomplete full plans; no known or already-asked detail. A complete revision needs no generic follow-up question. Suggested-question chips are separate and must not be copied here.
- Size facts to the turn_plan limits for words, time blocks, changed days and questions, so the Manager can render them without losing activities or constraints. The application attaches the Manager's formatting rules.
- limitations: only unresolved traveler-relevant outcomes; no internal errors, suggestion bookkeeping, environment labels, or claims about unsupported rendering. Do not erase useful completed work when one part is unavailable.

The Manager uses these facts and policies without adding destinations, attractions, plans, photos, current facts or extra questions. Do not draft its answer for it.`;
