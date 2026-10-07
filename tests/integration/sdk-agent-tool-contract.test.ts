/**
 * Pins native `Agent.asTool()` behavior, including optional SDK capabilities.
 *
 * Optional guardrails and timeout tests below exercise the SDK, not application
 * Manager wrappers. Production Manager uses the direct singleton registrations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
process.env.OPENAI_API_KEY ||= 'test-key';

const {
  Agent,
  Runner,
  Usage,
  tool,
  defineToolOutputGuardrail,
  ToolGuardrailFunctionOutputFactory,
} = await import('@openai/agents');
const { z } = await import('zod');

function textAnswer(text: string) {
  return {
    usage: new Usage(),
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    responseId: 'resp_contract',
  };
}

function toolCall(name: string, input: string, callId: string) {
  return {
    usage: new Usage(),
    output: [{
      type: 'function_call',
      callId,
      name,
      arguments: JSON.stringify({ input }),
      status: 'completed',
    }],
    responseId: `resp_${callId}`,
  };
}

/**
 * Runs one Manager turn that calls one `asTool()` specialist, and reports the
 * model settings each side actually resolved to.
 *
 * `gate` sets `runConfig.modelProvider` on the tool; `specialistSets` decides
 * whether the specialist agent declares its own reasoning/verbosity.
 */
async function observeSpecialistSettings(
  { gate, specialistSets }: { gate: boolean; specialistSets: boolean },
) {
  const observed: Array<{ who: string; effort: unknown; verbosity: unknown }> = [];

  const specialistModel = {
    async getResponse(request: any) {
      observed.push({
        who: 'specialist',
        effort: request.modelSettings?.reasoning?.effort ?? null,
        verbosity: request.modelSettings?.text?.verbosity ?? null,
      });
      return textAnswer('specialist output');
    },
  };
  let managerCalls = 0;
  const managerModel = {
    async getResponse(request: any) {
      managerCalls += 1;
      observed.push({
        who: 'manager',
        effort: request.modelSettings?.reasoning?.effort ?? null,
        verbosity: request.modelSettings?.text?.verbosity ?? null,
      });
      return managerCalls === 1
        ? toolCall('spec', 'do the subtask', 'call_1')
        : textAnswer('done');
    },
  };

  const specialist = new Agent({
    name: 'Specialist',
    instructions: 'Reply.',
    model: specialistModel as any,
    modelSettings: specialistSets
      ? { reasoning: { effort: 'low' }, text: { verbosity: 'low' } }
      : {},
  });

  const specialistTool = specialist.asTool({
    toolName: 'spec',
    toolDescription: 'A specialist',
    runConfig: {
      ...(gate
        ? { modelProvider: { async getModel() { return specialistModel as any; } } as any }
        : {}),
      // Mirrors production: the tool's runConfig carries transport concerns
      // only. Setting reasoning/verbosity here would override the inherited
      // values by itself and make the gate untestable.
      modelSettings: { preserveRawUsage: true },
    },
    runOptions: { maxTurns: 3 },
    customOutputExtractor: (result: any) => JSON.stringify(result.finalOutput ?? null),
  });

  const manager = new Agent({
    name: 'Manager',
    instructions: 'Route.',
    model: managerModel as any,
    modelSettings: { reasoning: { effort: 'high' }, text: { verbosity: 'high' } },
    tools: [specialistTool],
  });

  await new Runner({
    tracingDisabled: true,
    modelSettings: { reasoning: { effort: 'high' }, text: { verbosity: 'high' } },
  }).run(manager, 'go', { maxTurns: 6 });

  return {
    specialist: observed.find((entry) => entry.who === 'specialist'),
    manager: observed.find((entry) => entry.who === 'manager'),
  };
}

/**
 * The production invariant: a specialist that declares its own model settings
 * runs on them, never on the Manager's, while the Manager keeps its own.
 *
 * This holds because an agent's own `modelSettings` beat anything inherited
 * through the agent-tool run config, and `selectModel()` always prefers the
 * agent's own `model` over `runConfig.model`. Both Flight and Trip Planner
 * declare `model`, `reasoning.effort` and `text.verbosity` in their configs.
 */
test('asTool specialist runs on its own declared model settings, not the Manager\'s', async () => {
  const withGate = await observeSpecialistSettings({ gate: true, specialistSets: true });
  assert.ok(withGate.specialist, 'specialist model was never invoked');
  assert.equal(withGate.specialist.effort, 'low', 'specialist took the Manager reasoning effort');
  assert.equal(withGate.specialist.verbosity, 'low', 'specialist took the Manager verbosity');
  assert.equal(withGate.manager?.effort, 'high', 'Manager lost its own reasoning effort');

  // The specialist's own settings win even without the modelProvider gate, so
  // the gate is defence in depth for declared settings rather than the thing
  // that protects them.
  const noGate = await observeSpecialistSettings({ gate: false, specialistSets: true });
  assert.equal(noGate.specialist?.effort, 'low');
});

