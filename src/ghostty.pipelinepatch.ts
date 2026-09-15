/**
 * Removes per-chunk work from Tabby's session -> terminal pipeline.
 *
 * Measured context: with ZMODEM stripped, both rendering frontends cap at the
 * same rate under streaming (Ghostty 43-45 fps, xterm 44-46 fps, both 144 idle),
 * so the residual cost is in the pipeline they share rather than in rendering.
 * A CPU profile of that state puts `(program)` at 57.3% self time with `(idle)`
 * at only 8.8% - the thread is busy, but not in attributable JS.
 *
 * Three costs run on every chunk, none of which normal output needs:
 *
 * 1. `DebugDecorator` (tabby-terminal char 3160903) subscribes to `output$` and
 *    does `buffer += data` then `buffer.substring(len - 8192)` per chunk. It is
 *    registered unconditionally as `{provide: TerminalDecorator, multi: true}`
 *    and its `attach()` reads no setting. The buffer feeds only the
 *    `debug-save-output` / `debug-copy-output` hotkeys.
 *
 * 2. No coalescing anywhere. `attachSessionHandlers` (char 3140732) subscribes
 *    straight to `output$`, with upstream's own batching commented out directly
 *    above it:
 *
 *        // this.session.output$.bufferTime(10).subscribe((datas) => {
 *        this.attachSessionHandler(this.session.output$, data => {
 *
 * 3. `BaseSession` (char 3231145) emits every chunk twice - once UTF-8 decoded,
 *    once raw:
 *
 *        this.output.next(data.toString())
 *        this.binaryOutput.next(data)
 *
 *    This one is NOT patched here. The decode happens inside BaseSession's own
 *    subscriber, and removing it would break anything reading `output$`. With
 *    (1) and (2) applied the string stream has far fewer consumers, which makes
 *    the decode's remaining cost measurable rather than assumed.
 */

import { BaseTerminalTabComponent } from 'tabby-terminal'

export interface PipelinePatchStats {
    debugDecoratorNeutered: number
    batchedHandlers: number
    chunksIn: number
    batchesOut: number
}

const stats: PipelinePatchStats = {
    debugDecoratorNeutered: 0,
    batchedHandlers: 0,
    chunksIn: 0,
    batchesOut: 0,
}

export function getPipelinePatchStats (): PipelinePatchStats {
    return { ...stats }
}

/**
 * Identify DebugDecorator without importing a class Tabby does not export.
 *
 * Minified builds rename it, so fall back to its shape: a TerminalDecorator
 * whose `attach` source mentions the 8192-byte buffer it keeps.
 */
function isDebugDecorator (d: any): boolean {
    if (!d) {
        return false
    }
    if (d.constructor?.name === 'DebugDecorator') {
        return true
    }
    try {
        const src = String(d.attach ?? '')
        return src.includes('8192') && src.includes('substring')
    } catch {
        return false
    }
}

/**
 * Stop DebugDecorator buffering output.
 *
 * Replacing `attach` with a no-op is safer than unsubscribing after the fact:
 * the decorator is constructed per tab by Angular, and its subscriptions are
 * owned by `subscribeUntilDetached`, which we would have to reach into.
 */
export function neuterDebugDecorator (
    decorators: any[],
    log?: (...args: any[]) => void,
): number {
    let count = 0
    for (const d of decorators ?? []) {
        if (!isDebugDecorator(d) || d.__ghosttyNeutered) {
            continue
        }
        try {
            const original = d.attach?.bind(d)
            d.__ghosttyOriginalAttach = original
            d.attach = function (terminal: any) {
                // Deliberately does nothing: the only consumers of the buffer
                // are the debug-save-output / debug-copy-output hotkeys, which
                // stop working while this is on.
                void terminal
            }
            d.__ghosttyNeutered = true
            count++
            stats.debugDecoratorNeutered++
        } catch (error) {
            log?.('could not neuter DebugDecorator:', error)
        }
    }
    if (count) {
        log?.(`neutered ${count} DebugDecorator instance(s)`)
    }
    return count
}

let originalAttachSessionHandlers: any = null
let batchApplied = false

/**
 * Batch `output$` so the terminal is written once per window instead of once
 * per chunk. Restores what upstream commented out.
 *
 * Implemented by wrapping `attachSessionHandlers` and intercepting the
 * `output$` subscription specifically: the other handlers it installs
 * (binaryOutput$, closed$, destroyed$) must stay untouched.
 */
export function applyOutputBatching (
    windowMs: () => number,
    enabled: () => boolean,
    log?: (...args: any[]) => void,
): void {
    if (batchApplied) {
        return
    }
    const proto = BaseTerminalTabComponent.prototype as any
    if (typeof proto.attachSessionHandlers !== 'function') {
        log?.('attachSessionHandlers is not a function; output batching unavailable')
        return
    }
    originalAttachSessionHandlers = proto.attachSessionHandlers
    const original = originalAttachSessionHandlers

    proto.attachSessionHandlers = function (this: any, ...args: any[]) {
        if (!enabled() || !this.session) {
            return original.apply(this, args)
        }

        const session = this.session
        const realOutput$ = session.output$
        let pending: string[] = []
        let timer: any = null

        const flush = (): void => {
            timer = null
            if (!pending.length) {
                return
            }
            const batch = pending.length === 1 ? pending[0] : pending.join('')
            pending = []
            stats.batchesOut++
            try {
                this.__ghosttyRealHandler?.(batch)
            } catch (error) {
                log?.('batched handler threw:', error)
            }
        }

        // Present a batching stand-in for output$ only while the original runs,
        // so `attachSessionHandler(this.session.output$, handler)` captures our
        // proxy instead of the raw subject.
        const proxy = {
            subscribe: (handler: any) => {
                this.__ghosttyRealHandler = typeof handler === 'function'
                    ? handler
                    : handler?.next?.bind(handler)
                stats.batchedHandlers++
                return realOutput$.subscribe((data: string) => {
                    stats.chunksIn++
                    pending.push(data)
                    if (timer === null) {
                        timer = setTimeout(flush, Math.max(0, windowMs()))
                    }
                })
            },
        }

        try {
            Object.defineProperty(session, 'output$', {
                configurable: true,
                get: () => proxy,
            })
            return original.apply(this, args)
        } finally {
            // Put the real subject back immediately; anything subscribing later
            // (decorators, plugins) must see the unmodified stream.
            try {
                delete session.output$
            } catch {
                Object.defineProperty(session, 'output$', {
                    configurable: true,
                    value: realOutput$,
                })
            }
        }
    }

    batchApplied = true
    log?.('Patched attachSessionHandlers (output batching)')
}

export function revertOutputBatching (): void {
    if (!batchApplied || !originalAttachSessionHandlers) {
        return
    }
    ;(BaseTerminalTabComponent.prototype as any).attachSessionHandlers = originalAttachSessionHandlers
    batchApplied = false
}
