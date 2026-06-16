// Single source of truth for runtime-container configuration.
//
// Two tiers, and nothing else reads process.env for config:
//   1. Invariants    - hardcoded; never read from the environment.
//   2. Required       - must be set at deploy; missing values throw at startup.
//
// No silent fallbacks for required config. A missing deploy value fails
// loudly here, on import, rather than producing weird behaviour later.
import { resolve as pathResolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// --- 1. Invariants (hardcoded, never from the environment) ---
// Every resource lives in eu-north-1. We deliberately do NOT read
// AWS_REGION - a stale shell value can silently misroute calls.
export const REGION = 'eu-north-1';

// The agent's sandbox. Tools refuse to touch anything outside it.
export const WORKSPACE_DIR = pathResolve(process.env.WORKSPACE_DIR ?? '/workspace');

// Where the AgentSkills plugin looks for skills. Each subfolder with a
// SKILL.md is loaded automatically. Baked into the image at /app/skills.
export const SKILLS_DIR = process.env.SKILLS_DIR ?? '/app/skills';

// --- 2. Required deploy config ---
export const BEDROCK_MODEL_ID = required('BEDROCK_MODEL_ID');