/**
 * What the `modelProvider` gate actually buys: for any setting the specialist
 * does NOT declare, the Manager's value leaks in without it.
 *
 * `getInheritedAgentToolRunConfig()` forwards the parent's `model` and
 * `modelSettings` only when the tool does not override `modelProvider`. Keep
 * that override in place (production also needs it for usage observation).
 */
test('modelProvider override stops the Manager settings a specialist leaves unset from leaking', async () => {
  const leaked = await observeSpecialistSettings({ gate: false, specialistSets: false });
  assert.equal(leaked.specialist?.effort, 'high',
    'expected the Manager effort to leak without the gate; SDK inheritance changed');

  const gated = await observeSpecialistSettings({ gate: true, specialistSets: false });
  assert.equal(gated.specialist?.effort, null,
    'the modelProvider override no longer blocks inherited model settings');
  assert.equal(gated.specialist?.verbosity, null);
});

/**
 * A tool output guardrail replaces what the MODEL sees. This is what lets the
 * refactor drop the `SDK_TOOL_ERROR_PREFIX` string sniffing: instead of parsing
 * the SDK's error wording, reject any output that is not a valid result shape
 * and hand the Manager a fixed generic line.
 */
test('tool output guardrail replaces model-visible tool output', async () => {
  const REPLACEMENT = "I couldn't finish that part of your request right now.";
  const managerInputs: string[] = [];

  const specialistModel = {
    async getResponse() { return textAnswer('RAW_SPECIALIST_DETAIL_SHOULD_NOT_LEAK'); },
  };
  const managerModel = {
    async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      return managerInputs.length === 1
        ? toolCall('spec', 'subtask', 'call_1')
        : textAnswer('final answer');
    },
  };

  const specialist = new Agent({
    name: 'Specialist',
    instructions: 'Reply.',
    model: specialistModel as any,
  });

  const specialistTool = specialist.asTool({
    toolName: 'spec',
    toolDescription: 'A specialist',
    runOptions: { maxTurns: 2 },
    customOutputExtractor: (result: any) => String(result.finalOutput ?? ''),
  });

  // Allow only a validated shape; replace anything else. Assigned onto the
  // returned tool because `asTool()` options do not expose `outputGuardrails`.
  specialistTool.outputGuardrails = [
    defineToolOutputGuardrail({
      name: 'specialist_result_shape',
      async run({ output }) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(output));
        } catch {
          return ToolGuardrailFunctionOutputFactory.rejectContent(REPLACEMENT);
        }
        return typeof (parsed as any)?.status === 'string'
          ? ToolGuardrailFunctionOutputFactory.allow()
          : ToolGuardrailFunctionOutputFactory.rejectContent(REPLACEMENT);
      },
    }),
  ];

  const manager = new Agent({
    name: 'Manager',
    instructions: 'Route.',
    model: managerModel as any,
    tools: [specialistTool],
  });

  await new Runner({ tracingDisabled: true }).run(manager, 'go', { maxTurns: 6 });

  assert.equal(managerInputs.length, 2, 'Manager did not make a second model call');
  assert.match(managerInputs[1], /couldn.{0,3}t finish that part/,
    'the replacement line never reached the Manager');
  assert.doesNotMatch(managerInputs[1], /RAW_SPECIALIST_DETAIL_SHOULD_NOT_LEAK/,
    'raw specialist output leaked into the Manager context');
});

/**
 * A per-call timeout belongs on the returned tool, not in `runOptions`: a
 * module-scope `AbortSignal.timeout` starts counting at import and would abort
 * every later run. `error_as_result` keeps a timeout as one failed tool call
 * instead of failing the whole Manager run.
 */
