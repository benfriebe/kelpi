/**
 * The repo picker (§GIT-073), ported from `RepoPickerView.swift`.
 *
 * One component, two modes, three call sites: the inspector's "New Worktree…" asks it for ONE
 * repo (`single`), the inspector's "Add Repository…" and the sidebar's New Workspace
 * Repositories section ask it for SEVERAL (`multiple`). Selection is decoupled from
 * confirmation exactly as the sheet is — clicks build a selection, Confirm commits it — because
 * a picker that acts on the first click cannot offer a range.
 *
 *   - plain click  : `single` replaces the selection, `multiple` toggles the row;
 *   - shift-click  : adds the anchor→row range WITHOUT dropping what was already selected;
 *   - double-click : select only this row and confirm immediately;
 *   - ↑/↓          : move the anchor (and, in `single`, the selection that follows it);
 *   - ⇧↑/⇧↓        : extend the selection over the span the anchor crossed (`multiple`);
 *   - Space        : toggle the anchor row;
 *   - Return       : confirm;
 *   - Tab / ⇧Tab   : cycle search → list → Cancel → Confirm, skipping a disabled Confirm.
 *
 * Already-associated rows render dimmed with an "Added" tag and cannot be selected — they are
 * still listed so "why is this one not in the list?" never has to be asked. Confirm stays
 * disabled until at least one selectable row is chosen.
 *
 * The Tab loop is driven by hand for the same reason the Swift sheet drives its own: the list
 * is not a native control, and a browser's natural order would put the roving-anchor list
 * wherever its `tabIndex` happens to fall.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { ChromeIcon } from './icons';
import { middleTruncate, withAlpha } from './theme';
import { tokens } from './tokens';

/**
 * The picker's own box (M50).
 *
 * `RepoPickerView.swift:60-62, 101` is `.padding(16).frame(width: 360, height: 340)` — a FIXED
 * box. Its list therefore keeps one height whatever the filter matches, and the sheet around it
 * never moves. The port's list was `max-h-[220px]` shrink-to-content, so every keystroke in the
 * filter resized the sheet under the pointer.
 *
 * 220 px is the height the port already capped at, kept as the fixed value so nothing that fits
 * today stops fitting.
 */
const LIST_HEIGHT_PX = 220;

/**
 * `.truncationMode(.middle)` on the path line (`RepoPickerView.swift:151-154`), as a character
 * budget — the same stand-in `settings/WebTab.tsx` uses for `SET-098`, because CSS has no middle
 * ellipsis. Sized for the NARROWEST host (the inspector's 340 px sheet, where the path column is
 * ~265 px) rather than the widest, because a budget that overflows gets CSS `truncate` on top and
 * throws the tail away again — which is the one thing middle truncation exists to keep. The full
 * path is always on the row's `title`. Measured on `docs/audit/uifid-settings-medium`'s
 * `08-repo-picker-multiselect-selected.png`, where 48 was still being clipped.
 */
const PATH_MAX_CHARS = 40;

export interface RepoPickerEntry {
    readonly id: string;
    readonly name: string;
    readonly path: string;
}

