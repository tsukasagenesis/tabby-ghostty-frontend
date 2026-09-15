import { Component, Injector, ElementRef, ViewChild, HostBinding, NgZone, ApplicationRef, OnInit, OnDestroy } from '@angular/core'
import { BaseTabComponent } from 'tabby-core'
import { BUILD_STAMP } from './ghostty.buildstamp'

/**
 * A rendering benchmark that runs *inside* Tabby's Angular tree.
 *
 * External benchmarks already established that the host is not the ceiling:
 * the same four probes reach full refresh in plain Chromium and in Tabby's own
 * Electron 42 build.
 *
 *     host                          raw rAF  canvas  DOM mutate  DOM churn
 *     Chromium 152, headful           144.1   143.9       143.9      143.9
 *     Electron 42 (Tabby's own)       144.2   143.9       143.9      143.9
 *     Tabby, idle                       144       -           -          -
 *     Tabby, streaming journalctl     11-12       -           -          -
 *
 * What no external benchmark can measure is how much of that collapse is
 * Angular change detection. Tabby bootstraps zone-based with no coalescing
 * options, the PTY output path runs inside the zone, and the terminal tab tree
 * is `ChangeDetectionStrategy.Default` - so every chunk of output ends in an
 * `ApplicationRef.tick()` that dirty-checks every binding in the app.
 *
 * This tab reproduces the same rungs in that environment and adds a fifth
 * measurement the others cannot make: how many ticks fire, and how long each
 * one takes, while the probes run.
 *
 * Measurement discipline, learned the hard way in this project:
 *  - requestAnimationFrame can be silently suspended while the page still
 *    reports `document.hidden === false`; the rAF rate is reported so a
 *    throttled window is visible rather than mistaken for a slow renderer.
 *  - The loop MUST stop in `destroy()`. A closed benchmark tab that keeps
 *    burning frames taints every later measurement.
 *  - Run with terminal tabs closed. A non-rendering CPU hog in another tab
 *    starves the same frame loop and would be misread as a rendering fault.
 */

interface ProbeResult {
    name: string
    fps: number
    frames: number
    ms: number
    ticks: number
    tickMs: number
}