test('asTool timeoutMs with error_as_result returns a model-visible result', async () => {
  const TIMEOUT_LINE = 'SPECIALIST_TIMED_OUT';
  const managerInputs: string[] = [];

  const slowModel = {
    async getResponse() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return textAnswer('too late');
    },
  };
  const managerModel = {
    async getResponse(request: any) {
      managerInputs.push(JSON.stringify(request.input));
      return managerInputs.length === 1
        ? toolCall('spec', 'subtask', 'call_1')
        : textAnswer('final answer');
    },
  };

  const specialist = new Agent({
    name: 'Slow Specialist',
    instructions: 'Reply.',
    model: slowModel as any,
  });

  const specialistTool = specialist.asTool({
    toolName: 'spec',
    toolDescription: 'A slow specialist',
    runOptions: { maxTurns: 2 },
    customOutputExtractor: (result: any) => String(result.finalOutput ?? ''),
  });
  specialistTool.timeoutMs = 20;
  specialistTool.timeoutBehavior = 'error_as_result';
  specialistTool.timeoutErrorFunction = () => TIMEOUT_LINE;

  const manager = new Agent({
    name: 'Manager',
    instructions: 'Route.',
    model: managerModel as any,
    tools: [specialistTool],
  });

  const result = await new Runner({ tracingDisabled: true })
    .run(manager, 'go', { maxTurns: 6 });

  assert.equal(managerInputs.length, 2, 'the timeout failed the run instead of becoming a result');
  assert.match(managerInputs[1], new RegExp(TIMEOUT_LINE),
    'the timeout result never reached the Manager');
  assert.equal(String(result.finalOutput), 'final answer');
});

/**
 * `maxFunctionToolConcurrency: 1` is how the refactor keeps specialists serial
 * once the manual `currentUserMessage` swap is gone. Two tool calls emitted in
 * one turn must not overlap.
 */
test('maxFunctionToolConcurrency 1 runs tools serially', async () => {
  let active = 0;
  let maxActive = 0;

  const makeSpecialist = (name: string) => {
    const model = {
      async getResponse() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return textAnswer(`${name} done`);
      },
    };
    return new Agent({ name, instructions: 'Reply.', model: model as any })
      .asTool({
        toolName: name,
        toolDescription: name,
        runOptions: { maxTurns: 2 },
        customOutputExtractor: (result: any) => String(result.finalOutput ?? ''),
      });
  };

  let managerCalls = 0;
  const managerModel = {
    async getResponse() {
      managerCalls += 1;
      if (managerCalls === 1) {
        // Both calls emitted in a single turn.
        return {
          usage: new Usage(),
          output: [
            { type: 'function_call', callId: 'c1', name: 'spec_a',
              arguments: JSON.stringify({ input: 'a' }), status: 'completed' },
            { type: 'function_call', callId: 'c2', name: 'spec_b',
              arguments: JSON.stringify({ input: 'b' }), status: 'completed' },
          ],
          responseId: 'resp_parallel',
        };
      }
      return textAnswer('final answer');
    },
  };

  const manager = new Agent({
    name: 'Manager',
    instructions: 'Route.',
    model: managerModel as any,
    tools: [makeSpecialist('spec_a'), makeSpecialist('spec_b')],
  });

  await new Runner({
    tracingDisabled: true,
    toolExecution: { maxFunctionToolConcurrency: 1 },
  }).run(manager, 'go', { maxTurns: 6 });

  assert.equal(maxActive, 1, `tools overlapped: ${maxActive} ran concurrently`);
});

/**
 * The reason the refactor can delete `SDK_TOOL_ERROR_PREFIX` parsing: EVERY way a
 * specialist call can fail funnels through the output guardrail, and none of them
 * throws out of the Manager run. That makes the guardrail a single choke point for
 * both masking the failure and recording it.
 *
 * Covers a nested run that exceeds its own maxTurns, a nested model that throws,
 * an extractor that throws, and an extractor that returns an unusable shape.
 */
