// The four base tools: read_file, write_file, edit_file, bash.
//
// This is deliberately the whole list. Listing, finding and grepping files
// and running Python all go through `bash` (ls, rg, python3): the model
// already knows those commands, so a dedicated tool has to earn its place by
// doing something the shell does badly. The file tools do: read_file shapes
// output for the context window (line numbers, offset/limit, size and binary
// guards), edit_file enforces a unique exact match, write_file is explicit
// about overwriting. Everything else is a shell command.
//
// Every tool wraps its body in try/catch and returns {error, hint} on
// failure - never throws. The agent reads the hint and adapts.
//
// Tool names use snake_case and parameter names match what the model is
// trained to emit (read_file, old_text, etc.) - that surface is load-bearing
// for the prompt and shouldn't be camelCased.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { tool as strandsTool } from "@strands-agents/sdk";
import { z } from "zod";

import { WORKSPACE_DIR as WORKSPACE } from "./config.js";

// Tool bodies return `{...}|{error,hint}` unions that TS infers with implicit
// `?: undefined` keys, which Strands' JSONValue rejects. Serialisation handles
// undefined fine; this re-typing of `tool()` loosens only the return type.
// Inputs stay typed via the Zod schema.
type ToolFactory = <S extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  inputSchema: S;
  callback: (input: z.infer<S>, ctx?: any) => any;
}) => unknown;
export const tool = strandsTool as unknown as ToolFactory;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // read_file refuses bigger files
const MAX_LINES = 2000; // read_file default window
const MAX_LINE_CHARS = 2000; // longer lines are cut
const MAX_OUTPUT_CHARS = 20_000; // bash stdout and stderr cap, each
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;

// --- helpers ----------------------------------------------------------------

// Resolve a path inside the workspace; refuse anything that escapes it.
function safePath(rel: string): string {
  const p = pathResolve(WORKSPACE, rel);
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + "/")) {
    throw new Error(`path traversal not allowed; stay inside ${WORKSPACE}`);
  }
  return p;
}

// A NUL byte in the first 8 KB is a good enough "not a text file" signal.
function isBinary(path: string): boolean {
  const buf = Buffer.alloc(8192);
  const fd = openSync(path, "r");
  try {
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const dropped = s.length - MAX_OUTPUT_CHARS;
  return (
    s.slice(0, MAX_OUTPUT_CHARS) +
    `\n... [truncated ${dropped} chars; redirect to a file and use read_file]`
  );
}

function errorResult(e: unknown, hint: string) {
  return { error: e instanceof Error ? e.message : String(e), hint };
}

// Files the agent has read (or written) in this run. edit_file and write_file
// refuse to change a file the agent hasn't seen, so it always edits what is
// actually there. One microVM is one run, so module state is safe.
const seen = new Set<string>();

// --- tools ------------------------------------------------------------------

const readFile = tool({
  name: "read_file",
  description: `Read a text file from the workspace.

Returns the content with 1-indexed line numbers (cat -n format). Reads up to
${MAX_LINES} lines from the start by default; use offset and limit to page
through longer files. Lines over ${MAX_LINE_CHARS} chars are cut.

For binary files, or files over 5 MB, use bash (head, tail, file, python3).
Don't re-read a file just to verify an edit_file or write_file: those fail
loudly if the change didn't apply.`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    offset: z
      .number()
      .int()
      .optional()
      .describe("Line number to start from (1-indexed)."),
    limit: z
      .number()
      .int()
      .optional()
      .describe(`Number of lines to read (default ${MAX_LINES}).`),
  }),
  callback: ({ path, offset, limit }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp)) {
        return {
          error: `file not found: ${path}`,
          hint: "check the path; use bash (ls) to explore",
        };
      }
      const stat = statSync(fp);
      if (stat.isDirectory()) {
        return {
          error: `path is a directory: ${path}`,
          hint: "use bash (ls) to list it",
        };
      }
      if (stat.size > MAX_FILE_BYTES) {
        return {
          error: `file too large (${stat.size} bytes)`,
          hint: "use bash (head, tail, sed -n) instead",
        };
      }
      if (isBinary(fp)) {
        return {
          error: "binary file",
          hint: "inspect it with bash (file, xxd, python3)",
        };
      }
      const lines = readFileSync(fp, "utf8").split("\n");
      seen.add(fp);
      const start = offset && offset >= 1 ? offset - 1 : 0;
      const selected = lines.slice(start, start + (limit ?? MAX_LINES));
      const width = String(start + selected.length).length;
      const numbered = selected
        .map(
          (ln, i) =>
            `${String(start + i + 1).padStart(width)}\t${ln.slice(0, MAX_LINE_CHARS)}`,
        )
        .join("\n");
      return {
        content: numbered,
        total_lines: lines.length,
        returned_lines: selected.length,
        start_line: start + 1,
      };
    } catch (e) {
      return errorResult(e, "check the path and try again");
    }
  },
});

