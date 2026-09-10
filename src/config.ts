// Runtime configuration. One file, config.json at the repo root, is the single
// source of truth for both the CDK stack and the running container (it's
// copied into the image). Nothing else reads process.env for config, except
// the two values only the deploy can know.
//
// We deliberately do NOT read AWS_REGION: a stale shell value can silently
// misroute calls.
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

export interface HarnessConfig {
  /** Every resource lives here. */
  region: string;
  /** Bedrock model id (cross-region inference profile). */
  bedrockModelId: string;
  /** Provision the web search gateway and give the agent web_search. */
  webSearch: boolean;
  /** Export OpenTelemetry traces to CloudWatch (AgentCore Observability). */
  tracing: boolean;
  /** Strip prompts, messages and tool payloads from exported spans. */
  redactTraceContent: boolean;
}

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')) as HarnessConfig;

export const REGION = config.region;
export const BEDROCK_MODEL_ID = config.bedrockModelId;
export const TRACING = config.tracing;
export const REDACT_TRACE_CONTENT = config.redactTraceContent;

// The agent's sandbox. File tools refuse to touch anything outside it.
export const WORKSPACE_DIR = pathResolve(process.env.WORKSPACE_DIR ?? '/workspace');

// Where the AgentSkills plugin looks for skills. Each subfolder with a
// SKILL.md is loaded automatically. Baked into the image at /app/skills.
export const SKILLS_DIR = process.env.SKILLS_DIR ?? '/app/skills';

// Set by the stack when webSearch is on: the gateway URL only exists after
// deploy. Empty means the web_search tool isn't wired.
export const WEB_SEARCH_GATEWAY_URL = process.env.WEB_SEARCH_GATEWAY_URL ?? '';
