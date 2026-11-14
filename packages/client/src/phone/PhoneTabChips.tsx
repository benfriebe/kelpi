/**
 * The phone's tabs (workspace-feature.md §12): the title bar's tab row, as a row of chips under
 * the pane header. Only once the workspace has a second tab; with one there is nothing to choose,
 * and the ⋯ menu's New tab is the way to a second one.
 *
 * - A tap shows that tab; the pane on screen then follows the daemon's focus into it, as it
 *   always does on the phone.
 * - A long press (or a right-click) opens that tab's sheet: rename, duplicate, move, close.
 * - The trailing + opens a new tab, of the kind the host's "A new tab opens" says.
 *
 * The row scrolls sideways when the chips overflow, so a press that moves is a scroll, never a
 * long press, and the press that did open the sheet is not also a tap.
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { withAlpha } from '../chrome/theme';
import type { WorkspaceTabStatus, WorkspaceTabView } from '../chrome/workspace-tabs';
import { LONG_PRESS_MS } from '../terminal';
import { PhoneGlyph } from './glyphs';

/** How far a press may travel and still be a long press rather than the row scrolling. */
const PRESS_SLOP_PX = 10;

function dotColor(status: WorkspaceTabStatus): string {
    if (status === 'waitingForInput') return tokens.statusWaiting;
    if (status === 'running') return tokens.statusRunning;
    return tokens.statusInactive;
}

export interface PhoneTabChipsProps {
    readonly tabs: readonly WorkspaceTabView[];
    readonly onSelect: (tabID: string) => void;
    /** The trailing +. Absent draws none. */
    readonly onNewTab?: (() => void) | undefined;
    /** A long press on a chip: that tab's sheet. Absent, a press is only ever a tap. */
    readonly onTabMenu?: ((tab: WorkspaceTabView) => void) | undefined;
}

export function PhoneTabChips(props: PhoneTabChipsProps): ReactElement | null {
    const press = useRef<{ readonly tabID: string; readonly x: number; readonly y: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
    /**
     * The tab whose LONG PRESS opened its sheet: the click that ends that press is not a tap, and
     * the contextmenu some browsers answer the same press with is not a second opening. A
     * right-click never sets it, so every right-click opens the sheet.
     */
    const pressOpened = useRef<string | null>(null);

    const cancel = (): void => {
        if (press.current?.timer != null) clearTimeout(press.current.timer);
        press.current = null;
    };
    useEffect(() => cancel, []);

    if (props.tabs.length <= 1) return null;

    const onPointerDown = (tab: WorkspaceTabView, event: ReactPointerEvent<HTMLButtonElement>): void => {
        if (props.onTabMenu === undefined || event.button > 0) return;
        cancel();
        pressOpened.current = null;
        const pending = { tabID: tab.id, x: event.clientX, y: event.clientY, timer: null as ReturnType<typeof setTimeout> | null };
        pending.timer = setTimeout(() => {
            if (press.current !== pending) return;
            cancel();
            pressOpened.current = tab.id;
            props.onTabMenu?.(tab);
        }, LONG_PRESS_MS);
        press.current = pending;
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
        const pending = press.current;
        if (pending === null) return;
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > PRESS_SLOP_PX) cancel();
    };

    return (
        <div
            role="tablist"
            aria-label="Tabs"
            data-testid="phone-tab-chips"
            className="flex shrink-0 gap-1.5 overflow-x-auto px-3 py-1.5"
            style={{ scrollbarWidth: 'none' }}
            onScroll={cancel}
        >
            {props.tabs.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.active}
                    data-testid={`phone-tab-chip-${tab.id}`}
                    data-active={tab.active ? 'true' : 'false'}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded px-3 text-[13px]"
                    style={{
                        color: tab.active || tab.attention ? tokens.textPrimary : tokens.textSecondary,
                        fontWeight: tab.attention ? 600 : 400,
                        background: tab.active ? withAlpha(tokens.accent, 0.2) : withAlpha('#E6E6EA', 0.06),
                        boxShadow: tab.active ? `inset 0 0 0 1px ${withAlpha(tokens.accent, 0.75)}` : 'none',
                        // A long press is ours: no text selection or link callout under the thumb.
                        WebkitTouchCallout: 'none',
                        userSelect: 'none'
                    } as React.CSSProperties}
                    onPointerDown={(event) => {
                        onPointerDown(tab, event);
                    }}
                    onPointerMove={onPointerMove}
                    onPointerUp={cancel}
                    onPointerCancel={cancel}
                    onPointerLeave={cancel}
                    onContextMenu={(event) => {
                        if (props.onTabMenu === undefined) return;
                        event.preventDefault();
                        // A browser that answers the long press with its own contextmenu has
                        // already had ours; a right-click has not.
                        if (pressOpened.current === tab.id) return;
                        cancel();
                        props.onTabMenu(tab);
                    }}
                    onClick={() => {
                        if (pressOpened.current === tab.id) {
                            pressOpened.current = null;
                            return;
                        }
                        if (!tab.active) props.onSelect(tab.id);
                    }}
                >
                    <span
                        aria-hidden
                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{
                            background: dotColor(tab.status),
                            boxShadow: tab.attention ? `0 0 0 3px ${withAlpha(tokens.statusWaiting, 0.28)}` : undefined
                        }}
                    />
                    <span className="max-w-[160px] truncate">{tab.title}</span>
                    {tab.paneCount > 1 ? (
                        <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                            {tab.paneCount}
                        </span>
                    ) : null}
                </button>
            ))}
            {props.onNewTab === undefined ? null : (
                <button
                    type="button"
                    data-testid="phone-tab-new"
                    aria-label="New tab"
                    className="flex h-8 w-9 shrink-0 items-center justify-center rounded"
                    style={{ color: tokens.textSecondary, background: withAlpha('#E6E6EA', 0.06) }}
                    onClick={props.onNewTab}
                >
                    <PhoneGlyph name="plus" size={16} />
                </button>
            )}
        </div>
    );
}
