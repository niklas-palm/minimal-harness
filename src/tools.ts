// The 14 base tools available to every agent.
//
// Every tool wraps its body in try/catch and returns {error, hint} on
// failure — never throws. The agent reads the hint and adapts.
//
// Tool names use snake_case and parameter names match what the model
// is trained to emit (read_file, old_text, etc.) — that surface is
// load-bearing for the prompt and shouldn't be camelCased.

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname, extname, join, resolve as pathResolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import fastGlob from 'fast-glob';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape';
import { tool as strandsTool } from '@strands-agents/sdk';
import { z } from 'zod';

import { REGION, WORKSPACE_DIR as WORKSPACE } from './config.js';

// Tool bodies return discriminated `{success,...}|{error,hint}` shapes that
// TS infers with implicit `?: undefined` keys, which Strands' JSONValue
// rejects. The runtime serialisation handles undefined fields fine; this
// thin re-typing of `tool()` widens the callback return so every tool can
// keep its idiomatic union return type without per-call casting. Inputs
// stay typed via the Zod schema — only the return is loosened.

type ToolFactory = <S extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  inputSchema: S;

  callback: (input: z.infer<S>, ctx?: any) => any;
}) => unknown;
const tool = strandsTool as unknown as ToolFactory;

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp',
};

// --- helpers ----------------------------------------------------------------

function safePath(rel: string | null | undefined): string {
  const p = pathResolve(WORKSPACE, rel ?? '');
  if (p !== WORKSPACE && !p.startsWith(WORKSPACE + '/')) {
    throw new Error(`path traversal not allowed; stay inside ${WORKSPACE}`);
  }
  return p;
}

function isBinary(path: string, sample = 8192): boolean {
  try {
    const buf = Buffer.alloc(sample);
    const fd = openSync(path, 'r');
    let read = 0;
    try {
      read = readSync(fd, buf, 0, sample, 0);
    } finally {
      closeSync(fd);
    }
    if (read === 0) return false;
    const chunk = buf.subarray(0, read);
    if (chunk.includes(0)) return true;
    const textChars = new Set([7, 8, 9, 10, 12, 13, 27]);
    let nonText = 0;
    for (const b of chunk) {
      if (!(textChars.has(b) || (b >= 0x20 && b < 0x100))) nonText++;
    }
    return nonText / read > 0.3;
  } catch {
    return true;
  }
}

function sizeMb(n: number): number {
  return Math.round((n / (1024 * 1024)) * 100) / 100;
}

// Spawn helper that captures stdout/stderr, supports timeout via SIGKILL on
// the whole process group (Linux), and resolves with code/stdout/stderr.
function runChild(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? WORKSPACE,
      env: opts.env ?? { ...process.env, HOME: WORKSPACE },
      shell: opts.shell ?? false,
      detached: true, // own process group, so we can kill the whole tree
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }, opts.timeoutMs);
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      stderr += '\n' + (err instanceof Error ? err.message : String(err));
      resolveP({ code: -1, stdout, stderr, timedOut });
    });
  });
}

// --- tools ------------------------------------------------------------------

