// JSON-line stdout writer. One event per line:
//   {"event": ..., "ts": ..., ...fields}
// `ts` is unix epoch seconds (fractional).
export function emit(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ts: Date.now() / 1000, ...fields });
  process.stdout.write(line + '\n');
}
