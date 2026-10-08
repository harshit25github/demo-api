import { tool } from '@openai/agents';
import { z } from 'zod';
import { ensureFlightRuntimeContext, resultCount } from '../context/flight-context.js';
import { getRequestState } from '../../../shared/runtime/request-context.js';
import { log } from '../../../shared/logging/logger.js';
import type { FlightAppContext } from '../types.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  type FlightToolFieldIssue,
} from './recovery.js';

export const UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME =
  'update_flight_suggested_questions';

/** Tools that replace the results the current suggestions were written for. */
const RESULT_CHANGING_TOOLS = new Set(['flight_search', 'apply_filter']);
/** One rejected draft can be corrected; a second rejection ends the attempt. */
const MAX_REJECTED_DRAFTS = 2;
/** A hard stop, so a confused model cannot loop on this tool within one turn. */
const MAX_CALLS_PER_TURN = 4;
/**
 * The width of a suggestion chip; Trip Planner and the live suggestion checks use
 * the same limit. Enforced here rather than as a schema `maxLength`, which
 * constrained decoding applies by cutting the string mid-word.
 */
export const MAX_SUGGESTION_LENGTH = 80;

/** Assistant voice. Suggestions are things the traveler says next. */
const ASSISTANT_OPENER =
  /^(would you like|do you want|should i|shall i|want me to|let me|i can|i'll|i will)\b/i;
/**
 * Internal field names, and empty slot-filling ("Add travel date"). Concrete
 * timing choices such as "Cheapest next month" or "Return after a week" are
 * real next steps and stay allowed.
 */
const BLOCKED_FIELD_WORDING =
  /\b(origin|destination|departure city|arrival city|departure date|outbound date|travel dates?|return date|date range)\b/i;
/** Asking the traveler to fill in or change a route endpoint. */
const ROUTE_ENDPOINT_REQUEST =
  /\b(add|provide|enter|share|give|choose|pick|select|change|update|set|switch)\b.*\b(departure|arrival) location\b|\bwhere (should|do|will|can) (i|we) fly\b/i;
/**
 * Ranking or comparing current options ("Which option is cheapest?"), as
 * opposed to a price window ("Cheapest this week") or a date comparison
 * ("Compare the promising dates"). Needs at least two options to rank.
 */
const RANKS_OPTIONS = /\b(cheapest|fastest|shortest|quickest|lowest|best|compare)\b/i;
const NAMES_OPTIONS = /\b(options?|flights?|ones?)\b/i;
const NAMES_TIMING = /\b(dates?|days?|weeks?|weekends?|months?|time)\b/i;

const updateFlightSuggestedQuestionsSchema = z.object({
  suggestedQuestions: z
    .array(z.string().min(1))
    .max(3)
    .describe(
      'Exactly 3 short next steps in the traveler\'s voice whenever any trip detail is known, before or after a search; an empty array only when nothing about the trip is known yet.',
    ),
});

type SuggestedQuestionsInput = z.infer<typeof updateFlightSuggestedQuestionsSchema>;

/**
 * Suggestion bookkeeping for one user turn.
 *
 * A turn is a Manager turn on the Manager path, which may run Flight more than
 * once, and one Flight run in the standalone runner. It is keyed by the request
 * state object and stamped with its requestId, so a new turn never inherits the
 * previous one.
 */
interface FlightSuggestionTurn {
  requestId: unknown;
  /**
   * The suggestions on screen when the turn began. flight_search and apply_filter
   * clear the live copy mid-turn, and the prompt is rebuilt before every model
   * call, so without this snapshot the model would lose what it must not repeat.
   */
  previousSuggestions: string[];
  /** Where this turn's entries begin in toolCallLog. */
  logStartLength: number;
  /** The entry just before the turn, to find the start again if the log was trimmed. */
  logStartMarker: unknown;
}

const suggestionTurns = new WeakMap<object, FlightSuggestionTurn>();

type ToolLogEntry = Record<string, unknown> | null | undefined;

function toolLog(appContext: object): ToolLogEntry[] {
  const entries = (appContext as { toolCallLog?: unknown }).toolCallLog;
  return Array.isArray(entries) ? entries : [];
}

function liveSuggestions(appContext: object): string[] {
  const suggestions = (appContext as { flight?: { suggestedQuestions?: unknown } }).flight
    ?.suggestedQuestions;
  return Array.isArray(suggestions)
    ? suggestions.filter((value): value is string => typeof value === 'string')
    : [];
}

function requestIdOf(appContext: object): unknown {
  return (appContext as { requestId?: unknown }).requestId ?? null;
}

function startTurn(
  appContext: object,
  flightRan: boolean,
  previousSuggestions?: readonly string[],
): FlightSuggestionTurn {
  const entries = toolLog(appContext);
  (appContext as FlightAppContext).flightRanThisTurn = flightRan;
  const turn: FlightSuggestionTurn = {
    requestId: requestIdOf(appContext),
    previousSuggestions: [...(previousSuggestions ?? liveSuggestions(appContext))],
    logStartLength: entries.length,
    logStartMarker: entries.length > 0 ? entries[entries.length - 1] : null,
  };
  suggestionTurns.set(appContext, turn);
  return turn;
}

function existingTurn(appContext: object): FlightSuggestionTurn | null {
  const turn = suggestionTurns.get(appContext);
  return turn && turn.requestId === requestIdOf(appContext) ? turn : null;
}

/** The current turn, started lazily when the tool runs outside a runner. */
function currentTurn(appContext: object): FlightSuggestionTurn {
  return existingTurn(appContext) || startTurn(appContext, true);
}

/**
 * Start suggestion tracking for a user turn. Call it once per turn, after the
 * turn's requestId is set: the standalone runner passes `flightRan: true`, the
 * Manager passes `false` and Flight sets `flightRanThisTurn` on the context when
 * it actually runs.
 *
 * Pass `previousSuggestions` when turn preparation may already have cleared the
 * live copy, so the model still sees what was on screen before this turn.
 */
export function beginFlightSuggestionTurn(
  context: unknown,
  { flightRan, previousSuggestions }: { flightRan: boolean; previousSuggestions?: readonly string[] },
): void {
  if (!context || typeof context !== 'object') return;
  startTurn(context, flightRan, previousSuggestions);
}

/** The suggestions shown before this turn began, for the prompt's anti-repeat block. */
export function previousFlightSuggestions(context: unknown): string[] {
  if (!context || typeof context !== 'object') return [];
  return existingTurn(context)?.previousSuggestions ?? liveSuggestions(context);
}

/** This turn's toolCallLog entries, even if another specialist trimmed the log. */
function turnEntries(appContext: object, turn: FlightSuggestionTurn): ToolLogEntry[] {
  const entries = toolLog(appContext);
  if (turn.logStartMarker === null) return entries;
  if (entries[turn.logStartLength - 1] === turn.logStartMarker) {
    return entries.slice(turn.logStartLength);
  }
  const markerIndex = entries.indexOf(turn.logStartMarker as ToolLogEntry);
  // A trim drops the oldest entries first, so if the marker is gone every entry
  // left was written after it.
  return markerIndex >= 0 ? entries.slice(markerIndex + 1) : entries;
}

interface SuggestionProgress {
  /** Suggestions were stored this turn and no later search or filter replaced their results. */
  written: boolean;
  /** Rejected drafts since the last write or result change. */
  rejected: number;
  calls: number;
  open: boolean;
}

function readProgress(appContext: object, turn: FlightSuggestionTurn): SuggestionProgress {
  let written = false;
  let rejected = 0;
  let calls = 0;
  for (const entry of turnEntries(appContext, turn)) {
    const toolName = entry?.tool;
    if (toolName === UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME) {
      calls += 1;
      if (entry?.ok === true) {
        written = true;
        rejected = 0;
      } else {
        rejected += 1;
      }
    } else if (
      typeof toolName === 'string' &&
      RESULT_CHANGING_TOOLS.has(toolName) &&
      entry?.ok !== false
    ) {
      // New results make the stored suggestions stale; both tools also clear them.
      written = false;
      rejected = 0;
    }
  }
  return {
    written,
    rejected,
    calls,
    open: !written && rejected < MAX_REJECTED_DRAFTS && calls < MAX_CALLS_PER_TURN,
  };
}

/**
 * Whether the trip has any known detail to ground suggestions in: a search key
 * (hydrated or created this turn), a route endpoint or date in the search state,
 * or the route of an earlier price prediction.
 *
 * Details the Manager carries only in a subtask are invisible here, so this
 * decides when an empty list is refused, never whether 3 suggestions are allowed.
 */
export function hasFlightTravelContext(context: unknown): boolean {
  const appContext = ensureFlightRuntimeContext(context);
  const flight = appContext.flight;
  if (typeof flight.searchKey === 'string' && flight.searchKey.trim()) return true;
  const segments = Array.isArray(flight.segments) ? flight.segments : [];
  if (segments.some((segment) => Boolean(segment?.origin || segment?.destination || segment?.date))) {
    return true;
  }
  const route = (flight.lastPricePrediction as { route?: Record<string, unknown> } | null)?.route;
  return Boolean(route?.originCity || route?.destinationCity);
}

function normalizeSuggestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '');
}

