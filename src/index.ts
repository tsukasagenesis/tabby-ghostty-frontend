import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { ProfileProvider, TabRecoveryProvider } from 'tabby-core'

import { GhosttyTabComponent } from './ghostty.tab.component'
import { GhosttyProfileProvider, GhosttyTabRecoveryProvider } from './ghostty.profile'

/**
 * Adds a terminal tab type rendered by Ghostty's VT engine (ghostty-web/WASM).
 *
 * Tabby's own frontend selection is a hardcoded map in
 * `BaseTerminalTabComponent.ngOnInit`, so this ships as its own tab type
 * and profile rather than as a replacement frontend.
 */
@NgModule({
    imports: [
        CommonModule,
    ],
    declarations: [
        GhosttyTabComponent,
    ],
    providers: [
        { provide: ProfileProvider, useClass: GhosttyProfileProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: GhosttyTabRecoveryProvider, multi: true },
    ],
})
export default class GhosttyFrontendModule { }

export { GhosttyTabComponent, GhosttyProfileProvider }
