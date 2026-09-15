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

## 2. `scrollbackLimit` is ignored

The option is accepted but never applied — scrollback grows without bound,
so long-running sessions keep accumulating memory.

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
