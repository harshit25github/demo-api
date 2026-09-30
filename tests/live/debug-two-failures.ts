/**
 * Debug test for the 2 genuine failures:
 * 1. Filter clearing - "remove all filters"
 * 2. Price prediction - "any cheaper dates?"
 */

import { runGatewayAgent } from '../../src/agents/manager-orchestrator/runner.js';

async function testFilterClearing() {
  console.log('\n========================================');
  console.log('TEST 1: Filter Clearing');
  console.log('========================================\n');

  let context: any;

  // Turn 1: Initial search
  console.log('Turn 1: Delhi to Dubai October 27 one-way, 1 adult economy');
  const turn1 = await runGatewayAgent({
    input: 'Delhi to Dubai October 27 one-way, 1 adult economy',
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-filter-clear-test',
  });
  context = turn1.context;
  console.log('✓ Initial search completed\n');

  // Turn 2: Apply nonstop filter
  console.log('Turn 2: direct only');
  const turn2 = await runGatewayAgent({
    input: 'direct only',
    context,
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-filter-clear-test',
  });
  context = turn2.context;
  console.log('✓ Nonstop filter applied\n');

  // Turn 3: Add evening filter
  console.log('Turn 3: evening flights');
  const turn3 = await runGatewayAgent({
    input: 'evening flights',
    context,
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-filter-clear-test',
  });
  context = turn3.context;
  console.log('✓ Evening filter applied\n');

  // Turn 4: Remove nonstop filter
  console.log('Turn 4: remove direct filter');
  const turn4 = await runGatewayAgent({
    input: 'remove direct filter',
    context,
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-filter-clear-test',
  });
  context = turn4.context;
  console.log('✓ Direct filter removed\n');

  // Turn 5: CRITICAL - Remove all filters
  console.log('Turn 5: remove all filters');
  const turn5 = await runGatewayAgent({
    input: 'remove all filters',
    context,
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-filter-clear-test',
  });

  // Analyze the apply_filter calls
  const toolLog = (turn5.context as any)?.toolCallLog || [];
  const applyFilterCalls = toolLog.filter((e: any) => e.tool === 'apply_filter');

  console.log('\n=== ANALYSIS ===');
  console.log(`Total apply_filter calls in Turn 5: ${applyFilterCalls.length}`);

  applyFilterCalls.forEach((call: any, idx: number) => {
    console.log(`\nCall ${idx + 1}:`);
    console.log('  Filters:', JSON.stringify(call.filters || []));
    console.log('  Empty?', (call.filters || []).length === 0);
  });

  const lastFilterCall = applyFilterCalls[applyFilterCalls.length - 1];
  const allFiltersCleared = lastFilterCall && (lastFilterCall.filters || []).length === 0;

  console.log('\n=== VERDICT ===');
  console.log('Trace ID:', turn5.traceId);
  if (allFiltersCleared) {
    console.log('✅ PASS - All filters cleared correctly');
  } else {
    console.log('❌ FAIL - Filters not cleared (last call still has filters)');
    console.log('Last call filters:', JSON.stringify(lastFilterCall?.filters || [], null, 2));
  }

  return { passed: allFiltersCleared, traceId: turn5.traceId };
}

async function testPricePrediction() {
  console.log('\n========================================');
  console.log('TEST 2: Price Prediction');
  console.log('========================================\n');

  let context: any;

  // Turn 1: Initial search
  console.log('Turn 1: NYC to London round-trip November 5-12, 2 adults economy');
  const turn1 = await runGatewayAgent({
    input: 'NYC to London round-trip November 5-12, 2 adults economy',
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-price-pred-test',
  });
  context = turn1.context;
  console.log('✓ Initial search completed\n');

  // Turn 2: CRITICAL - Ask for cheaper dates
  console.log('Turn 2: any cheaper dates?');
  const turn2 = await runGatewayAgent({
    input: 'any cheaper dates?',
    context,
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'OpenAI-price-pred-test',
  });

  // Analyze tool calls
  const toolLog = (turn2.context as any)?.toolCallLog || [];
  const pricePredictionCalls = toolLog.filter((e: any) => e.tool === 'price_prediction_tool');
  const flightSearchCalls = toolLog.filter((e: any) => e.tool === 'flight_search');

  console.log('\n=== ANALYSIS ===');
  console.log(`price_prediction_tool calls: ${pricePredictionCalls.length}`);
  console.log(`flight_search calls: ${flightSearchCalls.length}`);

  if (pricePredictionCalls.length > 0) {
    console.log('\nPrice prediction tool was called:');
    pricePredictionCalls.forEach((call: any, idx: number) => {
      console.log(`  Call ${idx + 1}:`, {
        status: call.ok === false ? 'FAILED' : 'SUCCESS',
        input: call.input || call.filters || 'N/A',
      });
    });
  } else {
    console.log('\n⚠️  Price prediction tool was NOT called');
    console.log('Alternative approach used:', toolLog.map((e: any) => e.tool).join(' → '));
  }

  console.log('\n=== VERDICT ===');
  console.log('Trace ID:', turn2.traceId);
  if (pricePredictionCalls.length > 0) {
    console.log('✅ PASS - price_prediction_tool was called');
  } else {
    console.log('❌ FAIL - price_prediction_tool was not called');
    console.log('Note: Flight Agent may have used alternative approach (manual date search)');
  }

  return { passed: pricePredictionCalls.length > 0, traceId: turn2.traceId };
}

async function main() {
  console.log('Testing 2 Failed Conversations\n');

  const result1 = await testFilterClearing();
  const result2 = await testPricePrediction();

  console.log('\n\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');
  console.log(`Test 1 (Filter Clearing): ${result1.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Trace ID: ${result1.traceId}`);
  console.log(`Test 2 (Price Prediction): ${result2.passed ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  Trace ID: ${result2.traceId}`);
  console.log(`\nOverall: ${result1.passed && result2.passed ? '✅ ALL PASSED' : '❌ SOME FAILED'}`);
}

main().catch(console.error);
