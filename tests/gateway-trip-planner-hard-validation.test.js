import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containsLinkLikeText } from '../src/flight-agent/linkSanitizer.js';
import { TripPlannerAgent } from '../src/flight-agent/tripPlannerAgent.js';
import {
  createSanitizedTripPlannerTextStream,
  sanitizeGatewayOutputForFinalAgent,
} from '../src/flight-agent/gatewayOutputGuardrail.js';

async function readStream(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }

  return chunks.join('');
}

describe('Gateway Trip Planner hard validation', () => {
  it('attaches the hosted web search tool to Trip Planner', () => {
    const webSearchTool = TripPlannerAgent.tools.find(
      (tool) =>
        tool.type === 'hosted_tool' &&
        tool.name === 'web_search' &&
        tool.providerData?.search_context_size === 'medium',
    );

    assert.ok(webSearchTool, 'Trip Planner should include medium web_search hosted tool.');
  });

  it('sanitizes Trip Planner final output before returning it', () => {
    const context = {
      gatewaySelections: [{ selectedAgent: 'Trip Planner Agent' }],
    };
    const unsafeOutput =
      'Day 1: [Burj Khalifa](https://example.com/burj), then <a href="https://example.com/mall">Dubai Mall</a>. See www.example.com.';

    const result = sanitizeGatewayOutputForFinalAgent({
      output: unsafeOutput,
      finalAgentName: 'Trip Planner Agent',
      context,
    });

    assert.equal(containsLinkLikeText(result.output), false);
    assert.match(result.output, /Burj Khalifa/);
    assert.match(result.output, /Dubai Mall/);
    assert.equal(result.guardrail.applied, true);
    assert.equal(result.guardrail.changed, true);
    assert.ok(result.guardrail.removedCount >= 3);
  });

  it('does not sanitize non-Trip-Planner outputs', () => {
    const context = {
      gatewaySelections: [{ selectedAgent: 'Policy Helper Agent' }],
    };
    const output = 'Policy source: https://example.com';

    const result = sanitizeGatewayOutputForFinalAgent({
      output,
      finalAgentName: 'Policy Helper Agent',
      context,
    });

    assert.equal(result.output, output);
    assert.equal(result.guardrail.applied, false);
  });

  it('emits only sanitized text from the stream-compatible wrapper', async () => {
    const unsafeOutput =
      'Use <a href="https://example.com">official hours</a> and avoid example.com/tickets.';

    const result = createSanitizedTripPlannerTextStream(unsafeOutput);
    const streamedText = await readStream(result.stream);

    assert.equal(containsLinkLikeText(streamedText), false);
    assert.equal(streamedText, result.output);
    assert.match(streamedText, /official hours/);
    assert.equal(result.guardrail.applied, true);
    assert.equal(result.guardrail.changed, true);
  });
});
