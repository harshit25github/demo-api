import assert from 'node:assert/strict';
import test from 'node:test';
import { managerRoutingCases } from '../fixtures/manager-routing-cases.js';
import { createManagerTools, createManagerTurnState } from '../../src/agents/manager/tools.js';

test('Manager routing probe covers each Gateway tie-breaker with available tool names', () => {
  const context = {
    currentUserMessage: '',
    flight: { searchResults: [], segments: [] },
    toolCallLog: [],
  } as any;
  const registered = new Set(createManagerTools(createManagerTurnState(context, 'routing-probe'))
    .map((tool) => tool.name));
  const ids = new Set<string>();
  const categories = new Set<string>();
  for (const scenario of managerRoutingCases) {
    assert.ok(!ids.has(scenario.id), `Duplicate routing case: ${scenario.id}`);
    ids.add(scenario.id);
    categories.add(scenario.category);
    assert.ok(scenario.input.trim(), `Empty input: ${scenario.id}`);
    assert.ok(scenario.expectedTools.length > 0 || scenario.declines,
      `Case must expect a tool or be marked declines: ${scenario.id}`);
    assert.equal(new Set(scenario.expectedTools).size, scenario.expectedTools.length,
      `Duplicate expected tool: ${scenario.id}`);
    for (const name of scenario.expectedTools) {
      assert.ok(registered.has(name), `Unregistered expected tool ${name}: ${scenario.id}`);
    }
  }
  for (const category of [
    'unconditional_seats', 'fare_filter_labels', 'current_option_reasoning',
    'selected_booking_benefits', 'dated_flight_search',
    'page_context_flight_modification', 'page_context_workflow',
    'general_policy', 'ambiguous_travel', 'mixed_intent',
  ]) {
    assert.ok(categories.has(category), `Missing routing category: ${category}`);
  }
  assert.ok(managerRoutingCases.some((scenario) => scenario.expectedTools.length > 1),
    'The probe must include multi-specialist requests.');
});
