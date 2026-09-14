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
}

const stats: RenderPatchStats = { applied: false, frames: 0, fastFrames: 0 }

let originalRender: ((...args: any[]) => void) | null = null

export function getRenderPatchStats (): RenderPatchStats {
    return { ...stats }
}

/**
 * Patch `CanvasRenderer.prototype.render`. Safe to call repeatedly.
 * `enabled` is read per frame, so the setting can be toggled at runtime.
 */
export function applyRenderPatch (ghosttyWeb: any, enabled: () => boolean, log?: (...args: any[]) => void): void {
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
        return original.call(this, wrapped, forceAll, viewportY, scrollbackProvider, scrollbarOpacity)
    }

    stats.applied = true
    log?.('Patched CanvasRenderer.render (viewport fast path)')
}

/** Restore the original renderer. */
export function revertRenderPatch (ghosttyWeb: any): void {
    if (!stats.applied || !originalRender) {
        return
    }
    const CanvasRenderer = ghosttyWeb?.CanvasRenderer
    if (CanvasRenderer?.prototype) {
        CanvasRenderer.prototype.render = originalRender
    }
    stats.applied = false
    originalRender = null
}
