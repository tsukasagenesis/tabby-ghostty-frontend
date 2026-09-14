import { Component, Injectable } from '@angular/core'
import { ConfigProvider, ConfigService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

/** Default config for this plugin. */
export class GhosttyConfigProvider extends ConfigProvider {
    defaults = {
        ghostty: {
            // Off by default: this replaces the terminal engine in every tab
            // by patching a Tabby internal, so it must be opted into.
            replaceTerminalFrontend: false,
            // Output arriving before the WASM engine has loaded is buffered
            // and replayed once the terminal opens. Capped so a tab that never
            // finishes attaching cannot grow without bound.
            writeBufferLimitMB: 1,

            // --- Ghostty engine options with no Tabby equivalent ---

            // ghostty-web's smooth-scroll easing, in ms. 0 = instant jumps.
            // Read live by the scroll animation, so it applies immediately.
            smoothScrollDuration: 100,

            // Translate bare \n to \r\n on output. Off matches xterm.js;
            // turn on only for programs that emit bare newlines.
            convertEol: false,

            // Read-only terminal: keystrokes are not forwarded to the session.
            disableStdin: false,

            // Load the WASM engine at startup instead of on first tab, so the
            // first terminal has nothing to buffer.
            preloadEngine: true,

            // Log frontend lifecycle to the developer console.
            debugLogging: false,
        },
    }

    platformDefaults = { }
}

@Component({
    template: `
        <div class="content-box">
            <h3 class="mb-3">Ghostty</h3>

            <div class="form-line">
                <div class="header">
                    <div class="title">Use Ghostty in all terminal tabs</div>
                    <div class="description">
                        Renders every terminal tab with Ghostty's VT engine instead of xterm.js.
                        Takes effect on newly opened tabs.
                    </div>
                </div>
                <toggle
                    [(ngModel)]="config.store.ghostty.replaceTerminalFrontend"
                    (ngModelChange)="config.save()"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Startup output buffer</div>
                    <div class="description">
                        Megabytes of terminal output held while Ghostty's WASM engine loads,
                        replayed once the terminal opens. Raise it if the start of a session's
                        output is missing on slow machines; 0 disables buffering.
                    </div>
                </div>
                <input
                    type="number"
                    class="form-control"
                    min="0"
                    max="64"
                    step="0.5"
                    [(ngModel)]="config.store.ghostty.writeBufferLimitMB"
                    (ngModelChange)="config.save()">
            </div>

            <h3 class="mb-3 mt-4">Engine</h3>

            <div class="form-line">
                <div class="header">
                    <div class="title">Smooth scrolling duration</div>
                    <div class="description">
                        Milliseconds of easing when the viewport scrolls. 0 jumps instantly.
                        Applies immediately, no new tab needed.
                    </div>
                </div>
                <input
                    type="number"
                    class="form-control"
                    min="0"
                    max="1000"
                    step="10"
                    [(ngModel)]="config.store.ghostty.smoothScrollDuration"
                    (ngModelChange)="config.save()">
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Preload the WASM engine at startup</div>
                    <div class="description">
                        Loads Ghostty's 413 KB WASM module when Tabby starts rather than when
                        the first terminal opens, so no output has to be buffered. Turn off to
                        save memory if you rarely use Ghostty tabs.
                    </div>
                </div>
                <toggle
                    [(ngModel)]="config.store.ghostty.preloadEngine"
                    (ngModelChange)="config.save()"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Translate newlines (convertEol)</div>
                    <div class="description">
                        Treat a bare <code>\n</code> as <code>\r\n</code>. Off matches xterm.js;
                        enable only for programs whose output stair-steps down the screen.
                    </div>
                </div>
                <toggle
                    [(ngModel)]="config.store.ghostty.convertEol"
                    (ngModelChange)="config.save()"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Read-only terminal (disableStdin)</div>
                    <div class="description">
                        Render output but do not forward keystrokes to the session.
                        Useful for log-watching tabs.
                    </div>
                </div>
                <toggle
                    [(ngModel)]="config.store.ghostty.disableStdin"
                    (ngModelChange)="config.save()"></toggle>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Debug logging</div>
                    <div class="description">
                        Log frontend attach, resize and failure details to the developer
                        console (Ctrl+Shift+I).
                    </div>
                </div>
                <toggle
                    [(ngModel)]="config.store.ghostty.debugLogging"
                    (ngModelChange)="config.save()"></toggle>
            </div>

            <div class="alert alert-info">
                <div>
                    <strong>How this works.</strong>
                    Tabby chooses its terminal frontend from a hardcoded list inside
                    <code>BaseTerminalTabComponent.ngOnInit</code>:
                    <code>{{ '{' }} xterm, 'xterm-webgl' {{ '}' }}[config.terminal.frontend] ?? XTermFrontend</code>.
                    That object is rebuilt on every call and there is no provider token for it,
                    so a plugin cannot add a third entry, and the
                    <em>Settings &rarr; Terminal &rarr; Frontend</em> dropdown will never list Ghostty.
                    <br><br>
                    With this switch on, the plugin wraps that method and substitutes its own
                    frontend as the tab builds, before Tabby subscribes to it. If anything goes
                    wrong the tab falls back to xterm.js and the reason is logged to the
                    developer console.
                    <br><br>
                    This depends on a Tabby internal and may break on a Tabby update. The
                    <strong>Ghostty Terminal</strong> profile is unaffected either way &mdash; it is a
                    separate tab type that does not patch anything.
                </div>
            </div>

            <div class="alert alert-warning">
                <div>
                    <strong>Known gaps.</strong>
                    ghostty-web ships no search or serialize addon yet, so the terminal search
                    panel and scrollback restore are inactive in Ghostty-rendered tabs.
                    <br><br>
                    These Appearance settings have no equivalent in ghostty-web and are
                    <em>not</em> applied to Ghostty tabs:
                    line padding, font weight / bold font weight, font ligatures,
                    minimum contrast ratio, "draw bold text in bright colors",
                    word separator, "Alt is Meta", and sixel images.
                    Font family, font size, cursor style, cursor blink, scrollback lines,
                    color scheme, background transparency and copy-on-select are applied.
                    <br><br>
                    Color scheme changes apply to newly opened tabs: ghostty-web does not
                    yet support swapping a terminal's theme after it has opened.
                </div>
            </div>

            <div class="alert alert-secondary">
                <div>
                    <strong>Deliberately not offered.</strong>
                    These would be useful, but ghostty-web does not expose them, so a switch
                    here would do nothing:
                    <br><br>
                    <strong>Keyboard protocol options</strong> &mdash; application cursor/keypad
                    mode, <code>Alt</code> as <code>ESC</code> prefix, xterm
                    <code>modifyOtherKeys</code>, and the Kitty keyboard protocol flags all live
                    on <code>KeyEncoder</code>, which <code>Terminal</code> builds internally as a
                    private field with no accessor.
                    <br>
                    <strong>Renderer scale</strong> (<code>devicePixelRatio</code>) &mdash;
                    accepted by <code>CanvasRenderer</code>, but <code>Terminal.open()</code>
                    constructs the renderer without forwarding it.
                    <br>
                    <strong>Scrollbar hide delay and fade duration</strong> &mdash;
                    <code>private readonly</code> constants.
                    <br><br>
                    They should become available as ghostty-web matures.
                </div>
            </div>
        </div>
    `,
})
export class GhosttySettingsTabComponent {
    constructor (public config: ConfigService) { }
}

@Injectable()
export class GhosttySettingsTabProvider extends SettingsTabProvider {
    id = 'ghostty'
    icon = 'ghost'
    title = 'Ghostty'

    getComponentType (): any {
        return GhosttySettingsTabComponent
    }
}
