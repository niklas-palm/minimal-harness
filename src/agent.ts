// Strands Agent factory for the harness.
//
// Each invocation builds a fresh Agent - no SessionManager, no shared state.
// The agent gets the four base tools, web_fetch, web_search when the stack
// enabled it, and the skills plugin; nothing else.
import { Agent, BedrockModel } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { AgentSkills } from "@strands-agents/sdk/vended-plugins/skills";

import {
  BEDROCK_MODEL_ID,
  REGION,
  SKILLS_DIR,
  WEB_SEARCH_GATEWAY_URL,
} from "./config.js";
import { emit } from "./emit.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS } from "./tools.js";
import { webFetch, webSearch } from "./web.js";

const MAX_TOKENS = 25000;

// Bedrock serves OpenAI models through an OpenAI-compatible endpoint ("Mantle")
// rather than the Converse API, so they need OpenAIModel instead of
// BedrockModel. Both are keyless: Mantle mints a bearer token from the same AWS
// credentials. Mantle currently only exists in us-east-1, so it is pinned there
// no matter where the rest of the stack runs.
const MANTLE_REGION = "us-east-1";

function buildModel() {
  if (BEDROCK_MODEL_ID.includes("openai.")) {
    return new OpenAIModel({
      // `global.` cross-region profiles are an Anthropic thing; Mantle wants the plain id.
      modelId: BEDROCK_MODEL_ID.replace(/^global\./, ""),
      maxTokens: MAX_TOKENS,
      bedrockMantleConfig: { region: MANTLE_REGION },
      // The OpenAI client defaults to 10 minutes and 2 retries, so one wedged
      // request could hold the microVM for half an hour of billable time.
      clientConfig: { timeout: 120_000, maxRetries: 2 },
    });
  }
  return new BedrockModel({
    modelId: BEDROCK_MODEL_ID,
    region: REGION,
    maxTokens: MAX_TOKENS,
    cacheConfig: { strategy: "auto" },
  });
}

// Hard stop for runaway loops. One run should never need this many model
// calls; hitting it ends the run with whatever the agent has so far.
const MAX_TURNS = 50;

export function buildAgent(sessionId: string): Agent {
  // Progressive-disclosure skills. The plugin scans SKILLS_DIR, injects an
  // <available_skills> list into the system prompt, and registers a `skills`
  // tool the agent calls to load a skill's full instructions on demand. Drop
  // a new folder with a SKILL.md into skills/ and it's picked up automatically.
  const skillsPlugin = new AgentSkills({ skills: [SKILLS_DIR] });

  const tools = [
    ...TOOLS,
    webFetch,
    ...(WEB_SEARCH_GATEWAY_URL ? [webSearch] : []),
  ];

  const agent = new Agent({
    name: "harness",
    model: buildModel(),
    tools: tools as any,
    plugins: [skillsPlugin],
    systemPrompt: SYSTEM_PROMPT,
    printer: false,
  });

  emit("session_start", { session_id: sessionId, model_id: BEDROCK_MODEL_ID });
  return agent;
}

// Stream the agent to completion, emitting one structured log line per
// model message and tool result. Returns the agent's final text - the
// answer the caller sees.
export async function runAgentStream(
  agent: Agent,
  prompt: string,
  sessionId: string,
): Promise<string> {
  let finalText = "";

  const stream = agent.stream(prompt as any, {
    invocationState: { session_id: sessionId },
    limits: { turns: MAX_TURNS },
  });

  try {
    for await (const ev of stream) {
      const evAny = ev as any;
      if (evAny.type === "modelMessageEvent") {
        for (const block of evAny.message?.content ?? []) {
          if (block?.type === "textBlock" && block.text) {
            const text = String(block.text);
            emit("text", { session_id: sessionId, content: text });
            finalText = text; // last assistant text wins - it's the answer
          } else if (
            block?.type === "toolUseBlock" &&
            block.toolUseId &&
            block.name
          ) {
            emit("tool_input", {
              session_id: sessionId,
              name: block.name,
              tool_use_id: block.toolUseId,
              input: block.input ?? {},
            });
          }
        }
      } else if (evAny.type === "toolResultEvent") {
        const tr = evAny.result;
        if (!tr) continue;
        emit("tool_result", {
          session_id: sessionId,
          tool_use_id: tr.toolUseId,
          result: serializeToolResult(tr.content ?? []).slice(0, 4000),
        });
      }
    }
  } catch (e) {
    emit("stream_error", {
      session_id: sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return finalText;
}

function serializeToolResult(content: any[]): string {
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.text !== undefined) return String(b.text);
      if (b?.json !== undefined) return JSON.stringify(b.json);
      return JSON.stringify(b);
    })
    .join("");
}
