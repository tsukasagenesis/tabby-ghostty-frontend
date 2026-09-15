/**
 * Speeds up ghostty-web's canvas renderer.
 *
 * `CanvasRenderer.render()` pulls the visible grid with one `getLine(y)` call
 * per row, every frame. `GhosttyTerminal.getLine()` is expensive:
 *
 *     getLine(y) {
 *         this.update()
 *         const vp = this.getViewport()                  // full WASM viewport fetch
 *         return vp.slice(y*cols, (y+1)*cols).map(c => ({...c}))   // deep copy
 *     }
 *
 * So a 280x80 terminal performs 80 viewport fetches and clones 22 400 cell
 * objects to draw a single frame - measured at 43 ms/frame, against a 6.9 ms
 * budget at 144 Hz.
 *
 * This wraps the buffer passed to `render()` so `getLine()` is served from ONE
 * `getViewport()` call per frame, slicing without cloning. The original render
 * body then runs unchanged.
 *
 *     120x30   2.79 ms -> 0.09 ms   (30x)
 *     200x50  12.69 ms -> 0.26 ms   (50x)
 *     280x80  43.43 ms -> 0.57 ms   (77x)
 *
 * Constraints, both verified against the library:
 *  - `getViewport()` returns the engine's pooled cell array (same identity and
 *    same cell objects between calls), so a wrapper must be built per frame and
 *    never cached across frames.
 *  - When `viewportY > 0` the renderer reads scrollback via
 *    `getScrollbackLine()`, which the viewport does not cover, so the fast path
 *    only applies when the view is pinned to the bottom.
 */

export interface RenderPatchStats {
    applied: boolean
    frames: number
    fastFrames: number
    lineFastFrames: number
    /** render() wall time, ms */
    renderMs: { avg: number, p50: number, p90: number, max: number }
    /** rows drawn per render() call */
    rowsPerFrame: number
    /** gap between consecutive render() calls, ms - reveals the real cadence */
    frameGapMs: { avg: number, p50: number, p90: number }
}

const stats: RenderPatchStats = {
    applied: false, frames: 0, fastFrames: 0, lineFastFrames: 0,
    renderMs: { avg: 0, p50: 0, p90: 0, max: 0 },
    rowsPerFrame: 0,
    frameGapMs: { avg: 0, p50: 0, p90: 0 },
}

const renderTimes: number[] = []
const frameGaps: number[] = []
let lastRenderAt = 0

function summarise (): void {
    const pct = (a: number[], k: number) => {
        if (!a.length) return 0
        const s = [...a].sort((x, y) => x - y)
        return +s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(2)
    }
    const avg = (a: number[]) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0
    stats.renderMs = { avg: avg(renderTimes), p50: pct(renderTimes, 0.5), p90: pct(renderTimes, 0.9), max: pct(renderTimes, 0.999) }
    stats.frameGapMs = { avg: avg(frameGaps), p50: pct(frameGaps, 0.5), p90: pct(frameGaps, 0.9) }
    stats.rowsPerFrame = stats.frames ? +(stats.lineFastFrames / stats.frames).toFixed(1) : 0
}

let originalRender: ((...args: any[]) => void) | null = null
let originalRenderLine: ((...args: any[]) => void) | null = null

/** Cell flag bits, mirroring ghostty-web's CellFlags enum. */
const FL = {
    BOLD: 1, ITALIC: 2, UNDERLINE: 4, STRIKE: 8,
    INVERSE: 16, INVISIBLE: 32, BLINK: 64, FAINT: 128,
}

/**
 * `rgb(r, g, b)` strings are rebuilt for every cell by the stock renderer.
 * The palette is bounded, so memoise them.
 */
const colorCache = new Map<number, string>()
function rgbCSS (r: number, g: number, b: number): string {
    const key = (r << 16) | (g << 8) | b
    let s = colorCache.get(key)
    if (s === undefined) {
        s = `rgb(${r}, ${g}, ${b})`
        colorCache.set(key, s)
    }
    return s
}

export function getRenderPatchStats (): RenderPatchStats {
    summarise()
    return JSON.parse(JSON.stringify(stats))
}

