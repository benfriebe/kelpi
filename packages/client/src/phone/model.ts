/**
 * The phone shell's host model: every daemon this phone can show, in one shape.
 *
 *   - `origin`      the daemon that served this page; its runtime is assembly's own
 *   - `configured`  a `remote-daemon` line in the origin's config (§1.7), dialled by assembly
 *   - `phone`       an entry in the phone's own list (`phone/hosts.ts`), dialled by the shell
 *
 * A workspace on screen is `{host, workspaceID}`; the origin's is the assembly's active
 * workspace and is not a selection of its own (`phone/view.ts` `remote`).
 */

import type { KelpiRuntime } from '../state';

export const ORIGIN_HOST_KEY = 'origin';

export type PhoneHostKind = 'origin' | 'configured' | 'phone';

export interface PhoneHostModel {
    readonly key: string;
    readonly name: string;
    readonly kind: PhoneHostKind;
    readonly runtime: KelpiRuntime;
    /** Only the phone's own entries can be removed from the phone. */
    readonly removable: boolean;
}

export interface PhoneWorkspaceSelection {
    readonly host: string;
    readonly workspaceID: string;
}
