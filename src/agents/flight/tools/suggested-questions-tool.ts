import { tool } from '@openai/agents';
import { z } from 'zod';
import { ensureFlightRuntimeContext } from '../context/flight-context.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import type { FlightAppContext } from '../types.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
} from './recovery.js';

export const UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME =
  'update_flight_suggested_questions';

const updatedRequestIds = new WeakMap<object, unknown>();

const updateFlightSuggestedQuestionsSchema = z.object({
  suggestedQuestions: z
    .array(z.string().min(1))
    .max(3)
    .describe(
      'Exactly 3 Flight Agent generated suggestions when an active context.flight.searchKey exists; otherwise pass an empty array.',
    ),
});

type SuggestedQuestionsInput = z.infer<typeof updateFlightSuggestedQuestionsSchema>;

export function updateFlightSuggestedQuestions({
  currentFlightContext,
  suggestedQuestions,
}: {
  currentFlightContext?: unknown;
  suggestedQuestions?: SuggestedQuestionsInput['suggestedQuestions'];
} = {}) {
  const context = ensureFlightRuntimeContext(currentFlightContext);

  const latestSearchKey =
    typeof context.flight.searchKey === 'string' && context.flight.searchKey.trim()
      ? context.flight.searchKey
      : null;

  if (!latestSearchKey) {
    context.flight.suggestedQuestions = [];
    return {
      ok: true as const,
      suggestedQuestions: [],
    };
  }

  if (!Array.isArray(suggestedQuestions)) {
    return createFlightToolFailure({
      code: 'INVALID_SUGGESTED_QUESTIONS',
      message: 'suggestedQuestions must be an array of strings.',
      retrySafe: false,
      fieldIssues: [{ path: 'suggestedQuestions', problem: 'Expected an array of strings.' }],
    });
  }

  if (
    suggestedQuestions.length !== 3 ||
    suggestedQuestions.some((question) => typeof question !== 'string' || question.length === 0)
  ) {
    return createFlightToolFailure({
      code: 'INVALID_SUGGESTED_QUESTIONS',
      message: 'suggestedQuestions must contain exactly 3 non-empty strings.',
      retrySafe: false,
      fieldIssues: [{
        path: 'suggestedQuestions',
        problem: 'An active search requires exactly 3 non-empty suggestions.',
      }],
    });
  }

  context.flight.suggestedQuestions = suggestedQuestions;

  return {
    ok: true as const,
    suggestedQuestions,
  };
}

export const UpdateFlightSuggestedQuestionsTool = tool({
  name: UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
  description:
    'Best-effort enrichment after the user\'s core Flight request is complete. At execution time, read the latest context.flight.searchKey. Store exactly 3 provided suggestions only when it exists; otherwise clear stale suggestions. Call at most once and never delay, retry, or discard successful flight results because this tool fails.',
  parameters: updateFlightSuggestedQuestionsSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction(
    UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
    { retrySafe: false, requiredFields: ['suggestedQuestions'] },
  ),
  isEnabled: ({ runContext }) => {
    const appContext = getRequestState(
      (runContext?.context || {}) as Record<string, unknown>,
    ) as Record<string, any>;
    return !appContext.requestId || updatedRequestIds.get(appContext) !== appContext.requestId;
  },
  execute(input, runContext) {
    const appContext = getRequestState(runContext?.context as FlightAppContext);
    const output = updateFlightSuggestedQuestions({
      currentFlightContext: appContext,
      suggestedQuestions: input.suggestedQuestions,
    });

    appContext.toolCallLog.push({
      tool: UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
      searchKey: appContext.flight?.searchKey || null,
      input,
      suggestedQuestions: output.suggestedQuestions || [],
      ok: output.ok,
      code: 'code' in output ? output.code : null,
      ...('recovery' in output ? { recovery: output.recovery } : {}),
    });

    if (appContext.requestId) {
      updatedRequestIds.set(appContext, appContext.requestId);
    }

    return output;
  },
});

export function update_flight_suggested_questions(
  input: Parameters<typeof updateFlightSuggestedQuestions>[0],
) {
  return updateFlightSuggestedQuestions(input);
}
