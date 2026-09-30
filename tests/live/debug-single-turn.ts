/**
 * Single-turn debug test to validate tool extraction without burning API credits
 */

import { runGatewayAgent } from '../../src/agents/manager-orchestrator/runner.js';

async function debugSingleTurn() {
  console.log('Testing single turn: "Delhi to Dubai October 27 one-way, 1 adult economy"\n');

  const result = await runGatewayAgent({
    input: 'Delhi to Dubai October 27 one-way, 1 adult economy',
    now: new Date('2026-09-20T10:00:00Z'),
    workflowName: 'debug-single-turn',
  });

  console.log('\n=== RESULT STRUCTURE ===');
  console.log('specialistsUsed:', result.specialistsUsed);
  console.log('output preview:', result.output?.substring(0, 100));

  // Check context.toolCallLog
  const context = result.context as any;
  if (context?.toolCallLog) {
    console.log('\n=== FLIGHT AGENT TOOL CALLS ===');
    console.log(`Total tools called: ${context.toolCallLog.length}`);
    context.toolCallLog.forEach((entry: any, idx: number) => {
      console.log(`\n${idx + 1}. Tool: ${entry.tool}`);
      console.log(`   Status: ${entry.ok === false ? 'FAILED' : 'SUCCESS'}`);
      if (entry.input) {
        const inputStr = JSON.stringify(entry.input).substring(0, 200);
        console.log(`   Input: ${inputStr}...`);
      }
    });
  }

  console.log('\n=== VALIDATION ===');
  const hasFlightAgent = result.specialistsUsed?.includes('flight_agent');
  const toolLog = context?.toolCallLog || [];
  const hasFlightSearch = toolLog.some((e: any) => e.tool === 'flight_search');
  const hasApplyFilter = toolLog.some((e: any) => e.tool === 'apply_filter');

  console.log('✓ Manager called flight_agent:', hasFlightAgent);
  console.log('✓ Flight Agent called flight_search:', hasFlightSearch);
  console.log('✓ Tool extraction working:', toolLog.length > 0);

  if (hasFlightAgent && hasFlightSearch && toolLog.length > 0) {
    console.log('\n✅ PASS - Tool extraction is working correctly!');
  } else {
    console.log('\n❌ FAIL - Tool extraction has issues');
  }
}

debugSingleTurn().catch(console.error);
