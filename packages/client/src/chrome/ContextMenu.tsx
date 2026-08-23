/**
 * The chrome's context menu, rendered through a **portal**.
 *
 * shell-ui.md §15 "Menu stability": two macOS bugs (#124/#227) came from open menus being
 * destroyed by unrelated re-renders — the 1-second agent-status tick under the row you
 * right-clicked. A portal whose mount point is `document.body` and whose open state lives in
 * the sidebar (not in the row) has a lifetime independent of the row beneath it, which is the
 * requirement: an open menu, and any open submenu, must survive a status re-render.
 *
 * Everything is data: `MenuItemSpec[]` in, `onSelect` callbacks out. Submenus are one level
 * deep (that is all §5.6/§5.7 use) and open on hover, matching the native menus.
 *
 * Row *highlighting* is owned here too, and by nothing else: every menu in the client — the
 * sidebar's row and background menus, the footer chevron, the pane context menu, the titlebar
 * ••• — renders through `MenuRow`, so the rule lives in one function (`rowHighlight`) and no
 * call site restyles its own rows. See its comment for what the rule is and what it replaced.
 */

import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactElement,
    type ReactNode,
    type RefObject
} from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';

/** How close to the window edge a submenu may sit before it flips to the other side. */
const SUBMENU_EDGE_MARGIN = 8;

/**
 * A submenu opens to the right of its parent — unless there is no room, in which case it opens
 * to the left instead.
 *
 * The parent panel is clamped into the viewport (`menuAnchorFromEvent` below); the submenu was
 * not, and `left-full` was unconditional, so a menu opened from a row near the window's right
 * edge put its submenu past the edge entirely. It rendered, it reported a box, and every click
 * on it landed outside the window — the pane header's Status ▸ submenu was unreachable on a
 * right-hand pane. Found by docs/audit/run-H, whose "Status ▸ Running reaches the daemon"
 * assertion failed only in the runs whose target pane happened to sit on the right.
 *
 * Measured, not estimated: a submenu's width depends on its longest label, and a "Move to
 * Workspace ▸" list of workspace names can be far wider than the 180 px minimum. The flip runs
 * in a layout effect so it lands before the browser paints — a submenu that visibly jumps
 * sideways after opening would be its own defect.
 */
function useSubmenuFlip(open: boolean): { ref: RefObject<HTMLDivElement | null>; flipped: boolean } {
    const ref = useRef<HTMLDivElement | null>(null);
    const [flipped, setFlipped] = useState(false);
    useLayoutEffect(() => {
        if (!open) {
            setFlipped(false);
            return;
        }
        const node = ref.current;
        if (node === null) return;
        const width = globalThis.innerWidth ?? 0;
        if (width === 0) return;
        // `flipped` was reset to false above, so this box is always the right-hand placement's.
        const box = node.getBoundingClientRect();
        setFlipped(box.right > width - SUBMENU_EDGE_MARGIN);
    }, [open]);
    return { ref, flipped };
}

export interface MenuItemSpec {
    readonly id: string;
    readonly label: string;
    /** `separator` and `caption` (the inert "N workspaces selected" row) are non-interactive. */
    readonly kind?: 'item' | 'separator' | 'caption' | undefined;
    readonly disabled?: boolean | undefined;
    /** `'mixed'` draws the dash used by bulk label menus (§5.6). */
    readonly checked?: boolean | 'mixed' | undefined;
    /** A real-color dot (label presets, workspace colors) drawn before the label. */
    readonly swatch?: string | undefined;
    readonly danger?: boolean | undefined;
    /** A `keyTriggerDisplayString` hint (`⌘N`), right-aligned the way a native menu shows it. */
    readonly shortcut?: string | undefined;
    readonly submenu?: readonly MenuItemSpec[] | undefined;
    readonly onSelect?: (() => void) | undefined;
}

export interface ContextMenuProps {
    readonly x: number;
    readonly y: number;
    readonly items: readonly MenuItemSpec[];
    readonly onClose: () => void;
    readonly label?: string | undefined;
    /**
     * Take the keyboard on open, landing on the first enabled row.
     *
     * Off by default, and deliberately: a *context* menu is raised by a right-click over a row,
     * and pulling focus out of whatever the user was in (a rename field, the terminal) to a
     * menu they may dismiss with one more click is a worse trade than leaving focus alone. A
     * menu opened by CLICKING a toggle — §WS-004's footer chevron — is the opposite case: it is
     * a dropdown, so it behaves like one, and Escape hands focus back through `onClose`.
     */
    readonly autoFocus?: boolean | undefined;
    /** Test seam: where the portal mounts (defaults to `document.body`). */
    readonly container?: Element | undefined;
}

const PANEL_STYLE = {
    background: tokens.surfaceBackground,
    border: `1px solid ${tokens.divider}`,
    color: tokens.textPrimary,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.38)'
} as const;

function Checkmark({ state }: { readonly state: boolean | 'mixed' }): ReactElement {
    return (
        <span aria-hidden className="w-3 shrink-0 text-center text-[10px]">
            {state === 'mixed' ? '–' : state ? '✓' : ''}
        </span>
    );
}

