/**
 * The phone's tabs (workspace-feature.md §12): the title bar's tab row, as a row of chips under
 * the pane header. Only once the workspace has a second tab; with one there is nothing to choose.
 * A tap shows that tab; the pane on screen then follows the daemon's focus into it, as it always
 * does on the phone.
 */

import type { ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { withAlpha } from '../chrome/theme';
import type { WorkspaceTabStatus, WorkspaceTabView } from '../chrome/workspace-tabs';

function dotColor(status: WorkspaceTabStatus): string {
    if (status === 'waitingForInput') return tokens.statusWaiting;
    if (status === 'running') return tokens.statusRunning;
    return tokens.statusInactive;
}

export interface PhoneTabChipsProps {
    readonly tabs: readonly WorkspaceTabView[];
    readonly onSelect: (tabID: string) => void;
}

export function PhoneTabChips(props: PhoneTabChipsProps): ReactElement | null {
    if (props.tabs.length <= 1) return null;
    return (
        <div
            role="tablist"
            aria-label="Tabs"
            data-testid="phone-tab-chips"
            className="flex shrink-0 gap-1.5 overflow-x-auto px-3 py-1.5"
            style={{ scrollbarWidth: 'none' }}
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
                        boxShadow: tab.active ? `inset 0 0 0 1px ${withAlpha(tokens.accent, 0.75)}` : 'none'
                    }}
                    onClick={() => {
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
        </div>
    );
}
