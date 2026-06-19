import { ReadableStream } from 'node:stream/web';
import { assertNoLinks, sanitizeNoLinks } from './linkSanitizer.js';

function selectedAgentFromContext(context) {
  return context?.gatewaySelections?.at(-1)?.selectedAgent || null;
}

export function isTripPlannerOutput(finalAgentName, context) {
  return finalAgentName === 'Trip Planner Agent' || selectedAgentFromContext(context) === 'Trip Planner Agent';
}

export function createTextReadableStream(text) {
  return new ReadableStream({
    start(controller) {
      if (text) {
        controller.enqueue(text);
      }
      controller.close();
    },
  });
}

export function sanitizeGatewayOutputForFinalAgent({ output = '', finalAgentName, context = {} } = {}) {
  if (!isTripPlannerOutput(finalAgentName, context)) {
    return {
      output,
      guardrail: {
        applied: false,
        changed: false,
        removedCount: 0,
      },
    };
  }

  const sanitized = sanitizeNoLinks(output);
  assertNoLinks(sanitized.text);

  context.tripPlannerLinkGuardrail = {
    applied: true,
    changed: sanitized.changed,
    removedCount: sanitized.removedCount,
  };

  return {
    output: sanitized.text,
    guardrail: context.tripPlannerLinkGuardrail,
  };
}

export function createSanitizedTripPlannerTextStream(output = '') {
  const sanitized = sanitizeNoLinks(output);
  assertNoLinks(sanitized.text);
  return {
    stream: createTextReadableStream(sanitized.text),
    output: sanitized.text,
    guardrail: {
      applied: true,
      changed: sanitized.changed,
      removedCount: sanitized.removedCount,
    },
  };
}
