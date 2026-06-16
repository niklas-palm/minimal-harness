import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { setupTracer } from '@strands-agents/sdk/telemetry';

import { buildAgent, runAgentStream } from './agent.js';
import { emit } from './emit.js';

// Emit OpenTelemetry traces (agent loop, model calls, tool calls) over OTLP.
// The endpoint + headers come from OTEL_* env vars set on the runtime, which
// AgentCore Observability points at CloudWatch. No-op locally if unset.
setupTracer({ exporters: { otlp: true } });

// One AgentCore microVM per runtimeSessionId. We use a fresh sessionId per
// invocation, so every run is isolated. No queue, no SessionManager — one
// run per microVM.
const app = new BedrockAgentCoreApp({
  config: {
    logging: { enabled: true, options: { level: 'warn' } },
    contentTypeParsers: [
      {
        contentType: 'application/octet-stream',
        parseAs: 'string',
        parser: (
          _req: unknown,
          body: unknown,
          done: (err: Error | null, value?: unknown) => void,
        ) => {
          try {
            done(null, body ? JSON.parse(body as string) : {});
          } catch (err) {
            done(err as Error);
          }
        },
      },
    ],
  },
  invocationHandler: {
    process: async (payload, context) => {
      const sid = context.sessionId;
      const body = (payload ?? {}) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';

      if (!prompt) {
        return { status: 'rejected', error: "missing 'prompt' in payload" };
      }

      // Fire-and-forget: return immediately so the caller isn't blocked
      // while the agent works. Progress + the final answer land in the logs.
      void wrappedRun({ prompt, sessionId: sid }).catch(reportTaskError);
      return { status: 'accepted', session_id: sid };
    },
  },
});

interface RunArgs {
  prompt: string;
  sessionId: string;
}

const wrappedRun = app.asyncTask(run as (...args: unknown[]) => Promise<unknown>);

async function run(args: RunArgs): Promise<void> {
  const agent = buildAgent(args.sessionId);
  const answer = await runAgentStream(agent, args.prompt, args.sessionId);
  emit('session_end', { session_id: args.sessionId, answer });
}

function reportTaskError(err: unknown): void {
  emit('error', {
    error: err instanceof Error ? err.message : String(err),
    trace: err instanceof Error && err.stack ? err.stack : '',
  });
}

(async () => {
  app.run();
})().catch((err) => {
  console.error('failed to start server', err);
  process.exit(1);
});
