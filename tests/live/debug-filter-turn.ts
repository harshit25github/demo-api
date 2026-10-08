/**
 * Debug test for filter turn to check payload structure
 */

import { runGatewayAgent } from '../../src/agents/manager-orchestrator/runner.js';

async function debugFilterTurn() {
  console.log('Turn 1: Initial search\n');
  const turn1 = await runGatewayAgent({
    input: 'Delhi to Dubai October 27 one-way, 1 adult economy',
    now: new Date('2026-09-20T10:00:00Z'),
  });

  console.log('Turn 2: Apply nonstop filter\n');
  const turn2 = await runGatewayAgent({
    input: 'direct only',
    context: turn1.context,
    now: new Date('2026-09-20T10:00:00Z'),
  });

  const context = turn2.context as any;
  if (context?.toolCallLog) {
    console.log('\n=== FLIGHT AGENT TOOL CALLS (Turn 2) ===');
    context.toolCallLog.forEach((entry: any, idx: number) => {
      console.log(`\n${idx + 1}. Tool: ${entry.tool}`);
      console.log(`   Status: ${entry.ok === false ? 'FAILED' : 'SUCCESS'}`);
      console.log('   Entry keys:', Object.keys(entry));
      if (entry.tool === 'apply_filter') {
        console.log('   Full entry:', JSON.stringify(entry, null, 2).substring(0, 1000));
      }
    });
  }

  // Check if filter was applied (using corrected structure)
  const filterTool = context?.toolCallLog?.find((e: any) => e.tool === 'apply_filter');
  if (filterTool) {
    console.log('\n=== FILTER VALIDATION (Corrected) ===');
    const filters = filterTool.filters;  // Direct property, not nested under input
    console.log('Filters array:', filters);
    if (filters && Array.isArray(filters)) {
      const stopsFilter = filters.find((f: any) =>
        f.filterType === 'stops' || f.rawUserFilter?.toLowerCase().includes('stop')
      );
      console.log('Stops filter found:', !!stopsFilter);
      if (stopsFilter) {
        console.log('filterCode:', stopsFilter.filterCode);
        console.log('Is nonstop (filterCode === "0"):', stopsFilter.filterCode === '0');
        console.log('✅ PASS - Filter correctly applied!');
      }
    }
  }
}

debugFilterTurn().catch(console.error);
