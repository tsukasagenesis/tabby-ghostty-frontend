# The frozen-tab WASM fault

## Symptom

A terminal tab freezes mid-stream, showing a band of corrupted colour blocks
where text should be. Everything else keeps running:

```
renderer thread        alive  (rAF ticking at 138 fps)
canvas draw ops in 2s  0      <- nothing painted at all
journalctl             95% CPU, still producing
tabby main / renderer  85.8% / 81% CPU
perf snapshot          stale, stopped being written
```

The renderer console, repeating on every write:

```
RuntimeError: memory access out of bounds
  at wasm://wasm/0019d216:wasm-function[163]:0xf8b0
RangeError: Invalid code point 1924376 at renderCellText
```

`1924376` is `0x1D5A18` — far outside valid Unicode (max `0x10FFFF`). The engine
is reading back corrupted cell data, so the WASM heap is already damaged by the
time anything is drawn.

Once damaged, every later `write()` throws. `GhosttyFrontend` caught and logged
those throws but carried on, so the tab sat frozen with a garbled last frame and
no indication anything was wrong.

## Hypotheses tested and refuted

Each was run against the same `ghostty-web` build in headless Chromium.

| hypothesis | test | result |
|---|---|---|
| Large single writes | 4 KB, 64 KB, 256 KB, 512 KB, 1 MB, 2 MB single `write()` calls | **0/6 faulted** — 2 MB writes are fine |
| Sustained volume | 900 MB through one engine, scrollback 25000 | **no fault** (the frozen tab had processed 879 MB) |
| Malformed UTF-8 | Thai/CJK bulk, lone high surrogate, lone low surrogate, both halves of a split surrogate pair, unpaired-surrogate bulk, 300 KB unbroken line | **0/7 faulted** |

The size hypothesis was the original reason for the 64 KB write cap. Since it is
refuted, that cap is **defensive hardening, not a fix** — it should not be
described as one.

## Hypothesis 4, also refuted: the render patch

The render patch wraps `render()` so `getLine()` is served from a single
`getViewport()` slice instead of one `getLine()` per row. Because the symptom is
a render-side read of corrupted cells, and this is the only thing in the user's
session reading cells differently from stock, it was the last suspect.

A first attempt looked clean but proved nothing: 400 MB streamed without fault,
yet it logged `fast 2 / bail 0` — `render()` ran only twice, because the write
loop yielded to rAF once every 32 MB.

Re-run yielding on **every** iteration so the render loop actually runs:

```
streamed  : 120.1 MB in 34.3 s   (Thai/CJK journalctl-shaped lines)
frames    : fast 1921 / bail 0
renderErrs: none
RESULT    : no fault
```

1921 patched render calls against a live engine, no fault.

## All four hypotheses refuted — what that means

| hypothesis | verdict |
|---|---|
| Large single writes | refuted (2 MB clean) |
| Sustained volume | refuted (900 MB clean) |
| Malformed UTF-8 | refuted (7/7 clean) |
| Render patch | refuted (1921 frames clean) |

There is no remaining theory. Every mechanism reproducible in headless Chromium
behaves correctly, which points at what the harness *cannot* reproduce: the real
PTY path, Electron's IPC transport, node-pty chunk boundaries, and terminal
resize — none of which exist outside the app.

The next occurrence is therefore the evidence to wait for, which is why the
fault detection below matters more than further harness work.

## Mitigation shipped

`noteEngineFault()` recognises `out of bounds` / `Invalid code point` /
`unreachable`, reports the first occurrence with a message naming the likely
trigger, and after three faults sets `engineDead` so the frontend stops feeding
an engine that can only produce garbage. `engineFaults`, `engineDead` and
`splitWrites` are reported in the telemetry so a recurrence is visible rather
than silent.

Recovery from a fault requires a new engine: close and reopen the tab.
