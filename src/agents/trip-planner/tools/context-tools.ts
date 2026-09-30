import { tool } from '@openai/agents';
import { z } from 'zod';
import {
  getTripPlannerContextDetails,
  withTripPlannerSessionLock,
} from '../context/store.js';
import { validateTripPlannerSuggestedQuestions } from '../scope-policy.js';
import {
  applyTripPlannerContextUpdate,
  applyTripPlannerSuggestedQuestionsUpdate,
} from '../context/lifecycle.js';
import {
  getTripPlannerContext,
  getTripPlannerState,
  recordToolCall,
  TRIP_PLANNER_TOOL_NAMES,
} from './runtime.js';

type DynamicRecord = Record<string, any>;

const contextDetailsSchema = z.object({
  sections: z
    .array(z.enum(['places', 'events', 'last_plan']))
    .min(1)
    .max(3)
    .describe('Only the detailed Trip Planner context sections needed now.'),
  query: z.string().max(100).nullish(),
  limit: z.number().int().min(1).max(10).nullish(),
});

export const GetTripPlannerContextDetailsTool = tool({
  name: TRIP_PLANNER_TOOL_NAMES.getContextDetails,
  description:
    'Read compact saved places, events, or the last itinerary only when turn_plan says contextDetails:call. Never use for excluded-scope requests.',
  parameters: contextDetailsSchema,
  strict: true,
  isEnabled: ({ runContext }) => {
    const state = getTripPlannerContext(runContext).tripPlanner;
    return (
      state?.turnState?.contextCaptured === true &&
      state?.scopeClassification?.mode !== 'excluded' &&
      state?.planningBrief?.toolStrategy?.contextDetails?.action === 'call'
    );
  },
  execute(input, runContext) {
    const output = getTripPlannerContextDetails(
      getTripPlannerContext(runContext),
      input,
    );
    return recordToolCall(
      runContext,
      TRIP_PLANNER_TOOL_NAMES.getContextDetails,
      input,
      output,
    );
  },
});

const endpointPatchSchema = z.object({
  city: z.string().max(80).nullish(),
  iata: z.string().regex(/^[A-Za-z]{3}$/).nullish(),
});

const budgetPatchSchema = z.object({
  total: z.number().positive().nullish(),
  amount: z.number().positive().nullish(),
  currency: z.string().min(3).max(3).nullish(),
  per_person: z.boolean().nullish(),
});

const tripTypePatchSchema = z.object({
  add: z.array(z.string().min(1).max(40)).max(10).nullish(),
  remove: z.array(z.string().min(1).max(40)).max(10).nullish(),
});

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .max(10);

const contextPatchSchema = z.object({
  pax: z.number().int().positive().nullish(),
  budget: budgetPatchSchema.nullish(),
  origin: endpointPatchSchema.nullish(),
  destination: endpointPatchSchema.nullish(),
  outbound_date: isoDateSchema.nullish(),
  return_date: isoDateSchema.nullish(),
  duration_days: z.number().int().positive().nullish(),
  tripType: tripTypePatchSchema.nullish(),
  date_hint: z
    .string()
    .min(1)
    .max(80)
    .nullish()
    .describe('A user-provided vague date phrase such as next month; never invent one.'),
});

const clearFieldSchema = z.enum([
  'pax',
  'budget',
  'origin',
  'destination',
  'outbound_date',
  'return_date',
  'duration_days',
  'tripType',
  'date_hint',
]);

export const tripPlannerContextUpdateInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  contextPatch: contextPatchSchema.nullish(),
  clearFields: z.array(clearFieldSchema).max(9).nullish(),
});

export const tripPlannerSuggestedQuestionsInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  suggestedQuestions: z
    .array(z.string().min(1).max(80))
    .min(3)
    .max(3)
    .describe('Exactly three 3-8 word, user-perspective, scope-safe follow-up actions.'),
});

