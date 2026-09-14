import { Injector } from '@angular/core'
import { ConfigService, PlatformService, ThemesService, getCSSFontFamily } from 'tabby-core'
import { Frontend, BaseTerminalProfile } from 'tabby-terminal'

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
        const { init, Terminal, FitAddon } = this.ghosttyWeb

        await init()

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
        super.destroy()
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
    private backgroundColor (scheme: any, config: any): string {
        const opaque = (c: string | undefined | null): string | null => {
            if (!c) return null
            // Reject fully-transparent and 8-digit-with-zero-alpha colours.
            if (/^#[0-9a-f]{8}$/i.test(c) && c.slice(7).toLowerCase() === '00') return null
            if (/^#0{8}$/.test(c)) return null
            return c
        }
        if (config.terminal.background === 'colorScheme') {
            const c = opaque(scheme?.background)
            if (c) return c
        }
        return opaque(this.themes.findCurrentTheme()?.terminalBackground)
            ?? opaque(scheme?.background)
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
        try {
            this.terminal.write(data)
            this.contentUpdated.next()
        } catch (error) {
            // Swallow: rejecting here would poison Tabby's write lock.
            console.error('GhosttyFrontend.write failed:', error)
        }
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