export interface RepoPickerProps {
    readonly repos: readonly RepoPickerEntry[];
    /** Rows already associated with the destination: listed, dimmed, not selectable. */
    readonly disabledRepoIDs?: ReadonlySet<string> | undefined;
    readonly mode?: 'single' | 'multiple' | undefined;
    readonly confirmLabel?: string | undefined;
    readonly onConfirm: (repos: readonly RepoPickerEntry[]) => void;
    readonly onCancel: () => void;
    /**
     * `repo-scan`'s entry point (§GIT-066), offered inline so a registry that is missing the
     * repo can be filled without leaving the picker. The scan registers what it finds; the
     * rows arrive on the next `repos` prop.
     */
    readonly onScan?: ((path: string) => void) | undefined;
    readonly scanning?: boolean | undefined;
    /**
     * Embedded mode: the host renders the Cancel/Confirm pair itself (the Add Repository sheet
     * pairs the picker with a typed path in ONE submit) and follows the selection through
     * `onSelectionChange`. Return still confirms, so the keyboard path is unchanged.
     */
    readonly hideFooter?: boolean | undefined;
    readonly onSelectionChange?: ((chosen: readonly RepoPickerEntry[]) => void) | undefined;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

type Field = 'search' | 'list' | 'cancel' | 'confirm';

/**
 * `checkmark.circle.fill` / `circle` at 13 pt (`RepoPickerView.swift:139-141`) — the multi-select
 * mark. `chrome/icons.tsx` has neither, and adding two Settings-shaped glyphs to the chrome's
 * shared table for one caller is worse than drawing them here on the same 12×12 grid.
 */
function CheckmarkCircleGlyph(props: { readonly filled: boolean }): ReactElement {
    return (
        <svg aria-hidden viewBox="0 0 12 12" width={13} height={13} fill="none">
            <circle
                cx="6"
                cy="6"
                r="4.6"
                fill={props.filled ? 'currentColor' : 'none'}
                stroke="currentColor"
                strokeWidth="1.2"
            />
            {props.filled ? (
                <path
                    d="M3.9 6.1 5.3 7.5 8.1 4.6"
                    stroke={tokens.surfaceBackground}
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ) : null}
        </svg>
    );
}

export function RepoPicker(props: RepoPickerProps): ReactElement {
    const mode = props.mode ?? 'single';
    const disabled = props.disabledRepoIDs ?? EMPTY_IDS;
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_IDS);
    /** The last interacted-with row: it drives keyboard nav and shift-click ranges. */
    const [anchor, setAnchor] = useState<string | null>(null);
    const [scanPath, setScanPath] = useState('');
    const [listFocused, setListFocused] = useState(false);

