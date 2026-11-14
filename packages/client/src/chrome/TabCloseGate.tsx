/**
 * The close-tab gate (workspace-feature.md §12.5): closing a tab closes its panes, so a tab with
 * agents in it asks first, under the same setting that guards deleting a workspace with agents
 * (`confirm-workspace-delete`). It is `AgentDeleteGate`'s alert (App.tsx) for a tab rather than a
 * workspace, minus the worktree list, which a tab has none of: Cancel is the default and takes
 * Return as well as Escape, Close is destructive, and "Don't ask again" holds whichever button
 * is clicked.
 */

import { describeAgentSummary, type WorkspaceAgentSummary } from '@kelpi/core/agent';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { hoverFill, useHoverKey } from './hover';
import { useModalPresence } from './modal-presence';
import { tokens } from './tokens';

export interface TabCloseGateProps {
    /** "“build”", or "3 tabs" for Close Other Tabs. */
    readonly subject: string;
    readonly tabCount: number;
    readonly agents: WorkspaceAgentSummary;
    readonly onCancel: () => void;
    readonly onConfirm: () => void;
    /** "Don't ask again" was ticked: turn `confirm-workspace-delete` off. */
    readonly onSuppress: () => void;
}

export function tabCloseWarning(agents: WorkspaceAgentSummary, tabCount: number): string {
    const holder = tabCount === 1 ? 'This tab has' : 'These tabs have';
    const consequence = agents.total === 1 ? 'close it' : `close all ${String(agents.total)}`;
    return `${holder} ${describeAgentSummary(agents)}. Closing ${tabCount === 1 ? 'it' : 'them'} will ${consequence}.`;
}

export function TabCloseGate(props: TabCloseGateProps): ReactElement {
    const [suppress, setSuppress] = useState(false);
    const [hoveredAction, bindHover] = useHoverKey();
    useModalPresence();

    const { onCancel, onSuppress } = props;
    const cancel = useCallback((): void => {
        if (suppress) onSuppress();
        onCancel();
    }, [onCancel, onSuppress, suppress]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' && event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [cancel]);

    return (
        <div
            data-testid="tab-close-backdrop"
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
        >
            <div
                data-testid="tab-close-gate"
                role="dialog"
                aria-modal="true"
                aria-label="Close tab with agents"
                className="fixed left-1/2 top-1/3 z-50 w-[340px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                <div className="mb-1 font-semibold">{`Close ${props.subject}?`}</div>
                <div className="mb-3 text-[11px]" style={{ color: tokens.textSecondary }}>
                    {tabCloseWarning(props.agents, props.tabCount)}
                </div>
                <label className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: tokens.textSecondary }}>
                    <input
                        type="checkbox"
                        data-testid="tab-close-suppress"
                        checked={suppress}
                        onChange={(event) => setSuppress(event.target.checked)}
                    />
                    Don&apos;t ask again
                </label>
                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        data-testid="tab-close-cancel"
                        data-default="true"
                        autoFocus
                        className="rounded px-2 py-1"
                        {...bindHover('cancel')}
                        style={{
                            color: tokens.textPrimary,
                            border: `1px solid ${tokens.accent}`,
                            background: hoveredAction === 'cancel' ? 'rgba(111,155,216,0.28)' : 'rgba(111,155,216,0.16)'
                        }}
                        onClick={cancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-testid="tab-close-confirm"
                        data-destructive="true"
                        className="rounded px-2 py-1"
                        {...bindHover('close')}
                        style={{
                            color: '#E0655C',
                            border: `1px solid ${hoveredAction === 'close' ? tokens.selectionStroke : 'transparent'}`,
                            background: hoverFill(hoveredAction === 'close')
                        }}
                        onClick={() => {
                            if (suppress) props.onSuppress();
                            props.onConfirm();
                        }}
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
