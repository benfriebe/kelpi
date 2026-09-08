/**
 * The phone's landing page (B7, owner request 2026-09-08, after driving the B1 shell on a real
 * Android phone: *"a landing page / dashboard to pick a host, with local state"*).
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it). The
 * Mac shows every host at once in one sidebar; a phone has room for one host's workspaces, so it
 * gets a screen for choosing between hosts and a screen for working inside one.
 *
 * It is the shell's THIRD top-level state, beside `pane` and `layout` (`phone/view.ts`), and
 * deliberately not a sheet: a sheet is laid over what you were looking at and is dismissed back to
 * it, and this is where the phone STARTS. That is also why it registers nothing with
 * `chrome/modal-presence.ts` - it is not an overlay, there is nothing behind it to park - while
 * the Add-host sheet it opens does, like every other phone sheet.
 *
 * Two levels, both in this one screen:
 *
 *   1. **the host list** - one card per host (`phone/model.ts`): the origin first, then the
 *      origin's configured `remote-daemon` peers, then the phone's own entries. Each card carries
 *      what a person picks a host BY: its name, whether it is reachable, and how much is running
 *      on it (workspaces, agents running, agents waiting). Counts come from that host's own store
 *      mirror, so a host that has not answered yet shows its connection state and no numbers
 *      rather than a confident zero;
 *   2. **one host's workspaces** - the same `WorkspaceRow`/`GroupHeaderRow` rows the drawer draws
 *      (`PhoneHostWorkspaceList`), so a row here is pixel-identical to the same row in the drawer
 *      and on the Mac.
 *
 * It writes NOTHING to any daemon. Opening a workspace is the shell's `onSelect`, which is the
 * same verb the drawer's rows use; the landing page itself never moves focus and never activates
 * anything (MOBILE-PLAN.md §7: the shown pane is the daemon's focused pane, one owner).
 */

import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';

import { ChromeIcon } from '../chrome/icons';
import { agentCounts } from '../chrome/Sidebar';
import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ChromeWorkspace } from '../chrome/types';
import type { ConnectionStatus } from '../connection';
import type { PhoneHostModel, PhoneWorkspaceSelection } from './model';
import { connectionDotColor, PhoneHostWorkspaceList } from './PhoneWorkspaceDrawer';
import { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton } from './ui';

export interface PhoneLandingProps {
    readonly hosts: readonly PhoneHostModel[];
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onAddHost: () => void;
    readonly onRemoveHost: (hostKey: string) => void;
}

/** The words a card puts beside its dot; the drawer's own vocabulary, spelled for a card. */
export function reachabilityLabel(status: ConnectionStatus): string {
    if (status === 'connected') return 'reachable';
    if (status === 'connecting') return 'connecting…';
    if (status === 'reconnecting') return 'reconnecting…';
    if (status === 'rejected') return 'refused';
    return 'unreachable';
}

