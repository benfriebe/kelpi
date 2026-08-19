/**
 * The command palette (shell-ui.md §7, app-state-core.md §10).
 *
 * Overlay over the content row with an almost-invisible backdrop; clicking outside dismisses.
 * The panel is 440 wide, pinned 40 from the top, results capped at 300px and scrollable, with
 * a "No results" row for a non-empty query that matches nothing.
 *
 * The two behaviors worth calling out, because they are contracts rather than styling:
 *
 *   - **Matching is `palette.ts`'s substring rule**, not a fuzzy match, and the `w:`/`p:`
 *     scope prefixes are honored. This component only renders it.
 *   - **The 200ms focus handoff** (§10.4). Closing the palette — confirm, Escape, backdrop —
 *     must hand keyboard focus back to a terminal, but only after the fade-out has released
 *     the text field: wait 200ms, then focus the destination pane. Exactly one handoff can be
 *     pending; a newer interaction supersedes it and re-opening cancels it outright. That is
 *     why this component stays MOUNTED while closed (it renders null) — an unmounted component
 *     cannot honor a pending timer.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { iconGlyph } from './icons';
import {
    clampSelection,
    matchPaletteQuery,
    paletteNavigationOrder,
    paletteSections,
    type PaletteItem
} from './palette';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

/** §10.4: "wait 200 ms, then imperatively focus the target pane's surface". */
export const FOCUS_HANDOFF_MS = 200;

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
    /** The whole universe; the palette applies the matching rule itself. */
    readonly items: readonly PaletteItem[];
    readonly onConfirm: (item: PaletteItem) => void;
    readonly onDismiss: () => void;
    /** Called `handoffDelayMs` after any close, with the pane focus should land on. */
    readonly onFocusHandoff?: ((paneID: string | null) => void) | undefined;
    /** The active workspace's focused pane — the handoff target for dismiss paths. */
    readonly fallbackPaneID?: string | null | undefined;
    readonly bucket?: ChromeBucket | undefined;
    readonly handoffDelayMs?: number | undefined;
}