/**
 * The content rules a stored suggestion must satisfy. Production stated these
 * only in its prompt; checking them here turns a bad draft into one targeted
 * retry instead of a chip the traveler sees.
 */
export function findSuggestedQuestionIssues(
  suggestedQuestions: readonly unknown[],
  previousSuggestions: readonly string[] = [],
  /** Options in the current result set; null when no result set is known. */
  currentOptionCount: number | null = null,
): FlightToolFieldIssue[] {
  const issues: FlightToolFieldIssue[] = [];
  if (suggestedQuestions.length !== 3) {
    issues.push({
      path: 'suggestedQuestions',
      problem: `Send exactly 3 suggestions; received ${suggestedQuestions.length}.`,
    });
  }

  const seen = new Set<string>();
  suggestedQuestions.forEach((value, index) => {
    const path = `suggestedQuestions.${index}`;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      issues.push({ path, problem: 'Empty suggestion.' });
      return;
    }
    if (text.length > MAX_SUGGESTION_LENGTH) {
      issues.push({
        path,
        problem: `Longer than ${MAX_SUGGESTION_LENGTH} characters; use 3-8 words.`,
      });
    }
    if (ASSISTANT_OPENER.test(text)) {
      issues.push({
        path,
        problem: 'Written as the assistant; phrase it as the traveler would, e.g. "Show nonstop flights only".',
      });
    }
    if (BLOCKED_FIELD_WORDING.test(text) || ROUTE_ENDPOINT_REQUEST.test(text)) {
      issues.push({
        path,
        problem: 'Asks the traveler to fill in a trip detail, or uses an internal field name; offer a concrete next step instead, such as "Cheapest next month" or "Return after a week".',
      });
    }
    if (
      currentOptionCount !== null &&
      currentOptionCount < 2 &&
      RANKS_OPTIONS.test(text) &&
      NAMES_OPTIONS.test(text) &&
      !NAMES_TIMING.test(text)
    ) {
      issues.push({
        path,
        problem: currentOptionCount === 1
          ? 'Ranks or compares options, but only one current option exists; offer its details instead, such as "Show details for option 1".'
          : 'Ranks or compares options, but no current option matches; offer to relax a filter instead.',
      });
    }
    const key = normalizeSuggestion(text);
    if (seen.has(key)) {
      issues.push({ path, problem: 'Duplicates another suggestion in this set.' });
    }
    seen.add(key);
  });

  const previous = new Set(previousSuggestions.map(normalizeSuggestion));
  if (
    suggestedQuestions.length === 3 &&
    previous.size === 3 &&
    suggestedQuestions.every(
      (value) => typeof value === 'string' && previous.has(normalizeSuggestion(value)),
    )
  ) {
    issues.push({
      path: 'suggestedQuestions',
      problem: 'Identical to the suggestions already shown; replace at least one with a different intent.',
    });
  }
  return issues;
}