/**
 * Patch `CanvasRenderer.prototype.render`. Safe to call repeatedly.
 * `enabled` is read per frame, so the setting can be toggled at runtime.
 */
export function applyRenderPatch (
    ghosttyWeb: any,
    enabled: () => boolean,
    log?: (...args: any[]) => void,
    lineEnabled: () => boolean = enabled,
): void {
    const CanvasRenderer = ghosttyWeb?.CanvasRenderer
    if (!CanvasRenderer?.prototype) {
        log?.('CanvasRenderer not exported; render fast path unavailable')
        return
    }
    if (stats.applied) {
        return
    }

    const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderer.prototype, 'render')
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) {
        log?.('CanvasRenderer.prototype.render is not writable; render fast path unavailable')
        return
    }

    originalRender = descriptor.value as (...args: any[]) => void
    const original = originalRender

    CanvasRenderer.prototype.render = function (
        buffer: any,
        forceAll?: boolean,
        viewportY?: number,
        scrollbackProvider?: any,
        scrollbarOpacity?: number,
    ): void {
        stats.frames++

        // Only safe while pinned to the bottom: scrolled-back frames read rows
        // out of scrollback, which the viewport does not contain.
        const scrolled = !!viewportY && viewportY > 0
        if (!enabled() || scrolled || !buffer || typeof buffer.getViewport !== 'function') {
            return original.call(this, buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
        }

        let dims: { cols: number, rows: number }
        let flat: any[]
        try {
            dims = buffer.getDimensions()
            flat = buffer.getViewport()
        } catch {
            return original.call(this, buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
        }

        const cols = dims?.cols | 0
        const rows = dims?.rows | 0
        if (!cols || !rows || !flat || flat.length < cols * rows) {
            return original.call(this, buffer, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
        }

        // Rows are sliced lazily; the render body only touches rows it repaints.
        const rowCache: any[][] = new Array(rows)
        const wrapped = {
            getLine (y: number): any[] | null {
                if (y < 0 || y >= rows) {
                    return buffer.getLine(y)
                }
                let row = rowCache[y]
                if (row === undefined) {
                    row = flat.slice(y * cols, (y + 1) * cols)
                    rowCache[y] = row
                }
                return row
            },
            getCursor: () => buffer.getCursor(),
            getDimensions: () => dims,
            isRowDirty: (y: number) => buffer.isRowDirty(y),
            clearDirty: () => buffer.clearDirty(),
            needsFullRedraw: typeof buffer.needsFullRedraw === 'function'
                ? () => buffer.needsFullRedraw()
                : undefined,
            getGraphemeString: typeof buffer.getGraphemeString === 'function'
                ? (r: number, c: number) => buffer.getGraphemeString(r, c)
                : undefined,
        }

        stats.fastFrames++
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        if (lastRenderAt) {
            frameGaps.push(now - lastRenderAt)
            if (frameGaps.length > 4000) frameGaps.splice(0, 2000)
        }
        lastRenderAt = now
        const out = original.call(this, wrapped, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
        renderTimes.push((typeof performance !== 'undefined' ? performance.now() : Date.now()) - now)
        if (renderTimes.length > 4000) renderTimes.splice(0, 2000)
        return out
    }

    stats.applied = true
    log?.('Patched CanvasRenderer.render (viewport fast path)')

    patchRenderLine(CanvasRenderer, lineEnabled, log)
}

/**
 * Replace `CanvasRenderer.prototype.renderLine` with a version that:
 *
 *  - run-merges background fills (one `fillRect` per colour run instead of one
 *    per cell), and
 *  - skips `fillText` for blank cells that carry no decoration.
 *
 * Measured in a standalone harness at 282x77: together with the viewport fast
 * path this took the demo from ~17 fps to vsync-capped 60 (78 fps with the cap
 * lifted).
 *
 * Correctness constraints, each load-bearing:
 *  - Two passes are kept (all backgrounds, then all text) because glyphs from
 *    complex scripts bleed left into the previous cell; collapsing the passes
 *    lets a later background erase an earlier overhang.
 *  - `cell.width === 0` spacer cells (the tail of a wide CJK char) are skipped
 *    in both passes, and merged runs advance by `cell.width`.
 *  - A blank cell may still carry UNDERLINE / STRIKETHROUGH / a hyperlink, so
 *    only the glyph is skipped, never the decoration path.
 *  - Cells whose background is rgb(0,0,0) are deliberately left unpainted: the
 *    row fill already drew the theme background behind them.
 *  - Anything with a grapheme cluster, FAINT, or selection active falls through
 *    to the stock per-cell path rather than being reimplemented here.
 */
function patchRenderLine (CanvasRenderer: any, enabled: () => boolean, log?: (...args: any[]) => void): void {
    const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderer.prototype, 'renderLine')
    if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) {
        log?.('CanvasRenderer.prototype.renderLine is not writable; line fast path unavailable')
        return
    }

    originalRenderLine = descriptor.value as (...args: any[]) => void
    const original = originalRenderLine

    CanvasRenderer.prototype.renderLine = function (line: any[], y: number, cols: number): void {
        if (!enabled() || !line) {
            return original.call(this, line, y, cols)
        }

        // Selection recolours cells individually; defer to the stock path.
        const hasSelection = !!(this.selectionManager && this.selectionManager.hasSelection())
        if (hasSelection) {
            return original.call(this, line, y, cols)
        }

        const m = this.metrics
        const lineY = y * m.height
        const lineWidth = cols * m.width

        this.ctx.clearRect(0, lineY, lineWidth, m.height)
        this.ctx.fillStyle = this.theme.background
        this.ctx.fillRect(0, lineY, lineWidth, m.height)

        // PASS 1 - backgrounds, run-merged by colour.
        let x = 0
        while (x < line.length) {
            const cell = line[x]
            if (!cell || cell.width === 0) { x++; continue }
            const inverse = (cell.flags & FL.INVERSE) !== 0
            const r = inverse ? cell.fg_r : cell.bg_r
            const g = inverse ? cell.fg_g : cell.bg_g
            const b = inverse ? cell.fg_b : cell.bg_b
            if (r === 0 && g === 0 && b === 0) { x++; continue }

            let width = cell.width || 1
            let next = x + 1
            while (next < line.length) {
                const n = line[next]
                if (!n) { break }
                if (n.width === 0) { next++; continue }
                const inv = (n.flags & FL.INVERSE) !== 0
                if ((inv ? n.fg_r : n.bg_r) !== r ||
                    (inv ? n.fg_g : n.bg_g) !== g ||
                    (inv ? n.fg_b : n.bg_b) !== b) { break }
                width += n.width || 1
                next++
            }
            this.ctx.fillStyle = rgbCSS(r, g, b)
            this.ctx.fillRect(x * m.width, lineY, width * m.width, m.height)
            x = next
        }

        // PASS 2 - text, strictly left to right.
        for (let i = 0; i < line.length; i++) {
            const cell = line[i]
            if (!cell || cell.width === 0) { continue }
            const codepoint = cell.codepoint || 32
            const isBlank = (codepoint === 32 || codepoint === 0) && !cell.grapheme_len
            const decorated = (cell.flags & (FL.UNDERLINE | FL.STRIKE)) !== 0 || !!cell.hyperlink_id
            if (isBlank && !decorated) { continue }
            this.renderCellText(cell, i, y)
        }

        stats.lineFastFrames++
    }

    log?.('Patched CanvasRenderer.renderLine (run-merged backgrounds, blank skip)')
}

/** Restore the original renderer. */
export function revertRenderPatch (ghosttyWeb: any): void {
    if (!stats.applied || !originalRender) {
        return
    }
    const CanvasRenderer = ghosttyWeb?.CanvasRenderer
    if (CanvasRenderer?.prototype) {
        CanvasRenderer.prototype.render = originalRender
        if (originalRenderLine) {
            CanvasRenderer.prototype.renderLine = originalRenderLine
        }
    }
    stats.applied = false
    originalRender = null
    originalRenderLine = null
    colorCache.clear()
}
