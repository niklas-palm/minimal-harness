// The AgentCore Runtime entrypoint. Accepts {prompt}, starts the agent as a
// background task and returns "accepted" immediately; progress and the final
// answer go to stdout as JSON lines (and so to CloudWatch). One microVM per
// session id, so nothing here is shared between runs.
import type { Agent } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

import { buildAgent, runAgentStream } from "./agent.js";
import { TRACING } from "./config.js";
import { emit } from "./emit.js";
import { flushTraces, setTraceSessionId, startTracing } from "./tracing.js";

// Register the tracer before anything creates spans.
if (TRACING) startTracing();

// One AgentCore microVM per runtimeSessionId. `make invoke` picks a fresh
// session id by default, so every run is isolated; pass the same SESSION_ID
// again to continue a conversation in the same microVM. No queue, no
// SessionManager.
const app = new BedrockAgentCoreApp({
  config: {
    logging: { enabled: true, options: { level: "warn" } },
    contentTypeParsers: [
      {
        contentType: "application/octet-stream",
        parseAs: "string",
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
      const prompt = typeof body.prompt === "string" ? body.prompt : "";

      if (!prompt) {
        return { status: "rejected", error: "missing 'prompt' in payload" };
      }

      // Fire-and-forget: return immediately so the caller isn't blocked
      // while the agent works. Progress + the final answer land in the logs.
      void wrappedRun({ prompt, sessionId: sid }).catch(reportTaskError);
      return { status: "accepted", session_id: sid };
    },
  },
});

interface RunArgs {
  prompt: string;
  sessionId: string;
}

const wrappedRun = app.asyncTask(
  run as (...args: unknown[]) => Promise<unknown>,
);

// One agent per microVM, created on the first invocation and reused after.
// AgentCore routes every call with the same session id to the same microVM,
// so this is the session: the conversation lives in the agent's message list
// for as long as the microVM does, and a second invocation continues where
// the first left off. There is no external store; when the microVM idles out
// the conversation is gone with it.
let agent: Agent | undefined;

async function run(args: RunArgs): Promise<void> {
  setTraceSessionId(args.sessionId);
  agent ??= buildAgent(args.sessionId);
  const answer = await runAgentStream(agent, args.prompt, args.sessionId);
  emit("session_end", { session_id: args.sessionId, answer });
  await flushTraces();
}

function reportTaskError(err: unknown): void {
  emit("error", {
    error: err instanceof Error ? err.message : String(err),
    trace: err instanceof Error && err.stack ? err.stack : "",
  });
}

(async () => {
  app.run();
})().catch((err) => {
  console.error("failed to start server", err);
  process.exit(1);
});