const readFile = tool({
  name: 'read_file',
  description: `Read file contents from the workspace.

Returns content with 1-indexed line numbers (cat -n format).
Default: reads up to 2000 lines from start. Lines >2000 chars are truncated.

DO NOT use on directories - use list_directory() instead.
For CSV, JSON, or Excel files - use preview_data() instead.
For text/code files larger than 5MB - use preview_file() instead.`,
  inputSchema: z.object({
    path: z.string().describe('Relative path to the file.'),
    offset: z.number().int().optional().describe('Line number to start reading from (1-indexed).'),
    limit: z.number().int().optional().describe('Number of lines to read.'),
  }),
  callback: ({ path, offset, limit }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp)) {
        return { error: `file not found: ${path}`, hint: 'use list_directory to explore' };
      }
      const stat = statSync(fp);
      if (stat.isDirectory()) {
        return { error: `path is a directory: ${path}`, hint: 'use list_directory()' };
      }
      if (stat.size > MAX_FILE_SIZE) {
        return {
          error: `file too large (${sizeMb(stat.size)} MB)`,
          hint: 'use preview_file or preview_data',
        };
      }
      if (isBinary(fp)) {
        return { error: 'binary or non-UTF-8 file', hint: 'use preview_file or view_image' };
      }
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      const total = lines.length;
      const start = offset && offset >= 1 ? offset - 1 : 0;
      const end = start + (limit ?? 2000);
      const selected = lines.slice(start, end);
      const width = String(start + selected.length).length;
      const numbered = selected
        .map((ln, i) => `${String(start + i + 1).padStart(width, ' ')}\t${ln.slice(0, 2000)}`)
        .join('\n');
      return {
        content: numbered,
        total_lines: total,
        returned_lines: selected.length,
        start_line: start + 1,
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check the path and try again',
      };
    }
  },
});

const writeFile = tool({
  name: 'write_file',
  description: `Write content to a new file. Creates parent directories as needed.

USE ONLY FOR NEW FILES. For files that already exist, use edit_file().
write_file() on an existing file OVERWRITES it entirely - data loss risk.

DO NOT create documentation files (*.md, README, etc.) unless asked.`,
  inputSchema: z.object({
    path: z.string().describe('Relative path for the new file.'),
    content: z.string().describe('Complete file content to write.'),
  }),
  callback: ({ path, content }) => {
    try {
      const fp = safePath(path);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content);
      return { success: true, path, bytes_written: Buffer.byteLength(content, 'utf8') };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check the path is valid and writable',
      };
    }
  },
});

const editFile = tool({
  name: 'edit_file',
  description: `Edit a file by replacing an exact string match.

You MUST read the file with read_file() before calling this tool.

UNIQUENESS REQUIREMENT (default mode):
    old_text must appear EXACTLY ONCE in the file. Set replace_all=True to
    replace every occurrence (useful for renames).

WHITESPACE SENSITIVITY:
    Indentation must match exactly. Copy old_text verbatim from read_file output.

new_text must differ from old_text.`,
  inputSchema: z.object({
    path: z.string().describe('Relative path to the file.'),
    old_text: z.string().describe('Exact text to find. Unique unless replace_all=True.'),
    new_text: z.string().describe('Replacement text. Must differ from old_text.'),
    replace_all: z
      .boolean()
      .optional()
      .describe('If True, replaces every occurrence (no uniqueness check).'),
  }),
  callback: ({ path, old_text, new_text, replace_all }) => {
    try {
      if (old_text === new_text) {
        return { error: 'old_text and new_text are identical', hint: 'no-op edit rejected' };
      }
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return {
          error: `file not found: ${path}`,
          hint: 'create it with write_file or check the path',
        };
      }
      if (isBinary(fp)) {
        return { error: 'binary or non-UTF-8 file', hint: 'edit_file only works on text files' };
      }
      const content = readFileSync(fp, 'utf8');
      const count = content.split(old_text).length - 1;
      if (count === 0) {
        return {
          error: 'old_text not found in file',
          searched_for: old_text.slice(0, 200) + (old_text.length > 200 ? '...' : ''),
          hint: 'check whitespace and quoting; copy text verbatim from read_file output',
        };
      }
      if (!replace_all && count > 1) {
        return {
          error: `old_text matches ${count} locations - must be unique`,
          occurrences: count,
          hint: 'add surrounding context to make old_text unique, or set replace_all=True',
        };
      }
      const newContent = replace_all
        ? content.split(old_text).join(new_text)
        : content.replace(old_text, new_text);
      writeFileSync(fp, newContent);
      return { success: true, path, replacements: replace_all ? count : 1 };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check the path and try again',
      };
    }
  },
});

