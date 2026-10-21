/**
 * The small pieces Home, the location bar, the picker and the Needs-you sheet share: a workspace's
 * avatar, a host's reachability dot, the waiting badge, the attention pill, and the glyph a pane
 * type wears. One place, so the four surfaces cannot drift into four looks for the same fact.
 */

import type { ReactElement, ReactNode } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';

import { avatarLetter, iconGlyph } from '../chrome/icons';
import { workspaceColorHex, type ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ConnectionStatus } from '../connection';
import { paneDisplayTitle, type PaneModel } from '../grid';
import { PhoneGlyph, type PhoneGlyphName } from './glyphs';
import type { PhoneHostKind } from './model';
import { phoneStyle, textOn } from './style';

/** The glyph a pane wears in the picker, a workspace tile and the Needs-you cards. */
export function paneTypeGlyph(pane: Pick<PaneModel, 'type' | 'agentKind'>): PhoneGlyphName {
    if (pane.agentKind !== null) return 'agent';
    switch (pane.type) {
        case 'markdown':
            return 'doc';
        case 'diff':
            return 'diff';
        case 'scratchpad':
            return 'note';
        case 'csv':
            return 'table';
        case 'image':
            return 'image';
        case 'web':
            return 'globe';
        case 'plugin':
            return 'plugin';
        default:
            return 'terminal';
    }
}

/**
 * What the phone calls a pane: the name a person gave it, else the agent running in it ("claude"),
 * else the desktop's own title (the terminal's title, then its directory). An agent's pane is
 * named by the agent because that is what a person is looking for in a list of six.
 */
export function phonePaneTitle(pane: PaneModel, homeDirectory: string): string {
    if (pane.label !== null && pane.label.length > 0) return pane.label;
    return pane.agentKind ?? paneDisplayTitle(pane, homeDirectory);
}

/** The dot beside a host's name: green when reachable, amber while dialling, grey otherwise. */
export function hostDotColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    return tokens.statusInactive;
}

/** What kind of host it is, in the words a host card puts before its reachability. */
export function hostKindLabel(kind: PhoneHostKind): string {
    if (kind === 'origin') return 'Origin';
    if (kind === 'configured') return 'Remote';
    return 'Added on this phone';
}

/** The words a host says when it is not simply reachable. */
export function hostReachability(status: ConnectionStatus): string {
    if (status === 'connected') return 'reachable';
    if (status === 'connecting') return 'connecting…';
    if (status === 'reconnecting') return 'reconnecting…';
    if (status === 'rejected') return 'refused';
    return 'unreachable';
}

export function HostDot(props: { readonly status: ConnectionStatus; readonly size?: number }): ReactElement {
    const size = props.size ?? 7;
    return (
        <span
            aria-hidden
            data-status={props.status}
            className="shrink-0 rounded-full"
            style={{ width: size, height: size, background: hostDotColor(props.status) }}
        />
    );
}

/** A workspace's avatar: its colour as the fill, its icon or first letter on it. */
export function WorkspaceAvatar(props: {
    readonly workspace: Pick<WorkspaceState, 'name' | 'color' | 'icon'>;
    readonly bucket: ChromeBucket;
    readonly size?: number;
}): ReactElement {
    const size = props.size ?? 28;
    const glyph = iconGlyph(props.workspace.icon);
    const fill = workspaceColorHex(props.workspace.color, props.bucket);
    return (
        <span
            aria-hidden
            className="flex shrink-0 items-center justify-center font-bold"
            style={{
                width: size,
                height: size,
                borderRadius: Math.round(size * 0.28),
                background: fill,
                // The letter reads on its own swatch: dark on yellow or white, white on blue.
                color: textOn(fill),
                fontSize: Math.round(size * 0.46)
            }}
        >
            {glyph ?? avatarLetter(props.workspace.name)}
        </span>
    );
}

/** The small square a breadcrumb or a tab puts before a workspace's name. */
export function WorkspaceSwatch(props: { readonly color: WorkspaceState['color']; readonly bucket: ChromeBucket }): ReactElement {
    return (
        <span
            aria-hidden
            className="h-[8px] w-[8px] shrink-0 rounded-[2px]"
            style={{ background: workspaceColorHex(props.color, props.bucket) }}
        />
    );
}

/** "2 waiting", in the waiting colour. */
export function WaitingBadge(props: { readonly children: ReactNode; readonly testID?: string }): ReactElement {
    return (
        <span
            data-testid={props.testID}
            className="shrink-0 whitespace-nowrap rounded-full px-2 py-[3px] text-[12px] font-semibold"
            style={{ background: phoneStyle.waitingBadge, color: tokens.textPrimary }}
        >
            {props.children}
        </span>
    );
}

/** The waiting dot with its halo, the mark Home's heading and the pill lead with. */
export function WaitingDot(props: { readonly size?: number }): ReactElement {
    const size = props.size ?? 8;
    return (
        <span
            aria-hidden
            className="shrink-0 rounded-full"
            style={{ width: size, height: size, background: tokens.statusWaiting, boxShadow: `0 0 0 3px ${phoneStyle.waitingHalo}` }}
        />
    );
}

/**
 * "3 need you · 2 hosts": the count of waiting agents everywhere, which opens the Needs-you sheet.
 * Nothing at all when nothing waits, so a calm phone has nothing in the corner.
 */
export function AttentionPill(props: { readonly waiting: number; readonly hosts: number; readonly onOpen: () => void }): ReactElement | null {
    if (props.waiting === 0) return null;
    return (
        <button
            type="button"
            data-testid="phone-attention-pill"
            data-waiting={props.waiting}
            aria-haspopup="dialog"
            aria-label={`${String(props.waiting)} need you${props.hosts > 1 ? ` on ${String(props.hosts)} hosts` : ''}. Open Needs you`}
            className="flex h-[44px] shrink-0 items-center"
            onClick={props.onOpen}
        >
            <span
                className="flex h-[36px] items-center gap-2 rounded-full border pr-[14px] pl-3 text-[14px] font-semibold"
                style={{ background: phoneStyle.waitingCard, borderColor: phoneStyle.waitingBorder, color: tokens.textPrimary, boxShadow: phoneStyle.shadow }}
            >
            <WaitingDot />
            {`${String(props.waiting)} need you`}
            {props.hosts > 1 ? (
                <span className="font-normal" style={{ color: phoneStyle.waitingText }}>
                    {`· ${String(props.hosts)} hosts`}
                </span>
            ) : null}
            </span>
        </button>
    );
}

/** The rounded tile a glyph sits in, at the head of a list row. */
export function GlyphTile(props: { readonly name: PhoneGlyphName; readonly size?: number; readonly tint?: string; readonly waiting?: boolean }): ReactElement {
    const size = props.size ?? 32;
    return (
        <span
            aria-hidden
            className="flex shrink-0 items-center justify-center"
            style={{
                width: size,
                height: size,
                borderRadius: Math.round(size * 0.29),
                background: props.waiting === true ? phoneStyle.waitingBadge : phoneStyle.well,
                color: props.tint ?? (props.waiting === true ? tokens.textPrimary : tokens.textSecondary)
            }}
        >
            <PhoneGlyph name={props.name} size={Math.round(size * 0.52)} />
        </span>
    );
}