test('every specialist failure mode reaches the output guardrail and is replaced', async () => {
  const REPLACEMENT = 'GENERIC_FAILURE_LINE';

  const noopTool = tool({
    name: 'noop',
    description: 'noop',
    parameters: z.object({}),
    async execute() { return 'noop-result'; },
  });

  async function runFailure(specialist: any, extractor: (result: any) => string) {
    const guardrailSaw: string[] = [];
    const managerInputs: string[] = [];

    const specialistTool = specialist.asTool({
      toolName: 'spec',
      toolDescription: 'spec',
      inputBuilder: ({ params }: any) => String(params.input),
      runOptions: { maxTurns: 2 },
      customOutputExtractor: extractor,
    });
    specialistTool.outputGuardrails = [defineToolOutputGuardrail({
      name: 'shape',
      async run({ output }: any) {
        guardrailSaw.push(String(output));
        let parsed: any;
        try { parsed = JSON.parse(String(output)); } catch { parsed = null; }
        return parsed && typeof parsed.status === 'string'
          ? ToolGuardrailFunctionOutputFactory.allow()
          : ToolGuardrailFunctionOutputFactory.rejectContent(REPLACEMENT);
      },
    })];

    let managerCalls = 0;
    const managerModel = {
      async getResponse(request: any) {
        managerCalls += 1;
        managerInputs.push(JSON.stringify(request.input));
        return managerCalls === 1
          ? toolCall('spec', 'subtask', 'call_1')
          : textAnswer('final answer');
      },
    };
    const manager = new Agent({
      name: 'Manager', instructions: 'Route.',
      model: managerModel as any, tools: [specialistTool],
    });

    let threw: unknown = null;
    try {
      await new Runner({ tracingDisabled: true }).run(manager, 'go', { maxTurns: 8 });
    } catch (error) { threw = error; }

    const seenByManager = managerInputs[1]
      ? JSON.parse(managerInputs[1]).find((item: any) => item.type === 'function_call_result')
      : null;
    return { threw, guardrailSaw, seenByManager };
  }

  const validExtractor = (result: any) =>
    JSON.stringify({ status: 'success', summary: String(result.finalOutput ?? '') });

  const cases: Array<[string, any, (result: any) => string]> = [
    ['nested maxTurns exceeded',
      new Agent({ name: 'SA', instructions: 'x', tools: [noopTool],
        model: { async getResponse() { return toolCall('noop', '', `i${Math.random()}`); } } as any },
      ), validExtractor],
    ['nested model throws',
      new Agent({ name: 'SB', instructions: 'x',
        model: { async getResponse() { throw new Error('NESTED_BOOM_DETAIL'); } } as any }),
      validExtractor],
    ['extractor throws',
      new Agent({ name: 'SC', instructions: 'x',
        model: { async getResponse() { return textAnswer('fine'); } } as any }),
      () => { throw new Error('EXTRACTOR_BOOM_DETAIL'); }],
    ['extractor returns an unusable shape',
      new Agent({ name: 'SD', instructions: 'x',
        model: { async getResponse() { return textAnswer('fine'); } } as any }),
      () => 'not json at all'],
  ];

  for (const [label, specialist, extractor] of cases) {
    const { threw, guardrailSaw, seenByManager } = await runFailure(specialist, extractor);
    assert.equal(threw, null, `${label}: failed the Manager run instead of becoming a tool result`);
    assert.equal(guardrailSaw.length, 1, `${label}: the output guardrail did not run`);
    assert.equal(seenByManager?.output?.text, REPLACEMENT,
      `${label}: the Manager did not see the replacement line`);
    assert.doesNotMatch(JSON.stringify(seenByManager), /BOOM_DETAIL|MaxTurnsExceeded/,
      `${label}: SDK or specialist error detail leaked to the Manager`);
  }
});

/**
 * The tool timeout genuinely ABORTS the nested run rather than just returning
 * early, because the SDK combines its timeout controller with `details.signal`,
 * which `asTool()` passes down as the nested run's signal. It also clones
 * `details` by property descriptors, preserving the non-enumerable parent run
 * config and trace span symbols — the thing the application used to hand-roll.
 */
test('asTool timeoutMs aborts the nested run', async () => {
  let nestedSawAbort = false;
  let nestedCompleted = false;

  const slowModel = {
    async getResponse(request: any) {
      const signal: AbortSignal | undefined = request?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { nestedCompleted = true; resolve(); }, 400);
        signal?.addEventListener('abort', () => {
          nestedSawAbort = true;
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return textAnswer('too late');
    },
  };

  const specialist = new Agent({ name: 'Slow', instructions: 'x', model: slowModel as any });
  const specialistTool = specialist.asTool({
    toolName: 'spec',
    toolDescription: 'spec',
    runOptions: { maxTurns: 2 },
    customOutputExtractor: (result: any) => String(result.finalOutput ?? ''),
  });
  specialistTool.timeoutMs = 30;
  specialistTool.timeoutBehavior = 'error_as_result';
  specialistTool.timeoutErrorFunction = () => 'TIMED_OUT';

  let managerCalls = 0;
  const managerModel = {
    async getResponse() {
      managerCalls += 1;
      return managerCalls === 1 ? toolCall('spec', 'subtask', 'c1') : textAnswer('final answer');
    },
  };
  const manager = new Agent({
    name: 'Manager', instructions: 'Route.', model: managerModel as any, tools: [specialistTool],
  });

  await new Runner({ tracingDisabled: true }).run(manager, 'go', { maxTurns: 6 });
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(nestedSawAbort, true, 'the nested run was never aborted on timeout');
  assert.equal(nestedCompleted, false, 'the nested run kept running past the tool timeout');
});
