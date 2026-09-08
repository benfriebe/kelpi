/**
 * The phone's landing page (B7, owner request 2026-09-08, after driving the B1 shell on a real
 * Android phone: *"a landing page / dashboard to pick a host, with local state"*; rebuilt in B9
 * from the same owner's next round).
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * It is the shell's THIRD top-level state, beside `pane` and `layout` (`phone/view.ts`), and
 * deliberately not a sheet: a sheet is laid over what you were looking at and is dismissed back to
 * it, and this is where the phone STARTS. That is also why it registers nothing with
 * `chrome/modal-presence.ts` - it is not an overlay, there is nothing behind it to park - while
 * the Add-host sheet it opens does, like every other phone sheet.
 *
 * **What B9 changed.** Owner, device round 11, 2026-09-08: *"It does look weird with one sidebar
 * showing all hosts, and one showing only workspaces from one host."* B7 had this page as a list
 * of host CARDS you tapped into to reach one host's workspaces, while the drawer showed one host's
 * workspaces with an `All hosts` row back here: two surfaces over two levels of one tree. Now both
 * draw the SAME tree (`phone/PhoneHostTree.tsx`) - hosts, each with its workspaces under it, Add
 * host at the end - and this page is that tree full-screen with every section expanded, because
 * this is where a person is choosing and a choice you have to drill into twice is not one. The
 * card look B7 gave a host stays, as the section header. There is no drill-in step left, so there
 * is no way back UP from inside one host either: the whole tree is always on screen.
 *
 * It writes NOTHING to any daemon. Opening a workspace is the shell's `onSelect`, which is the
 * same verb the drawer's rows use; the landing page itself never moves focus and never activates
 * anything (MOBILE-PLAN.md §7: the shown pane is the daemon's focused pane, one owner). Which
 * sections are open is this phone's own memory (`phone/view.ts`), shared with the drawer, and the
 * remembered PLACE (`phone/place.ts`) is still only written when a workspace is actually opened -
 * so putting the phone down here brings it back here.
 */

import { type ReactElement } from 'react';

import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { PhoneHostModel, PhoneWorkspaceSelection } from './model';
import { PhoneHostTree } from './PhoneHostTree';
import type { PhoneHostExpansion } from './view';

export interface PhoneLandingProps {
    readonly hosts: readonly PhoneHostModel[];
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    /** Which sections are open, remembered on the phone and shared with the drawer. */
    readonly expansion: PhoneHostExpansion;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onAddHost: () => void;
    readonly onRemoveHost: (hostKey: string) => void;
}

export function PhoneLanding(props: PhoneLandingProps): ReactElement {
    return (
        <div
            data-testid="phone-landing"
            className="flex h-full min-h-0 flex-col overflow-y-auto"
            style={{ background: tokens.windowBackground }}
        >
            {/* No `currentHostKey`: every section is open here, so there is no default to aim. */}
            <PhoneHostTree
                presentation="landing"
                hosts={props.hosts}
                selection={props.selection}
                bucket={props.bucket}
                expansion={props.expansion}
                onSelect={props.onSelect}
                onAddHost={props.onAddHost}
                onRemoveHost={props.onRemoveHost}
            />
            <span className="px-4 pb-3 text-[11px]" style={{ color: tokens.textTertiary }}>
                A host is added by pasting its pairing URL from Settings ▸ Remote on that machine. The list lives on this
                phone.
            </span>
        </div>
    );
}