export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
    const bucket = props.bucket ?? 'dark';
    const delay = props.handoffDelayMs ?? FOCUS_HANDOFF_MS;
    const [selected, setSelected] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    const matched = matchPaletteQuery(props.items, props.query);
    const sections = paletteSections(matched);
    const order = paletteNavigationOrder(matched);
    const index = clampSelection(selected, order.length);

    const cancelHandoff = (): void => {
        if (handoffRef.current === null) return;
        clearTimeout(handoffRef.current);
        handoffRef.current = null;
    };

    const scheduleHandoff = (paneID: string | null): void => {
        cancelHandoff();
        const handler = props.onFocusHandoff;
        if (handler === undefined) return;
        handoffRef.current = setTimeout(() => {
            handoffRef.current = null;
            handler(paneID);
        }, delay);
    };

    // Opening resets the query selection and cancels any handoff from a prior close (§10.3).
    useEffect(() => {
        if (!props.open) return;
        cancelHandoff();
        setSelected(0);
        inputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only, by design
    }, [props.open]);

    // A pending handoff must not outlive the app.
    useEffect(() => cancelHandoff, []);

    useEffect(() => {
        setSelected(0);
    }, [props.query]);

    useEffect(() => {
        if (!props.open) return;
        const row = listRef.current?.querySelector('[data-selected="true"]');
        (row as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView?.({
            block: 'nearest'
        });
    }, [index, props.open]);

    if (!props.open) return null;

    const confirm = (item: PaletteItem | undefined): void => {
        if (item === undefined) {
            // §10.3: an out-of-range selection (zero matches) still closes AND hands off, so
            // the window is never left without keyboard focus.
            props.onDismiss();
            scheduleHandoff(props.fallbackPaneID ?? null);
            return;
        }
        item.run?.();
        props.onConfirm(item);
        scheduleHandoff(item.paneID ?? props.fallbackPaneID ?? null);
    };

    const dismiss = (): void => {
        props.onDismiss();
        scheduleHandoff(props.fallbackPaneID ?? null);
    };

    let flatIndex = -1;

    return (
        <div
            data-testid="palette-backdrop"
            className="absolute inset-0 z-40 flex justify-center"
            style={{ background: 'rgba(0,0,0,0.08)' }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) dismiss();
            }}
        >
            <div
                data-testid="command-palette"
                role="dialog"
                aria-label="Command palette"
                className="mt-10 h-fit w-[440px] overflow-hidden rounded-[10px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
                    color: tokens.textPrimary
                }}
            >
                <div
                    className="flex items-center gap-2 border-b px-3 py-2"
                    style={{ borderColor: tokens.divider }}
                >
                    <span aria-hidden style={{ color: tokens.textTertiary }}>
                        ⌕
                    </span>
                    <input
                        ref={inputRef}
                        autoFocus
                        aria-label="Jump to workspace or pane"
                        placeholder="Jump to workspace or pane..."
                        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
                        style={{ color: tokens.textPrimary }}
                        value={props.query}
                        onChange={(event) => {
                            props.onQueryChange(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                setSelected(clampSelection(index + 1, order.length));
                                return;
                            }
                            if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                setSelected(clampSelection(index - 1, order.length));
                                return;
                            }
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                confirm(order[index]);
                                return;
                            }
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                dismiss();
                            }
                        }}
                    />
                </div>

                <div ref={listRef} className="max-h-[300px] overflow-y-auto p-1">
                    {order.length === 0 ? (
                        <div
                            data-testid="palette-no-results"
                            className="px-3 py-4 text-center text-[12px]"
                            style={{ color: tokens.textTertiary }}
                        >
                            No results
                        </div>
                    ) : (
                        sections.map((section) => (
                            <div key={section.kind}>
                                <div
                                    className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide"
                                    style={{ color: tokens.textTertiary }}
                                >
                                    {section.title}
                                </div>
                                {section.items.map((item) => {
                                    flatIndex += 1;
                                    const isSelected = flatIndex === index;
                                    const rowIndex = flatIndex;
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            data-testid="palette-row"
                                            data-item-id={item.id}
                                            data-selected={isSelected ? 'true' : 'false'}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left"
                                            style={{
                                                background: isSelected
                                                    ? withAlpha('#6F9BD8', 0.2)
                                                    : 'transparent'
                                            }}
                                            onMouseEnter={() => {
                                                setSelected(rowIndex);
                                            }}
                                            onClick={() => {
                                                confirm(item);
                                            }}
                                        >
                                            {item.workspaceColor === null ? null : (
                                                <span
                                                    aria-hidden
                                                    className="h-[8px] w-[8px] shrink-0 rounded-full"
                                                    style={{
                                                        background: workspaceColorHex(
                                                            item.workspaceColor,
                                                            bucket
                                                        )
                                                    }}
                                                />
                                            )}
                                            <span
                                                aria-hidden
                                                className="w-3 shrink-0 text-center text-[11px]"
                                                style={{ color: tokens.textSecondary }}
                                            >
                                                {iconGlyph({ kind: 'system', name: item.icon })}
                                            </span>
                                            <span className="flex min-w-0 flex-1 flex-col">
                                                <span className="truncate text-[13px]">{item.title}</span>
                                                {item.subtitle.length === 0 ? null : (
                                                    <span
                                                        className="truncate text-[11px]"
                                                        style={{ color: tokens.textSecondary }}
                                                    >
                                                        {item.subtitle}
                                                    </span>
                                                )}
                                            </span>
                                            {item.shortcut === undefined ? null : (
                                                <span
                                                    data-testid="palette-shortcut"
                                                    className="shrink-0 font-mono text-[10px]"
                                                    style={{ color: tokens.textTertiary }}
                                                >
                                                    {item.shortcut}
                                                </span>
                                            )}
                                            {item.kind === 'workspace' ? (
                                                <span
                                                    className="shrink-0 rounded px-1.5 py-px text-[10px]"
                                                    style={{
                                                        background: withAlpha('#E6E6EA', 0.08),
                                                        color: tokens.textSecondary
                                                    }}
                                                >
                                                    workspace
                                                </span>
                                            ) : item.kind === 'pane' && item.workspaceColor !== null ? (
                                                <span
                                                    className="shrink-0 rounded px-1.5 py-px text-[10px] text-white"
                                                    style={{
                                                        background: withAlpha(
                                                            workspaceColorHex(item.workspaceColor, bucket),
                                                            0.7
                                                        )
                                                    }}
                                                >
                                                    {item.workspaceName}
                                                </span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
