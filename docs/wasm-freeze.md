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

## Root cause located: it is a ghostty-web bug, not a plugin bug

Reproduced with **no Tabby code involved at all**. Real `journalctl` output,
captured to a file and written into a bare headless `ghostty-web` engine:

```
source 190.4 MB, streamed 111.8 MB in 3.1 s
RESULT: FAULT at 111.8 MB -> memory access out of bounds
```

The same harness with *synthetic* log-shaped lines reached 900 MB clean. So the
trigger is the **content** of real journal output, not volume, and not anything
this plugin does.

Two further results pin it down:

- **Coalescing is not involved.** With `coalesceOutput: false` — no `queue()`,
  no `flush()`, no slicing, `splitWrites: 0` throughout — Tabby still faulted at
  **145.9 MB**, against 145.99 MB with slicing on. A threshold stable to within
  0.1 MB across two completely different write paths cannot be a property of
  either path.
- **The slicing pattern is safe.** Replicating `flush()`'s exact behaviour
  headlessly (520 KB batches sliced into 64 KB writes, 7,092 slices, 400 MB)
  produced no fault.

### Every hypothesis tested

| hypothesis | result |
|---|---|
| Large single writes | refuted — 2 MB clean |
| Sustained volume (synthetic) | refuted — 900 MB clean |
| Malformed UTF-8 / surrogates | refuted — 7/7 clean |
| Render patch | refuted — 1921 patched frames clean |
| Resize during streaming | refuted — 200 resizes clean |
| Split mid-escape-sequence | refuted — 6/6 clean (CSI, OSC, lone ESC) |
| Scrollback size | refuted — 400 MB clean at both 25000 and 1000 |
| `flush()` slicing | refuted — 7,092 slices clean |
| Coalescing | refuted — faults with it off |
| **Real journal content** | **REPRODUCES — fault at 111.8 MB, bare engine, 3/3 runs identical** |

### The reproduction is exactly deterministic

Three consecutive runs of the same harness:

```
run 1: streamed 111.8 MB in 2.9 s -> FAULT at 111.8 MB
run 2: streamed 111.8 MB in 3.0 s -> FAULT at 111.8 MB
run 3: streamed 111.8 MB in 3.0 s -> FAULT at 111.8 MB
```

Identical to the decimal, so this is a specific offset in the capture rather
than accumulated state or nondeterminism.

**One contradiction is unresolved and recorded rather than hidden:** a bisect
harness that wrote the 0–130 MB prefix ran *clean*. It differed from the
reproduction by creating a fresh engine per probe and calling `dispose()`, and
by bounding each write to the probe's end offset instead of the full text
length. Until that is explained, the exact triggering condition is not fully
characterised — a deterministic offset and a clean superset-prefix cannot both
be the whole story.

Note also that the content itself looks unremarkable: scanning the first 60 MB
found the longest line at 807 bytes, 515 non-ASCII bytes, **zero** NUL bytes,
**zero** other control bytes and **zero** ESC sequences. It is essentially plain
ASCII, which is what makes "real content is special" hard to explain and worth
pinning down precisely.

The fault message shipped to users previously blamed `batchOutputMs`. That was
wrong and has been corrected: no plugin setting prevents this.

## The trigger is cumulative, not a poison byte

Bisecting the capture with the reproduction's exact write loop narrowed the
faulting prefix to a 190 KB window (clean at 111.738 MB, faults at 111.924 MB).
That window looked like a smoking gun — it is dense Thai text inside dolphin
file-copy paths, matching the corrupted-glyph screenshot exactly:

```
chars 194,952 | non-ASCII 14,773 (7.6%) | Thai 14,092 | combining marks 708
lines 682 | longest 357 chars | astral chars 0
```

But writing that window **alone** is clean, and writing it **20 times** faults:

| input | result |
|---|---|
| window once, 64 KB writes | ok |
| window once, single write | ok |
| window x20 (3.9 MB) | **FAULT — memory access out of bounds** |

So there is no poison byte at a fixed offset. The fault accumulates, and the
190 KB window reaches the threshold ~30x sooner than plain ASCII does.

### Script density does not explain it either

Synthetic streams of a single repeated sequence, 300 MB each, fresh engine:

| content | result |
|---|---|
| ASCII only | clean to 300 MB |
| Thai (one repeated cluster) | clean to 300 MB |
| Devanagari (one repeated cluster) | clean to 300 MB |

Repetition of *one* complex cluster is harmless.

### Cluster variety does not explain it either

The obvious follow-up was that an engine cache keyed per unique grapheme
cluster would grow with *distinct* clusters rather than with bytes. Tested with
a fresh browser per arm:

| content | distinct clusters | result |
|---|---|---|
| one cluster, repeated | 0 new | clean to 300 MB |
| a new base+mark cluster per line | **2,599,974** | clean to 300 MB |

2.6 million distinct Thai base+mark clusters, 300 MB, no fault. So variety is
not the mechanism.

The Arabic run that had failed with "Failed to create terminal" was re-tested
first in a fresh page: **clean to 300 MB**. That failure was accumulated page
state from three prior 300 MB runs, not anything about Arabic — retracted.

### Where that leaves it

Every synthetic construction survives 300 MB: ASCII, repeated Thai, repeated
Devanagari, Arabic, and 2.6M distinct clusters. The real 190 KB window faults
after 3.9 MB. Something in the actual bytes is not captured by any statistic
measured so far, so the next step is bisecting *inside* the window rather than
proposing another property to test.

## Mitigation shipped

`noteEngineFault()` recognises `out of bounds` / `Invalid code point` /
`unreachable`, reports the first occurrence with a message naming the likely
trigger, and after three faults sets `engineDead` so the frontend stops feeding
an engine that can only produce garbage. `engineFaults`, `engineDead` and
`splitWrites` are reported in the telemetry so a recurrence is visible rather
than silent.

Recovery from a fault requires a new engine: close and reopen the tab.
