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
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { tokens } from './tokens';

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

function MenuRow(props: RowProps): ReactElement {
    const { item } = props;
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
    return (
        <button
            type="button"
            role="menuitem"
            aria-haspopup={item.submenu === undefined ? undefined : 'menu'}
            aria-expanded={item.submenu === undefined ? undefined : props.openSubmenu}
            aria-disabled={interactive ? undefined : true}
            disabled={!interactive}
            data-menu-item={item.id}
            className="flex w-full items-center gap-1.5 rounded px-2.5 py-1 text-left text-[12px] disabled:opacity-40"
            style={{
                color: item.danger === true ? '#E0655C' : tokens.textPrimary,
                background: props.openSubmenu ? tokens.selectionFill : 'transparent'
            }}
            onMouseEnter={props.onHover}
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

    const container = props.container ?? globalThis.document?.body;
    if (container === undefined || container === null) return null;

    const submenuItems = props.items.find((item) => item.id === openSubmenuID)?.submenu;

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
                            role="menu"
                            aria-label={item.label}
                            data-testid="context-submenu"
                            className="absolute left-full top-0 z-50 ml-1 max-h-[320px] min-w-[180px] overflow-auto rounded-lg p-1"
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

/** Where a context menu should open for a mouse event, clamped into the viewport. */
export function menuAnchorFromEvent(event: { clientX: number; clientY: number }): {
    x: number;
    y: number;
} {
    const width = globalThis.innerWidth || 1280;
    const height = globalThis.innerHeight || 800;
    return {
        x: Math.min(event.clientX, Math.max(0, width - 200)),
        y: Math.min(event.clientY, Math.max(0, height - 260))
    };
}
