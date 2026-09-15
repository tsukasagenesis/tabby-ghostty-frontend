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

## Still open

The one configuration that has not been meaningfully exercised is the render
patch itself: `render()` wrapped so `getLine()` is served from a single
`getViewport()` slice rather than one `getLine()` per row. A first attempt
streamed 400 MB through it without fault, but reported `fast 2 / bail 0` —
`render()` ran only twice, because the write loop yielded to rAF once every
32 MB. That run proves nothing about the patch.

This matters because the symptom is a **render-side read** of corrupted cells,
and the render patch is the only thing in the user's session reading cells
differently from stock.

## Mitigation shipped

`noteEngineFault()` recognises `out of bounds` / `Invalid code point` /
`unreachable`, reports the first occurrence with a message naming the likely
trigger, and after three faults sets `engineDead` so the frontend stops feeding
an engine that can only produce garbage. `engineFaults`, `engineDead` and
`splitWrites` are reported in the telemetry so a recurrence is visible rather
than silent.

Recovery from a fault requires a new engine: close and reopen the tab.
