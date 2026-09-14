import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider, ProfileProvider, TabRecoveryProvider } from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'
import { SettingsTabProvider } from 'tabby-settings'

import { GhosttyTabComponent } from './ghostty.tab.component'
import { GhosttyProfileProvider, GhosttyTabRecoveryProvider } from './ghostty.profile'
import { GhosttyConfigProvider, GhosttySettingsTabComponent, GhosttySettingsTabProvider } from './ghostty.settings'
import { GhosttyFrontendPatch } from './ghostty.patch'

/**
 * Ghostty's VT engine (ghostty-web/WASM) for Tabby, in two independent parts:
 *
 * 1. A `Ghostty Terminal` profile opening its own tab type. Uses only public
 *    extension points and is always available.
 *
 * 2. An opt-in patch (Settings -> Ghostty) that replaces the frontend in
 *    Tabby's own terminal tabs. Tabby resolves its frontend from a hardcoded
 *    object literal inside `BaseTerminalTabComponent.ngOnInit`, with no
 *    provider token to extend, so this is the only way to reach normal tabs.
 *
 * `ProfilesService` only surfaces providers that survive
 * `ConfigService.enabledServices()`, which matches instances against the
 * provider classes a plugin module registers - hence `useExisting` against
 * root-injectable services, and the TabbyCoreModule/TabbyTerminalModule
 * imports, mirroring tabby-ssh.
 */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
        TabbyTerminalModule,
    ],
    declarations: [
        GhosttyTabComponent,
        GhosttySettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: GhosttyConfigProvider, multi: true },
        { provide: ProfileProvider, useExisting: GhosttyProfileProvider, multi: true },
        { provide: TabRecoveryProvider, useExisting: GhosttyTabRecoveryProvider, multi: true },
        { provide: SettingsTabProvider, useClass: GhosttySettingsTabProvider, multi: true },
    ],
})
export default class GhosttyFrontendModule {
    constructor (patch: GhosttyFrontendPatch) {
        // Installed unconditionally; the wrapper is a no-op per tab while the
        // setting is off, so toggling it does not require re-patching.
        patch.apply()
    }
}

export { GhosttyTabComponent, GhosttyProfileProvider, GhosttyFrontendPatch }
