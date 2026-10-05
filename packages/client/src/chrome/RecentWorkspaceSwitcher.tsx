/**
 * The ⌃Tab switcher: recent workspaces, the highlighted one in the palette's selection band.
 * Keys are not handled here — the gesture lives in `app/recent-switcher.ts` and reaches this
 * through props — but it takes focus and registers modal presence: a live web page is parked
 * while it is up, which hands the keyboard (and so the ⌃ release) back to the window.
 */

import type { WorkspaceColor } from '@kelpi/daemon/store';
import { useLayoutEffect, useRef, type ReactElement } from 'react';

import { useModalPresence } from './modal-presence';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

export interface RecentSwitcherRow {
    readonly id: string;
    readonly name: string;
    readonly color: WorkspaceColor | null;
}

export interface RecentWorkspaceSwitcherProps {
    readonly rows: readonly RecentSwitcherRow[];
    readonly index: number;
    readonly bucket?: ChromeBucket | undefined;
    onPick(workspaceID: string): void;
}

export function RecentWorkspaceSwitcher(props: RecentWorkspaceSwitcherProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const panelRef = useRef<HTMLDivElement>(null);
    useModalPresence(true);
    useLayoutEffect(() => {
        panelRef.current?.focus();
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'transparent' }}>
            <div
                ref={panelRef}
                tabIndex={-1}
                data-testid="recent-switcher"
                role="listbox"
                aria-label="Recent workspaces"
                className="w-[320px] overflow-hidden rounded-[10px] py-1 outline-none"
                style={{
                    background: tokens.surfaceBackground,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                    color: tokens.textPrimary
                }}
            >
                {props.rows.map((row, rowIndex) => {
                    const selected = rowIndex === props.index;
                    return (
                        <button
                            key={row.id}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-testid="recent-switcher-row"
                            data-workspace-id={row.id}
                            data-selected={selected ? 'true' : 'false'}
                            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
                            style={{ background: selected ? withAlpha(tokens.accent, 0.2) : 'transparent' }}
                            onClick={() => props.onPick(row.id)}
                        >
                            <span
                                aria-hidden
                                className="h-[8px] w-[8px] shrink-0 rounded-full"
                                style={{ background: workspaceColorHex(row.color, bucket) }}
                            />
                            <span className="truncate text-[13px]">{row.name}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
