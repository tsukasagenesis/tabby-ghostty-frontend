import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'

export interface GhosttySessionOptions {
    command?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    width?: number
    height?: number
}

/**
 * A local PTY session driving a Ghostty-rendered terminal tab.
 *
 * node-pty is resolved from Tabby's own runtime rather than bundled: Tabby
 * already ships a build compiled against its exact Electron ABI, and bundling
 * a second copy would require a native rebuild per Electron version.
 */
export class GhosttySession extends BaseSession {
    private pty: any = null
    private exitHandler: any = null
    private dataHandler: any = null

    constructor (logger: Logger) {
        super(logger)
    }

    private requirePTY (): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const req = (global as any).nodeRequire ?? require
        return req('node-pty')
    }

    async start (options: GhosttySessionOptions): Promise<void> {
        const nodePTY = this.requirePTY()

        const shell = options.command ?? process.env.SHELL ?? '/bin/bash'
        const args = options.args ?? []

        this.pty = nodePTY.spawn(shell, args, {
            name: 'xterm-256color',
            cols: options.width ?? 80,
            rows: options.height ?? 24,
            cwd: options.cwd ?? process.env.HOME,
            env: { ...process.env, ...(options.env ?? {}), TERM: 'xterm-256color' },
        })

        this.open = true

        this.dataHandler = this.pty.onData((data: string) => {
            this.emitOutput(Buffer.from(data, 'utf-8'))
        })

        this.exitHandler = this.pty.onExit(() => {
            this.open = false
            this.destroy()
        })
    }

    resize (columns: number, rows: number): void {
        if (!this.pty || !this.open) {
            return
        }
        try {
            this.pty.resize(columns, rows)
        } catch {
            // The PTY can die between a resize being queued and delivered.
        }
    }

    write (data: Buffer): void {
        if (!this.pty || !this.open) {
            return
        }
        this.pty.write(data.toString('utf-8'))
    }

    kill (signal?: string): void {
        if (!this.pty) {
            return
        }
        try {
            this.pty.kill(signal)
        } catch {
            // Already gone.
        }
        this.open = false
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill('SIGTERM')
    }

    supportsWorkingDirectory (): boolean {
        // Reported via OSC 7 by the shell integration, handled by oscProcessor.
        return !!this.reportedCWD
    }

    async getWorkingDirectory (): Promise<string | null> {
        return this.reportedCWD ?? null
    }

    async destroy (): Promise<void> {
        this.dataHandler?.dispose?.()
        this.exitHandler?.dispose?.()
        this.kill()
        await super.destroy()
    }
}
