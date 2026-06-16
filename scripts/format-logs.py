#!/usr/bin/env python3
"""Pretty-print the agent's JSON-line logs from `aws logs tail`.

Reads `aws logs tail` output on stdin and renders each event on a readable
line. Non-JSON lines (and anything we don't recognise) are passed through
untouched, so nothing is ever hidden.

Usage:  aws logs tail <group> --follow | python3 scripts/format-logs.py
"""
import json
import sys

# event -> (symbol, how to summarise the payload)
def _summary(event: str, d: dict) -> str:
    if event == "session_start":
        return f"model {d.get('model_id', '?')}"
    if event == "tool_input":
        name = d.get("name", "?")
        args = json.dumps(d.get("input", {}), ensure_ascii=False)
        return f"{name}  {args[:120]}"
    if event == "tool_result":
        return str(d.get("result", ""))[:120]
    if event in ("text", "session_end"):
        return d.get("content") or d.get("answer") or ""
    if event in ("error", "stream_error"):
        return d.get("error", "")
    return json.dumps({k: v for k, v in d.items() if k not in ("event", "ts")}, ensure_ascii=False)


SYMBOL = {
    "session_start": "▶",
    "tool_input": "→",
    "tool_result": "←",
    "text": "💬",
    "session_end": "✓",
    "error": "✗",
    "stream_error": "✗",
}


def main() -> None:
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        brace = line.find("{")
        if brace == -1:
            print(line)
            continue
        try:
            d = json.loads(line[brace:])
        except json.JSONDecodeError:
            print(line)
            continue
        event = d.get("event")
        if not event:
            print(line)
            continue
        sym = SYMBOL.get(event, "·")
        sid = str(d.get("session_id", ""))[:8]
        text = _summary(event, d)
        print(f"{sym} {event:<14} [{sid}] {text}")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
