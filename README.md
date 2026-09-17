# tabby-ghostty-frontend

A [Tabby](https://tabby.sh) plugin that renders terminal tabs with **Ghostty's VT engine**, via [`ghostty-web`](https://github.com/coder/ghostty-web) (Ghostty compiled to WebAssembly).

Instead of xterm.js's hand-written JavaScript terminal emulation, escape sequences are parsed by the same Zig code that runs the native Ghostty app.

> **Experimental.** `ghostty-web` is pre-1.0. This plugin is usable daily, but there are real gaps and one known upstream crash — all documented below rather than glossed over.

---

## What this actually is

Two independent parts:

1. **A `Ghostty Terminal` profile** that opens its own tab type. Uses only public extension points, always available.
2. **An opt-in patch** (Settings → Ghostty) that replaces the frontend in Tabby's *own* terminal tabs.

### Why a separate tab type, and not a registered frontend

Tabby has a clean `Frontend` abstraction, so the obvious move is to register a third frontend alongside `xterm` and `xterm-webgl`. That is impossible from a plugin. `BaseTerminalTabComponent.ngOnInit` picks its frontend from a hardcoded object literal:

```ts
const cls: new (..._) => Frontend = {
    xterm: XTermFrontend,
    'xterm-webgl': XTermWebGLFrontend,
}[this.config.store.terminal.frontend] ?? XTermFrontend
```

There is no provider token and no registration hook, and subclassing inherits the same lookup. Hence a separate tab type, plus an opt-in monkey-patch for anyone who wants Ghostty everywhere.

---

## Performance: what was wrong and what changed

The headline: **the renderer was never the bottleneck.** Both engines hit the same ceiling, because the cost is in the pipeline that feeds them.

| host | raw rAF | canvas | DOM mutate | DOM churn |
|---|---|---|---|---|
| Chromium 152, headful | 144.1 | 143.9 | 143.9 | 143.9 |
| Electron 42 (Tabby's own) | 144.2 | 143.9 | 143.9 | 143.9 |
| Tabby, idle | 144 | — | — | — |
| **Tabby, streaming journalctl** | **11–12** | — | — | — |

With ZMODEM stripped, Ghostty caps at 43–45 fps and xterm at 44–46 — *the same ceiling*. Swapping VT engines cannot fix a limit both share.

### 1. ZMODEM detection — the largest single cost

Tabby scans every byte of all terminal output for a file-transfer header. `consume()` boxes its input into a plain JS `Array`, one element per byte:

```js
consume(input) {
  if (!(input instanceof Array)) {
    input = Array.prototype.slice.call(new Uint8Array(input))
  }
```

45 s CPU profile, 283,646 samples, streaming `journalctl` in a **stock xterm tab**:

| self time | | function |
|---|---|---|
| 34.7% | 7,058 ms | `(program)` (native/GPU) |
| **28.4%** | **5,773 ms** | **`consume`** (ZMODEM sentry) |
| 3.3% | 675 ms | `restore` |
| 2.6% | 533 ms | `print` (xterm parser) |

`consume` costs more than xterm's own parsing, cell writes and painting **combined**. Isolated microbenchmark over 64 MB:

| approach | time | throughput | |
|---|---|---|---|
| boxed array per chunk (what Tabby does) | 3,942 ms | 16.2 MB/s | baseline |
| identical scan, no boxing | 55 ms | 1,162.9 MB/s | **71.6×** |
| `indexOf` prefilter for the ZDLE header | 7 ms | 8,611.3 MB/s | **530×** |

At the 5.2 MB/s `journalctl` actually streams, the boxed path burns **~320 ms of CPU per second of output** — about a third of the main thread, looking for a header that is not there.

**After removing the middleware:**

| | before | after |
|---|---|---|
| `renderMs` p90 | 15.6 ms | 0.2 ms |
| `frameGapMs` p90 | 98.2 ms | 7.2 ms |
| `consume` | 4,625 ms | absent from profile |

### 2. `getLine()` makes rendering O(rows² · cols)

`CanvasRenderer.render()` calls `getLine()` once per row, and each call walks the grid from the start. Measured on a 128×68 grid:

| | per frame |
|---|---|
| per-row `getLine()` | 40.64 ms |
| one `getViewport()` | 0.54 ms |

**75.4×.** Hoisting a single `getViewport()` out of the row loop took a demo page from 17 fps to 78 fps.

### 3. No output coalescing anywhere

Tabby writes the terminal once per chunk, with upstream's own batching commented out directly above their subscription:

```js
// this.session.output$.bufferTime(10).subscribe((datas) => {
this.attachSessionHandler(this.session.output$, data => {
```

SSH delivers ~1.7 KB per packet, and each write pays the whole per-chunk pipeline — capping throughput at 1.2 MB/s while rendering itself cost 0.1 ms/frame.

### 4. Idle rendering

`ghostty-web`'s render loop is unconditional and `render()` has no early-out, so an idle terminal still runs `getCursor()`, `getDimensions()`, `getScrollbackLength()`, a selection scan, a hyperlink scan and a full rows-long dirty loop — **~143 times per second with zero bytes of output.**

### Net effect

| | throughput | blocked on drain |
|---|---|---|
| native Ghostty | 44.2 MB/s | — |
| Tabby (stock) | 5.3 MB/s | 98.8% |

---

## Bugs found upstream

Found while profiling. Documented here in full under [`docs/`](docs/).

### ghostty-web 0.4.0

| # | Issue | Status |
|---|---|---|
| 1 | `getLine()` makes rendering O(rows²·cols) — 75.4× slower than one `getViewport()` | worked around (`fastRenderer`) |
| 2 | Render cost degrades as scrollback fills — 50× monotonic, never recovers | **open, no workaround** |
| 3 | `isDefaultBg` treats true black as "default" — explicit black renders as theme colour | **open** |
| 4 | No `clearRect` in the renderer — a transparent background breaks erasing entirely | **open**, `#00000000` is a silent footgun |
| 5 | **`memory access out of bounds` on replayed input** | **open**, mitigated |
| 6 | Flow-control callbacks are delivered via rAF only — a stalled rAF deadlocks output permanently | mitigated (2 s watchdog) |

On #2, measured streaming into a 128×68 grid with `scrollback: 25000`:

| elapsed | frame gap p90 | render p90 |
|---|---|---|
| 0–20 s | 7.2 ms | 0.2 ms |
| 40 s | 30.6 ms | 0.4 ms |
| 60 s | 98.3 ms | **10.4 ms** |

Repainting 68 rows should cost the same whether there are 200 or 25,000 lines behind them.

### The WASM fault (#5) — the one real crash

A tab freezes mid-stream showing corrupted colour blocks. The engine reads back codepoints outside Unicode (`RangeError: Invalid code point 1924376` = `0x1D5A18`), so the heap is already damaged before anything is drawn. Every later `write()` throws.

**Reduced to a standalone reproducer** in [`repro-ghostty-wasm/`](repro-ghostty-wasm/): 53.5 KB of real `journalctl` output, written into a 125×42 terminal **twice**. No Tabby, no plugin, no PTY. Pass 1 completes; pass 2 faults — three consecutive runs identical to the decimal.

It needs *those* bytes, *in full*, *twice*:

| input | result |
|---|---|
| `repro.txt` once | ok |
| **`repro.txt` twice** | **FAULT** |
| `repro.txt`, then the next 53.5 KB of the log | ok |
| a different 53.5 KB slice, twice | ok |
| `repro.txt`, then its own first half | ok |

Ten hypotheses were tested and refuted — large writes (2 MB clean), sustained volume (900 MB clean), malformed UTF-8 (7/7 clean), the render patch (1921 frames clean), resize, split escape sequences, scrollback size, `flush()` slicing, coalescing, and cluster variety (2.6M distinct Thai clusters, 300 MB, clean). **One contradiction is recorded rather than hidden:** a bisect harness writing the 0–130 MB prefix ran clean, and until that is explained the triggering condition is not fully characterised.

**Mitigation shipped:** `noteEngineFault()` recognises the fault, reports the first occurrence, and after three faults stops feeding an engine that can only produce garbage. Recovery requires reopening the tab.

### Tabby 1.0.235

| # | Issue | Status |
|---|---|---|
| 1 | ZMODEM detection costs up to 28.4% of renderer CPU in **every** tab, used or not | worked around per-session |
| 2 | `DebugDecorator` keeps an 8 KB rolling buffer via concat + `substring` per chunk, unconditionally, for two hotkeys | worked around (opt-in) |
| 3 | No output coalescing between PTY and renderer; upstream's own `bufferTime(10)` is commented out | worked around |
| 4 | Frontends are resolved from a hardcoded object literal — no plugin can register one | unavoidable; hence a separate tab type |

---

## Settings

Settings → **Ghostty**. Defaults are chosen so a fresh install is fast and safe.

| Setting | Default | What it does |
|---|---|---|
| **Fast renderer** | ✅ on | Serves per-frame row reads from one `getViewport()` instead of one `getLine()` per row. Works around ghostty-web #1. |
| **Fast line rendering** | ✅ on | Run-merges background fills, skips blank cells. ~17 fps → 60+ at 282×77. |
| **Batch output per frame** | ✅ on | Coalesces session output into one write per frame. |
| **Disable ZMODEM detection** | ✅ on | Removes the sentry from Ghostty tabs. **Disables `rz`/`sz` auto-detection in these tabs.** |
| **Preload the WASM engine** | ✅ on | Loads at startup so the first tab buffers nothing. |
| **Smooth scrolling duration** | 100 ms | ghostty-web's easing. 0 = instant. |
| **Startup output buffer** | 1 MB | Caps output buffered before the engine loads. |
| **Use Ghostty in all terminal tabs** | ❌ off | Patches a Tabby internal to replace the frontend everywhere. Opt-in by design. |
| **Strip ZMODEM everywhere** | ❌ off | Extends the strip to tabs this plugin does not render. Measured 28.4% → absent. |
| **Skip debug output buffer** | ❌ off | Neuters `DebugDecorator`. Breaks *debug-save-output* / *debug-copy-output*. |
| **Batch terminal output** | ❌ off | Restores upstream's commented-out `bufferTime(10)`. |
| **Flow control** | ❌ off | Backpressure via xterm's watermarks. Off because it did not improve smoothness and can only delay output. |
| **Translate newlines** | ❌ off | `\n` → `\r\n`. Only for programs emitting bare newlines. |
| **Read-only terminal** | ❌ off | Keystrokes are not forwarded. |
| **Debug logging** | ❌ off | Frontend lifecycle to the console. |

---

## Limits

Known gaps versus Tabby's xterm frontend:

- **No search panel.** `ghostty-web` ships no serialize/search addon.
- **No scrollback restore on session recovery.** Recovery restores the working directory and launches a fresh shell.
- **Local shell only** for the Ghostty tab type. SSH/serial/telnet profiles use Tabby's own tabs (the *replace frontend* option covers those).
- **Terminal decorators and context-menu providers do not apply** to the Ghostty tab type — they are wired to `BaseTerminalTabComponent`.
- **`rz`/`sz` auto-detection is off** in Ghostty tabs by default. See the ZMODEM trade-off above.
- **A faulted engine needs a new tab.** There is no in-place recovery from the WASM fault.
- **Transparent background colours break erasing.** ghostty-web has no `clearRect`; the background fill *is* the eraser.

---

## Install

```bash
./install.sh
```

Then restart Tabby. A **Ghostty Terminal** profile appears in the profile list and the new-tab dropdown.

### Requirements

- Tabby 1.0.197+ (developed against 1.0.235)
- Linux / macOS / Windows — `ghostty-web` is WASM, so there is no native build

`node-pty` is resolved from Tabby's own runtime rather than bundled, since Tabby already ships a copy compiled against its exact Electron ABI. `ghostty-web` *is* bundled: its UMD build inlines the WASM as a base64 `data:` URI, so `dist/index.js` is self-contained with no separate `.wasm` to ship.

---

## Measuring this plugin

Several rounds of measurement in this project produced confident, wrong numbers. [`docs/measurement-harness.md`](docs/measurement-harness.md) records what invalidated them. The short version:

- **Gate on rAF first.** A window can report `document.hidden: false` and `visibilityState: "visible"` while rAF is fully suspended — 0 ticks in 3 s against 60 `setInterval` ticks. That artefact once made the plugin look severely broken; re-measured with working rAF, the same build gave 0 stalls and 13–15 MB/s.
- **Prove the workload ran.** Four "load tests" here measured an idle terminal. Assert a byte counter advanced before reporting anything.
- **State the ceiling next to every number.** A reading above the monitor's refresh rate is a broken instrument, not a result.
- **Never install a second rAF loop without cancelling the first**, or the counts silently add up.

---

## Architecture

| File | Role |
| --- | --- |
| `src/ghostty.frontend.ts` | `Frontend` implementation: engine lifecycle, write coalescing, flow control, fault detection |
| `src/ghostty.renderpatch.ts` | Fast renderer + fast line renderer; idle-frame skipping |
| `src/ghostty.pipelinepatch.ts` | Output batching, `DebugDecorator` neutering |
| `src/ghostty.zmodem.ts` | Per-session ZMODEM middleware removal |
| `src/ghostty.patch.ts` | The opt-in frontend replacement for Tabby's own tabs |
| `src/ghostty.session.ts` | `BaseSession` subclass driving a `node-pty` PTY |
| `src/ghostty.tab.component.ts` | `BaseTabComponent` hosting the terminal |
| `src/ghostty.bench.component.ts` | In-app render benchmark, including `ApplicationRef.tick()` accounting |
| `src/ghostty.profile.ts` | `ProfileProvider` + `TabRecoveryProvider` |
| `src/ghostty.settings.ts` | Settings tab and config defaults |

## Build

```bash
npm install --legacy-peer-deps
npm run build
```

## License

MIT
