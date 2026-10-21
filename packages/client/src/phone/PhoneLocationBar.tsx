/**
 * The location bar: the phone's ONE navigation control, pinned at the bottom where a thumb is.
 *
 * It replaces the old header's Hosts, Workspaces and Panes buttons with the place itself, read as a
 * breadcrumb: `host › workspace › pane`. Each segment opens the picker (`PhonePicker.tsx`) at its
 * own level, so "where am I" and "go somewhere else" are the same tap. The segment whose level the
 * picker is showing fills with the accent, so the bar and the card above it read as one control.
 *
 * On Home there is no workspace or pane to name, so the bar is the host segment and Jump to…, the
 * search across every host (`PhoneJumpSheet.tsx`).
 *
 * The test ids the scenarios already drive by are kept on the segments that took over their job:
 * `phone-title` is the pane segment (it opened the pane list, and still does), and
 * `phone-title-workspace` names the workspace on screen.
 */

import type { ReactElement, ReactNode } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';

import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ConnectionStatus } from '../connection';
import { PhoneGlyph, type PhoneGlyphName } from './glyphs';
import { HostDot, WorkspaceSwatch } from './parts';
import { phoneStyle } from './style';
import { PHONE_SAFE_AREA } from './ui';

export type PhonePickerLevel = 'hosts' | 'workspaces' | 'panes';

/** The bar's height and its gap from the screen's bottom edge; the picker card sits above both. */
export const PHONE_BAR_HEIGHT_PX = 56;
export const PHONE_BAR_GAP_PX = 12;
/** Where the picker card's bottom edge goes: clear of the bar, with the same gap again. */
export const PHONE_PICKER_BOTTOM = `calc(max(${PHONE_SAFE_AREA.bottom} + 4px, ${String(PHONE_BAR_GAP_PX)}px) + ${String(PHONE_BAR_GAP_PX + PHONE_BAR_HEIGHT_PX)}px)`;

export interface PhoneLocationBarProps {
    readonly hostName: string;
    readonly hostStatus: ConnectionStatus;
    /** On Home the bar is the host segment and Jump to…; elsewhere it is the full breadcrumb. */
    readonly home: boolean;
    /** The workspace on screen; null while none is (the origin has none, or has not said yet). */
    readonly workspace: Pick<WorkspaceState, 'name' | 'color'> | null;
    readonly workspaceLabel: string;
    readonly workspaceWaiting: boolean;
    readonly pane: { readonly title: string; readonly glyph: PhoneGlyphName; readonly paneID: string } | null;
    readonly bucket: ChromeBucket;
    /** The level the picker is open at, if it is: that segment wears the accent. */
    readonly open: PhonePickerLevel | null;
    /** Above the picker's scrim while the picker is open, so the open segment stays in view. */
    readonly raised: boolean;
    readonly onPick: (level: PhonePickerLevel) => void;
    readonly onJump: () => void;
}

