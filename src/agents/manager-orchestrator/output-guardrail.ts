import { assertNoLinks, sanitizeNoLinks } from '../../shared/text/link-sanitizer.js';
import { sanitizeTripPlannerFinalOutput } from '../trip-planner/scope-policy.js';

type GuardrailContext = Record<string, any>;

interface GatewayOutputInput {
  output?: string;
  finalAgentName?: string | null;
  context?: GuardrailContext;
}

function selectedAgentFromContext(context: GuardrailContext): string | null {
  return context?.gatewaySelections?.at(-1)?.selectedAgent || null;
}

export function isTripPlannerOutput(
  finalAgentName: string | null | undefined,
  context: GuardrailContext,
): boolean {
  return finalAgentName === 'Trip Planner Agent' || selectedAgentFromContext(context) === 'Trip Planner Agent';
}

export function sanitizeGatewayOutputForFinalAgent({
  output = '',
  finalAgentName,
  context = {},
}: GatewayOutputInput = {}) {
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

  const scopeSanitized = sanitizeTripPlannerFinalOutput(output, { context });
  const sanitized = sanitizeNoLinks(scopeSanitized.text, { preserveCardImageUrls: true });
  assertNoLinks(sanitized.text, { allowCardImageUrls: true });

  context.tripPlannerScopeGuardrail = {
    applied: true,
    changed: scopeSanitized.changed,
    violationCount: scopeSanitized.violationCount,
    categories: scopeSanitized.categories,
  };
  context.tripPlannerLinkGuardrail = {
    applied: true,
    changed: sanitized.changed,
    removedCount: sanitized.removedCount,
  };

  return {
    output: sanitized.text,
    guardrail: context.tripPlannerLinkGuardrail,
    scopeGuardrail: context.tripPlannerScopeGuardrail,
  };
}

