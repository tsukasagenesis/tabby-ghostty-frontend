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
