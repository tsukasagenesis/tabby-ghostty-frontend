import { Injectable, Injector } from '@angular/core'
import { ConfigService, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { GhosttyFrontend } from './ghostty.frontend'
import { watchAndStrip } from './ghostty.zmodem'
import { applyOutputBatching, neuterDebugDecorator } from './ghostty.pipelinepatch'
import { BUILD_STAMP } from './ghostty.buildstamp'

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
                if (patch.config.store?.ghostty?.skipDebugDecorator === true) {
                    try {
                        neuterDebugDecorator(
                            this.decorators ?? [],
                            (...a: any[]) => patch.logger.info('[pipeline]', ...a),
                        )
                    } catch (error) {
                        patch.logger.warn('could not neuter DebugDecorator:', error)
                    }
                }
                // `disableZmodemEverywhere` must still apply here. The strip
                // used to live in the `finally` below, after this early return,
                // so with the frontend patch off it never ran - the setting
                // looked ineffective because it was never reached, not because
                // stripping does not help.
                if (patch.config.store?.ghostty?.disableZmodemEverywhere === true) {
                    const stopOnly = watchAndStrip(
                        this,
                        () => patch.config.store?.ghostty?.disableZmodem !== false,
                        (...a: any[]) => patch.logger.info('[zmodem]', ...a),
                    )
                    try {
                        this.destroyed$?.subscribe?.(() => stopOnly())
                    } catch {
                        // Tab without destroyed$: the watcher self-limits anyway.
                    }
                }
                return original.apply(this, args)
            }

            // Neuter DebugDecorator before the original runs: it attaches from
            // `enabledServices(this.decorators).forEach(d => d.attach(this))`
            // inside ngOnInit, so replacing attach() afterwards would be too
            // late - the per-chunk subscription would already exist.
            if (patch.config.store?.ghostty?.skipDebugDecorator === true) {
                try {
                    neuterDebugDecorator(
                        this.decorators ?? [],
                        (...a: any[]) => patch.logger.info('[pipeline]', ...a),
                    )
                } catch (error) {
                    patch.logger.warn('could not neuter DebugDecorator:', error)
                }
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
                if (current) {
                    this.frontend = current
                } else {
                    // Neither a replacement nor Tabby's own value ever arrived,
                    // so the setter was never called. Writing `undefined` here
                    // makes Tabby's own getters throw 'Frontend not ready' on
                    // every later access; leaving the property absent lets its
                    // normal initialisation path run instead.
                    patch.logger.warn('frontend was never assigned during ngOnInit; leaving it unset')
                }

                // Only for tabs we actually render: strip Tabby's ZMODEM
                // detection, which a CPU profile showed to be the single
                // largest cost under load (10.2% self time, ~3x the renderer's
                // own cell decoding).
                // `disableZmodemEverywhere` also strips tabs this plugin does
                // not render. A CPU profile of a stock xterm tab under
                // journalctl put `consume` at 28.4% self time (5,773 ms of
                // 20,356 ms), so the cost is Tabby-wide rather than specific
                // to this frontend.
                const stripAll = patch.config.store?.ghostty?.disableZmodemEverywhere === true
                if (replaced || stripAll) {
                    const stop = watchAndStrip(
                        this,
                        () => patch.config.store?.ghostty?.disableZmodem !== false,
                        (...a: any[]) => patch.logger.info('[zmodem]', ...a),
                    )
                    try {
                        this.destroyed$?.subscribe?.(() => stop())
                    } catch {
                        // Tab without destroyed$: the watcher self-limits anyway.
                    }
                }
            }
        }

        this.applied = true
        this.logger.info('Patched BaseTerminalTabComponent.ngOnInit; build', BUILD_STAMP)

        // Pipeline mitigations, independent of the frontend swap. Both default
        // off; each is measured separately. See ghostty.pipelinepatch.ts for
        // what they remove and why normal output does not need it.
        applyOutputBatching(
            () => Number(this.config.store?.ghostty?.batchOutputMs ?? 10),
            () => this.config.store?.ghostty?.batchOutput === true,
            (...a: any[]) => this.logger.info('[pipeline]', ...a),
        )

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
