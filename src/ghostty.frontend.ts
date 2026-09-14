import { Injector } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
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

    private configService: ConfigService
    private platformService: PlatformService

    constructor (injector: Injector) {
        super(injector)
        this.configService = injector.get(ConfigService)
        this.platformService = injector.get(PlatformService)
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
        this.configuredFontSize = config.terminal.fontSize ?? 14

        this.terminal = new Terminal({
            fontSize: this.configuredFontSize,
            fontFamily: config.terminal.font ?? 'monospace',
            cursorBlink: config.terminal.cursorBlink ?? true,
            scrollback: config.terminal.scrollback ?? 1000,
            theme: this.makeTheme(profile),
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
            if (config.terminal.copyOnSelect && this.getSelection()) {
                this.copySelection()
            }
        })

        this.fitAddon = new FitAddon()
        this.terminal.loadAddon(this.fitAddon)

        this.terminal.open(host)
        this.opened = true

        this.fitAddon.fit?.()

        host.addEventListener('dragover', (event: DragEvent) => this.dragOver.next(event))
        host.addEventListener('drop', (event: DragEvent) => this.drop.next(event))
        host.addEventListener('mousedown', (event: MouseEvent) => this.mouseEvent.next(event))
        host.addEventListener('mouseup', (event: MouseEvent) => this.mouseEvent.next(event))
        host.addEventListener('mousewheel', (event: any) => this.mouseEvent.next(event))

        this.resizeObserver = new ResizeObserver(() => this.fitAddon?.fit?.())
        this.resizeObserver.observe(host)

        this.ready.next()
        this.ready.complete()
    }

    detach (host: HTMLElement): void {
        this.resizeObserver?.disconnect()
        this.resizeObserver = undefined
        super.detach(host)
    }

    destroy (): void {
        super.destroy()
        this.resizeObserver?.disconnect()
        try {
            this.terminal?.dispose()
        } catch {
            // Disposing a terminal that never opened throws; harmless.
        }
        this.terminal = null
    }

    private makeTheme (profile: BaseTerminalProfile): any {
        const scheme = profile.terminalColorScheme ?? this.configService.store.terminal?.colorScheme
        if (!scheme?.colors) {
            return undefined
        }
        const c = scheme.colors
        return {
            foreground: scheme.foreground,
            background: scheme.background,
            cursor: scheme.cursor,
            cursorAccent: scheme.cursorAccent ?? undefined,
            selectionBackground: scheme.selection ?? undefined,
            selectionForeground: scheme.selectionForeground ?? undefined,
            black: c[0], red: c[1], green: c[2], yellow: c[3],
            blue: c[4], magenta: c[5], cyan: c[6], white: c[7],
            brightBlack: c[8], brightRed: c[9], brightGreen: c[10], brightYellow: c[11],
            brightBlue: c[12], brightMagenta: c[13], brightCyan: c[14], brightWhite: c[15],
        }
    }

    async write (data: string): Promise<void> {
        this.terminal?.write(data)
        this.contentUpdated.next()
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
        const size = (config.terminal.fontSize ?? 14) * Math.pow(1.1, this.zoom)
        if (this.terminal.options) {
            this.terminal.options.fontSize = size
            this.terminal.options.fontFamily = config.terminal.font ?? 'monospace'
            this.terminal.options.theme = this.makeTheme(profile)
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
