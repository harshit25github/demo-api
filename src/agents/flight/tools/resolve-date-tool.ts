import { tool } from '@openai/agents';
import { z } from 'zod';
import { resolveFlightDateIntent } from '../date/resolver.js';
import { log } from '../../../shared/logging/logger.js';
import type { FlightAppContext } from '../types.js';
import type { RequestContext } from '../../../shared/runtime/request-context.js';
import {
  createFlightToolFailure,
  createFlightToolSchemaErrorFunction,
  recordFlightToolFailure,
} from './recovery.js';

export const RESOLVE_FLIGHT_DATE_TOOL_NAME = 'resolve_flight_date';

export const resolveFlightDateInputSchema = z.object({
  kind: z.enum(['exact', 'weekday', 'week', 'weekend', 'month', 'range', 'flexible']),
  relation: z.enum(['this', 'next']).nullable(),
  offset: z.number().int().min(0).nullable(),
  weekday: z
    .enum([
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ])
    .nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  year: z.number().int().min(2000).max(9999).nullable(),
  exactDate: z.string().nullable(),
  rangeStart: z.string().nullable(),
  rangeEnd: z.string().nullable(),
  tripDurationDays: z.number().int().positive().nullable(),
  tripType: z.enum(['oneway', 'roundtrip']).nullable(),
});

export const ResolveFlightDateTool = tool({
  name: RESOLVE_FLIGHT_DATE_TOOL_NAME,
  description:
    'Statelessly resolve structured calendar semantics into ISO flight dates using the immutable local clock. Use it for relative, weekday, weekend, month, range, duration, or flexible timing; do not pass raw user text. Always pass tripType when known. It never mutates flight state. A non-success result includes safe date constraints: repair and retry only when reliable evidence or explicit user flexibility yields one correction; otherwise ask one narrow question.',
  parameters: resolveFlightDateInputSchema,
  strict: true,
  errorFunction: createFlightToolSchemaErrorFunction(RESOLVE_FLIGHT_DATE_TOOL_NAME, {
    requiredFields: [
      'kind',
      'relation',
      'offset',
      'weekday',
      'month',
      'year',
      'exactDate',
      'rangeStart',
      'rangeEnd',
      'tripDurationDays',
      'tripType',
    ],
  }),
  execute(input, runContext) {
    const requestContext = runContext?.context as RequestContext<FlightAppContext>;
    const appContext = requestContext.state;
    const flight = appContext.flight;

    const result = resolveFlightDateIntent(input, {
      clock: requestContext.runtime.clock,
      existingSearch: {
        trip_type: flight.tripType || null,
        outbound_date: flight.outboundDate || null,
        return_date: flight.inboundDate || null,
      },
    });

    log('info', 'resolve_flight_date.called', {
      requestId: appContext.requestId,
      sessionId: appContext.sessionId,
      status: result.status,
      kind: input.kind,
      searchDate: result.searchDate,
      returnDate: result.returnDate,
    });

    if (result.status !== 'RESOLVED') {
      recordFlightToolFailure({
        appContext,
        toolName: RESOLVE_FLIGHT_DATE_TOOL_NAME,
        input,
        failure: createFlightToolFailure({
          code: result.status,
          message: result.assumptionLabel,
          kind: result.recovery?.kind || 'input',
          retrySafe: result.recovery?.retrySafe ?? true,
          stateChanged: false,
          fieldIssues: result.recovery?.fieldIssues,
          requiredState: result.recovery?.requiredState,
        }),
      });
    }

    return result;
  },
});
