#!/usr/bin/env python3
"""Pretty-print the agent's JSON-line logs from `aws logs tail`.

Reads `aws logs tail` output on stdin and renders each event on a readable
line. Non-JSON lines (and anything we don't recognise) are passed through
untouched, so nothing is ever hidden.

Two modes:
  (default)  buffer to EOF, then print events grouped by session id, so
             concurrent runs don't interleave. Best for a finite window.
  --stream   print each line as it arrives, ungrouped. Use with --follow,
             where events are unbounded and arrive over time.

Usage:
  aws logs tail <group> --since 30m            | python3 format-logs.py
  aws logs tail <group> --since 30m --follow   | python3 format-logs.py --stream
"""
import json
import sys

SYMBOL = {
    "session_start": "▶",
    "tool_input": "→",
    "tool_result": "←",
    "text": "💬",
    "session_end": "✓",
    "error": "✗",
    "stream_error": "✗",
}


def _summary(event: str, d: dict) -> str:
    if event == "session_start":
        return f"model {d.get('model_id', '?')}"
    if event == "tool_input":
        args = json.dumps(d.get("input", {}), ensure_ascii=False)
        return f"{d.get('name', '?')}  {args[:120]}"
    if event == "tool_result":
        return str(d.get("result", ""))[:120]
    if event in ("text", "session_end"):
        return d.get("content") or d.get("answer") or ""
    if event in ("error", "stream_error"):
        return d.get("error", "")
    return json.dumps({k: v for k, v in d.items() if k not in ("event", "ts")}, ensure_ascii=False)


def _parse(line: str):
    """Return the event dict for a log line, or None if it's not our JSON."""
    brace = line.find("{")
    if brace == -1:
        return None
    try:
        d = json.loads(line[brace:])
    except json.JSONDecodeError:
        return None
    return d if d.get("event") else None


def _fmt(d: dict) -> str:
    event = d["event"]
    sym = SYMBOL.get(event, "·")
    return f"  {sym} {event:<14} {_summary(event, d)}"


def stream() -> None:
    for raw in iter(sys.stdin.readline, ""):
        line = raw.rstrip("\n")
        d = _parse(line)
        if d is None:
            print(line, flush=True)
            continue
        sid = str(d.get("session_id", ""))[:8]
        print(f"{SYMBOL.get(d['event'], '·')} {d['event']:<14} [{sid}] {_summary(d['event'], d)}", flush=True)


def grouped() -> None:
    # session id -> list of event dicts, preserving first-seen order.
    sessions: dict[str, list[dict]] = {}
    order: list[str] = []
    passthrough: list[str] = []
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        d = _parse(line)
        if d is None:
            if line.strip():
                passthrough.append(line)
            continue
        sid = str(d.get("session_id", "unknown"))
        if sid not in sessions:
            sessions[sid] = []
            order.append(sid)
        sessions[sid].append(d)

    for sid in order:
        print(f"\n── session {sid[:8]} ──")
        for d in sessions[sid]:
            print(_fmt(d))
    if passthrough:
        print("\n── other log lines ──")
        for line in passthrough:
            print(f"  {line}")


if __name__ == "__main__":
    try:
        (stream if "--stream" in sys.argv[1:] else grouped)()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
