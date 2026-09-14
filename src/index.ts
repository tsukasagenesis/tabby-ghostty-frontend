import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCoreModule, { ProfileProvider, TabRecoveryProvider } from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'

import { GhosttyTabComponent } from './ghostty.tab.component'
import { GhosttyProfileProvider, GhosttyTabRecoveryProvider } from './ghostty.profile'

/**
 * Adds a terminal tab type rendered by Ghostty's VT engine (ghostty-web/WASM).
 *
 * Tabby's own frontend selection is a hardcoded map in
 * `BaseTerminalTabComponent.ngOnInit`, so this ships as its own tab type
 * and profile rather than as a replacement frontend.
 *
 * `TabbyCoreModule` / `TabbyTerminalModule` must be imported: `ProfilesService`
 * only surfaces providers that survive `ConfigService.enabledServices()`, which
 * matches instances against the provider classes registered by a plugin module.
 * The providers use `useExisting` against root-injectable services, mirroring
 * how tabby-ssh registers `SSHProfilesService`.
 */
@NgModule({
    imports: [
        CommonModule,
        TabbyCoreModule,
        TabbyTerminalModule,
    ],
    declarations: [
        GhosttyTabComponent,
    ],
    providers: [
        { provide: ProfileProvider, useExisting: GhosttyProfileProvider, multi: true },
        { provide: TabRecoveryProvider, useExisting: GhosttyTabRecoveryProvider, multi: true },
    ],
})
export default class GhosttyFrontendModule { }

export { GhosttyTabComponent, GhosttyProfileProvider }
