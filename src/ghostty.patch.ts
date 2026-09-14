import { Injectable, Injector } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { GhosttyFrontend } from './ghostty.frontend'

/**
 * Replaces the terminal frontend in Tabby's own tabs with GhosttyFrontend.
 *
 * Tabby picks its frontend from an object literal built inside
 * `BaseTerminalTabComponent.ngOnInit`:
 *
 *     const cls = {
 *         xterm: XTermFrontend,
 *         'xterm-webgl': XTermWebGLFrontend,
 *     }[this.config.store.terminal.frontend] ?? XTermFrontend
 *     this.frontend = new cls(this.injector)
 *
 * The literal is rebuilt on every call, so there is no registry to add to,
 * and no provider token to contribute a third frontend through.
 *
 * `ngOnInit` is emitted as an ordinary prototype method, so we wrap it. The
 * swap cannot happen *after* the original runs: `resize$` and `frontendReady$`
 * are subscribed immediately after construction, and replacing `this.frontend`
 * afterwards would orphan those subscriptions and the tab would hang waiting
 * for a resize event that never arrives.
 *
 * Instead we install a one-shot setter for `frontend` before calling through.
 * Tabby's own `this.frontend = new cls(...)` assignment hits the setter, which
 * discards the xterm instance and stores a GhosttyFrontend in its place, so
 * every subscription that follows binds to ours.
 */
@Injectable({ providedIn: 'root' })
export class GhosttyFrontendPatch {
    private logger: Logger
    private applied = false
    private originalNgOnInit: (() => void) | null = null

    constructor (
        private config: ConfigService,
        private injector: Injector,
        log: LogService,
    ) {
        this.logger = log.create('ghostty-patch')
    }

    get enabled (): boolean {
        // `config.store` is undefined until ConfigService.load() resolves, so
        // the guard has to be on `store` itself, not just on `ghostty`.
        return !!this.config.store?.ghostty?.replaceTerminalFrontend
    }

    /**
     * Installs the wrapper once. It is a no-op per tab while the setting is
     * off, so toggling the setting takes effect on newly opened tabs without
     * needing to patch and unpatch.
     */
    apply (): void {
        if (this.applied) {
            return
        }

        const proto = BaseTerminalTabComponent.prototype as any
        if (typeof proto.ngOnInit !== 'function') {
            this.logger.warn('BaseTerminalTabComponent.prototype.ngOnInit is not a function; not patching')
            return
        }

        const original = proto.ngOnInit as () => void
        this.originalNgOnInit = original
        const patch = this

        proto.ngOnInit = function (this: any, ...args: any[]) {
            if (!patch.enabled) {
                return original.apply(this, args)
            }

            let replaced: GhosttyFrontend | null = null
            let stored: any = undefined

            try {
                Object.defineProperty(this, 'frontend', {
                    configurable: true,
                    enumerable: true,
                    get: () => replaced ?? stored,
                    set: (value: any) => {
                        if (replaced) {
                            stored = value
                            return
                        }
                        try {
                            replaced = new GhosttyFrontend(this.injector ?? patch.injector)
                            patch.logger.info('Substituted GhosttyFrontend for', value?.constructor?.name)
                        } catch (error) {
                            patch.logger.error('Could not create GhosttyFrontend, keeping xterm:', error)
                            stored = value
                        }
                    },
                })
            } catch (error) {
                this.logger?.warn?.('Could not install frontend interceptor', error)
                return original.apply(this, args)
            }

            try {
                return original.apply(this, args)
            } finally {
                // Collapse the accessor back into a plain value property so the
                // tab behaves normally for the rest of its life.
                const current = replaced ?? stored
                delete this.frontend
                this.frontend = current
            }
        }

        this.applied = true
        this.logger.info('Patched BaseTerminalTabComponent.ngOnInit')

        // ConfigService populates `store` asynchronously: its constructor does
        // `setTimeout(() => this.init())` and `init()` awaits `load()`, which is
        // what assigns `this.store`. This method runs from the plugin's NgModule
        // constructor, long before that, so the store must not be touched here -
        // wait for `ready$` instead.
        this.config.ready$.subscribe(() => {
            if (!this.config.store?.ghostty?.preloadEngine) {
                return
            }
            // Loading the WASM module up front means the first terminal has
            // nothing to buffer while it waits for the engine.
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                void require('ghostty-web').init().then(
                    () => this.logger.info('Ghostty WASM engine preloaded'),
                    (error: any) => this.logger.warn('Ghostty WASM preload failed:', error),
                )
            } catch (error) {
                this.logger.warn('Ghostty WASM preload failed:', error)
            }
        })
    }

    /** Restores Tabby's original method. */
    revert (): void {
        if (!this.applied || !this.originalNgOnInit) {
            return
        }
        ;(BaseTerminalTabComponent.prototype as any).ngOnInit = this.originalNgOnInit
        this.applied = false
        this.logger.info('Reverted BaseTerminalTabComponent.ngOnInit')
    }
}
