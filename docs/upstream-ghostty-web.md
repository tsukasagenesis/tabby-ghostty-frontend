# ghostty-web: three renderer issues found while profiling

**Affects:** ghostty-web 0.4.0

## 1. `getLine()` makes rendering O(rows² · cols)

`CanvasRenderer.render()` calls `getLine()` once per row, and each call walks
the grid from the start, so a full repaint is quadratic in row count.

Measured on a 128x68 grid:

| | per frame |
|---|---|
| per-row `getLine()` | 40.64 ms |
| one `getViewport()` | 0.54 ms |

**75.4x.** Hoisting a single `getViewport()` out of the row loop took a demo
page from 17 fps to 78 fps (the latter with `--disable-frame-rate-limit`;
60 fps is the vsync ceiling).

## 2. Render cost grows as scrollback fills (under investigation)

*Correction: an earlier draft of this report claimed `scrollbackLimit` was
ignored. That was wrong. It is passed into the WASM config
(`setUint32(w, C.scrollbackLimit ?? 1e4)`) and the buffer lives in WASM
linear memory, not JS — which is why a JS-side search for eviction found
nothing. The limit is honoured.*

The open question is different: per-frame render cost degrades badly as the
scrollback buffer fills. Streaming into a 128x68 grid with
`scrollback: 25000`, measured over 60 s:

| elapsed | frame gap p90 | render p90 |
|---|---|---|
| 0-20 s | 7.2 ms | 0.2 ms |
| 40 s | 30.6 ms | 0.4 ms |
| 60 s | 98.3 ms | 10.4 ms |

A monotonic 50x degradation in render time that never recovers, while the
viewport stays pinned at the bottom and the visible row count never changes.
Repainting 68 rows should cost the same whether there are 200 or 25,000 lines
of history behind them.

## 3. `isDefaultBg` treats true black as "default"

Cells with an explicit black background are treated as unset. On a theme
whose background is not black, explicitly-black cells render with the theme
colour instead of black.

Related: there is no `clearRect` in the renderer — `fillStyle =
theme.background; fillRect(...)` *is* the eraser. A transparent background
colour therefore breaks erasing entirely, and also breaks `frontend.clear()`.
Worth documenting, since it makes `#00000000` a silent footgun.

## Note on the benchmark suite

The bundled benchmark runs under happy-dom, whose canvas is a no-op stub, so
it reports timings that do not reflect real rendering cost. The `getLine()`
issue above is invisible to it.
