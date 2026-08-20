/**
 * Settings ▸ Web — the favourites manager (web-pane.md §14; SET-097…SET-100, WEB-046).
 *
 * The list itself is daemon state (`webpane/favourites.ts`, persisted as `favourites.json`), so
 * this tab is a pure form over it: rename in place, remove, reorder. Adding is deliberately NOT
 * here — a favourite is created by starring a page in a web pane's URL bar, which is what the
 * empty state points at.
 *
 * Behaviours that are contracts:
 *   - a rename **commits on Return or focus loss**, trimmed, and only when the value actually
 *     changed (SET-099) — a re-render mid-typing must not fire a verb per keystroke;
 *   - reorder is a move, not a swap: the row travels to the new index and everything between it
 *     and there shifts by one (SET-100). Drag is the Swift gesture; here it is drag **plus**
 *     ↑/↓ buttons, because a drag with no keyboard equivalent is unreachable for some users.
 */

import { useState, type ReactElement } from 'react';

import { tokens } from '../grid/tokens';
import type { WebFavourite } from '../webpane';
import { SettingsButton, SettingsFooterNote, SettingsSection } from './ui';

export interface WebTabActions {
    renameFavourite(id: string, title: string): void;
    removeFavourite(id: string): void;
    moveFavourite(from: number, to: number): void;
}

export interface WebTabProps {
    readonly favourites: readonly WebFavourite[];
    readonly actions: WebTabActions;
    /** Where the list is stored, for the footer strip (§13.1's "this is a file" honesty). */
    readonly path?: string | undefined;
}

export const DEFAULT_FAVOURITES_PATH = '~/.local/state/nex/favourites.json';

export function WebTab(props: WebTabProps): ReactElement {
    const { favourites, actions } = props;
    /** The row being edited and its draft; committing clears it. */
    const [draft, setDraft] = useState<{ id: string; value: string } | null>(null);
    const [dragging, setDragging] = useState<number | null>(null);

    const commit = (favourite: WebFavourite): void => {
        if (draft === null || draft.id !== favourite.id) return;
        const next = draft.value.trim();
        setDraft(null);
        // SET-099: only when it actually changed.
        if (next === favourite.title) return;
        actions.renameFavourite(favourite.id, next);
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-web">
            <SettingsSection
                title="Favourites"
                hint="Saved from a web pane's URL bar. The star fills when the page you are on is already saved."
                testID="settings-favourites"
            >
                {favourites.length === 0 ? (
                    <div
                        data-testid="settings-favourites-empty"
                        className="flex flex-col items-center gap-1 rounded px-3 py-6 text-center"
                        style={{ border: `1px dashed ${tokens.divider}`, color: tokens.textTertiary }}
                    >
                        <span className="text-[18px]" style={{ color: '#F2C230' }}>
                            ☆
                        </span>
                        <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                            No favourites yet
                        </span>
                        <span className="text-[11px]">
                            Open a page in a web pane and press the star in its URL bar to save it here.
                        </span>
                    </div>
                ) : (
                    <div className="flex flex-col gap-1" data-testid="settings-favourites-list">
                        {favourites.map((favourite, index) => (
                            <div
                                key={favourite.id}
                                data-testid={`settings-favourite-${favourite.id}`}
                                draggable
                                onDragStart={() => setDragging(index)}
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (dragging === null || dragging === index) return;
                                    actions.moveFavourite(dragging, index);
                                    setDragging(null);
                                }}
                                className="flex items-center gap-2 rounded px-2 py-1.5"
                                style={{ background: 'rgba(128,128,128,0.06)' }}
                            >
                                <span className="shrink-0 text-[12px]" style={{ color: '#F2C230' }}>
                                    ★
                                </span>
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <input
                                        aria-label={`Title for ${favourite.url}`}
                                        data-testid={`settings-favourite-title-${favourite.id}`}
                                        placeholder={favourite.label}
                                        className="w-full rounded bg-transparent px-1 py-[2px] text-[12px] outline-none"
                                        style={{ border: `1px solid transparent`, color: tokens.textPrimary }}
                                        value={draft?.id === favourite.id ? draft.value : favourite.title}
                                        onFocus={() => setDraft({ id: favourite.id, value: favourite.title })}
                                        onChange={(event) =>
                                            setDraft({ id: favourite.id, value: event.target.value })
                                        }
                                        onBlur={() => commit(favourite)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault();
                                                commit(favourite);
                                                return;
                                            }
                                            if (event.key !== 'Escape') return;
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setDraft(null);
                                        }}
                                    />
                                    <span
                                        title={favourite.url}
                                        data-testid={`settings-favourite-url-${favourite.id}`}
                                        className="truncate px-1 font-mono text-[10px]"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {favourite.url}
                                    </span>
                                </div>
                                <SettingsButton
                                    testID={`settings-favourite-up-${favourite.id}`}
                                    ariaLabel={`Move ${favourite.label} up`}
                                    disabled={index === 0}
                                    onClick={() => actions.moveFavourite(index, index - 1)}
                                >
                                    ↑
                                </SettingsButton>
                                <SettingsButton
                                    testID={`settings-favourite-down-${favourite.id}`}
                                    ariaLabel={`Move ${favourite.label} down`}
                                    disabled={index === favourites.length - 1}
                                    onClick={() => actions.moveFavourite(index, index + 1)}
                                >
                                    ↓
                                </SettingsButton>
                                <SettingsButton
                                    testID={`settings-favourite-remove-${favourite.id}`}
                                    ariaLabel={`Remove ${favourite.label}`}
                                    tone="danger"
                                    onClick={() => actions.removeFavourite(favourite.id)}
                                >
                                    Remove
                                </SettingsButton>
                            </div>
                        ))}
                    </div>
                )}
            </SettingsSection>

            <SettingsFooterNote>
                Favourites live with the daemon, beside its database (by default{' '}
                <code>{props.path ?? DEFAULT_FAVOURITES_PATH}</code>), so every window and the desktop app share one
                list.
            </SettingsFooterNote>
        </div>
    );
}