const multiEdit = tool({
  name: 'multi_edit',
  description: `Apply multiple edits to a single file in one call.

Edits are applied SEQUENTIALLY - each operates on the result of the previous one.
The file is written only if every edit succeeds, so a failure leaves the
file untouched.

You MUST read the file with read_file() before calling this tool.`,
  inputSchema: z.object({
    path: z.string().describe('Relative path to the file.'),
    edits: z
      .array(z.object({ old_text: z.string(), new_text: z.string() }))
      .describe('List of {"old_text": "...", "new_text": "..."} objects.'),
  }),
  callback: ({ path, edits }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return { error: `file not found: ${path}`, hint: 'check the path' };
      }
      if (isBinary(fp)) {
        return { error: 'binary or non-UTF-8 file', hint: 'multi_edit only works on text files' };
      }
      let content = readFileSync(fp, 'utf8');
      for (let i = 0; i < edits.length; i++) {
        const { old_text, new_text } = edits[i]!;
        if (old_text === new_text) {
          return { error: `edit ${i}: old_text and new_text are identical` };
        }
        const count = content.split(old_text).length - 1;
        if (count === 0) {
          return {
            error: `edit ${i}: old_text not found`,
            hint: 'check whitespace; earlier edits may have changed the text',
          };
        }
        if (count > 1) {
          return {
            error: `edit ${i}: matches ${count} locations`,
            hint: 'add more context to make old_text unique',
          };
        }
        content = content.replace(old_text, new_text);
      }
      writeFileSync(fp, content);
      return { success: true, path, edits_applied: edits.length };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check the path and try again',
      };
    }
  },
});

const listDirectory = tool({
  name: 'list_directory',
  description: `List files and directories at a path in the workspace.

For finding files matching a name pattern, use glob_files() instead.
For searching file contents, use grep_search() instead.`,
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe('Directory path relative to workspace root. Omit to list workspace root.'),
  }),
  callback: ({ path }) => {
    try {
      const target = safePath(path);
      if (!existsSync(target)) {
        return { error: `directory not found: ${path}`, hint: 'create it or check the path' };
      }
      if (!statSync(target).isDirectory()) {
        return { error: `not a directory: ${path}`, hint: 'use read_file() for files' };
      }
      const entries = readdirSync(target).map((name) => {
        const full = join(target, name);
        const st = statSync(full);
        const entry: Record<string, unknown> = {
          name,
          type: st.isDirectory() ? 'directory' : 'file',
        };
        if (st.isFile()) {
          entry.size = st.size;
          entry.extension = extname(name).toLowerCase();
          entry.is_binary = isBinary(full);
        }
        return entry;
      });
      entries.sort((a, b) => {
        const aIsFile = a.type === 'file' ? 1 : 0;
        const bIsFile = b.type === 'file' ? 1 : 0;
        if (aIsFile !== bIsFile) return aIsFile - bIsFile;
        return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
      });
      return { path: path ?? '.', entries };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), hint: 'check the path' };
    }
  },
});

const globFiles = tool({
  name: 'glob_files',
  description: `Find files by name pattern using glob syntax.

Results are sorted by modification time, most recently modified first.
For searching file contents, use grep_search() instead.`,
  inputSchema: z.object({
    pattern: z
      .string()
      .describe('Glob pattern. Examples: "**/*.py", "src/**/*.{ts,tsx}", "*.config.js".'),
    path: z.string().optional().describe('Base directory to search from. Omit for workspace root.'),
  }),
  callback: async ({ pattern, path }) => {
    try {
      const base = safePath(path);
      const matches = await fastGlob(pattern, {
        cwd: base,
        onlyFiles: true,
        dot: false,
        absolute: true,
      });
      const withMtime = matches.map((m) => ({ p: m, mtime: statSync(m).mtimeMs }));
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const rel = withMtime.map(({ p }) => relative(WORKSPACE, p));
      return { pattern, files: rel, count: rel.length };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check the pattern and path',
      };
    }
  },
});