@Component({
    selector: 'ghostty-bench-tab',
    template: `
        <div class="bench">
            <div class="controls">
                <button class="btn btn-primary" (click)="run()" [disabled]="running">
                    {{ running ? 'Running…' : 'Run benchmark' }}
                </button>
                <span class="status">{{ status }}</span>
                <span class="status">build {{ build }}</span>
            </div>

            <table class="results" *ngIf="results.length">
                <tr>
                    <th>probe</th><th>fps</th><th>frames</th>
                    <th>ticks</th><th>tick ms</th><th>ms/tick</th>
                </tr>
                <tr *ngFor="let r of results">
                    <td class="name">{{ r.name }}</td>
                    <td [class.bad]="r.fps < 100" [class.good]="r.fps >= 100">{{ r.fps.toFixed(1) }}</td>
                    <td>{{ r.frames }}</td>
                    <td [class.bad]="r.ticks > r.frames">{{ r.ticks }}</td>
                    <td>{{ r.tickMs.toFixed(1) }}</td>
                    <td>{{ r.ticks ? (r.tickMs / r.ticks).toFixed(3) : '-' }}</td>
                </tr>
            </table>

            <div class="note" *ngIf="results.length">
                Reference: plain Chromium and Tabby's own Electron both sustain
                ~144 fps on every probe. A low number here, with terminal tabs
                closed, means the cost is inside Tabby's Angular tree rather
                than in Electron.
            </div>

            <canvas #cv width="800" height="400"></canvas>
            <div #dom class="domtarget"></div>
            <div #gh class="ghosttyhost"></div>
        </div>
    `,
    styles: [`
        :host { display: block; width: 100%; height: 100%; overflow: auto; }
        .bench { padding: 12px; font-family: monospace; }
        .controls { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .status { opacity: .75; }
        .results { border-collapse: collapse; margin-bottom: 12px; }
        .results th, .results td { padding: 3px 12px 3px 0; text-align: right; }
        .results th { opacity: .6; font-weight: normal; }
        .results .name { text-align: left; }
        .results .good { color: #7fb069; }
        .results .bad { color: #e07a5f; }
        .note { opacity: .7; max-width: 60em; margin-bottom: 12px; line-height: 1.5; }
        canvas { display: block; border: 1px solid rgba(128,128,128,.3); }
        .domtarget { height: 300px; overflow: hidden; }
        .ghosttyhost { width: 800px; height: 300px; overflow: hidden; }
    `],
})
export class GhosttyBenchTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    @ViewChild('cv') cv: ElementRef
    @ViewChild('dom') dom: ElementRef
    @ViewChild('gh') gh: ElementRef

    @HostBinding('class.ghostty-bench-tab') hostClass = true

    build = BUILD_STAMP
    running = false
    status = 'idle'
    results: ProbeResult[] = []

    private rafHandle: number | null = null
    private disposed = false
    private tickCount = 0
    private tickMs = 0
    private restoreTick: (() => void) | null = null
    private engine: any = null

    constructor (
        injector: Injector,
        private zone: NgZone,
        private appRef: ApplicationRef,
    ) {
        super(injector)
        this.setTitle('Render Benchmark')
    }

    ngOnInit (): void {
        this.instrumentTick()
    }

    /**
     * Count and time `ApplicationRef.tick()`.
     *
     * The static reading of the bundles says one tick fires per chunk of
     * terminal output, over a Default-strategy tree. This turns that into a
     * number: if ticks/sec tracks chunks/sec and each tick is expensive, the
     * hypothesis holds; if ticks are rare or cheap, it does not and the fix
     * plan should stop rather than ship something speculative.
     */
    private instrumentTick (): void {
        const ref: any = this.appRef
        if (typeof ref.tick !== 'function' || ref.__ghosttyTickPatched) {
            return
        }
        const original = ref.tick.bind(ref)
        const self = this
        const patched = function (this: any, ...args: any[]): any {
            const t0 = performance.now()
            try {
                return original(...args)
            } finally {
                self.tickCount++
                self.tickMs += performance.now() - t0
            }
        }
        ref.tick = patched
        ref.__ghosttyTickPatched = true
        this.restoreTick = () => {
            ref.tick = original
            delete ref.__ghosttyTickPatched
        }
    }

    /**
     * Run one probe for `secs`, outside the Angular zone.
     *
     * Running the loop itself outside the zone is deliberate: if the probe's
     * own rAF callbacks triggered change detection, the benchmark would be
     * measuring itself rather than the host.
     */
    private probe (name: string, work: (frame: number) => void, secs = 4): Promise<ProbeResult> {
        return new Promise(resolve => {
            this.zone.runOutsideAngular(() => {
                let frames = 0
                const ticks0 = this.tickCount
                const tickMs0 = this.tickMs
                const t0 = performance.now()
                const tick = (): void => {
                    if (this.disposed) {
                        return
                    }
                    frames++
                    work(frames)
                    const elapsed = performance.now() - t0
                    if (elapsed < secs * 1000) {
                        this.rafHandle = requestAnimationFrame(tick)
                    } else {
                        this.rafHandle = null
                        resolve({
                            name,
                            frames,
                            ms: elapsed,
                            fps: frames / (elapsed / 1000),
                            ticks: this.tickCount - ticks0,
                            tickMs: this.tickMs - tickMs0,
                        })
                    }
                }
                this.rafHandle = requestAnimationFrame(tick)
            })
        })
    }

    async run (): Promise<void> {
        if (this.running) {
            return
        }
        this.running = true
        this.results = []
        this.status = 'running…'

        const ctx = this.cv.nativeElement.getContext('2d')
        const domEl = this.dom.nativeElement

        const probes: Array<[string, (n: number) => void]> = [
            ['A raw rAF loop', () => { /* scheduling ceiling only */ }],
            ['B canvas paint', (n: number) => {
                ctx.fillStyle = '#0f1419'
                ctx.fillRect(0, 0, 800, 400)
                ctx.fillStyle = '#e6e1cf'
                ctx.font = '12px monospace'
                for (let r = 0; r < 40; r++) {
                    ctx.fillText(`row ${r} frame ${n} ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, 4, 12 + r * 10)
                }
            }],
            ['C DOM mutation', (n: number) => { domEl.textContent = `frame ${n}` }],
            ['D DOM churn 200 nodes', (n: number) => {
                let h = ''
                for (let r = 0; r < 200; r++) {
                    h += `<div>row ${r} f${n}</div>`
                }
                domEl.innerHTML = h
            }],
        ]

        // E: drive a real ghostty-web engine directly, with no Tabby session,
        // no middleware stack and no PTY. If the engine sustains full refresh
        // here while a Ghostty *tab* caps at ~43 fps under streaming, the cap
        // is the pipeline feeding it rather than the renderer.
        const engine = await this.makeEngine()
        if (engine) {
            probes.push(['E ghostty engine direct', (n: number) => {
                let out = ''
                for (let r = 0; r < 40; r++) {
                    out += `row ${r} frame ${n} ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\r\n`
                }
                engine.write(out)
            }])
        }

        for (const [name, work] of probes) {
            if (this.disposed) {
                return
            }
            const result = await this.probe(name, work)
            // Re-enter the zone only to publish each row, so the table updates
            // without the probe loop itself driving change detection.
            this.zone.run(() => {
                this.results = [...this.results, result]
                this.status = `${this.results.length}/${probes.length} done`
            })
        }

        domEl.innerHTML = ''
        this.zone.run(() => {
            this.running = false
            this.status = 'done — run again with a terminal streaming to compare'
        })
    }

    /**
     * Build a standalone ghostty-web terminal in this tab.
     *
     * Mirrors what GhosttyTabComponent does (`init()` then `new Terminal(...)`
     * then `open(host)`), but is fed synthetic writes rather than a session, so
     * nothing of Tabby's output pipeline is in the path.
     */
    private async makeEngine (): Promise<any | null> {
        if (this.engine) {
            return this.engine
        }
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const gw = require('ghostty-web')
            await gw.init()
            const term = new gw.Terminal({
                cols: 120,
                rows: 30,
                fontSize: 12,
                theme: { background: '#0f1419', foreground: '#e6e1cf' },
            })
            term.open(this.gh.nativeElement)
            this.engine = term
            return term
        } catch (error) {
            console.warn('[ghostty-bench] could not start engine:', error)
            return null
        }
    }

    ngOnDestroy (): void {
        // BaseTabComponent.ngOnDestroy() calls destroy() and then
        // BaseComponent.ngOnDestroy(), which cancels subscriptions.
        super.ngOnDestroy()
    }

    destroy (skipDestroyedEvent = false): void {
        // A benchmark tab that keeps running after it is closed silently taints
        // every later measurement, so stop the loop before anything else.
        this.disposed = true
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle)
            this.rafHandle = null
        }
        try {
            this.restoreTick?.()
        } catch {
            // Non-fatal: the patch is idempotent and guarded by a flag.
        }
        this.restoreTick = null
        try {
            this.engine?.dispose?.()
        } catch {
            // Engine already gone; nothing to release.
        }
        this.engine = null
        super.destroy(skipDestroyedEvent)
    }
}
