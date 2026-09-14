import { Component, Injector, ElementRef, ViewChild, Input, HostBinding, OnInit, OnDestroy } from '@angular/core'
import { BaseTabComponent, ConfigService, GetRecoveryTokenOptions, RecoveryToken, LogService } from 'tabby-core'
import { GhosttySession, GhosttySessionOptions } from './ghostty.session'

/**
 * A terminal tab rendered by Ghostty's VT engine (ghostty-web, WASM).
 *
 * This deliberately extends `BaseTabComponent` rather than
 * `BaseTerminalTabComponent`: the latter hardcodes its frontend in `ngOnInit`
 * (`{xterm, 'xterm-webgl'}[config.terminal.frontend] ?? XTermFrontend`), so a
 * subclass could never substitute a different engine.
 */
@Component({
    selector: 'ghostty-tab',
    template: `
        <div class="ghostty-container" #container></div>
    `,
    styles: [`
        :host {
            display: block;
            width: 100%;
            height: 100%;
        }

        .ghostty-container {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
    `],
})
export class GhosttyTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    @Input() sessionOptions: GhosttySessionOptions = {}
    @ViewChild('container') container: ElementRef

    @HostBinding('class.ghostty-tab') hostClass = true

    session: GhosttySession | null = null

    private terminal: any = null
    private fitAddon: any = null
    private resizeObserver: ResizeObserver | null = null
    private logger: any

    constructor (
        injector: Injector,
        config: ConfigService,
        log: LogService,
    ) {
        super(injector)
        this.logger = log.create('ghostty')
        this.setTitle('Ghostty')
        void config
    }

    async ngOnInit (): Promise<void> {
        // ghostty-web ships both ESM and UMD builds; the UMD one is what
        // webpack resolves for a CommonJS Tabby plugin.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ghosttyWeb = require('ghostty-web')
        const { init, Terminal, FitAddon } = ghosttyWeb

        await init()

        const colorScheme = this.config.store.terminal?.colorScheme ?? {}

        this.terminal = new Terminal({
            fontSize: this.config.store.terminal?.fontSize ?? 14,
            fontFamily: this.config.store.terminal?.font ?? 'monospace',
            cursorBlink: this.config.store.terminal?.cursorBlink ?? true,
            theme: this.mapColorScheme(colorScheme),
        })

        this.fitAddon = new FitAddon()
        this.terminal.loadAddon(this.fitAddon)

        this.terminal.open(this.container.nativeElement)
        this.fitAddon.fit?.()

        this.session = new GhosttySession(this.logger)

        this.terminal.onData((data: string) => {
            this.session?.feedFromTerminal(Buffer.from(data, 'utf-8'))
        })

        this.terminal.onTitleChange((title: string) => {
            this.setTitle(title)
        })

        this.terminal.onResize(({ cols, rows }: { cols: number, rows: number }) => {
            this.session?.resize(cols, rows)
        })

        this.session.output$.subscribe(data => {
            this.terminal?.write(data)
        })

        this.session.closed$.subscribe(() => {
            this.destroy()
        })

        await this.session.start({
            ...this.sessionOptions,
            width: this.terminal.cols,
            height: this.terminal.rows,
        })

        this.session.releaseInitialDataBuffer()

        this.resizeObserver = new ResizeObserver(() => {
            this.fitAddon?.fit?.()
        })
        this.resizeObserver.observe(this.container.nativeElement)

        this.focused$.subscribe(() => this.terminal?.focus())
    }

    private mapColorScheme (scheme: any): any {
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

    async getRecoveryToken (_options?: GetRecoveryTokenOptions): Promise<RecoveryToken | null> {
        return {
            type: 'app:ghostty-tab',
            sessionOptions: {
                ...this.sessionOptions,
                cwd: await this.session?.getWorkingDirectory() ?? this.sessionOptions.cwd,
            },
        }
    }

    async canClose (): Promise<boolean> {
        return true
    }

    ngOnDestroy (): void {
        this.destroy()
    }

    destroy (): void {
        this.resizeObserver?.disconnect()
        this.resizeObserver = null

        try {
            this.terminal?.dispose()
        } catch {
            // Disposing a terminal that never opened throws; harmless.
        }
        this.terminal = null

        void this.session?.destroy()
        this.session = null

        super.destroy()
    }
}