const previewFile = tool({
  name: 'preview_file',
  description: `Preview a large text or code file by reading its head and tail.

Use this INSTEAD OF read_file() for files larger than 5MB or when you only need
to understand structure.`,
  inputSchema: z.object({
    path: z.string().describe('Path to the file.'),
    head_lines: z
      .number()
      .int()
      .optional()
      .describe('Lines to return from the start (default 50).'),
    tail_lines: z.number().int().optional().describe('Lines to return from the end (default 50).'),
  }),
  callback: ({ path, head_lines = 50, tail_lines = 50 }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return { error: `file not found: ${path}` };
      }
      const size = statSync(fp).size;
      const info = {
        path,
        file_size_bytes: size,
        file_size_mb: sizeMb(size),
        extension: extname(fp).toLowerCase(),
      };
      if (isBinary(fp)) {
        return {
          ...info,
          is_binary: true,
          error: 'file appears to be binary',
          hint: 'binary files cannot be previewed as text',
        };
      }
      const text = readFileSync(fp, 'utf8');
      const lines = text.split('\n');
      const total = lines.length;
      if (head_lines + tail_lines >= total) {
        return { ...info, total_lines: total, is_truncated: false, content: lines.join('\n') };
      }
      const head = lines.slice(0, head_lines);
      const tail = lines.slice(total - tail_lines);
      const omitted = total - tail_lines - head_lines;
      return {
        ...info,
        total_lines: total,
        is_truncated: true,
        head_lines_count: head.length,
        tail_lines_count: tail.length,
        omitted_lines: omitted,
        head: head.join('\n'),
        tail: tail.join('\n'),
        hint: `lines ${head_lines + 1} to ${total - tail_lines} omitted`,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), path };
    }
  },
});

