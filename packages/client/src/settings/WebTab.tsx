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

import { useState, type ReactElement, type ReactNode } from 'react';

import { tokens } from '../grid/tokens';
import { truncateMiddle, type WebFavourite } from '../webpane';
import { StarGlyph } from './glyphs';
import {
    SettingsButton,
    SettingsEmptyState,
    SettingsFooterNote,
    SettingsSection,
    hoverBackground,
    useHover
} from './ui';

/**
 * One favourite row. H11: the Swift list's rows light under the pointer and these did not —
 * and this one is also the drop target for the drag reorder, so "the pointer is here" is
 * information the gesture needs, not only polish.
 */
function FavouriteRow(props: {
    readonly id: string;
    readonly onDragStart: () => void;
    readonly onDrop: () => void;
    readonly children: ReactNode;
}): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <div
            data-testid={`settings-favourite-${props.id}`}
            draggable
            onDragStart={props.onDragStart}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
                event.preventDefault();
                props.onDrop();
            }}
            className="flex items-center gap-2 rounded px-2 py-1.5 transition-colors duration-100"
            style={{ background: hoverBackground(hovered, 'rgba(128,128,128,0.06)') }}
            {...hoverProps}
        >
            {props.children}
        </div>
    );
}

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

/**
 * SET-098's middle truncation, as a character budget.
 *
 * 64 characters of the row's 10 px monospace is about 380 px — comfortably inside the detail
 * column at the dialog's own width — so a normal URL is untouched and only a long one loses its
 * middle. The full URL is always in the row's `title`.
 */
export const FAVOURITE_URL_MAX_CHARS = 64;

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
            {/*
             * L79's `plain`: `SettingsView.swift:707-741` is a `VStack { List }` — the favourites
             * tab has no `Form` and no grouped card, and each row already carries its own fill.
             */}
            <SettingsSection
                plain
                title="Favourites"
                hint="Saved from a web pane's URL bar. The star fills when the page you are on is already saved."
                testID="settings-favourites"
            >
                {/*
                 * M45: `SettingsView.swift:710-720` — `Image(systemName: "star")` at 28 pt in
                 * `.tertiary`, not an 18 px `☆` in favourite-yellow. The Swift empty state's
                 * glyph is the same faint label tone as the other three; the yellow belongs to
                 * the star on a ROW, which is a value rather than an illustration.
                 */}
                {favourites.length === 0 ? (
                    <SettingsEmptyState
                        testID="settings-favourites-empty"
                        glyph={<StarGlyph size={28} />}
                        title="No favourites yet"
                        detail="Click the star button in a web pane's URL bar to save one."
                    />
                ) : (
                    <div className="flex flex-col gap-1" data-testid="settings-favourites-list">
                        {favourites.map((favourite, index) => (
                            <FavouriteRow
                                key={favourite.id}
                                id={favourite.id}
                                onDragStart={() => setDragging(index)}
                                onDrop={() => {
                                    if (dragging === null || dragging === index) return;
                                    actions.moveFavourite(dragging, index);
                                    setDragging(null);
                                }}
                            >
                                <span className="shrink-0 text-[12px]" style={{ color: '#F2C230' }}>
                                    ★
                                </span>
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    {/*
                                     * L85: `.textFieldStyle(.roundedBorder)` at `.system(size: 12,
                                     * weight: .medium)` (`SettingsView.swift:772-776`). The port
                                     * drew a transparent border at normal weight, so the one
                                     * EDITABLE thing in the row looked like a caption until you
                                     * clicked it — the opposite of what a bordered field is for.
                                     */}
                                    <input
                                        aria-label={`Title for ${favourite.url}`}
                                        data-testid={`settings-favourite-title-${favourite.id}`}
                                        placeholder={favourite.label}
                                        className="w-full rounded bg-transparent px-1 py-[2px] text-[12px] font-medium outline-none"
                                        style={{ border: `1px solid ${tokens.divider}`, color: tokens.textPrimary }}
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
                                    {/*
                                      * SET-099's sibling clause in SET-098: the URL is 10 pt
                                      * monospace and MIDDLE-truncated. CSS can only ellipsize at
                                      * one end, and neither end is the right one for a URL — the
                                      * host is at the front and the page is at the back — so the
                                      * ellipsis is put in the middle by the same string helper the
                                      * bookmarks menu uses, with the whole URL in `title`. The
                                      * `truncate` class stays as the backstop for a narrow window.
                                      */}
                                    <span
                                        title={favourite.url}
                                        data-testid={`settings-favourite-url-${favourite.id}`}
                                        // L85: `.foregroundStyle(.secondary)`
                                        // (`SettingsView.swift:779-783`), one tone up from the
                                        // tertiary the port had it in — a URL is the row's
                                        // identity, not a footnote about it.
                                        className="truncate px-1 font-mono text-[10px]"
                                        style={{ color: tokens.textSecondary }}
                                    >
                                        {truncateMiddle(favourite.url, FAVOURITE_URL_MAX_CHARS)}
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
                                {/* L80: `.help("Remove favourite")` (`SettingsView.swift:792`). */}
                                <SettingsButton
                                    testID={`settings-favourite-remove-${favourite.id}`}
                                    ariaLabel={`Remove ${favourite.label}`}
                                    title="Remove favourite"
                                    tone="danger"
                                    onClick={() => actions.removeFavourite(favourite.id)}
                                >
                                    Remove
                                </SettingsButton>
                            </FavouriteRow>
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