export function updateTripPlannerSuggestedQuestions(
  context: DynamicRecord,
  suggestedQuestions: unknown,
) {
  const appContext = context || {};
  appContext.summaryContext =
    appContext.summaryContext && typeof appContext.summaryContext === 'object'
      ? appContext.summaryContext
      : {};
  const validation = validateTripPlannerSuggestedQuestions(suggestedQuestions, {
    previousSuggestions: appContext.summaryContext.suggestedQuestions,
  });
  if (!validation.ok) {
    appContext.summaryContext.suggestedQuestions = [];
    return {
      ok: false,
      status: 'INVALID_SUGGESTIONS',
      suggestedQuestions: [],
      issues: validation.issues,
    };
  }
  appContext.summaryContext.suggestedQuestions = [...validation.suggestions];
  return {
    ok: true,
    status: 'SUCCESS',
    suggestedQuestions: appContext.summaryContext.suggestedQuestions,
  };
}

export const UpdateTripPlannerContextTool = tool({
  name: TRIP_PLANNER_TOOL_NAMES.updateContext,
  description:
    'Store a structured Trip Planner context patch prepared by the agent. Call this before planning or any other tool, even when the patch is null. This tool validates and persists values; it never interprets raw user text.',
  parameters: tripPlannerContextUpdateInputSchema,
  strict: true,
  isEnabled: ({ runContext }) => {
    const turnState = getTripPlannerContext(runContext).tripPlanner?.turnState;
    return (
      !turnState?.contextCaptured &&
      (turnState?.contextCaptureAttempts || 0) < 2
    );
  },
  async execute(input, runContext) {
    const state = getTripPlannerState(runContext);
    state.turnState ||= {
      baseRevision: input.baseRevision,
      contextCaptured: false,
      contextCaptureAttempts: 0,
      suggestionsUpdated: false,
      suggestionAttempts: 0,
    };
    if (state.turnState.contextCaptured) {
      return recordToolCall(
        runContext,
        TRIP_PLANNER_TOOL_NAMES.updateContext,
        input,
        {
          ok: true,
          status: 'ALREADY_UPDATED',
          messageForAgent:
            'Trip context was already captured. Continue the trip-planning task.',
        },
      );
    }

    const context = getTripPlannerContext(runContext);
    const output = await withTripPlannerSessionLock(context, () =>
      applyTripPlannerContextUpdate(context, input),
    );
    return recordToolCall(
      runContext,
      TRIP_PLANNER_TOOL_NAMES.updateContext,
      input,
      output,
    );
  },
});

export const UpdateTripPlannerSuggestedQuestionsTool = tool({
  name: TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions,
  description:
    'Validate and store exactly three scope-safe Trip Planner suggested questions. Call only after context capture and all planning tools, as the final tool call.',
  parameters: tripPlannerSuggestedQuestionsInputSchema,
  strict: true,
  isEnabled: ({ runContext }) => {
    const turnState = getTripPlannerContext(runContext).tripPlanner?.turnState;
    return (
      turnState?.contextCaptured === true &&
      !turnState?.suggestionsUpdated &&
      (turnState?.suggestionAttempts || 0) < 2
    );
  },
  async execute(input, runContext) {
    const state = getTripPlannerState(runContext);
    if (state.turnState?.suggestionsUpdated) {
      return recordToolCall(
        runContext,
        TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions,
        input,
        {
          ok: true,
          status: 'ALREADY_UPDATED',
          messageForAgent:
            'Suggested questions were already stored. Return the final user response.',
        },
      );
    }

    const context = getTripPlannerContext(runContext);
    const output = await withTripPlannerSessionLock(context, () =>
      applyTripPlannerSuggestedQuestionsUpdate(context, input),
    );
    return recordToolCall(
      runContext,
      TRIP_PLANNER_TOOL_NAMES.updateSuggestedQuestions,
      input,
      output,
    );
  },
});