function Swatch({ color }: { readonly color: string }): ReactElement {
    return (
        <span
            aria-hidden
            className="h-[9px] w-[9px] shrink-0 rounded-full"
            style={{ background: color }}
            data-testid="menu-swatch"
        />
    );
}

interface RowProps {
    readonly item: MenuItemSpec;
    readonly openSubmenu: boolean;
    readonly onHover: () => void;
    readonly onActivate: () => void;
}

/**
 * The one place a menu row's highlight is decided (the user's second report).
 *
 * The rule this replaces was `background: openSubmenu ? selectionFill : 'transparent'` — which
 * meant the ONLY row in any menu in the app that ever lit up was a submenu parent, and only
 * because its submenu had opened underneath the pointer. "Rename…", "Duplicate", "Close Pane",
 * every row in the footer chevron and the titlebar ••• stayed transparent under the cursor, so
 * a menu gave no feedback at all about which row a click was about to hit. Native menus (and
 * every other selectable surface in this client — the repo picker's rows, the palette) do the
 * opposite: the row under the pointer is the row that acts, so it is painted.
 *
 * Three sources, ONE appearance, which is the part that matters:
 *
 *   - **hover** on any enabled row;
 *   - **keyboard focus**, so `autoFocus`'s landing row and a Tab walk read identically to a
 *     pointer — a menu that highlights only for the mouse is unusable from the keyboard, and
 *     two different-looking highlights would be worse than one;
 *   - **an open submenu**, which is the existing behaviour and is kept: the parent stays lit
 *     while the pointer is away in its child panel, where hover alone would have dropped it.
 *
 * `disabled` rows are excluded at the source (`interactive`) rather than by relying on the
 * browser not to dispatch mouse events to a disabled `<button>`: they already read as
 * unavailable through `disabled:opacity-40`, and a dimmed row that still lights up would be
 * telling the user it can be clicked.
 *
 * The fill is `selectionFill` — the token the submenu-parent highlight already used, and the
 * one the repo picker paints a selected row with — so a highlight means the same thing
 * everywhere in the chrome. Text colour is deliberately unchanged: the fill is a 24%-alpha
 * wash rather than a solid accent, so `textPrimary` keeps its contrast over it and a `danger`
 * row keeps the red that is the only thing marking it destructive (macOS keeps its destructive
 * rows red under the highlight too).
 */
function rowHighlight(interactive: boolean, hovered: boolean, focused: boolean, openSubmenu: boolean): boolean {
    if (!interactive) return false;
    return hovered || focused || openSubmenu;
}

function MenuRow(props: RowProps): ReactElement {
    const { item } = props;
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    if (item.kind === 'separator') {
        return <div role="separator" className="my-1 h-px" style={{ background: tokens.divider }} />;
    }
    if (item.kind === 'caption') {
        return (
            <div className="px-2.5 py-1 text-[11px]" style={{ color: tokens.textTertiary }}>
                {item.label}
            </div>
        );
    }
    const interactive = item.disabled !== true;
    const highlighted = rowHighlight(interactive, hovered, focused, props.openSubmenu);
    return (
        <button
            type="button"
            role="menuitem"
            aria-haspopup={item.submenu === undefined ? undefined : 'menu'}
            aria-expanded={item.submenu === undefined ? undefined : props.openSubmenu}
            aria-disabled={interactive ? undefined : true}
            disabled={!interactive}
            data-menu-item={item.id}
            /*
             * The tick is a glyph inside the label, so "is this row selected?" could only be
             * read by string-matching `✓` off `textContent` — which the audit harness already
             * has to strip before it can match a label. The state as an attribute costs
             * nothing. It stays a `data-` attribute rather than `aria-checked` because ARIA
             * allows that only on `menuitemcheckbox`, and three suites plus the harness query
             * these rows by `role="menuitem"`.
             */
            data-checked={item.checked === undefined ? undefined : String(item.checked)}
            /* The highlight as an attribute, for the same reason `data-checked` is one: the
               harness and three suites read row state without having to resolve a colour. */
            data-highlighted={highlighted ? 'true' : 'false'}
            className="flex w-full items-center gap-1.5 rounded px-2.5 py-1 text-left text-[12px] outline-none disabled:opacity-40"
            style={{
                color: item.danger === true ? '#E0655C' : tokens.textPrimary,
                background: highlighted ? tokens.selectionFill : 'transparent'
            }}
            onMouseEnter={() => {
                setHovered(true);
                props.onHover();
            }}
            onMouseLeave={() => {
                setHovered(false);
            }}
            onFocus={() => {
                setFocused(true);
            }}
            onBlur={() => {
                setFocused(false);
            }}
            onClick={(event) => {
                event.stopPropagation();
                if (!interactive) return;
                props.onActivate();
            }}
        >
            {item.checked === undefined ? null : <Checkmark state={item.checked} />}
            {item.swatch === undefined ? null : <Swatch color={item.swatch} />}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut === undefined ? null : (
                <span
                    data-testid="menu-shortcut"
                    className="shrink-0 font-mono text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {item.shortcut}
                </span>
            )}
            {item.submenu === undefined ? null : (
                <span aria-hidden className="text-[10px]" style={{ color: tokens.textTertiary }}>
                    ▸
                </span>
            )}
        </button>
    );
}

