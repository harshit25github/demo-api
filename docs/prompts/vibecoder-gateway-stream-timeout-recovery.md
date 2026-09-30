# Implement Streaming `ModelTimeoutError` Recovery

## Context

The application uses `@openai/agents` with a Gateway Agent, specialist
handoffs, and a Node text stream:

```js
const result = await runner.run(GatewayAgent, input, {
  context,
  session,
  maxTurns,
  stream: true,
});

const textStream = result.toTextStream({
  compatibleWithNodeStreams: true,
});
```

SDK `modelSettings.retry` already exists. Keep it unchanged. This task adds a
fallback for a `ModelTimeoutError` that reaches the streaming error path.

Use this reference:

```text
docs/examples/gateway-text-stream-timeout-recovery.example.ts
```

## Required Recovery Flow

When `ModelTimeoutError` reaches `toTextStream()`:

1. Do not immediately close the HTTP response.
2. Confirm that no user-visible text has been emitted.
3. Confirm that `result.state` exists and the recovery limit is not exhausted.
4. Increase the timeout for the next model attempt.
5. Resume the unfinished turn with `result.state`:

   ```js
   runner.run(GatewayAgent, result.state, {
     context,
     session,
     maxTurns,
     stream: true,
   });
   ```

6. Forward the resumed output through the same client-facing stream.
7. Stop immediately when an attempt succeeds.
8. If recovery is exhausted, let the existing API catch close the response
   once:

   ```js
   if (!res.writableEnded && !res.destroyed) {
     res.end();
   }
   ```

Never resend the original user message. `result.state` preserves the active
specialist, completed handoffs, completed tools, context, and unfinished turn.
Restarting with the original input could repeat those operations.

## Increasing Timeout Per Recovery

Use request-local values:

```js
let timeoutMs = 80_000;
let recoveries = 0;

// Before each RunState recovery:
recoveries += 1;
timeoutMs += 4_000;
```

For four allowed recoveries, the sequence is:

```text
Initial attempt: 80000ms
Recovery 1:     84000ms
Recovery 2:     88000ms
Recovery 3:     92000ms
Recovery 4:     96000ms
```

Create/use a request-scoped Runner with the calculated timeout for each attempt.
Keep existing retry and model settings on that Runner:

```js
const runner = new Runner({
  model,
  modelSettings: {
    ...existingModelSettings,
    timeoutMs,
    retry: existingSdkRetrySettings,
  },
});
```

Use only one timeout owner. Remove `timeoutMs` from the shared Gateway/Flight
Agent `modelSettings` when timeout is controlled by the request-scoped Runner;
otherwise the Agent setting may override the increasing Runner value.

Do not mutate a shared singleton like this in a production server:

```js
FlightAgent.modelSettings.timeoutMs += 4_000;
```

That can change the timeout of concurrent requests. Timeout counters and Runner
instances must remain local to the current HTTP request.

## Streaming Structure

Use one `PassThrough` stream for all attempts:

```text
Initial text stream ─┐
Recovery stream 1   ├─ PassThrough → HTTP response
Recovery stream 2   ┘
```

Track the number of characters forwarded. Recovery is permitted only when that
count is zero. Await both the attempt's text stream and `result.completed`
before considering the attempt settled.

The recovery limit is separate from SDK `maxRetries`:

- SDK `maxRetries` retries one model request internally when replay is allowed.
- RunState recovery handles a terminal timeout surfaced by the stream.

## Scope

- Handle only streaming `ModelTimeoutError` recovery.
- Preserve the current context, session, handoffs, tools, and client format.
- Do not change prompts, tool schemas, business logic, or existing SDK retry
  policy.
- Do not add retry state to durable conversation context.

## Deliverable

Implement the wrapper at the current `toTextStream()` integration point and
report the files changed, timeout sequence, and how `result.state`, context,
session, and the HTTP response are preserved.