const previewData = tool({
  name: 'preview_data',
  description: `Preview the first N rows of a structured data file (CSV, JSON, Excel, Parquet).

Use this INSTEAD OF read_file() for any data file.`,
  inputSchema: z.object({
    path: z.string().describe('Path to the data file (typically under uploads/).'),
    rows: z.number().int().optional().describe('Number of rows to preview (default 100).'),
  }),
  callback: async ({ path, rows = 100 }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return { error: `file not found: ${path}` };
      }
      const ext = extname(fp).toLowerCase();
      const size = statSync(fp).size;

      if (ext === '.csv') {
        const text = readFileSync(fp, 'utf8');
        // Minimal CSV: split on newline, then on comma. Handles unquoted fields
        // fine for previewing — for quoted CSVs the agent should use run_python.
        const allLines = text.replace(/\n$/, '').split('\n');
        const previewLines = allLines.slice(0, rows + 1);
        const parseRow = (line: string) => line.split(',');
        const preview = previewLines.map(parseRow);
        const columns = preview[0] ?? [];
        const data = preview.slice(1);
        return {
          type: 'csv',
          file_size_mb: sizeMb(size),
          total_rows: allLines.length - 1,
          columns,
          column_count: columns.length,
          preview_rows: data.length,
          data,
        };
      }

      if (ext === '.json') {
        const data = JSON.parse(readFileSync(fp, 'utf8'));
        if (Array.isArray(data)) {
          return {
            type: 'json_array',
            file_size_mb: sizeMb(size),
            total_items: data.length,
            preview_items: Math.min(rows, data.length),
            data: data.slice(0, rows),
          };
        }
        const keys = Object.keys(data ?? {});
        const preview: Record<string, string> = {};
        for (const k of keys.slice(0, 20)) {
          preview[k] = String((data as Record<string, unknown>)[k]).slice(0, 200);
        }
        return {
          type: 'json_object',
          file_size_mb: sizeMb(size),
          keys,
          key_count: keys.length,
          preview,
        };
      }

      if (ext === '.xlsx' || ext === '.xls' || ext === '.parquet') {
        // Shell to python (openpyxl/pyarrow are pre-installed in the image).
        // Keeps this file from pulling in two heavyweight npm libs.
        const pyCode = `
import json, sys
from pathlib import Path
fp = Path(${JSON.stringify(fp)})
ext = fp.suffix.lower()
rows = ${rows}
if ext in ('.xlsx', '.xls'):
    from openpyxl import load_workbook
    wb = load_workbook(fp, read_only=True, data_only=True)
    sheet = wb.active
    preview = []
    for i, row in enumerate(sheet.iter_rows(values_only=True)):
        if i >= rows + 1: break
        preview.append([None if v is None else str(v) if not isinstance(v, (int, float, bool)) else v for v in row])
    columns = preview[0] if preview else []
    data = preview[1:] if len(preview) > 1 else []
    print(json.dumps({"type": "excel", "sheet_name": sheet.title, "columns": columns, "column_count": len(columns), "preview_rows": len(data), "data": data}))
elif ext == '.parquet':
    import pyarrow.parquet as pq
    table = pq.read_table(fp)
    columns = table.column_names
    head = table.slice(0, rows).to_pylist()
    data = [[None if row.get(c) is None else str(row[c]) for c in columns] for row in head]
    print(json.dumps({"type": "parquet", "total_rows": table.num_rows, "columns": columns, "column_count": len(columns), "preview_rows": len(data), "data": data}))
`;
        const r = await runChild('python3', ['-c', pyCode], { timeoutMs: 60_000 });
        if (r.code !== 0) {
          return {
            error: r.stderr || `python3 exited ${r.code}`,
            hint: 'preview_data requires python3 with openpyxl/pyarrow',
          };
        }
        try {
          const parsed = JSON.parse(r.stdout);
          return { ...parsed, file_size_mb: sizeMb(size) };
        } catch {
          return { error: 'failed to parse python output', stderr: r.stderr };
        }
      }

      return {
        error: `unsupported file type: ${ext}`,
        hint: 'supported: .csv, .json, .xlsx, .xls, .parquet',
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), path };
    }
  },
});

const grepSearch = tool({
  name: 'grep_search',
  description: `Search file contents using regex (ripgrep). Fast at any codebase size.

ALWAYS use grep_search for content searches. Never call rg/grep via run_bash.

Output modes:
    "files_with_matches" - file paths only (default, cheapest - use first to scope)
    "content"            - matching lines with surrounding context
    "count"              - match count per file`,
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern.'),
    path: z
      .string()
      .optional()
      .describe('File or directory to search (defaults to workspace root).'),
    output_mode: z
      .enum(['files_with_matches', 'content', 'count'])
      .optional()
      .describe('"files_with_matches" | "content" | "count".'),
    context: z
      .number()
      .int()
      .optional()
      .describe('Lines of context before AND after each match (only with output_mode="content").'),
    ignore_case: z.boolean().optional().describe('Case-insensitive matching.'),
    file_type: z
      .string()
      .optional()
      .describe('Restrict to a file extension: "py", "ts", "tsx", "js", "json".'),
    include_glob: z
      .string()
      .optional()
      .describe('Restrict to files matching a glob: "*.tsx", "src/**/*.py".'),
    head_limit: z.number().int().optional().describe('Limit output to first N entries.'),
    multiline: z
      .boolean()
      .optional()
      .describe('Enable multiline mode (. matches newlines, patterns can span lines).'),
  }),
  callback: async ({
    pattern,
    path,
    output_mode = 'files_with_matches',
    context,
    ignore_case,
    file_type,
    include_glob,
    head_limit,
    multiline,
  }) => {
    try {
      const searchPath = safePath(path);
      const args: string[] = ['--no-heading', '-n'];
      if (ignore_case) args.push('-i');
      if (multiline) args.push('--multiline', '--multiline-dotall');
      if (output_mode === 'files_with_matches') args.push('-l');
      else if (output_mode === 'count') args.push('-c');
      if (context && output_mode === 'content') args.push('-C', String(context));
      if (include_glob) args.push('-g', include_glob);
      else if (file_type) args.push('-g', `*.${file_type}`);
      args.push(pattern, searchPath);

      const r = await runChild('rg', args, { timeoutMs: 30_000 });
      if (r.timedOut) {
        return {
          error: 'grep timed out after 30s',
          pattern,
          hint: 'narrow the search with path/include_glob',
        };
      }
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error
      if (r.code === 2) {
        return { error: r.stderr || 'rg error', pattern };
      }
      let output = r.stdout.replaceAll(WORKSPACE + '/', '');
      let truncated = false;
      if (head_limit && output.trim()) {
        const lines = output.split('\n');
        if (lines.length > head_limit) {
          output = lines.slice(0, head_limit).join('\n');
          truncated = true;
        }
      }
      const response: Record<string, unknown> = {
        pattern,
        matches: output,
        match_count: output.trim() ? output.trim().split('\n').length : 0,
        returncode: r.code,
        truncated,
      };
      if (r.stderr.trim()) response.warnings = r.stderr;
      return response;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), pattern };
    }
  },
});

