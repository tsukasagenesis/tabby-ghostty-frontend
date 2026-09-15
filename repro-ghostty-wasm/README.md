# ghostty-web: `memory access out of bounds` on replayed input

## Reproduce

```sh
python3 -m http.server 8080 --directory .
# open http://127.0.0.1:8080/
```

The page writes `repro.txt` (53.5 KB of real `journalctl` output) into a
125x42 terminal **twice**, in 64 KB chunks. Pass 1 completes; pass 2 throws:

```
RuntimeError: memory access out of bounds
  at wasm://wasm/…:wasm-function[162]
```

After this the engine is unusable: every later `write()` throws, and
`renderCellText` reads back codepoints outside Unicode
(`RangeError: Invalid code point 1924376` = `0x1D5A18`), painting stray colour
blocks where text should be.

## It is specific to replaying the same bytes

Same engine, same sizes, one fresh terminal per case:

| input | result |
|---|---|
| `repro.txt` once | ok |
| **`repro.txt` twice** | **FAULT** |
| `repro.txt`, then the next 53.5 KB of the log | ok |
| `repro.txt`, then the first 53.5 KB of the log | ok |
| a different 53.5 KB slice, twice | ok |
| `repro.txt`, then its own first half | ok |

So it is neither volume nor repetition in general: it needs *these* bytes,
*in full*, *twice*.

## Not explained by any of these

Each tested against the same build, fresh engine, and found clean:

| hypothesis | test | result |
|---|---|---|
| large single writes | 4 KB … 2 MB single `write()` | clean |
| sustained volume | 900 MB synthetic | clean |
| malformed UTF-8 | lone/split surrogates, 7 cases | clean |
| complex scripts | 300 MB each of Thai, Devanagari, Arabic | clean |
| grapheme-cluster variety | 2,599,974 distinct clusters, 300 MB | clean |
| long/wrapped lines | 75, 117, 341, 985-char lines, 120 MB each | clean |
| scrollback size | 400 MB at 25000 and at 1000 | clean |
| split mid-escape-sequence | cut inside CSI, OSC, lone ESC | clean |
| resize during streaming | 200 resizes while writing | clean |

## Content

`repro.txt` is ordinary `journalctl` output: KDE file-copy log lines whose
paths contain Thai script. 16–23% non-ASCII, 426 combining marks, longest line
357 chars, no NUL bytes, no control bytes, no escape sequences.

## Environment

ghostty-web 0.4.0, Chromium 152 (headless and headful), Linux x86_64.
Also reproduces inside Electron 42 (Chrome 148).
