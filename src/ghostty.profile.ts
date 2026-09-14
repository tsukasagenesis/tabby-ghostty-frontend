import { Injectable } from '@angular/core'
import {
    ProfileProvider,
    Profile,
    PartialProfile,
    NewTabParameters,
    TabRecoveryProvider,
    RecoveryToken,
} from 'tabby-core'
import { GhosttyTabComponent } from './ghostty.tab.component'
import { GhosttySessionOptions } from './ghostty.session'

export interface GhosttyProfile extends Profile {
    type: 'ghostty'
    options: GhosttySessionOptions
}

@Injectable({ providedIn: 'root' })
export class GhosttyProfileProvider extends ProfileProvider<GhosttyProfile> {
    id = 'ghostty'
    name = 'Ghostty'
    supportsQuickConnect = false
    configDefaults = {
        options: {
            command: null,
            args: [],
            cwd: null,
            env: {},
        },
    }

    async getBuiltinProfiles (): Promise<PartialProfile<GhosttyProfile>[]> {
        return [
            {
                id: 'ghostty:default',
                type: 'ghostty',
                name: 'Ghostty Terminal',
                icon: 'fas fa-ghost',
                options: {},
                isBuiltin: true,
            },
        ]
    }

    async getNewTabParameters (profile: GhosttyProfile): Promise<NewTabParameters<GhosttyTabComponent>> {
        return {
            type: GhosttyTabComponent,
            inputs: {
                sessionOptions: profile.options ?? {},
            },
        }
    }

    getDescription (profile: PartialProfile<GhosttyProfile>): string {
        return profile.options?.command ?? 'Local shell rendered by Ghostty'
    }
}

@Injectable({ providedIn: 'root' })
export class GhosttyTabRecoveryProvider extends TabRecoveryProvider<GhosttyTabComponent> {
    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:ghostty-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<GhosttyTabComponent>> {
        return {
            type: GhosttyTabComponent,
            inputs: {
                sessionOptions: recoveryToken.sessionOptions ?? {},
            },
        }
    }
}