const runBash = tool({
  name: 'run_bash',
  description: `Execute a bash command in the workspace.

DO NOT use run_bash for:
    - Reading files          -> read_file
    - Editing files          -> edit_file
    - Writing files          -> write_file
    - Finding files by name  -> glob_files
    - Searching file content -> grep_search

USE run_bash for:
    - Package management:    npm install, pip install
    - Build & type-check:    npm run build, tsc --noEmit
    - Tests:                 npm test, pytest, vitest
    - Chained operations:    npm install && npm run build`,
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute.'),
    timeout: z.number().int().optional().describe('Max seconds to wait (default 30, max 300).'),
  }),
  callback: async ({ command, timeout = 30 }) => {
    try {
      const t = Math.min(Math.max(timeout, 1), 300);
      const r = await runChild('bash', ['-lc', command], { timeoutMs: t * 1000 });
      const response: Record<string, unknown> = {
        command,
        stdout: r.stdout,
        stderr: r.stderr,
        returncode: r.code,
        success: r.code === 0,
      };
      if (r.timedOut) {
        response.success = false;
        response.returncode = -1;
        response.error_summary = `timed out after ${t}s`;
        response.timeout = true;
      } else if (r.code !== 0) {
        const summary = (r.stderr.trim() || `exit code ${r.code}`).slice(0, 500);
        response.error_summary = summary;
      }
      return response;
    } catch (e) {
      return { command, success: false, error_summary: e instanceof Error ? e.message : String(e) };
    }
  },
});

const runPython = tool({
  name: 'run_python',
  description: `Execute Python code for data analysis, processing, or visualisation.

Pre-installed: boto3, httpx, pdfplumber, openpyxl, pyarrow.
Use print() to surface results. Use boto3 for read-only AWS calls.`,
  inputSchema: z.object({
    code: z
      .string()
      .describe('Complete Python code. Must be self-contained - no state persists between calls.'),
    timeout: z.number().int().optional().describe('Max seconds to wait (default 60).'),
  }),
  callback: async ({ code, timeout = 60 }) => {
    const scriptsDir = join(WORKSPACE, '.tmp');
    let scriptPath: string | null = null;
    try {
      mkdirSync(scriptsDir, { recursive: true });
      scriptPath = join(scriptsDir, `_run_${randomUUID().replace(/-/g, '').slice(0, 8)}.py`);
      writeFileSync(scriptPath, code);
      const t = Math.min(Math.max(timeout, 1), 300);
      const r = await runChild('python3', [scriptPath], { timeoutMs: t * 1000 });
      if (r.timedOut) {
        return { success: false, error_summary: `python timed out after ${t}s`, timeout: true };
      }
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        returncode: r.code,
        success: r.code === 0,
      };
    } catch (e) {
      return { success: false, error_summary: e instanceof Error ? e.message : String(e) };
    } finally {
      if (scriptPath) {
        try {
          unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
      }
    }
  },
});

