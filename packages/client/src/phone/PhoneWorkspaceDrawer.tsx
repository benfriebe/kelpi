/**
 * The workspace drawer (B3's left drawer, grown for the owner's multi-host request and rebuilt in
 * B9): the sheet, and the phone's ONE host tree inside it (`phone/PhoneHostTree.tsx`).
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * What B9 changed here, from the owner on a real Android phone (2026-09-08, device round 11):
 * *"It does look weird with one sidebar showing all hosts, and one showing only workspaces from
 * one host."* B7's drawer listed one host's workspaces with an `All hosts` row at the top back to
 * the landing page - a second level of the same tree, in a second surface. Now the drawer IS all
 * hosts: every host is a section, the one whose workspace is on screen open and the others closed
 * to their header with their counts, and a tap on any workspace under any host switches host and
 * workspace in one move. So the `All hosts` row is gone - there is nowhere else it could take you.
 * The header's Hosts button still opens the landing page, which is the same tree full-screen.
 *
 * The drawer keeps New workspace at its foot (a verb, not a place); Add host lives at the end of
 * the tree, where the hosts are.
 */

import { type ReactElement } from 'react';

import { ChromeIcon } from '../chrome/icons';
import { tokens } from '../chrome/tokens';
import type { ChromeBucket } from '../chrome/theme';
import type { PhoneHostModel, PhoneWorkspaceSelection } from './model';
import { PhoneHostTree } from './PhoneHostTree';
import { PhoneButton, PhoneSheet, PhoneSheetHeader } from './ui';
import type { PhoneHostExpansion } from './view';

export interface PhoneWorkspaceDrawerProps {
    readonly open: boolean;
    readonly hosts: readonly PhoneHostModel[];
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    /** The host on screen: the section the drawer opens expanded (`PhoneHostTree.tsx`). */
    readonly currentHostKey: string;
    /** Which sections are open, remembered on the phone and shared with the landing page. */
    readonly expansion: PhoneHostExpansion;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onNewWorkspace: () => void;
    readonly onAddHost: () => void;
    readonly onRemoveHost: (hostKey: string) => void;
    readonly onClose: () => void;
}

export function PhoneWorkspaceDrawer(props: PhoneWorkspaceDrawerProps): ReactElement | null {
    return (
        <PhoneSheet open={props.open} side="left" label="Workspaces" testID="phone-workspace-drawer" onClose={props.onClose}>
            {/* Still "Workspaces": the drawer is opened by the header's Workspaces button and a
                workspace is what it is for. The hosts are how the workspaces are grouped. */}
            <PhoneSheetHeader title="Workspaces" testID="phone-workspace-drawer-header" onClose={props.onClose} />
            <PhoneHostTree
                presentation="drawer"
                hosts={props.hosts}
                selection={props.selection}
                bucket={props.bucket}
                currentHostKey={props.currentHostKey}
                expansion={props.expansion}
                onSelect={(selection) => {
                    props.onSelect(selection);
                    props.onClose();
                }}
                onAddHost={props.onAddHost}
                onRemoveHost={props.onRemoveHost}
            />
            <div className="flex shrink-0 items-center border-t px-1" style={{ borderColor: tokens.divider }}>
                <PhoneButton testID="phone-new-workspace" onClick={props.onNewWorkspace}>
                    <ChromeIcon name="plus" size={12} />
                    New workspace
                </PhoneButton>
            </div>
        </PhoneSheet>
    );
}