function Segment(props: {
    readonly testID: string;
    readonly label: string;
    readonly open: boolean;
    readonly current?: boolean;
    readonly grow?: boolean;
    /** A width cap for the host and workspace segments, so long names leave the pane its room. */
    readonly cap?: string;
    readonly onClick: () => void;
    readonly children: ReactNode;
}): ReactElement {
    const filled = props.open ? phoneStyle.accentFill : props.current === true ? phoneStyle.selected : 'transparent';
    return (
        <button
            type="button"
            data-testid={props.testID}
            data-open={props.open ? 'true' : 'false'}
            aria-label={props.label}
            aria-haspopup="dialog"
            aria-expanded={props.open}
            className={`relative flex h-[44px] min-w-0 items-center gap-[6px] rounded-[14px] px-[10px] text-[14px] ${props.grow === true ? 'min-w-[96px] flex-1' : 'shrink'}`}
            style={{
                maxWidth: props.cap,
                background: filled,
                color: props.open ? phoneStyle.onAccent : props.current === true ? tokens.textPrimary : tokens.textSecondary,
                fontWeight: props.open || props.current === true ? 600 : 400
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

function Separator(): ReactElement {
    return (
        <span className="flex shrink-0 items-center" style={{ color: tokens.textTertiary }}>
            <PhoneGlyph name="chevron-right" size={12} weight={2.5} />
        </span>
    );
}

export function PhoneLocationBar(props: PhoneLocationBarProps): ReactElement {
    const home = props.home;
    return (
        <nav
            aria-label="Location"
            data-testid="phone-location-bar"
            data-phone-bar={home ? 'home' : 'workspace'}
            className="relative flex shrink-0 items-center gap-[2px] rounded-[20px] border p-[6px]"
            style={{
                height: PHONE_BAR_HEIGHT_PX,
                // The gap to the bottom edge, less whatever the home indicator already leaves.
                margin: `0 12px calc(max(4px, ${String(PHONE_BAR_GAP_PX)}px - ${PHONE_SAFE_AREA.bottom}))`,
                background: phoneStyle.bar,
                borderColor: phoneStyle.barBorder,
                boxShadow: phoneStyle.shadow,
                zIndex: props.raised ? 45 : undefined
            }}
        >
            <Segment
                testID="phone-bar-host"
                label={`Host ${props.hostName}. Switch host`}
                open={props.open === 'hosts'}
                current={home}
                cap={home ? '55%' : '30%'}
                onClick={() => props.onPick('hosts')}
            >
                <HostDot status={props.hostStatus} />
                <span className="truncate">{props.hostName}</span>
                {home ? (
                    <span className="flex shrink-0" style={{ color: props.open === 'hosts' ? undefined : tokens.textSecondary }}>
                        <PhoneGlyph name="chevron-up" size={13} weight={2.2} />
                    </span>
                ) : null}
            </Segment>
            {home ? (
                <button
                    type="button"
                    data-testid="phone-bar-jump"
                    className="flex h-[44px] min-w-0 flex-1 items-center gap-2 rounded-[14px] px-[10px] text-left text-[15px]"
                    style={{ color: tokens.textSecondary }}
                    onClick={props.onJump}
                >
                    <PhoneGlyph name="search" size={18} />
                    <span className="truncate">Jump to…</span>
                </button>
            ) : (
                <>
                    <Separator />
                    <Segment
                        testID="phone-bar-workspace"
                        label={`Workspace ${props.workspaceLabel}${props.workspaceWaiting ? ', something is waiting here' : ''}. Switch workspace`}
                        open={props.open === 'workspaces'}
                        cap="36%"
                        onClick={() => props.onPick('workspaces')}
                    >
                        {props.workspace === null ? null : <WorkspaceSwatch color={props.workspace.color} bucket={props.bucket} />}
                        <span className="truncate" data-testid="phone-title-workspace">
                            {props.workspaceLabel}
                        </span>
                        {props.workspaceWaiting && props.open !== 'workspaces' ? (
                            <span
                                aria-hidden
                                data-testid="phone-bar-workspace-waiting"
                                className="absolute top-[6px] right-[3px] h-[9px] w-[9px] rounded-full border-2"
                                style={{ background: tokens.statusWaiting, borderColor: phoneStyle.bar }}
                            />
                        ) : null}
                    </Segment>
                    <Separator />
                    <Segment
                        testID="phone-title"
                        label={props.pane === null ? 'Panes' : `Pane ${props.pane.title}. Switch pane`}
                        open={props.open === 'panes'}
                        current
                        grow
                        onClick={() => props.onPick('panes')}
                    >
                        {props.pane === null ? (
                            <span className="flex-1 truncate text-left">Panes</span>
                        ) : (
                            <>
                                <PhoneGlyph name={props.pane.glyph} size={15} weight={2} />
                                <span className="flex-1 truncate text-left" data-testid="phone-bar-pane-title" data-pane-id={props.pane.paneID}>
                                    {props.pane.title}
                                </span>
                            </>
                        )}
                        <span className="flex shrink-0" style={{ color: props.open === 'panes' ? undefined : tokens.textSecondary }}>
                            <PhoneGlyph name="chevron-up" size={14} weight={2.2} />
                        </span>
                    </Segment>
                </>
            )}
        </nav>
    );
}
