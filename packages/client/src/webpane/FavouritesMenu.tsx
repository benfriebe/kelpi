/**
 * The URL bar's star, and the bookmarks button beside the field (web-pane.md §14; WEB-037,
 * WEB-038).
 *
 * Two controls, and the shipped app keeps them apart — which is why this module exports two
 * components rather than one. `WebPaneChrome.swift:426-443` embeds the **star** inside
 * `WebURLBar`'s rounded border, and `:193` puts the **bookmarks menu** in the toolbar between the
 * URL bar and "New tab" as a standalone 22×22 `book` (§L63). The port had merged them into one
 * cluster inside the field, which renamed the menu and shrank the address.
 *
 * The star's state is a *match*, not a flag: it fills when the tab's current URL matches a saved
 * favourite under WEB-044's rule (scheme + host case-folded, trailing slash stripped, path and
 * query left alone), and it is disabled and dimmed for an empty URL — a blank new tab has
 * nothing to save.
 *
 * The menu lists every favourite with its label middle-truncated at 50 characters, shows a
 * two-line hint when there are none, and ends with "Manage favourites…" which opens Settings on
 * the Web tab. In the Swift app that deep link needed a pending-tab stash *and* a notification so
 * a cold-open landed on the right tab; the port's Settings overlay takes its initial tab as a
 * prop, so one callback does it.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useOverlayPresence } from '../chrome/modal-presence';
import { tokens } from '../grid/tokens';
import { Glyph } from './glyphs';
import { favouriteMatching, truncateMiddle, type WebFavourite } from './state';

export interface FavouriteStarProps {
    readonly paneID: string;
    /** The active tab's URL: what the star toggles, and what it matches against. */
    readonly url: string;
    readonly title: string;
    readonly favourites: readonly WebFavourite[];
    readonly onToggle: (url: string, title: string) => void;
}

/** `WebURLBar`'s trailing star (`WebPaneChrome.swift:404-419`) — inside the field's border. */
export function FavouriteStar(props: FavouriteStarProps): ReactElement {
    const saved = favouriteMatching(props.favourites, props.url);
    const disabled = props.url.trim() === '';
    return (
        <button
            type="button"
            data-testid={`web-favourite-star-${props.paneID}`}
            data-saved={saved === null ? 'false' : 'true'}
            aria-label={saved === null ? 'Add favourite' : 'Remove favourite'}
            aria-pressed={saved !== null}
            title={saved === null ? 'Add favourite' : 'Remove favourite'}
            disabled={disabled}
            className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded text-[12px]"
            style={{
                color: saved === null ? tokens.textTertiary : '#F2C230',
                opacity: disabled ? 0.3 : 1,
                cursor: disabled ? 'default' : 'pointer'
            }}
            onClick={() => props.onToggle(props.url, props.title)}
        >
            {saved === null ? '☆' : '★'}
        </button>
    );
}

export interface BookmarksMenuProps {
    readonly paneID: string;
    readonly favourites: readonly WebFavourite[];
    readonly onOpen: (url: string) => void;
    readonly onManage: () => void;
}

/**
 * The toolbar's `book` button and the menu it drops (`WebPaneChrome.swift:94-128`).
 *
 * It is a sibling of Back / Forward / New tab, at their 22×22 footprint and under their label —
 * "Bookmarks", which is the word `.help("Bookmarks")` puts on it.
 */
export function BookmarksMenu(props: BookmarksMenuProps): ReactElement {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    /*
     * §N26 — this menu drops off the toolbar straight onto its OWN pane's page, and that page is
     * a native `WebContentsView` composited above this document: it was painted under the page
     * every time (`docs/audit/n26-popup-layering`, step `06-favourites-menu`). It registers its
     * box with `chrome/modal-presence`, so the pane it covers parks while the list is down — and
     * because the registration is a rect rather than a count, a second web pane beside it keeps
     * its page.
     */
    useOverlayPresence(listRef, open);

    // A menu that does not close on an outside click is a menu that covers the page.
    useEffect(() => {
        if (!open) return;
        const onDown = (event: Event): void => {
            const root = rootRef.current;
            if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
    }, [open]);

    return (
        <div ref={rootRef} className="relative flex shrink-0 items-center">
            <button
                type="button"
                data-testid={`web-favourites-menu-${props.paneID}`}
                aria-label="Bookmarks"
                aria-expanded={open}
                title="Bookmarks"
                // No lit state: `bookmarksMenuButton` is a plain `Menu` at a flat `.opacity(0.8)`
                // (`WebPaneChrome.swift:117-127`) — unlike the scope and storage buttons beside
                // it, it does not take an accent fill while its menu is down. `aria-expanded`
                // carries the open state for anything that needs to read it.
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
                style={{ color: tokens.textSecondary, cursor: 'pointer' }}
                onClick={() => setOpen((current) => !current)}
            >
                <Glyph name="book" />
            </button>

            {!open ? null : (
                <div
                    ref={listRef}
                    data-testid={`web-favourites-list-${props.paneID}`}
                    role="menu"
                    className="absolute right-0 top-[24px] z-20 flex w-[280px] flex-col gap-0.5 rounded-md p-1 text-[11px]"
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                        color: tokens.textPrimary
                    }}
                >
                    {props.favourites.length === 0 ? (
                        <p
                            data-testid={`web-favourites-empty-${props.paneID}`}
                            className="px-1.5 py-1 leading-relaxed"
                            style={{ color: tokens.textTertiary }}
                        >
                            {/*
                             * L64 — `WebPaneChrome.swift:96-99` verbatim: two disabled `Text`
                             * rows, the second at `.caption`. The port had reworded both
                             * ("No favourites yet." / "Use the star in the URL bar to save this
                             * page."), which is the same information in words the app never says.
                             */}
                            No favourites yet
                            <br />
                            Click the star to save the current page
                        </p>
                    ) : (
                        props.favourites.map((favourite) => (
                            <button
                                key={favourite.id}
                                type="button"
                                role="menuitem"
                                data-testid={`web-favourite-${favourite.id}`}
                                title={favourite.url}
                                className="truncate rounded px-1.5 py-1 text-left"
                                /*
                                 * L65 — no selected state. `WebPaneChrome.swift:101-106` is a
                                 * plain `Button(label) { onOpenFavourite(fav.url) }` per row; the
                                 * port had lit the row matching the current page with an accent
                                 * pill, which is a highlight the shipped menu does not have (and
                                 * which the star beside the field already says).
                                 */
                                style={{ color: tokens.textPrimary }}
                                onClick={() => {
                                    setOpen(false);
                                    props.onOpen(favourite.url);
                                }}
                            >
                                {truncateMiddle(favourite.label)}
                            </button>
                        ))
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        data-testid={`web-favourites-manage-${props.paneID}`}
                        className="mt-0.5 rounded px-1.5 py-1 text-left"
                        style={{ borderTop: `1px solid ${tokens.divider}`, color: tokens.textSecondary }}
                        onClick={() => {
                            setOpen(false);
                            props.onManage();
                        }}
                    >
                        Manage favourites…
                    </button>
                </div>
            )}
        </div>
    );
}
