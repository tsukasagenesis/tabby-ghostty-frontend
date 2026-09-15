/**
 * Removes Tabby's ZMODEM detection middleware from terminals rendered by this
 * plugin.
 *
 * A CPU profile of the Tabby renderer under load (45 s capture, 283,646
 * samples) put `consume` from tabby-terminal's bundled ZMODEM sentry at the
 * top of the non-idle list:
 *
 *     10.2%  4,625 ms  consume            tabby-terminal/dist/index.js:20064
 *      3.2%  1,455 ms  parseCellsIntoPool (ghostty-web cell decode)
 *      2.2%  1,012 ms  fillText
 *
 * It is ~3x the renderer's own cell decoding and ~4.5x all glyph painting.
 * The reason is visible in the source:
 *
 *     consume(input) {
 *       if (!(input instanceof Array)) {
 *         input = Array.prototype.slice.call(new Uint8Array(input))
 *       }
 *
 * and ZModemDecorator feeds it in 1 KB slices:
 *
 *     const chunkSize = 1024
 *     for (let i = 0; i <= Math.floor(data.length / chunkSize); i++) {
 *       this.sentry.consume(Buffer.from(data.slice(...)))
 *     }
 *
 * So every megabyte of terminal output is copied into roughly a million boxed
 * JavaScript array elements, scanned for a ZRINIT/ZRQINIT header, and
 * discarded. Measured end to end: 5.3 MB/s in Tabby against 44.2 MB/s in
 * native Ghostty on the same machine, with the writer blocked on drain 98.8%
 * of the time.
 *
 * Tabby exposes no setting for this, but `session.middleware` is a public
 * `SessionMiddlewareStack` with a public `remove()`, so the entry can be
 * taken out per session.
 *
 * Trade-off: `rz`/`sz` ZMODEM file transfers stop being auto-detected in
 * these tabs. Everything else - OSC processing, login scripts, stream
 * processing - is left untouched.
 */

export interface ZModemStripStats {
    removed: number
    inspected: number
    lastStack: string[]
}

const stats: ZModemStripStats = { removed: 0, inspected: 0, lastStack: [] }

export function getZModemStripStats (): ZModemStripStats {
    return { ...stats, lastStack: [...stats.lastStack] }
}

/** Identify ZModemMiddleware without importing a class Tabby does not export. */
function isZModemMiddleware (m: any): boolean {
    if (!m) {
        return false
    }
    if (m.constructor?.name === 'ZModemMiddleware') {
        return true
    }
    // Minified builds rename the class, so fall back to its shape: the only
    // middleware holding a ZMODEM `sentry` with a `consume` method.
    const sentry = m.sentry
    return !!sentry && typeof sentry.consume === 'function'
}

/**
 * Strip the ZMODEM middleware from a session's stack.
 * Returns the number of entries removed.
 */
export function stripZModem (session: any, log?: (...args: any[]) => void): number {
    const stack = session?.middleware?.stack
    if (!Array.isArray(stack) || typeof session.middleware.remove !== 'function') {
        return 0
    }

    // Snapshot for diagnostics before mutating.
    stats.lastStack = stack.map((m: any) => m?.constructor?.name ?? 'unknown')
    stats.inspected++

    const targets = stack.filter(isZModemMiddleware)
    for (const t of targets) {
        try {
            session.middleware.remove(t)
            if (typeof t.close === 'function') {
                t.close()
            }
            stats.removed++
        } catch (error) {
            log?.('could not remove ZMODEM middleware:', error)
        }
    }
    if (targets.length) {
        log?.(`removed ${targets.length} ZMODEM middleware entrie(s);`,
            'stack was', stats.lastStack.join(' -> '))
    }
    return targets.length
}

/**
 * Watch a terminal tab and keep ZMODEM stripped from its session.
 *
 * `ZModemDecorator.attach` installs the middleware from inside a `setTimeout`,
 * and re-installs it on every `sessionChanged$`, so a single removal at attach
 * time would lose the race. This defers past that timeout and re-arms on
 * session changes.
 */
export function watchAndStrip (
    tab: any,
    enabled: () => boolean,
    log?: (...args: any[]) => void,
): () => void {
    let disposed = false
    const timers: any[] = []

    const attempt = (): void => {
        if (disposed || !enabled() || !tab?.session) {
            return
        }
        stripZModem(tab.session, log)
    }

    // The decorator unshifts from a setTimeout(0); run after it, then once
    // more a little later in case a decorator attaches late.
    timers.push(setTimeout(attempt, 0))
    timers.push(setTimeout(attempt, 50))
    timers.push(setTimeout(attempt, 500))

    let sub: any = null
    try {
        sub = tab?.sessionChanged$?.subscribe?.(() => {
            timers.push(setTimeout(attempt, 0))
            timers.push(setTimeout(attempt, 50))
        })
    } catch (error) {
        log?.('could not subscribe to sessionChanged$:', error)
    }

    return () => {
        disposed = true
        for (const t of timers) {
            clearTimeout(t)
        }
        try {
            sub?.unsubscribe?.()
        } catch { /* already gone */ }
    }
}
