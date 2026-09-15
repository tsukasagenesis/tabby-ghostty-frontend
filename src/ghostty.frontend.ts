import { Injector } from '@angular/core'
import { ConfigService, PlatformService, ThemesService, getCSSFontFamily } from 'tabby-core'
import { Frontend, BaseTerminalProfile } from 'tabby-terminal'
import { applyRenderPatch, getRenderPatchStats } from './ghostty.renderpatch'
import { getZModemStripStats } from './ghostty.zmodem'

// `SearchOptions` / `SearchState` are declared in tabby-terminal's
// frontends/frontend.d.ts but are not re-exported from the package root, and
// the package publishes no subpath exports map. They are structurally typed,
// so local declarations satisfy the abstract signatures.
interface SearchOptions {
    regex?: boolean
    wholeWord?: boolean
    caseSensitive?: boolean
    incremental?: true
}

interface SearchState {
    resultIndex?: number
    resultCount: number
}

/**
 * A Tabby terminal frontend backed by Ghostty's VT engine (ghostty-web, WASM).
 *
 * Mirrors XTermFrontend's wiring: the terminal's events feed the Frontend
 * Subjects (`input`, `resize`, `title`, `bell`), and `attach()` opens the
 * terminal into the host element and then completes `ready`.
 */
export class GhosttyFrontend extends Frontend {
    enableResizing = true

    private terminal: any = null
    private fitAddon: any = null
    private element?: HTMLElement
    private resizeObserver?: ResizeObserver
    private zoom = 0
    private configuredFontSize = 14
    private opened = false
    private copyOnSelect = false
    private writeBuffer: string[] = []
    private writeBufferBytes = 0

    // Write-path instrumentation: if render() turns out to be cheap, the cost
    // is here - Tabby serialises every chunk through a promise chain.
    private wrCount = 0
    private wrBytes = 0
    private wrMs = 0
    private wrMax = 0
    private wrFirstAt = 0

    // Output coalescing. SSH delivers one russh packet per emitOutput, which
    // measured ~1.7 KB in practice: 90 MB arrived as 52,969 separate writes,
    // and throughput sat at 1.2 MB/s while rendering cost only 0.1 ms/frame.
    //
    // The engine is not the constraint: ghostty-web sustains 36.1 MB/s at
    // 1.7 KB chunks versus 37.7 MB/s at 64 KB, so its per-call cost (~2 us)
    // is irrelevant. The 30x gap is Tabby's per-chunk pipeline - a write-lock
    // promise hop, the detectProgress regex, OSC buffer scans, five
    // SessionMiddleware passes and an Angular zone entry, all paid per chunk
    // regardless of size. Batching to one write per animation frame removes
    // ~99% of those traversals.
    private pending: string[] = []
    private pendingBytes = 0
    private flushHandle: any = null
    private flushTimer: any = null
    private lastFlushAt = 0
    private stalls = 0
    private readonly FLUSH_TIMEOUT_MS = 24
    private coalescedWrites = 0
    private flushes = 0

    // Flow control, mirroring XTermFrontend's FlowControl watermarks. Without
    // it the PTY outruns the terminal during a large `cat`: Tabby serialises
    // every chunk through one promise chain, and frames never get to run.
    private fcBlocked = false
    private fcPending = 0
    private fcBytes = 0
    private fcWaiters: (() => void)[] = []
    private readonly FC_LOW = 5
    private readonly FC_HIGH = 10
    private readonly FC_BYTES = 128 * 1024

    private configService: ConfigService
    private platformService: PlatformService
    private themes: ThemesService

    constructor (injector: Injector) {
        super(injector)
        this.configService = injector.get(ConfigService)
        this.platformService = injector.get(PlatformService)
        this.themes = injector.get(ThemesService)
    }