export function updateFlightSuggestedQuestions({
  currentFlightContext,
  suggestedQuestions,
  previousSuggestions,
  retrySafe = false,
}: {
  currentFlightContext?: unknown;
  suggestedQuestions?: SuggestedQuestionsInput['suggestedQuestions'];
  /** Defaults to the suggestions currently stored. */
  previousSuggestions?: readonly string[];
  /** Whether a corrected draft may still be sent this turn. */
  retrySafe?: boolean;
} = {}) {
  const context = ensureFlightRuntimeContext(currentFlightContext);

  if (Array.isArray(suggestedQuestions) && suggestedQuestions.length === 0) {
    // An empty list is only for a turn that knows nothing about the trip. A
    // failed prediction, zero matches or a failed search still leaves details
    // to build next steps on, and an empty list there is a skipped update.
    if (hasFlightTravelContext(context)) {
      return createFlightToolFailure({
        code: 'EMPTY_CTA_NOT_ALLOWED',
        message: retrySafe
          ? 'Trip details are known, so send 3 grounded next steps built from the route, dates, results or prediction. Do not re-run any other tool because of this; call this tool once more.'
          : 'Nothing was stored, and no attempts remain this turn. Return your feedback without suggestions.',
        retrySafe,
        fieldIssues: [{
          path: 'suggestedQuestions',
          problem: 'Empty while trip details are known.',
        }],
      });
    }
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
      retrySafe,
      fieldIssues: [{ path: 'suggestedQuestions', problem: 'Expected an array of strings.' }],
    });
  }

  const issues = findSuggestedQuestionIssues(
    suggestedQuestions,
    previousSuggestions ?? context.flight.suggestedQuestions,
    context.flight.searchKey ? resultCount(context.flight.searchResults) : null,
  );
  if (issues.length > 0) {
    return createFlightToolFailure({
      code: 'INVALID_SUGGESTED_QUESTIONS',
      message: retrySafe
        ? 'Nothing was stored. Fix only the listed issues and call this tool once more.'
        : 'Nothing was stored, and no attempts remain this turn. Return your feedback without suggestions.',
      retrySafe,
      fieldIssues: issues,
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
    'Required final step of every Flight turn. Call it exactly once after all other Flight tools have finished, including on turns that only clarify, ask for missing details, or answer from context, and call no tool after it succeeds. Pass exactly 3 short next steps in the traveler\'s voice whenever any trip detail is known, before or after a search; pass an empty array only when nothing about the trip is known yet. A failed or empty result is never a reason for an empty array. It stores what you pass and never writes suggestions itself. If it returns INVALID_SUGGESTED_QUESTIONS or EMPTY_CTA_NOT_ALLOWED, fix only the listed issues and call it once more, without re-running any other tool. Its failure never changes a completed result. Never mention it or its output.',
  parameters: updateFlightSuggestedQuestionsSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction(
    UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
    { retrySafe: false, requiredFields: ['suggestedQuestions'] },
  ),
  isEnabled: ({ runContext }) => {
    const appContext = getRequestState(
      (runContext?.context || {}) as Record<string, unknown>,
    );
    return readProgress(appContext, currentTurn(appContext)).open;
  },
  execute(input, runContext) {
    const appContext = getRequestState(runContext?.context as FlightAppContext);
    const turn = currentTurn(appContext);
    const progress = readProgress(appContext, turn);
    const output = updateFlightSuggestedQuestions({
      currentFlightContext: appContext,
      suggestedQuestions: input.suggestedQuestions,
      previousSuggestions: turn.previousSuggestions,
      retrySafe:
        progress.rejected + 1 < MAX_REJECTED_DRAFTS &&
        progress.calls + 1 < MAX_CALLS_PER_TURN,
    });

    appContext.toolCallLog.push({
      tool: UPDATE_FLIGHT_SUGGESTED_QUESTIONS_TOOL_NAME,
      requestId: appContext.requestId ?? null,
      searchKey: appContext.flight?.searchKey || null,
      input,
      suggestedQuestions: output.suggestedQuestions || [],
      ok: output.ok,
      code: 'code' in output ? output.code : null,
      ...('recovery' in output ? { recovery: output.recovery } : {}),
    });

    return output;
  },
});

export interface FlightSuggestionTurnOutcome {
  /** Flight ran during the turn; when false the suggestions were left untouched. */
  flightRan: boolean;
  /** The turn stored current suggestions. */
  written: boolean;
  /** Suggestions from an earlier turn were removed because this turn wrote none. */
  cleared: boolean;
  count: number;
  calls: number;
  rejected: number;
}

/**
 * Close out a turn's suggestions. Call it once per user turn on every path,
 * including failures.
 *
 * When Flight ran but left no current suggestions, the strings still in context
 * were written for an earlier state of the conversation, so they are cleared
 * rather than shown again. Trip Planner does the same in finalizeTripPlannerTurn.
 * A Manager turn that never reached Flight keeps them: they still describe the
 * active search.
 */
export function finalizeFlightSuggestedQuestions(context: unknown): FlightSuggestionTurnOutcome {
  const appContext = ensureFlightRuntimeContext(context);
  const turn = existingTurn(appContext);

  if (!turn || !appContext.flightRanThisTurn) {
    // Flight never saw this turn, so nothing refreshed the suggestions and nothing
    // made them wrong. Turn preparation clears the live list when no search exists
    // yet, which would drop valid pre-search suggestions; put back what was shown.
    if (turn && appContext.flight.suggestedQuestions.length === 0 && turn.previousSuggestions.length > 0) {
      appContext.flight.suggestedQuestions = [...turn.previousSuggestions];
    }
    return {
      flightRan: false,
      written: false,
      cleared: false,
      count: appContext.flight.suggestedQuestions.length,
      calls: 0,
      rejected: 0,
    };
  }

  const before = appContext.flight.suggestedQuestions.length;

  const progress = readProgress(appContext, turn);
  if (!progress.written) {
    appContext.flight.suggestedQuestions = [];
  }
  const outcome: FlightSuggestionTurnOutcome = {
    flightRan: true,
    written: progress.written,
    cleared: !progress.written && before > 0,
    count: appContext.flight.suggestedQuestions.length,
    calls: progress.calls,
    rejected: progress.rejected,
  };
  log('info', 'flight_suggestions.turn', {
    requestId: appContext.requestId ?? null,
    sessionId: appContext.sessionId ?? null,
    ...outcome,
  });
  return outcome;
}