const viewImage = tool({
  name: 'view_image',
  description: `Analyse an image file and answer a specific question about it.`,
  inputSchema: z.object({
    path: z.string().describe('Path to the image file.'),
    question: z.string().describe('Precise question about the image.'),
  }),
  callback: async ({ path, question }) => {
    try {
      const fp = safePath(path);
      if (!existsSync(fp) || !statSync(fp).isFile()) {
        return { error: `file not found: ${path}` };
      }
      const ext = extname(fp).toLowerCase();
      const format = SUPPORTED_IMAGE_TYPES[ext];
      if (!format) {
        return {
          error: `unsupported image type: ${ext}`,
          hint: `supported: ${Object.keys(SUPPORTED_IMAGE_TYPES).join(',')}`,
        };
      }
      const size = statSync(fp).size;
      if (size > MAX_FILE_SIZE) {
        return { error: `image too large (${sizeMb(size)} MB)`, hint: 'max 5MB' };
      }
      const bedrock = new BedrockRuntimeClient({ region: REGION });
      const bytes = readFileSync(fp);
      const cmd = new ConverseCommand({
        modelId: 'global.amazon.nova-2-lite-v1:0',
        messages: [
          {
            role: 'user',
            content: [
              { image: { format: format as 'jpeg' | 'png' | 'gif' | 'webp', source: { bytes } } },
              { text: question },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
      });
      const response = await bedrock.send(cmd);
      const blocks = response.output?.message?.content ?? [];
      for (const block of blocks) {
        if ('text' in block && block.text) return { answer: block.text };
      }
      return {
        error: 'no text in vision response',
        hint: 'the model returned an unexpected shape',
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        hint: 'check AWS credentials and model access',
      };
    }
  },
});

const webSearch = tool({
  name: 'web_search',
  description: `Search the web using DuckDuckGo.`,
  inputSchema: z.object({
    query: z.string().describe('Short, specific query (1-6 words).'),
    max_results: z.number().int().optional().describe('Maximum results to return (default 5).'),
  }),
  callback: async ({ query, max_results = 5 }) => {
    try {
      const r = await ddgSearch(query, { safeSearch: SafeSearchType.MODERATE });
      if (r.noResults || !r.results.length) return { query, results: [] };
      const formatted = r.results.slice(0, max_results).map((it) => ({
        title: it.title ?? '',
        url: it.url ?? '',
        snippet: it.description ?? '',
      }));
      return { query, results: formatted };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), query };
    }
  },
});

const webFetch = tool({
  name: 'web_fetch',
  description: `Fetch a webpage and return its content as clean markdown.`,
  inputSchema: z.object({
    url: z.string().describe('The URL to fetch.'),
  }),
  callback: async ({ url }) => {
    try {
      const resp = await fetch(`https://r.jina.ai/${url}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 422)
        return { error: `unable to fetch ${url}`, hint: 'may be paywalled or blocked' };
      if (resp.status >= 400) return { error: `http ${resp.status}`, url };
      let content = await resp.text();
      if (content.trim().length < 100) return { error: 'no meaningful content', url };
      let truncated = false;
      if (content.length > 20_000) {
        content = content.slice(0, 20_000);
        truncated = true;
      }
      return { url, content, truncated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('aborted')) {
        return { error: 'fetch timed out', url };
      }
      return { error: msg, url };
    }
  },
});

export const ALL_TOOLS = [
  readFile,
  writeFile,
  editFile,
  multiEdit,
  listDirectory,
  globFiles,
  previewData,
  previewFile,
  grepSearch,
  runBash,
  runPython,
  viewImage,
  webSearch,
  webFetch,
];
