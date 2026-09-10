---
name: ascii-banner
description: Render a short piece of text as a large ASCII-art banner. Load this when the user asks for a banner, a big text header, or "ASCII art" of a word or short phrase.
---

# Skill - ASCII banner

A tiny, self-contained illustration of a skill. When the user wants a word or
short phrase rendered as a big ASCII-art banner, follow the steps below.

## How to do it

The runtime has Python available via `bash` (`python3`). Use the `pyfiglet`-free
approach below - it depends on nothing beyond the standard library, so it
works in the sandbox without installing anything.

1. Keep the text short (one or two words). Long input makes an unreadable banner.
2. Write the following to a file and run it with `bash` (`python3 banner.py`), substituting the text:

```python
# A minimal 5-row block font covering A-Z, 0-9 and space.
text = "HELLO"  # <- the user's text, uppercased

FONT = {
    "A": ["  ▄  ", " ▄ ▄ ", "▄▄▄▄▄", "▄   ▄", "▄   ▄"],
    "H": ["▄   ▄", "▄   ▄", "▄▄▄▄▄", "▄   ▄", "▄   ▄"],
    "E": ["▄▄▄▄▄", "▄    ", "▄▄▄▄ ", "▄    ", "▄▄▄▄▄"],
    "L": ["▄    ", "▄    ", "▄    ", "▄    ", "▄▄▄▄▄"],
    "O": ["▄▄▄▄▄", "▄   ▄", "▄   ▄", "▄   ▄", "▄▄▄▄▄"],
    " ": ["     ", "     ", "     ", "     ", "     "],
}

rows = ["", "", "", "", ""]
for ch in text.upper():
    glyph = FONT.get(ch, FONT[" "])
    for i in range(5):
        rows[i] += glyph[i] + "  "
print("\n".join(rows))
```

3. If the text contains letters not in the font above, extend the `FONT`
   dict with the missing glyphs (each is a list of 5 equal-width strings)
   before running, or tell the user which characters you can't render.
4. Return the banner to the user inside a fenced code block so the alignment
   is preserved.

That's it - this skill is here purely to show the mechanics: a folder with a
SKILL.md under `skills/` is discovered automatically and offered to the agent,
which loads these instructions on demand when the task calls for them.