function HostCard(props: {
    readonly host: PhoneHostModel;
    readonly onOpen: () => void;
    readonly onRemove: (() => void) | null;
}): ReactElement {
    const { host } = props;
    const connection = useStore(host.runtime.store, (state) => state.ui.connection);
    const workspaces = useStore(host.runtime.store, (state) => state.daemon.state.workspaces);
    // "Where known": a host whose snapshot has not landed has no roster to count, and a zero would
    // read as "nothing is running there" rather than "nobody has told us yet".
    const known = useStore(host.runtime.store, (state) => state.daemon.hasSnapshot);
    const counts = agentCounts(workspaces as unknown as readonly ChromeWorkspace[]);

    return (
        <div
            className="flex shrink-0 items-stretch rounded-lg"
            data-testid={`phone-landing-host-${host.key}`}
            data-host-kind={host.kind}
            data-status={connection}
            style={{ background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}` }}
        >
            <button
                type="button"
                data-testid={`phone-landing-open-${host.key}`}
                aria-label={`${host.name} workspaces`}
                className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-4 py-3 text-left"
                style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
                onClick={props.onOpen}
            >
                <span className="flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden
                        className="h-[8px] w-[8px] shrink-0 rounded-full"
                        data-testid={`phone-landing-status-${host.key}`}
                        data-status={connection}
                        style={{ background: connectionDotColor(connection) }}
                    />
                    <span className="truncate text-[16px] font-semibold" style={{ color: tokens.textPrimary }}>
                        {host.name}
                    </span>
                    <span className="ml-auto shrink-0" style={{ color: tokens.textTertiary }}>
                        <ChromeIcon name="chevron-right" size={12} />
                    </span>
                </span>
                <span
                    className="truncate text-[12px]"
                    data-testid={`phone-landing-summary-${host.key}`}
                    style={{ color: tokens.textSecondary }}
                >
                    {known
                        ? [
                              `${String(workspaces.length)} ${workspaces.length === 1 ? 'workspace' : 'workspaces'}`,
                              counts.running > 0 ? `${String(counts.running)} running` : null,
                              counts.waiting > 0 ? `${String(counts.waiting)} waiting` : null
                          ]
                              .filter((part) => part !== null)
                              .join(' · ')
                        : reachabilityLabel(connection)}
                </span>
            </button>
            {props.onRemove === null ? null : (
                <PhoneButton testID={`phone-landing-remove-${host.key}`} ariaLabel={`Remove ${host.name}`} onClick={props.onRemove}>
                    <ChromeIcon name="clear" size={12} />
                </PhoneButton>
            )}
        </div>
    );
}

export function PhoneLanding(props: PhoneLandingProps): ReactElement {
    /*
     * Which card is open is this screen's own state and nothing else's: it is not remembered, and
     * it is not the remembered PLACE (`phone/place.ts`), which is only written when a workspace is
     * actually opened. Opening a card and putting the phone down leaves the phone on the landing
     * page, which is what the person did.
     */
    const [openHostKey, setOpenHostKey] = useState<string | null>(null);
    // A host removed (or dropped from the origin's config) while its workspaces are open falls
    // back to the host list by resolving to nothing; no effect, no cleanup, no stale runtime.
    const openHost = openHostKey === null ? null : (props.hosts.find((host) => host.key === openHostKey) ?? null);

    if (openHost !== null) {
        return (
            <div
                data-testid="phone-landing"
                data-phone-landing-host={openHost.key}
                className="flex h-full min-h-0 flex-col overflow-y-auto"
                style={{ background: tokens.windowBackground }}
            >
                <div className="flex shrink-0 items-center gap-2 border-b px-1" style={{ borderColor: tokens.divider }}>
                    <PhoneButton testID="phone-landing-back" ariaLabel="All hosts" onClick={() => setOpenHostKey(null)}>
                        <span aria-hidden className="inline-flex rotate-180">
                            <ChromeIcon name="chevron-right" size={12} />
                        </span>
                        All hosts
                    </PhoneButton>
                    <span className="truncate text-[13px] font-semibold" style={{ color: tokens.textPrimary }}>
                        {openHost.name}
                    </span>
                </div>
                <PhoneHostWorkspaceList
                    host={openHost}
                    selection={props.selection}
                    bucket={props.bucket}
                    onSelect={props.onSelect}
                />
            </div>
        );
    }

    return (
        <div
            data-testid="phone-landing"
            data-phone-landing-host=""
            className="flex h-full min-h-0 flex-col overflow-y-auto"
            style={{ background: tokens.windowBackground }}
        >
            <div className="flex flex-col gap-2 p-3" data-testid="phone-landing-hosts" style={{ paddingBottom: PHONE_SAFE_AREA.bottom }}>
                {props.hosts.map((host) => (
                    <HostCard
                        key={host.key}
                        host={host}
                        onOpen={() => setOpenHostKey(host.key)}
                        onRemove={host.removable ? () => props.onRemoveHost(host.key) : null}
                    />
                ))}
                <PhoneButton testID="phone-landing-add-host" onClick={props.onAddHost}>
                    <ChromeIcon name="plus" size={12} />
                    Add host
                </PhoneButton>
                <span className="px-1 text-[11px]" style={{ color: tokens.textTertiary }}>
                    A host is added by pasting its pairing URL from Settings ▸ Remote on that machine. The list lives on this
                    phone.
                </span>
            </div>
        </div>
    );
}