    const searchRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const cancelRef = useRef<HTMLButtonElement | null>(null);
    const confirmRef = useRef<HTMLButtonElement | null>(null);
    const rowRefs = useRef(new Map<string, HTMLElement>());

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === '') return props.repos;
        return props.repos.filter(
            (repo) =>
                repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle)
        );
    }, [props.repos, query]);

    const firstSelectableID = useMemo(
        () => filtered.find((repo) => !disabled.has(repo.id))?.id ?? filtered[0]?.id ?? null,
        [disabled, filtered]
    );

    // The anchor and the selection are clamped to what the filter still shows, so a narrowing
    // query can never confirm a row the user cannot see (`clampAnchor` in the Swift sheet).
    useEffect(() => {
        const visible = new Set(filtered.map((repo) => repo.id));
        setSelected((current) => {
            const kept = [...current].filter((id) => visible.has(id));
            return kept.length === current.size ? current : new Set(kept);
        });
        setAnchor((current) => (current !== null && visible.has(current) ? current : firstSelectableID));
    }, [filtered, firstSelectableID]);

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    const selectable = (id: string): boolean => !disabled.has(id);
    const chosen = filtered.filter((repo) => selected.has(repo.id) && selectable(repo.id));
    const canConfirm = chosen.length > 0;

    // Embedded mode's read-out. Keyed on the ids so a re-render with the same choice does not
    // re-notify (and cannot loop through a host that stores what it is handed).
    const chosenKey = chosen.map((repo) => repo.id).join('\u0000');
    const onSelectionChange = props.onSelectionChange;
    const chosenRef = useRef(chosen);
    chosenRef.current = chosen;
    useEffect(() => {
        onSelectionChange?.(chosenRef.current);
    }, [chosenKey, onSelectionChange]);

    const rangeIDs = (from: string, to: string): string[] => {
        const i = filtered.findIndex((repo) => repo.id === from);
        const j = filtered.findIndex((repo) => repo.id === to);
        if (i < 0 || j < 0) return [to];
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        return filtered
            .slice(lo, hi + 1)
            .map((repo) => repo.id)
            .filter(selectable);
    };

    const confirm = (): void => {
        if (!canConfirm) return;
        props.onConfirm(chosen);
    };

    const clickRow = (id: string, shift: boolean): void => {
        if (!selectable(id)) return;
        setListFocused(true);
        if (mode === 'single') {
            setSelected(new Set([id]));
            setAnchor(id);
            return;
        }
        setSelected((current) => {
            // Checkbox semantics: a plain click toggles ONE row; shift-click adds the range
            // from the anchor without dropping what was selected before it.
            if (shift && anchor !== null && anchor !== id) {
                const next = new Set(current);
                for (const member of rangeIDs(anchor, id)) next.add(member);
                return next;
            }
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        setAnchor(id);
    };

    const moveAnchor = (delta: 1 | -1, extend: boolean): void => {
        if (filtered.length === 0) return;
        const currentIdx = Math.max(
            0,
            filtered.findIndex((repo) => repo.id === anchor)
        );
        const nextIdx = Math.min(Math.max(currentIdx + delta, 0), filtered.length - 1);
        const nextID = filtered[nextIdx]?.id;
        if (nextID === undefined) return;
        setAnchor(nextID);
        if (mode === 'single') {
            // The selection follows the cursor, so the row Return confirms is the row the
            // highlight is on.
            if (selectable(nextID)) setSelected(new Set([nextID]));
        } else if (extend) {
            const span = rangeIDs(filtered[currentIdx]?.id ?? nextID, nextID);
            setSelected((current) => {
                const next = new Set(current);
                for (const member of span) next.add(member);
                return next;
            });
        }
        /*
         * L87: `withAnimation(.linear(duration: 0.1)) { proxy.scrollTo(newID, anchor: .center) }`
         * (`RepoPickerView.swift:323-326`) — the anchored row is kept in the MIDDLE of the list
         * while you walk it, and the list glides rather than jumping. `block: 'nearest'` scrolled
         * the minimum instead, so the cursor rode the bottom edge with nothing ahead of it.
         *
         * `behavior: 'smooth'` is the same stand-in `CommandPalette.tsx` uses for the same Swift
         * shape (M59): CSS owns the duration, so the 100 ms itself is not reproducible — what is
         * reproducible is that the movement is animated rather than instant.
         */
        rowRefs.current.get(nextID)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    };

    const toggleAnchor = (): void => {
        if (anchor === null || !selectable(anchor)) return;
        if (mode === 'single') {
            setSelected(new Set([anchor]));
            return;
        }
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(anchor)) next.delete(anchor);
            else next.add(anchor);
            return next;
        });
    };

    /** Visible stops, in reading order. A disabled Confirm is omitted, never landed on. */
    const fields = (): Field[] => {
        const list: Field[] = ['search'];
        if (filtered.length > 0) list.push('list');
        list.push('cancel');
        if (canConfirm) list.push('confirm');
        return list;
    };

    const focusField = (field: Field): void => {
        setListFocused(field === 'list');
        if (field === 'search') searchRef.current?.focus();
        else if (field === 'list') listRef.current?.focus();
        else if (field === 'cancel') cancelRef.current?.focus();
        else confirmRef.current?.focus();
    };

    const advance = (current: Field, shift: boolean): void => {
        const list = fields();
        const index = list.indexOf(current);
        if (index < 0) return;
        const next = list[(index + (shift ? -1 : 1) + list.length) % list.length];
        if (next !== undefined) focusField(next);
    };

    const tabHandler =
        (field: Field) =>
        (event: React.KeyboardEvent): void => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            advance(field, event.shiftKey);
        };

    return (
        /*
         * S15: `gap-3`. `RepoPickerView.swift:61` is `VStack(spacing: 12)` — the headline, the
         * search field, the list and the action row are 12 pt apart, not 8.
         */
        <div className="flex flex-col gap-3" data-testid="repo-picker">
            {/*
             * M50: the picker owns its headline. `RepoPickerView.swift:62-63` opens the sheet
             * with `Text(selectionMode == .multiple ? "Add Repositories" : "Add Repository")
             * .font(.headline)`, so both hosts get the same words for the same control; the port
             * had left each host to write its own ("Choose a Repository", "Add Repositories"),
             * which is how one control ended up with two names.
             *
             * `hideFooter` is the EMBEDDED case — the Add Repository sheet pairs this picker with
             * a typed path under one submit, so that sheet's own title is the title and a second
             * headline inside it would be wrong.
             */}
            {props.hideFooter === true ? null : (
                <div data-testid="repo-picker-title" className="text-[13px] font-semibold">
                    {mode === 'multiple' ? 'Add Repositories' : 'Add Repository'}
                </div>
            )}
            <input
                ref={searchRef}
                aria-label="Search repositories"
                data-testid="repo-picker-search"
                placeholder="Search repos…"
                className="w-full rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                value={query}
                onChange={(event) => {
                    setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        confirm();
                        return;
                    }
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        props.onCancel();
                        return;
                    }
                    tabHandler('search')(event);
                }}
            />

            {filtered.length === 0 ? (
                // M50: the SAME height as the list it replaces (`.frame(maxHeight: .infinity)` in
                // a fixed box), so filtering down to nothing does not collapse the sheet either.
                <div
                    data-testid="repo-picker-empty"
                    className="flex flex-col items-center justify-center rounded px-2 text-center text-[11px]"
                    style={{ color: tokens.textTertiary, height: `${String(LIST_HEIGHT_PX)}px` }}
                >
                    <div style={{ color: tokens.textSecondary }}>No matching repositories</div>
                    <div>{props.repos.length === 0 ? 'Scan a folder, or add one in Settings ▸ Repositories.' : 'Try a different filter.'}</div>
                </div>
            ) : (
                <div
                    ref={listRef}
                    role="listbox"
                    aria-label="Repositories"
                    aria-multiselectable={mode === 'multiple'}
                    tabIndex={0}
                    data-testid="repo-picker-list"
                    className="flex flex-col gap-0.5 overflow-y-auto rounded p-1 outline-none"
                    // M50: a FIXED height, not `max-h`. The Swift box is `360×340` and its list
                    // fills what is left of it, so the sheet is the same size before and after a
                    // keystroke in the filter.
                    style={{ border: `1px solid ${tokens.divider}`, height: `${String(LIST_HEIGHT_PX)}px` }}
                    onFocus={() => {
                        setListFocused(true);
                    }}
                    onBlur={() => {
                        setListFocused(false);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            moveAnchor(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
                            return;
                        }
                        if (event.key === ' ') {
                            event.preventDefault();
                            toggleAnchor();
                            return;
                        }
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            confirm();
                            return;
                        }
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            props.onCancel();
                            return;
                        }
                        tabHandler('list')(event);
                    }}
                >
                    {filtered.map((repo) => {
                        const isAdded = disabled.has(repo.id);
                        const isSelected = selected.has(repo.id);
                        const isAnchor = anchor === repo.id && listFocused;
                        return (
                            <div
                                key={repo.id}
                                ref={(element) => {
                                    if (element === null) rowRefs.current.delete(repo.id);
                                    else rowRefs.current.set(repo.id, element);
                                }}
                                role="option"
                                aria-selected={isSelected}
                                aria-disabled={isAdded}
                                data-testid={`repo-choice-${repo.id}`}
                                data-selected={isSelected ? 'true' : 'false'}
                                data-anchor={isAnchor ? 'true' : 'false'}
                                data-added={isAdded ? 'true' : 'false'}
                                title={repo.path}
                                className="flex cursor-default items-center gap-1.5 rounded px-2 py-1"
                                style={{
                                    /*
                                     * M49: `rowBackground` (`RepoPickerView.swift:193-201`) dims a
                                     * SELECTED row from accent@0.4 to accent@0.25 the moment
                                     * keyboard focus leaves the list — which is what tells you
                                     * Return will not act on it. The port painted one neutral
                                     * `selectionFill` in both states, so a selected row looked
                                     * identical whether or not it was live.
                                     *
                                     * M48/H22: the anchor's own fill is `accent@0.1` in the same
                                     * expression, so it goes through the accent token too rather
                                     * than the hardcoded `#E6E6EA` it had.
                                     */
                                    background: isSelected
                                        ? withAlpha(tokens.accent, listFocused ? 0.4 : 0.25)
                                        : isAnchor
                                          ? withAlpha(tokens.accent, 0.1)
                                          : 'transparent',
                                    opacity: isAdded ? 0.5 : 1,
                                    // M48: `.strokeBorder(Color.accentColor.opacity(0.5))` — the
                                    // keyboard anchor's ring is an ACCENT ring; a neutral divider
                                    // outline reads as a table rule, not as "the keys are here".
                                    outline:
                                        isAnchor && !isSelected
                                            ? `1px solid ${withAlpha(tokens.accent, 0.5)}`
                                            : 'none',
                                    outlineOffset: '-1px'
                                }}
                                onClick={(event) => {
                                    clickRow(repo.id, event.shiftKey);
                                }}
                                onDoubleClick={() => {
                                    if (!selectable(repo.id)) return;
                                    setSelected(new Set([repo.id]));
                                    setAnchor(repo.id);
                                    props.onConfirm([repo]);
                                }}
                            >
                                {/*
                                 * M48: `Image(systemName: isSelected ? "checkmark.circle.fill" :
                                 * "circle").font(.system(size: 13))` — a filled CHECK, not the
                                 * `◉`/`○` typographic marks the port had, which at 11 px read as
                                 * two barely-different bullets. Hand-rolled on `ChromeIcon`'s
                                 * 12×12 grid (the ledgered SF-Symbols class) so it takes the
                                 * accent the same way.
                                 */}
                                {mode === 'multiple' ? (
                                    <span
                                        aria-hidden
                                        data-testid={`repo-check-${repo.id}`}
                                        data-checked={isSelected ? 'true' : 'false'}
                                        className="flex shrink-0 items-center"
                                        style={{ color: isSelected ? tokens.accent : tokens.textTertiary }}
                                    >
                                        <CheckmarkCircleGlyph filled={isSelected} />
                                    </span>
                                ) : (
                                    <ChromeIcon name="folder" size={13} />
                                )}
                                <span className="min-w-0 flex-1">
                                    {/* M48: 13 pt `.medium` over an 11 pt secondary path — the
                                        Swift row's own type (`:145-154`). */}
                                    <span className="block truncate text-[13px] font-medium">{repo.name}</span>
                                    <span
                                        className="block truncate text-[11px]"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {middleTruncate(repo.path, PATH_MAX_CHARS)}
                                    </span>
                                </span>
                                {isAdded ? (
                                    <span className="shrink-0 text-[10px]" style={{ color: tokens.textTertiary }}>
                                        Added
                                    </span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            )}

            {props.onScan === undefined ? null : (
                <div className="flex items-center gap-1">
                    <input
                        aria-label="Scan folder for repositories"
                        data-testid="repo-picker-scan-path"
                        placeholder="Scan a folder…"
                        className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={scanPath}
                        onChange={(event) => {
                            setScanPath(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            if (scanPath.trim() !== '') props.onScan?.(scanPath.trim());
                        }}
                    />
                    <button
                        type="button"
                        data-testid="repo-picker-scan"
                        disabled={scanPath.trim() === '' || props.scanning === true}
                        /*
                         * S15: a bordered chip, not a bare word. It sits immediately right of a
                         * 26.8 px bordered input and was a 28 × 17 px run of accent text with no
                         * box — the same defect as the sheet's own Cancel/Add pair below it.
                         */
                        className="shrink-0 rounded border px-2 py-1 text-[11px]"
                        style={{
                            borderColor: tokens.divider,
                            color: scanPath.trim() === '' ? tokens.textTertiary : tokens.accent
                        }}
                        onClick={() => {
                            if (scanPath.trim() !== '') props.onScan?.(scanPath.trim());
                        }}
                    >
                        {props.scanning === true ? 'Scanning…' : 'Scan'}
                    </button>
                </div>
            )}

            <div className="flex items-center justify-end gap-2">
                <span
                    data-testid="repo-picker-count"
                    className="mr-auto text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {mode === 'multiple' && chosen.length > 0
                        ? `${String(chosen.length)} selected`
                        : ''}
                </span>
                {props.hideFooter === true ? null : (
                    <>
                        <button
                            ref={cancelRef}
                            type="button"
                            data-testid="repo-picker-cancel"
                            style={{ color: tokens.textSecondary }}
                            onClick={props.onCancel}
                            onKeyDown={tabHandler('cancel')}
                        >
                            Cancel
                        </button>
                        <button
                            ref={confirmRef}
                            type="button"
                            data-testid="repo-picker-choose"
                            disabled={!canConfirm}
                            style={{ color: canConfirm ? tokens.accent : tokens.textTertiary }}
                            onClick={confirm}
                            onKeyDown={tabHandler('confirm')}
                        >
                            {props.confirmLabel ?? (mode === 'multiple' ? 'Add' : 'Choose')}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
