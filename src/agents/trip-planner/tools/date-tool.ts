import { tool } from '@openai/agents';
import { z } from 'zod';
import { buildTripPlannerDateValidationFingerprint } from '../context/planning-brief.js';
import {
  getTripPlannerContext,
  getTripPlannerState,
  recordToolCall,
  TRIP_PLANNER_TOOL_NAMES,
} from './runtime.js';

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function monthRangeFromKeyword(keyword: string, now = new Date()) {
  const monthIndex = MONTHS.findIndex((month) => new RegExp(`\\b${month}\\b`, 'i').test(keyword));
  if (monthIndex < 0) {
    return null;
  }

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let year = today.getUTCFullYear();
  if (monthIndex < today.getUTCMonth()) {
    year += 1;
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

const validateTripDateSchema = z.object({
  candidateDate: z
    .string()
    .nullish()
    .describe('Full YYYY-MM-DD candidate date, otherwise null.'),
  eventKeyword: z
    .string()
    .nullish()
    .describe('Event, month, season, and destination wording, otherwise null.'),
});

export const ValidateTripDateTool = tool({
  name: TRIP_PLANNER_TOOL_NAMES.validateTripDate,
  description:
    'Dummy date validator for Trip Planner testing. Call only when turn_plan tools mark dateValidation as call; reuse the compact state otherwise.',
  parameters: validateTripDateSchema,
  strict: true,
  isEnabled: ({ runContext }) => {
    const state = getTripPlannerContext(runContext).tripPlanner;
    return (
      state?.turnState?.contextCaptured === true &&
      state?.scopeClassification?.mode !== 'excluded' &&
      state?.planningBrief?.toolStrategy?.dateValidation?.action === 'call'
    );
  },
  execute(input, runContext) {
    const candidateDate = input.candidateDate?.trim() || null;
    const eventKeyword = input.eventKeyword?.trim() || null;
    const state = getTripPlannerState(runContext);
    const fingerprint = buildTripPlannerDateValidationFingerprint({
      candidateDate,
      eventKeyword,
    });
    const priorValidation = state.dateValidationState;
    if (fingerprint && priorValidation?.fingerprint === fingerprint) {
      return recordToolCall(
        runContext,
        TRIP_PLANNER_TOOL_NAMES.validateTripDate,
        input,
        {
          ...priorValidation.output,
          cached: true,
          messageForAgent:
            'Reuse this prior validation result. Do not call validate_trip_date again for the same date intent.',
        },
      );
    }

    let output;

    if (candidateDate) {
      const parsed = parseIsoDate(candidateDate);
      output = parsed
        ? {
            ok: true,
            status: 'valid_exact_date',
            feedback: 'OK',
            validatedDate: candidateDate,
            messageForAgent: 'Use the validated date and continue planning.',
            isDummy: true,
          }
        : {
            ok: false,
            status: 'needs_clarification',
            feedback: 'SEARCH_OPTIONAL',
            messageForAgent:
              'The date was not a valid YYYY-MM-DD value. Continue generally or ask once for an exact date.',
            isDummy: true,
          };
    } else if (eventKeyword) {
      const monthRange = monthRangeFromKeyword(eventKeyword);
      if (
        /oktoberfest|coachella|olympics|cherry blossoms?|festivals?|events?|weather|forecast/i.test(
          eventKeyword,
        )
      ) {
        output = {
          ok: true,
          status: 'event_requires_search',
          feedback: 'SEARCH_REQUIRED',
          searchQuery: `${eventKeyword} official dates and visitor information`,
          messageForAgent: 'Call web_search once with searchQuery, then continue planning.',
          isDummy: true,
        };
      } else if (monthRange) {
        output = {
          ok: true,
          status: 'valid_month_range',
          feedback: 'SEARCH_OPTIONAL',
          ...monthRange,
          messageForAgent: 'Use this month range and continue planning without validating again.',
          isDummy: true,
        };
      } else {
        output = {
          ok: true,
          status: 'needs_clarification',
          feedback: 'SEARCH_OPTIONAL',
          messageForAgent: 'Continue with general planning or ask once for a more specific date.',
          isDummy: true,
        };
      }
    } else {
      output = {
        ok: false,
        status: 'needs_clarification',
        feedback: 'SEARCH_OPTIONAL',
        messageForAgent: 'No usable date or event was supplied. Continue with general planning.',
        isDummy: true,
      };
    }

    if (fingerprint) {
      state.dateValidationState = {
        fingerprint,
        status: output.status,
        feedback: output.feedback,
        input: { candidateDate, eventKeyword },
        output: { ...output, cached: false },
      };
    }

    return recordToolCall(
      runContext,
      TRIP_PLANNER_TOOL_NAMES.validateTripDate,
      input,
      { ...output, cached: false },
    );
  },
});