    private get ghosttyWeb (): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('ghostty-web')
    }

    async attach (host: HTMLElement, profile: BaseTerminalProfile): Promise<void> {
        const ghosttyWeb = this.ghosttyWeb
        const { init, Terminal, FitAddon } = ghosttyWeb

        await init()

        // ~77x fewer WASM calls per frame at 280x80. Reads the setting per
        // frame, so it can be toggled without reopening the tab.
        applyRenderPatch(
            ghosttyWeb,
            () => this.configService.store?.ghostty?.fastRenderer !== false,
            (...args: any[]) => this.debug(...args),
            () => this.configService.store?.ghostty?.fastLineRenderer !== false,
        )

        this.element = host

        const config = this.configService.store
        const gh = config?.ghostty ?? {}
        this.configuredFontSize = config.terminal.fontSize
        this.copyOnSelect = config.terminal.copyOnSelect

        this.terminal = new Terminal({
            fontSize: this.configuredFontSize,
            // Tabby composes font + fallbackFont + monospace fallbacks.
            fontFamily: this.fontFamily,
            cursorStyle: this.cursorStyle,
            cursorBlink: config.terminal.cursorBlink,
            // The key is `scrollbackLines` (default 25000), not `scrollback`.
            scrollback: config.terminal.scrollbackLines,
            // The background is deliberately opaque (see backgroundColor()),
            // so transparency compositing must stay off.
            allowTransparency: false,
            theme: this.makeTheme(profile),
            // Ghostty-specific options (Settings -> Ghostty -> Engine).
            // ghostty-web reads all three live from its options Proxy, so
            // configure() can update them without reopening the tab.
            smoothScrollDuration: gh.smoothScrollDuration ?? 100,
            convertEol: !!gh.convertEol,
            disableStdin: !!gh.disableStdin,
        })

        // Feed Tabby's Subjects exactly as XTermFrontend does.
        this.terminal.onData((data: string) => {
            this.input.next(Buffer.from(data, 'utf-8'))
        })
        this.terminal.onResize(({ cols, rows }: { cols: number, rows: number }) => {
            this.resize.next({ rows, columns: cols })
        })
        this.terminal.onTitleChange((title: string) => {
            this.title.next(title)
        })
        this.terminal.onBell(() => {
            this.bell.next()
        })
        this.terminal.onSelectionChange(() => {
            if (this.copyOnSelect && this.getSelection()) {
                this.copySelection()
            }
        })

        this.fitAddon = new FitAddon()
        this.terminal.loadAddon(this.fitAddon)

        // Neither XTermFrontend.attach() nor Frontend.detach() clears the host,
        // and ghostty-web's open() only appendChild()s its canvas. If anything
        // else has already rendered into this element - a stray xterm instance,
        // or a previous attach on the same host - both renderings end up stacked
        // in the same box. Log what was there and start from a clean container.
        if (host.childElementCount > 0) {
            const existing = Array.from(host.children).map(
                el => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : ''),
            )
            console.warn('[ghostty] host was not empty before open(), clearing:', existing)
            host.innerHTML = ''
        }

        this.terminal.open(host)
        this.opened = true
        this.debug('open() done; host children:',
            Array.from(host.children).map(el => el.tagName.toLowerCase()).join(','))

        // Flush anything the session emitted while the WASM engine was still
        // loading. Without this the SSH banner and login output are lost.
        const buffered = this.writeBuffer
        this.writeBuffer = []
        this.writeBufferBytes = 0
        for (const chunk of buffered) {
            try {
                this.terminal.write(chunk)
            } catch {
                // Ignore: a failed replay must not abort attach().
            }
        }

        this.fitAddon.fit?.()

        host.addEventListener('dragover', (event: DragEvent) => this.dragOver.next(event))
        host.addEventListener('drop', (event: DragEvent) => this.drop.next(event))
        host.addEventListener('mousedown', (event: MouseEvent) => this.mouseEvent.next(event))
        host.addEventListener('mouseup', (event: MouseEvent) => this.mouseEvent.next(event))
        host.addEventListener('mousewheel', (event: any) => this.mouseEvent.next(event))

        this.resizeObserver = new ResizeObserver(() => this.fitAddon?.fit?.())
        this.resizeObserver.observe(host)

        // Tabby's terminal template is `<div class="content" #content
        // [style.opacity]="frontendIsReady ? 1 : 0">`, and `frontendIsReady`
        // is only set once `resize$` has emitted at least once:
        //
        //     this.frontend.resize$.pipe(first()).subscribe(({columns, rows}) => {
        //         this.frontendReady.next(); this.frontendReady.complete()
        //     })
        //
        // ghostty-web's `resize()` early-returns when the size is unchanged,
        // and `FitAddon.fit()` silently does nothing when it cannot measure
        // the container, so relying on `onResize` alone can leave `resize$`
        // silent forever - the session runs but the terminal stays at
        // opacity 0. Always emit the current size here.
        this.debug('attached', this.terminal.cols + 'x' + this.terminal.rows,
            'replayed', buffered.length, 'buffered chunk(s)')

        // Prove whether the render patches are actually live in Tabby. Without
        // this there is no way to tell a patched renderer from a stock one.
        setTimeout(() => {
            const st = getRenderPatchStats()
            const elapsed = this.wrFirstAt
                ? ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.wrFirstAt) / 1000
                : 0
            const report = {
                ...st,
                write: {
                    chunks: this.wrCount,
                    mb: +(this.wrBytes / 1048576).toFixed(2),
                    totalMs: +this.wrMs.toFixed(1),
                    avgMs: this.wrCount ? +(this.wrMs / this.wrCount).toFixed(3) : 0,
                    maxMs: +this.wrMax.toFixed(2),
                    mbPerSec: elapsed > 0 ? +((this.wrBytes / 1048576) / elapsed).toFixed(1) : 0,
                },
                grid: `${this.terminal?.cols}x${this.terminal?.rows}`,
                devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
                flowControl: this.flowControlEnabled,
                fastRenderer: this.configService.store?.ghostty?.fastRenderer !== false,
                fastLineRenderer: this.configService.store?.ghostty?.fastLineRenderer !== false,
                at: new Date().toISOString(),
            }
            console.info('[ghostty] render patch status:', JSON.stringify(report))
            // Devtools is awkward to open in Tabby, so mirror this to a file.
            try {
                const req = (globalThis as any).nodeRequire ?? require
                const fs = req('fs')
                const os = req('os')
                fs.writeFileSync(
                    os.homedir() + '/.config/tabby/ghostty-perf.json',
                    JSON.stringify(report, null, 2),
                )
            } catch {
                // Non-fatal: the console line above is still emitted.
            }
        }, 5000)

        // Keep refreshing while the tab lives, so the file reflects a busy
        // period rather than the first idle five seconds.
        const perfTimer = setInterval(() => {
            // Watchdog. Both schedulers should have fired long ago; if bytes
            // are still pending, something swallowed them. Force progress
            // rather than leaving the tab frozen on output.
            if (this.pendingBytes > 0) {
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
                if (this.lastFlushAt && now - this.lastFlushAt > 1000) {
                    this.stalls++
                    console.warn('[ghostty] flush stalled for',
                        Math.round(now - this.lastFlushAt), 'ms with',
                        this.pendingBytes, 'bytes pending - forcing flush')
                    this.flush()
                }
            }

            const st2 = getRenderPatchStats()
            try {
                const req = (globalThis as any).nodeRequire ?? require
                const fs = req('fs')
                const os = req('os')
                const elapsed2 = this.wrFirstAt
                    ? ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.wrFirstAt) / 1000
                    : 0
                fs.writeFileSync(os.homedir() + '/.config/tabby/ghostty-perf.json', JSON.stringify({
                    ...st2,
                    grid: `${this.terminal?.cols}x${this.terminal?.rows}`,
                    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
                    zmodem: getZModemStripStats(),
                    write: {
                        chunks: this.wrCount,
                        mb: +(this.wrBytes / 1048576).toFixed(2),
                        avgMs: this.wrCount ? +(this.wrMs / this.wrCount).toFixed(3) : 0,
                        maxMs: +this.wrMax.toFixed(2),
                        mbPerSec: elapsed2 > 0 ? +((this.wrBytes / 1048576) / elapsed2).toFixed(1) : 0,
                    },
                    // Coalescing health. If `pendingBytes` is non-zero and
                    // `msSinceFlush` keeps climbing across reports, the flush
                    // scheduler has stalled and output is hung - exactly the
                    // failure this telemetry exists to catch.
                    coalesce: {
                        coalesced: this.coalescedWrites,
                        flushes: this.flushes,
                        perFlush: this.flushes ? +(this.coalescedWrites / this.flushes).toFixed(1) : 0,
                        pendingBytes: this.pendingBytes,
                        pendingChunks: this.pending.length,
                        msSinceFlush: this.lastFlushAt
                            ? +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.lastFlushAt)).toFixed(0)
                            : null,
                        rafPending: this.flushHandle !== null,
                        timerPending: this.flushTimer !== null,
                        stalls: this.stalls,
                    },
                    at: new Date().toISOString(),
                }, null, 2))
            } catch { /* non-fatal */ }
        }, 3000)
        this.destroyed$.subscribe(() => clearInterval(perfTimer))
        this.resize.next({ columns: this.terminal.cols, rows: this.terminal.rows })

        this.ready.next()
        this.ready.complete()
    }

    detach (host: HTMLElement): void {
        this.resizeObserver?.disconnect()
        this.resizeObserver = undefined
        // Base Frontend.detach() is a no-op and leaves our canvas in the host;
        // remove it so a later attach cannot stack a second rendering.
        try {
            host.innerHTML = ''
        } catch {
            // Host may already be gone.
        }
        super.detach(host)
    }

    destroy (): void {
        if (this.flushHandle !== null) {
            const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
            cancel(this.flushHandle)
            this.flushHandle = null
        }
        this.flush()
        super.destroy()
        // Never leave Tabby's write chain awaiting a promise that cannot settle.
        this.fcBlocked = false
        const waiters = this.fcWaiters
        this.fcWaiters = []
        for (const resume of waiters) {
            resume()
        }
        this.writeBuffer = []
        this.writeBufferBytes = 0
        this.opened = false
        this.resizeObserver?.disconnect()
        try {
            this.terminal?.dispose()
        } catch {
            // Disposing a terminal that never opened throws; harmless.
        }
        this.terminal = null
    }

    /**
     * `getCSSFontFamily()` does `config.terminal.font.split(',')` with no null
     * guard. `terminal.font` comes from platformDefaults rather than the user's
     * config file, so if it is ever absent this would throw inside attach() and
     * take the whole tab down. Fall back instead.
     */
    private debug (...args: any[]): void {
        if (this.configService.store?.ghostty?.debugLogging) {
            console.log('[ghostty]', ...args)
        }
    }

    private get fontFamily (): string {
        try {
            return getCSSFontFamily(this.configService.store)
        } catch {
            return '"monospace-fallback", "monospace"'
        }
    }

    /** Tabby calls it `beam`; ghostty-web (like xterm) calls it `bar`. */
    private get cursorStyle (): 'block' | 'underline' | 'bar' {
        const cursor = this.configService.store.terminal.cursor
        return ({ beam: 'bar' }[cursor] ?? cursor) as 'block' | 'underline' | 'bar'
    }

    /**
     * Resolve an OPAQUE background. Tabby normally lets the terminal be
     * transparent so its themed background shows through, but ghostty-web
     * relies on this colour as its eraser, so it can never be transparent.
     */
    private backgroundColor (scheme: any, _config: any): string {
        const opaque = (c: string | undefined | null): string | null => {
            if (!c) return null
            const v = String(c).trim()
            // Reject anything with a zero alpha channel (#rrggbb00 / #rgba form).
            if (/^#[0-9a-f]{8}$/i.test(v) && v.slice(7).toLowerCase() === '00') return null
            if (/^#[0-9a-f]{4}$/i.test(v) && v[4] === '0') return null
            if (/^(transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(\.0+)?\s*\))$/i.test(v)) return null
            return v
        }

        // The colour scheme's background is what belongs behind terminal text -
        // it is the only background XTermFrontend ever paints. The app theme's
        // `terminalBackground` is the *window* chrome colour and is light
        // (#f7f1e0) on light themes, which is why preferring it turned Ghostty
        // terminals white. Use it only if the scheme has no usable background.
        return opaque(scheme?.background)
            ?? opaque(this.themes.findCurrentTheme()?.terminalBackground)
            ?? '#000000'
    }

    private makeTheme (profile: BaseTerminalProfile): any {
        const config = this.configService.store
        const scheme = profile.terminalColorScheme ?? config.terminal.colorScheme
        if (!scheme?.colors) {
            return undefined
        }
        const c = scheme.colors
        return {
            foreground: scheme.foreground,
            // Same rule as XTermFrontend.configureColors: the scheme background
            // is only painted when the user asked for it and the app theme does
            // not already follow the color scheme. Otherwise stay transparent
            // so Tabby's themed background shows through.
            // MUST be opaque. ghostty-web has no clearRect: the only thing that
            // erases the canvas is `fillStyle = theme.background; fillRect(...)`
            // in renderLine()/resize()/clear(). A transparent background paints
            // nothing, so every repaint composites over the previous frame and
            // old glyphs are never wiped - text ends up stacked on itself.
            // XTermFrontend can use '#00000000' because xterm clears properly;
            // here we fall back to the theme's terminal background instead.
            background: this.backgroundColor(scheme, config),
            cursor: scheme.cursor,
            cursorAccent: scheme.cursorAccent ?? undefined,
            selectionBackground: scheme.selection ?? '#88888888',
            selectionForeground: scheme.selectionForeground ?? undefined,
            black: c[0], red: c[1], green: c[2], yellow: c[3],
            blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
            brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11],
            brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
        }
    }

    /**
     * Cap for the pre-open write buffer, from
     * Settings -> Ghostty -> "Startup output buffer". A value of 0 disables
     * buffering entirely; anything unparseable falls back to 1 MiB.
     */
    private get writeBufferLimit (): number {
        const mb = Number(this.configService.store?.ghostty?.writeBufferLimitMB)
        if (!Number.isFinite(mb) || mb < 0) {
            return 1024 * 1024
        }
        return Math.round(mb * 1024 * 1024)
    }

    private get coalesceEnabled (): boolean {
        return this.configService.store?.ghostty?.coalesceOutput !== false
    }

    /**
     * Queue a chunk and schedule a flush on the next animation frame.
     * Painting is already synced to rAF, so batching to the same cadence adds
     * no latency the user can perceive while removing ~99% of the per-chunk
     * pipeline cost.
     */
    private queue (data: string): void {
        this.pending.push(data)
        this.pendingBytes += data.length
        this.coalescedWrites++

        // Bound the buffer: a burst should not grow without limit between
        // frames. 4 MB is far above a single frame's worth of PTY output.
        if (this.pendingBytes >= 4 * 1024 * 1024) {
            this.flush()
            return
        }

        // Schedule a flush on the next frame, but never depend on
        // requestAnimationFrame alone. If rAF stops firing - a backgrounded
        // surface, a compositor stall, a starved renderer - a flush scheduled
        // only through it would never run, `flushHandle` would stay set, and no
        // further flush could ever be scheduled. Output would stop permanently
        // while chunks piled up: a hung terminal, which is worse than a slow
        // one. The timer below guarantees forward progress regardless.
        if (this.flushHandle === null && typeof requestAnimationFrame === 'function') {
            this.flushHandle = requestAnimationFrame(() => {
                this.flushHandle = null
                this.flush()
            })
        }
        if (this.flushTimer === null) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null
                this.flush()
            }, this.FLUSH_TIMEOUT_MS)
        }
    }

    private flush (): void {
        // Cancel whichever scheduler did not win the race, so neither is left
        // holding a stale handle that blocks future scheduling.
        if (this.flushHandle !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.flushHandle)
        }
        this.flushHandle = null
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer)
            this.flushTimer = null
        }

        if (!this.pending.length) {
            return
        }
        const batch = this.pending.length === 1 ? this.pending[0] : this.pending.join('')
        this.pending = []
        this.pendingBytes = 0
        this.flushes++
        this.lastFlushAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        try {
            this.terminal?.write(batch)
            this.contentUpdated.next()
        } catch (error) {
            console.error('GhosttyFrontend.flush failed:', error)
        }
    }

    /**
     * Must never throw and never reject.
     *
     * Tabby serialises terminal output through a single promise chain:
     *
     *     this.frontendWriteLock = this.frontendWriteLock.then(() =>
     *         this.withSpinnerPaused(() => this.writeRaw(data)))
     *
     * `writeRaw` does not catch, so one rejection poisons that chain and every
     * later write is silently dropped for the life of the tab. ghostty-web's
     * `write()` calls `assertOpen()`, which throws until `open()` has run - and
     * `attach()` cannot call `open()` until the WASM engine has loaded. Output
     * arriving in that window is buffered here and replayed by `attach()`.
     */
    async write (data: string): Promise<void> {
        if (!this.terminal || !this.opened) {
            if (this.writeBufferBytes < this.writeBufferLimit) {
                this.writeBuffer.push(data)
                this.writeBufferBytes += data.length
            }
            return
        }

        if (this.flowControlEnabled && this.fcBlocked) {
            // Park until the terminal has caught up. Tabby awaits this, which
            // is what applies backpressure to the session.
            await new Promise<void>(resolve => this.fcWaiters.push(resolve))
        }

        const wrStart = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        if (!this.wrFirstAt) this.wrFirstAt = wrStart
        this.wrCount++
        this.wrBytes += data.length

        try {
            if (!this.flowControlEnabled) {
                if (this.coalesceEnabled) {
                    this.queue(data)
                } else {
                    this.terminal.write(data)
                    this.contentUpdated.next()
                }
                const d = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - wrStart
                this.wrMs += d
                if (d > this.wrMax) this.wrMax = d
                return
            }

            this.fcBytes += data.length
            if (this.fcBytes > this.FC_BYTES) {
                this.fcBytes = 0
                this.fcPending++
                if (!this.fcBlocked && this.fcPending > this.FC_HIGH) {
                    this.fcBlocked = true
                }
                // The callback fires on the next animation frame, i.e. once a
                // frame has actually been painted - the same signal xterm uses.
                this.terminal.write(data, () => {
                    this.fcPending--
                    if (this.fcBlocked && this.fcPending < this.FC_LOW) {
                        this.fcBlocked = false
                        const waiters = this.fcWaiters
                        this.fcWaiters = []
                        for (const resume of waiters) {
                            resume()
                        }
                    }
                })
            } else {
                this.terminal.write(data)
            }
            this.contentUpdated.next()
        } catch (error) {
            // Swallow: rejecting here would poison Tabby's write lock.
            console.error('GhosttyFrontend.write failed:', error)
        }
    }

    private get flowControlEnabled (): boolean {
        return this.configService.store?.ghostty?.flowControl !== false
    }

    clear (): void {
        this.terminal?.clear()
    }

    visualBell (): void {
        if (!this.element) {
            return
        }
        this.element.style.background = '#fff'
        setTimeout(() => {
            this.element!.style.background = ''
        }, 125)
    }

    focus (): void {
        this.terminal?.focus()
    }

    getSelection (): string {
        return this.terminal?.getSelection() ?? ''
    }

    copySelection (): void {
        const text = this.getSelection()
        if (!text.trim().length) {
            return
        }
        this.platformService.setClipboard({ text })
    }

    selectAll (): void {
        this.terminal?.selectAll()
    }

    clearSelection (): void {
        this.terminal?.clearSelection()
    }

    scrollToTop (): void {
        this.terminal?.scrollToTop()
    }

    scrollPages (pages: number): void {
        this.terminal?.scrollPages(pages)
    }

    scrollToBottom (): void {
        this.terminal?.scrollToBottom()
    }

    configure (profile: BaseTerminalProfile): void {
        if (!this.terminal) {
            return
        }
        const config = this.configService.store
        const gh = config?.ghostty ?? {}
        this.configuredFontSize = config.terminal.fontSize
        this.copyOnSelect = config.terminal.copyOnSelect

        // ghostty-web re-applies these through an options Proxy
        // (handleOptionChange): fontSize and fontFamily remeasure and resize
        // the canvas, cursorStyle/cursorBlink update the renderer.
        //
        // `theme` is deliberately NOT reassigned here: ghostty-web logs
        // "theme changes after open() are not yet fully supported", so the
        // theme is applied once at construction.
        if (this.terminal.options) {
            this.terminal.options.fontSize = this.configuredFontSize * Math.pow(1.1, this.zoom)
            this.terminal.options.fontFamily = this.fontFamily
            this.terminal.options.cursorStyle = this.cursorStyle
            this.terminal.options.cursorBlink = config.terminal.cursorBlink
            this.terminal.options.scrollback = config.terminal.scrollbackLines

            const gh = config?.ghostty ?? {}
            this.terminal.options.smoothScrollDuration = gh.smoothScrollDuration ?? 100
            this.terminal.options.convertEol = !!gh.convertEol
            this.terminal.options.disableStdin = !!gh.disableStdin
        }
        if (this.opened) {
            this.fitAddon?.fit?.()
        }
    }

    setZoom (zoom: number): void {
        this.zoom = zoom
        if (this.terminal?.options) {
            this.terminal.options.fontSize = this.configuredFontSize * Math.pow(1.1, zoom)
            this.fitAddon?.fit?.()
        }
    }

    // ghostty-web ships no search or serialize addon yet.
    findNext (_term: string, _options?: SearchOptions): SearchState {
        return { resultCount: 0 }
    }

    findPrevious (_term: string, _options?: SearchOptions): SearchState {
        return { resultCount: 0 }
    }

    cancelSearch (): void { }

    saveState (): any {
        return null
    }

    restoreState (_state: string): void { }

    supportsBracketedPaste (): boolean {
        return true
    }

    isAlternateScreenActive (): boolean {
        return this.terminal?.buffer?.active?.type === 'alternate'
    }
}