export function ContextMenu(props: ContextMenuProps): ReactElement | null {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [openSubmenuID, setOpenSubmenuID] = useState<string | null>(null);
    const onClose = props.onClose;

    useEffect(() => {
        const onPointerDown = (event: Event): void => {
            const root = rootRef.current;
            if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
            onClose();
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        const doc = globalThis.document;
        doc.addEventListener('mousedown', onPointerDown, true);
        doc.addEventListener('keydown', onKeyDown, true);
        return () => {
            doc.removeEventListener('mousedown', onPointerDown, true);
            doc.removeEventListener('keydown', onKeyDown, true);
        };
    }, [onClose]);

    const autoFocus = props.autoFocus ?? false;
    useEffect(() => {
        if (!autoFocus) return;
        const first = rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
        first?.focus();
    }, [autoFocus]);

    const submenuItems = props.items.find((item) => item.id === openSubmenuID)?.submenu;
    const submenu = useSubmenuFlip(openSubmenuID !== null && submenuItems !== undefined);

    const container = props.container ?? globalThis.document?.body;
    if (container === undefined || container === null) return null;

    const menu: ReactNode = (
        <div
            ref={rootRef}
            role="menu"
            aria-label={props.label ?? 'Context menu'}
            data-testid="context-menu"
            className="fixed z-50 min-w-[190px] rounded-lg p-1 text-[12px]"
            style={{ ...PANEL_STYLE, left: props.x, top: props.y }}
            onContextMenu={(event) => {
                event.preventDefault();
            }}
        >
            {props.items.map((item) => (
                <div key={item.id} className="relative">
                    <MenuRow
                        item={item}
                        openSubmenu={openSubmenuID === item.id}
                        onHover={() => {
                            setOpenSubmenuID(item.submenu === undefined ? null : item.id);
                        }}
                        onActivate={() => {
                            if (item.submenu !== undefined) {
                                setOpenSubmenuID(openSubmenuID === item.id ? null : item.id);
                                return;
                            }
                            item.onSelect?.();
                            onClose();
                        }}
                    />
                    {openSubmenuID === item.id && submenuItems !== undefined ? (
                        <div
                            ref={submenu.ref}
                            role="menu"
                            aria-label={item.label}
                            data-testid="context-submenu"
                            data-submenu-side={submenu.flipped ? 'left' : 'right'}
                            className={`absolute top-0 z-50 max-h-[320px] min-w-[180px] overflow-auto rounded-lg p-1 ${
                                submenu.flipped ? 'right-full mr-1' : 'left-full ml-1'
                            }`}
                            style={PANEL_STYLE}
                        >
                            {submenuItems.map((child) => (
                                <MenuRow
                                    key={child.id}
                                    item={child}
                                    openSubmenu={false}
                                    onHover={() => undefined}
                                    onActivate={() => {
                                        child.onSelect?.();
                                        onClose();
                                    }}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    );

    return createPortal(menu, container);
}

/** Panel size assumptions for the viewport clamp (the panel's own min-width is 190px). */
const MENU_ESTIMATED_WIDTH = 200;
const MENU_ESTIMATED_HEIGHT = 260;
const MENU_ROW_GAP = 4;

/** A rectangle the menu must not cover — normally the row that was right-clicked. */
export interface MenuAvoidRect {
    readonly top: number;
    readonly bottom: number;
}

/**
 * Where a context menu should open for a mouse event, clamped into the viewport.
 *
 * `avoid` keeps the menu off the row it acts on (run-B m7). Opening at the pointer put the
 * panel straight over the workspace being renamed or deleted, so the one thing a destructive
 * menu has to keep visible — WHICH one — was behind the menu. Given the row's rect the panel
 * drops to just under it, or rises above it when there is no room below, which is what a native
 * menu does when it cannot fit under its anchor.
 */
export function menuAnchorFromEvent(
    event: { clientX: number; clientY: number },
    avoid?: MenuAvoidRect | null | undefined
): {
    x: number;
    y: number;
} {
    const width = globalThis.innerWidth || 1280;
    const height = globalThis.innerHeight || 800;
    const maxY = Math.max(0, height - MENU_ESTIMATED_HEIGHT);
    let y = event.clientY;
    if (avoid !== undefined && avoid !== null) {
        const below = avoid.bottom + MENU_ROW_GAP;
        y = below <= maxY ? below : Math.max(0, avoid.top - MENU_ESTIMATED_HEIGHT - MENU_ROW_GAP);
    }
    return {
        x: Math.min(event.clientX, Math.max(0, width - MENU_ESTIMATED_WIDTH)),
        y: Math.min(y, maxY)
    };
}