const writeFile = tool({
  name: "write_file",
  description: `Write content to a new file, creating parent directories as needed.

Use only for new files. write_file on an existing file overwrites it entirely
and is refused unless you have read the file first; to change an existing
file, use edit_file.`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    content: z.string().describe("Complete file content."),
  }),
  callback: ({ path, content }) => {
    try {
      const fp = safePath(path);
      if (existsSync(fp) && !seen.has(fp)) {
        return {
          error: `file exists and you haven't read it: ${path}`,
          hint: "read_file it first, or use edit_file",
        };
      }
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      seen.add(fp);
      return {
        success: true,
        path,
        bytes_written: Buffer.byteLength(content, "utf8"),
      };
    } catch (e) {
      return errorResult(e, "check the path is valid and writable");
    }
  },
});

const editFile = tool({
  name: "edit_file",
  description: `Edit a file by replacing an exact string match.

You must read the file with read_file first; the edit is refused otherwise.
old_text must appear exactly once in the file, unless replace_all is set
(useful for renames). Whitespace and indentation must match exactly. When
copying from read_file output, strip the line-number prefix (number + tab).
new_text must differ from old_text.`,
  inputSchema: z.object({
    path: z.string().describe("Path relative to the workspace."),
    old_text: z
      .string()
      .describe(
        "Exact text to find. Must be unique unless replace_all is set.",
      ),
    new_text: z.string().describe("Replacement text."),
    replace_all: z
      .boolean()
      .optional()
      .describe(
        "Replace every occurrence instead of requiring a unique match.",
      ),
  }),
  callback: ({ path, old_text, new_text, replace_all }) => {
    try {
      if (old_text === new_text) {
        return {
          error: "old_text and new_text are identical",
          hint: "no-op edit rejected",
        };
      }
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return {
          error: `file not found: ${path}`,
          hint: "create it with write_file or check the path",
        };
      }
      if (!seen.has(fp)) {
        return {
          error: `you haven't read this file yet: ${path}`,
          hint: "read_file it first, then edit",
        };
      }
      if (isBinary(fp)) {
        return {
          error: "binary file",
          hint: "edit_file only works on text files",
        };
      }
      const content = readFileSync(fp, "utf8");
      const count = content.split(old_text).length - 1;
      if (count === 0) {
        return {
          error: "old_text not found in file",
          hint: "check whitespace and quoting, and drop any line-number prefix copied from read_file",
        };
      }
      if (!replace_all && count > 1) {
        return {
          error: `old_text matches ${count} locations - must be unique`,
          hint: "add surrounding context to make old_text unique, or set replace_all",
        };
      }
      const updated = replace_all
        ? content.split(old_text).join(new_text)
        : content.replace(old_text, new_text);
      writeFileSync(fp, updated);
      return { success: true, path, replacements: replace_all ? count : 1 };
    } catch (e) {
      return errorResult(e, "check the path and try again");
    }
  },
});

const bash = tool({
  name: "bash",
  description: `Run a bash command and return its stdout, stderr and exit code.

Each call is a fresh shell in ${WORKSPACE}: cd, variables and other shell
state do not carry over between calls. Use it for everything the file tools
don't cover: listing and finding files (ls, rg --files), searching content
(rg), running Python (python3 script.py), installing packages, git, curl,
builds and tests. Use read_file, edit_file and write_file for reading and
changing files.

Commands are killed after \`timeout\` seconds (default ${DEFAULT_TIMEOUT_S},
max ${MAX_TIMEOUT_S}). For longer work, start it in the background
(nohup cmd > out.log 2>&1 &) and poll the log. Output is capped at
${MAX_OUTPUT_CHARS} characters per stream; redirect longer output to a file
and read it with read_file.`,
  inputSchema: z.object({
    command: z.string().describe("The command to run."),
    timeout: z
      .number()
      .int()
      .optional()
      .describe(
        `Seconds before the command is killed (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
      ),
  }),
  callback: ({ command, timeout = DEFAULT_TIMEOUT_S }) =>
    new Promise((done) => {
      const seconds = Math.min(Math.max(timeout, 1), MAX_TIMEOUT_S);
      // detached: the command gets its own process group, so a timeout kills
      // the whole tree, not just the shell. The child inherits this process's
      // environment on purpose: anything the server puts in process.env for
      // the run (credentials, a per-user token) is reachable from scripts.
      const child = spawn("bash", ["-lc", command], {
        cwd: WORKSPACE,
        env: { ...process.env, HOME: WORKSPACE },
        detached: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (d: Buffer) => (stdout += d));
      child.stderr.on("data", (d: Buffer) => (stderr += d));

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, seconds * 1000);

      child.on("error", (e) => {
        clearTimeout(timer);
        done(errorResult(e, "check the command and try again"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exit_code: code ?? -1,
          ...(timedOut && {
            timed_out: true,
            hint: `killed after ${seconds}s; raise timeout or do less per call`,
          }),
        });
      });
    }),
});

export const TOOLS = [readFile, writeFile, editFile, bash];
