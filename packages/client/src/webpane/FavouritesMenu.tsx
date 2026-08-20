/**
 * The URL bar's star and the bookmarks menu beside it (web-pane.md §14; WEB-037, WEB-038).
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

import { tokens, pill } from '../grid/tokens';
import { favouriteMatching, truncateMiddle, type WebFavourite } from './state';

export interface FavouritesMenuProps {
    readonly paneID: string;
    /** The active tab's URL: what the star toggles, and what it matches against. */
    readonly url: string;
    readonly title: string;
    readonly favourites: readonly WebFavourite[];
    readonly onToggle: (url: string, title: string) => void;
    readonly onOpen: (url: string) => void;
    readonly onManage: () => void;
}

export function FavouritesMenu(props: FavouritesMenuProps): ReactElement {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const saved = favouriteMatching(props.favourites, props.url);
    const disabled = props.url.trim() === '';

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
                data-testid={`web-favourite-star-${props.paneID}`}
                data-saved={saved === null ? 'false' : 'true'}
                aria-label={saved === null ? 'Add favourite' : 'Remove favourite'}
                aria-pressed={saved !== null}
                title={saved === null ? 'Add favourite' : 'Remove favourite'}
                disabled={disabled}
                className="flex h-[20px] w-[20px] items-center justify-center rounded text-[12px]"
                style={{
                    color: saved === null ? tokens.textTertiary : '#F2C230',
                    opacity: disabled ? 0.3 : 1,
                    cursor: disabled ? 'default' : 'pointer'
                }}
                onClick={() => props.onToggle(props.url, props.title)}
            >
                {saved === null ? '☆' : '★'}
            </button>
            <button
                type="button"
                data-testid={`web-favourites-menu-${props.paneID}`}
                aria-label="Favourites"
                aria-expanded={open}
                title="Favourites"
                className="flex h-[20px] w-[16px] items-center justify-center rounded text-[9px]"
                style={{ color: tokens.textSecondary }}
                onClick={() => setOpen((current) => !current)}
            >
                ▾
            </button>

            {!open ? null : (
                <div
                    data-testid={`web-favourites-list-${props.paneID}`}
                    role="menu"
                    className="absolute right-0 top-[22px] z-20 flex w-[280px] flex-col gap-0.5 rounded-md p-1 text-[11px]"
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
                            No favourites yet.
                            <br />
                            Use the star in the URL bar to save this page.
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
                                style={{
                                    color: tokens.textPrimary,
                                    background:
                                        saved?.id === favourite.id ? pill(tokens.accent, 18) : 'transparent'
                                }}
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
