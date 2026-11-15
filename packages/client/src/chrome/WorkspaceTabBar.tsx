/**
 * The workspace's tabs, drawn in the title bar (workspace-feature.md §12, shell-ui.md §3.3).
 *
 * A tab is 24 px tall in the 32 px bar, so a 4 px strip above and below every tab still drags
 * the window; the tab itself opts out (`[role='tab']` in the bar's no-drag list), and so does
 * every pixel of it, its padding included. The space after + is the bar's, and always drags.
 *
 * Gestures, all on the tab:
 *  - click shows it; middle-click closes it (when it is not the only tab);
 *  - double-click renames it in place (Enter keeps, Escape cancels, empty = named after its pane);
 *  - right-click opens the tab menu;
 *  - drag reorders it, or, dropped on a workspace in the sidebar, moves it there (Escape, a
 *    release outside the bar or the window losing the pointer cancels it).
 *
 * A press on a tab never takes the caret: the pane keeps the keyboard, and the tab bar is only
 * the keyboard's when it is reached on purpose (⌥⌘ chords, or Tab onto the tab on screen).
 *
 * Too many tabs: they shrink to `TAB_MIN_WIDTH_PX`, then the rest go into a "+N" menu whose dot
 * is the busiest hidden tab's, and the tab on screen is never one of the hidden ones.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type PointerEvent as ReactPointerEvent } from 'react';

import { ContextMenu, type MenuItemSpec } from './ContextMenu';
import { holdEscape, registerGestureReset } from './gesture-reset';
import { hoverFill, hoverText, useHoverKey } from './hover';
import { ChromeIcon, type ChromeIconName } from './icons';
import { TAB_SPRING_MS, markTabSpringShown, setTabDragWorkspace, setTabSpring, tabDropState, tabSpring, useTabDrop } from './tab-drop';
import { withAlpha } from './theme';
import { tokens } from './tokens';
import type { WorkspaceTabKind, WorkspaceTabStatus, WorkspaceTabView } from './workspace-tabs';

export const TAB_MIN_WIDTH_PX = 100;
export const TAB_MAX_WIDTH_PX = 220;
const TAB_GAP_PX = 2;
/** The "+N" overflow button and the + / chevron pair, reserved before tabs are fitted. */
const OVERFLOW_BUTTON_PX = 46;
const NEW_TAB_CONTROLS_PX = 48;
/** How far a press moves before it is a drag rather than a click. */
const TAB_DRAG_THRESHOLD_PX = 4;
/** The "Drop here for a new tab" slot (56 px and its margins), reserved while a pane is dragged. */
const PANE_DROP_SLOT_PX = 72;
/** Below this a tab drops its kind icon, split count and ZOOM badge, so the title and × still fit. */
const TAB_NARROW_PX = 150;
/** How far above or below the bar a released tab still reorders, rather than staying put. */
const TAB_DROP_BAND_SLACK_PX = 24;

const KIND_ICON: Readonly<Record<WorkspaceTabKind, ChromeIconName>> = {
    terminal: 'terminal',
    agent: 'agent',
    web: 'globe',
    document: 'document',
    scratchpad: 'note',
    image: 'image'
};

/** What a screen reader hears for a tab: its title, then what the dot and the badges show. */
export function tabAccessibleName(tab: WorkspaceTabView): string {
    const parts = [tab.title];
    if (tab.paneCount > 1) parts.push(`${String(tab.paneCount)} panes`);
    if (tab.status === 'waitingForInput') parts.push('an agent is waiting for input');
    else if (tab.status === 'running') parts.push('running');
    if (tab.zoomed) parts.push('zoomed');
    return parts.join(', ');
}

function statusColor(status: WorkspaceTabStatus): string {
    if (status === 'waitingForInput') return tokens.statusWaiting;
    if (status === 'running') return tokens.statusRunning;
    return tokens.statusInactive;
}

const STATUS_RANK: Readonly<Record<WorkspaceTabStatus, number>> = { idle: 0, running: 1, waitingForInput: 2 };

export interface WorkspaceTabBarProps {
    readonly tabs: readonly WorkspaceTabView[];
    /**
     * `force`: ask for the tab even when this window already shows it. A spring's way home is
     * that: its request for the opened tab may still be on its way, so the window's copy of the
     * state still shows home while the daemon is about to show the other one.
     */
    readonly onSelect: (tabID: string, options?: { readonly force?: boolean }) => void;
    readonly onClose: (tabID: string) => void;
    readonly onRename: (tabID: string, name: string | null) => void;
    /** `toIndex` counts the tabs without the moving one, as the daemon's `move-tab` does. */
    readonly onMove: (tabID: string, toIndex: number) => void;
    readonly onNewTab: () => void;
    /** The chevron beside +: what kind of tab to open, and Move Focused Pane to New Tab. */
    readonly newTabMenuItems: readonly MenuItemSpec[];
    /** The tab menu below Rename Tab… (which the bar owns, since renaming happens in the bar). */
    readonly tabMenuItems: (tab: WorkspaceTabView) => readonly MenuItemSpec[];
    readonly onMoveToWorkspace?: ((tabID: string, workspaceID: string) => void) | undefined;
    /**
     * Whose sidebar rows `onMoveToWorkspace` takes: absent for this window's own daemon, else the
     * paired daemon (its name) whose workspace these tabs are.
     */
    readonly rowDaemon?: string | undefined;
    /** The workspace these tabs belong to: its own row is no target (a drop there moves nothing). */
    readonly workspaceID?: string | undefined;
    /**
     * Show a tab of a workspace that is no longer the one drawn: a spring going home after a
     * workspace switch ended its drag. Absent, such a spring leaves its old workspace as it is.
     */
    readonly onSelectInWorkspace?: ((workspaceID: string, tabID: string) => void) | undefined;
    /** A tab is being dragged: the title bar stops being the window's drag handle meanwhile. */
    readonly onDraggingChange?: ((dragging: boolean) => void) | undefined;
    /**
     * The bar is done with the keyboard (a rename ended with Enter or Escape, which unmounts the
     * field without a blur): give the caret back to the focused pane.
     */
    readonly onReleaseCaret?: (() => void) | undefined;
}

interface TabDrag {
    readonly tabID: string;
    readonly pointerID: number;
    readonly startX: number;
    readonly startY: number;
    readonly element: HTMLElement;
    active: boolean;
    /** Lets go of Escape (`holdEscape`); set once the press becomes a drag. */
    releaseEscape?: (() => void) | undefined;
}

export interface FittedTabs {
    readonly visible: readonly WorkspaceTabView[];
    readonly hidden: readonly WorkspaceTabView[];
    /** About how wide each visible tab is drawn (null = not measured yet). */
    readonly width: number | null;
}

/**
 * Which tabs fit: all of them, or the first few plus the one on screen. `reserve` is room the
 * bar needs for something else just now (the pane-drop slot). With no room for even one tab,
 * every tab is in "+N", so nothing is drawn over the bar's drag space or its trailing controls.
 */
export function fitTabs(tabs: readonly WorkspaceTabView[], room: number | null, reserve = 0): FittedTabs {
    if (room === null) return { visible: tabs, hidden: [], width: null };
    const space = room - reserve - NEW_TAB_CONTROLS_PX;
    const per = TAB_MIN_WIDTH_PX + TAB_GAP_PX;
    const widthFor = (count: number, left: number): number | null =>
        count === 0 ? null : Math.min(TAB_MAX_WIDTH_PX, (left + TAB_GAP_PX) / count - TAB_GAP_PX);
    const fitsAll = Math.floor((space + TAB_GAP_PX) / per);
    if (tabs.length <= fitsAll) return { visible: tabs, hidden: [], width: widthFor(tabs.length, space) };
    const left = space - OVERFLOW_BUTTON_PX;
    const count = Math.max(0, Math.floor((left + TAB_GAP_PX) / per));
    if (count === 0) return { visible: [], hidden: tabs, width: null };
    const active = tabs.find((tab) => tab.active);
    let visible = tabs.slice(0, count);
    if (active !== undefined && !visible.includes(active)) visible = [...tabs.slice(0, count - 1), active];
    return { visible, hidden: tabs.filter((tab) => !visible.includes(tab)), width: widthFor(visible.length, left) };
}

/** The insertion slot (0…n) a pointer at `x` is closest to, over the tabs drawn in `strip`. */
function slotAt(strip: HTMLElement | null, x: number): number | null {
    if (strip === null) return null;
    const tabs = [...strip.querySelectorAll<HTMLElement>('[data-workspace-tab-id]')];
    if (tabs.length === 0) return null;
    for (const tab of tabs) {
        const box = tab.getBoundingClientRect();
        if (x < box.left + box.width / 2) return Number(tab.getAttribute('data-tab-index'));
    }
    const last = tabs[tabs.length - 1] as HTMLElement;
    return Number(last.getAttribute('data-tab-index')) + 1;
}

/**
 * A sidebar workspace row under the pointer (`chrome/Sidebar.tsx`), for a tab dropped there.
 * Only the rows of the daemon the tabs belong to: this window's own (`daemon` null), or the
 * paired daemon whose workspace the bar is drawing. A paired daemon's rows draw the same
 * component inside its `data-remote-daemon` section (`app/RemoteDaemonSections.tsx`), and a tab
 * cannot move to another machine.
 */
function workspaceRowAt(x: number, y: number, daemon: string | null): string | null {
    if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
    for (const element of document.elementsFromPoint(x, y)) {
        const row = element.closest('[data-testid="workspace-row"][data-workspace-id]');
        if (row === null) continue;
        const owner = row.closest('[data-remote-daemon]')?.getAttribute('data-remote-daemon') ?? null;
        if (owner !== daemon) return null;
        // A row under the remote sections that names no daemon is nobody's to drop on.
        if (owner === null && row.closest('[data-testid="remote-daemon-sections"]') !== null) return null;
        return row.getAttribute('data-workspace-id');
    }
    return null;
}

/** A release this far from the bar is not a reorder: the tab stays where it was. */
function inDropBand(region: HTMLElement | null, y: number): boolean {
    if (region === null) return false;
    const box = region.getBoundingClientRect();
    return y >= box.top - TAB_DROP_BAND_SLACK_PX && y <= box.bottom + TAB_DROP_BAND_SLACK_PX;
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps): ReactElement {
    const { tabs } = props;
    const regionRef = useRef<HTMLDivElement | null>(null);
    const stripRef = useRef<HTMLDivElement | null>(null);
    const plusRef = useRef<HTMLButtonElement | null>(null);
    const chevronRef = useRef<HTMLButtonElement | null>(null);
    const overflowRef = useRef<HTMLButtonElement | null>(null);
    const [room, setRoom] = useState<number | null>(null);
    const [hovered, hover] = useHoverKey();
    const [menu, setMenu] = useState<
        | { readonly kind: 'tab'; readonly tab: WorkspaceTabView; readonly x: number; readonly y: number; readonly keyboard?: boolean }
        | { readonly kind: 'new' | 'overflow'; readonly x: number; readonly y: number }
        | null
    >(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [hints, setHints] = useState(false);
    const dragRef = useRef<TabDrag | null>(null);
    /** The exact `removeEventListener` calls for the window listeners a press installed. */
    const detachDrag = useRef<(() => void) | null>(null);
    const [dragSlot, setDragSlot] = useState<{ readonly tabID: string; readonly slot: number | null; readonly workspaceID: string | null } | null>(null);
    const suppressClick = useRef(false);
    /** Arrow keys picked this tab: focus it once it is drawn (it may be in "+N" until then). */
    const pendingFocus = useRef<string | null>(null);
    const paneDrop = useTabDrop();
    /*
     * The drag's window handlers outlive the render that installed them, so they read props
     * through a ref (as `SidebarResizer` does) rather than closing over a stale render.
     */
    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    // Too many tabs: measure the room the bar gives the strip (it grows to fill, so its width
    // IS the room) and fit tabs at their minimum width.
    useLayoutEffect(() => {
        const region = regionRef.current;
        if (region === null || typeof ResizeObserver === 'undefined') return undefined;
        const measure = (): void => {
            const width = region.getBoundingClientRect().width;
            if (width > 0) setRoom((current) => (current === width ? current : width));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(region);
        return () => {
            observer.disconnect();
        };
    }, []);

    /*
     * Spring-loading (§12): a pane held over a tab that is not on screen opens it after
     * `TAB_SPRING_MS`, and the tab fills from the left meanwhile so the wait reads as one. Only
     * a tab itself springs: the gaps between tabs and the new-tab slot are drops, not tabs.
     */
    const [springing, setSpringing] = useState<string | null>(null);
    const springTarget = paneDrop.dragging && paneDrop.target?.kind === 'tab' ? paneDrop.target.tabID : null;
    const springCandidate = springTarget !== null && tabs.some((tab) => tab.id === springTarget && !tab.active) ? springTarget : null;
    useEffect(() => {
        setSpringing(springCandidate);
        if (springCandidate === null) return undefined;
        const timer = setTimeout(() => {
            setSpringing(null);
            // No pane in flight any more (its grid went without saying so): nothing to open.
            if (!tabDropState().dragging) return;
            const current = latest.current;
            const origin = tabSpring()?.originTabID ?? current.tabs.find((tab) => tab.active)?.id;
            if (origin === undefined) return;
            // Home is a tab of THIS workspace, even if another is on screen by the time it is asked for.
            const home = current.workspaceID;
            // Back over the tab it started in is home again, not another spring.
            setTabSpring(
                springCandidate === origin
                    ? null
                    : {
                          originTabID: origin,
                          tabID: springCandidate,
                          shown: false,
                          returnHome: () => {
                              const now = latest.current;
                              if (home === undefined || now.workspaceID === home) now.onSelect(origin, { force: true });
                              else now.onSelectInWorkspace?.(home, origin);
                          }
                      }
            );
            current.onSelect(springCandidate);
        }, TAB_SPRING_MS);
        return () => {
            clearTimeout(timer);
        };
    }, [springCandidate]);
    // The tab a spring asked for is on screen now: the grid may offer its panes as drops.
    const shownTabID = tabs.find((tab) => tab.active)?.id ?? null;
    useEffect(() => {
        if (shownTabID !== null) markTabSpringShown(shownTabID);
    }, [shownTabID]);

    // ⌥⌘ held: every tab shows the number ⌥⌘1-9 would go to.
    useEffect(() => {
        const update = (event: KeyboardEvent): void => {
            setHints(event.altKey && event.metaKey && !event.ctrlKey);
        };
        const clear = (): void => {
            setHints(false);
        };
        window.addEventListener('keydown', update, true);
        window.addEventListener('keyup', update, true);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', update, true);
            window.removeEventListener('keyup', update, true);
            window.removeEventListener('blur', clear);
        };
    }, []);

    /*
     * Every way a tab drag ends comes through here: the release (`commit`), and every way it is
     * lost (pointercancel, Escape, the window losing the pointer, the bar unmounting, a new press
     * over a press whose release never arrived). It is safe with no drag running.
     */
    const endDrag = useCallback((commit: boolean, x = 0, y = 0): void => {
        const drag = dragRef.current;
        dragRef.current = null;
        detachDrag.current?.();
        detachDrag.current = null;
        drag?.releaseEscape?.();
        setDragSlot(null);
        setTabDragWorkspace(null);
        if (drag === null || !drag.active) return;
        const current = latest.current;
        current.onDraggingChange?.(false);
        // The click this release makes is the drag's, not a press on a tab. It is dispatched with
        // the release, so a click that comes later than that is a real one.
        suppressClick.current = true;
        setTimeout(() => {
            suppressClick.current = false;
        }, 0);
        if (!commit) return;
        // The tab can go while it is in flight (its agent pane exited): then nothing moves.
        const from = current.tabs.findIndex((tab) => tab.id === drag.tabID);
        if (from < 0) return;
        const row = current.onMoveToWorkspace === undefined ? null : workspaceRowAt(x, y, current.rowDaemon ?? null);
        const workspaceID = row === current.workspaceID ? null : row;
        if (workspaceID !== null) {
            current.onMoveToWorkspace?.(drag.tabID, workspaceID);
            return;
        }
        if (!inDropBand(regionRef.current, y)) return;
        const slot = slotAt(stripRef.current, x);
        if (slot === null) return;
        const toIndex = slot > from ? slot - 1 : slot;
        if (toIndex !== from) current.onMove(drag.tabID, toIndex);
    }, []);

    // The release can be lost to something outside this document (a web pane's native view, a
    // Space switch): `gesture-reset.ts` hears the blur. And the bar can go away mid-drag.
    useEffect(() => registerGestureReset(() => endDrag(false)), [endDrag]);
    useEffect(() => () => endDrag(false), [endDrag]);

    const onPointerDown = (tab: WorkspaceTabView, event: ReactPointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0 || renaming === tab.id) return;
        endDrag(false);
        const drag: TabDrag = {
            tabID: tab.id,
            pointerID: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            element: event.currentTarget,
            active: false
        };
        dragRef.current = drag;
        const move = (moved: PointerEvent): void => {
            if (dragRef.current !== drag || moved.pointerId !== drag.pointerID) return;
            // No button held: the release went somewhere this document never heard of.
            if ((moved.buttons & 1) === 0) {
                endDrag(false);
                return;
            }
            if (!drag.active) {
                if (Math.hypot(moved.clientX - drag.startX, moved.clientY - drag.startY) < TAB_DRAG_THRESHOLD_PX) return;
                drag.active = true;
                try {
                    drag.element.setPointerCapture?.(drag.pointerID);
                } catch {
                    // The tab is gone or the pointer is not down: the window listeners still follow it.
                }
                // Escape cancels it, ahead of the window's own Escape binding.
                drag.releaseEscape = holdEscape(() => endDrag(false));
                latest.current.onDraggingChange?.(true);
            }
            const daemon = latest.current.rowDaemon ?? null;
            const row = latest.current.onMoveToWorkspace === undefined ? null : workspaceRowAt(moved.clientX, moved.clientY, daemon);
            // Its own workspace's row takes no drop, so it does not light up either.
            const workspaceID = row === latest.current.workspaceID ? null : row;
            setTabDragWorkspace(workspaceID === null ? null : { daemon, workspaceID });
            setDragSlot({
                tabID: drag.tabID,
                slot: workspaceID === null && inDropBand(regionRef.current, moved.clientY) ? slotAt(stripRef.current, moved.clientX) : null,
                workspaceID
            });
        };
        const up = (released: PointerEvent): void => {
            if (released.pointerId === drag.pointerID) endDrag(true, released.clientX, released.clientY);
        };
        const cancel = (cancelled: PointerEvent): void => {
            if (cancelled.pointerId === drag.pointerID) endDrag(false);
        };
        const key = (pressed: KeyboardEvent): void => {
            if (pressed.key !== 'Escape' || !drag.active) return;
            pressed.preventDefault();
            pressed.stopPropagation();
            endDrag(false);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        window.addEventListener('keydown', key, true);
        detachDrag.current = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancel);
            window.removeEventListener('keydown', key, true);
        };
    };

    // A rename that ended with Enter or Escape removed the focused field without a blur, which
    // leaves the caret on <body>: hand it back to the pane (a blur commit went somewhere already).
    const returnRenameCaret = useRef(false);
    useEffect(() => {
        if (renaming !== null || !returnRenameCaret.current) return;
        returnRenameCaret.current = false;
        if (document.activeElement === document.body) latest.current.onReleaseCaret?.();
    }, [renaming]);

    // Arrow keys picked a tab that only becomes drawn (out of "+N") once the daemon shows it.
    useLayoutEffect(() => {
        const tabID = pendingFocus.current;
        if (tabID === null) return;
        const element = stripRef.current?.querySelector<HTMLElement>(`[data-workspace-tab-id="${tabID}"]`);
        if (element === null || element === undefined) return;
        pendingFocus.current = null;
        element.focus();
    });

    const commitRename = (tabID: string, value: string): void => {
        setRenaming(null);
        const trimmed = value.trim();
        props.onRename(tabID, trimmed === '' ? null : trimmed);
    };

    const fitted = fitTabs(tabs, room, paneDrop.dragging ? PANE_DROP_SLOT_PX : 0);
    const narrow = fitted.width !== null && fitted.width < TAB_NARROW_PX;
    const closable = tabs.length > 1;
    const hiddenBusiest = fitted.hidden.reduce<WorkspaceTabStatus>(
        (best, tab) => (STATUS_RANK[tab.status] > STATUS_RANK[best] ? tab.status : best),
        'idle'
    );
    const paneTarget = paneDrop.dragging ? paneDrop.target : null;
    const insertion =
        dragSlot !== null ? dragSlot.slot : paneTarget?.kind === 'slot' ? paneTarget.index : null;

    const menuAt = (anchor: HTMLElement | null): { x: number; y: number } => {
        const box = anchor?.getBoundingClientRect();
        return box === undefined ? { x: 8, y: 32 } : { x: Math.round(box.left), y: Math.round(box.bottom + 4) };
    };

    const tabMenu = (tab: WorkspaceTabView): readonly MenuItemSpec[] => [
        { id: 'rename-tab', label: 'Rename Tab…', onSelect: () => setRenaming(tab.id) },
        ...props.tabMenuItems(tab)
    ];

    return (
        <div ref={regionRef} data-testid="workspace-tab-region" className="flex h-full min-w-0 flex-1 items-center overflow-hidden">
            <div
                ref={stripRef}
                role="tablist"
                aria-label="Tabs"
                data-testid="workspace-tabs"
                className="flex h-full min-w-0 items-center pl-1"
                style={{ gap: TAB_GAP_PX, flex: '0 1 auto' }}
                onKeyDown={(event) => {
                    const at = tabs.findIndex((tab) => tab.active);
                    let next: WorkspaceTabView | undefined;
                    if (event.key === 'ArrowRight') next = tabs[(at + 1) % tabs.length];
                    else if (event.key === 'ArrowLeft') next = tabs[(at - 1 + tabs.length) % tabs.length];
                    else if (event.key === 'Home') next = tabs[0];
                    else if (event.key === 'End') next = tabs[tabs.length - 1];
                    else if (event.key === 'F2' && at >= 0) {
                        event.preventDefault();
                        setRenaming((tabs[at] as WorkspaceTabView).id);
                        return;
                    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                        // The tab menu from the keyboard: the focused tab's, under it, taking the keyboard.
                        const focusedID = (document.activeElement as HTMLElement | null)?.getAttribute('data-workspace-tab-id');
                        const target = tabs.find((tab) => tab.id === focusedID) ?? tabs[at];
                        if (target === undefined) return;
                        event.preventDefault();
                        const box = stripRef.current?.querySelector<HTMLElement>(`[data-workspace-tab-id="${target.id}"]`)?.getBoundingClientRect();
                        setMenu({
                            kind: 'tab',
                            tab: target,
                            keyboard: true,
                            ...(box === undefined ? { x: 8, y: 32 } : { x: Math.round(box.left), y: Math.round(box.bottom + 4) })
                        });
                        return;
                    } else return;
                    event.preventDefault();
                    if (next === undefined) return;
                    props.onSelect(next.id);
                    pendingFocus.current = next.id;
                    stripRef.current?.querySelector<HTMLElement>(`[data-workspace-tab-id="${next.id}"]`)?.focus();
                }}
            >
                {fitted.visible.map((tab, position) => {
                    const isRenaming = renaming === tab.id;
                    const isPaneTarget = paneTarget?.kind === 'tab' && paneTarget.tabID === tab.id;
                    const isDragged = dragSlot?.tabID === tab.id;
                    const key = `tab:${tab.id}`;
                    const isHovered = hovered === key;
                    // The slot after this tab, when the tab drawn next is not the one that starts
                    // it (the last tab, or the one before a run of tabs folded into "+N").
                    const nextDrawn = fitted.visible[position + 1];
                    const marksAfter = nextDrawn === undefined || nextDrawn.index !== tab.index + 1;
                    return (
                        <div
                            key={tab.id}
                            role="tab"
                            aria-selected={tab.active}
                            tabIndex={tab.active ? 0 : -1}
                            data-testid={`workspace-tab-${tab.id}`}
                            data-workspace-tab-id={tab.id}
                            data-tab-index={tab.index}
                            data-active={tab.active ? 'true' : 'false'}
                            data-status={tab.status}
                            data-attention={tab.attention ? 'true' : 'false'}
                            data-unvisited={tab.unvisited ? 'true' : 'false'}
                            title={tab.title}
                            aria-label={tabAccessibleName(tab)}
                            // No `outline-none`: Tab focus gets the app's keyboard ring (a press never
                            // focuses a tab, its mousedown is prevented, so the mouse never shows it).
                            className="relative flex h-6 shrink items-center gap-[7px] rounded-[3px] pl-2.5 pr-1 text-[12px]"
                            style={{
                                flex: '0 1 auto',
                                minWidth: TAB_MIN_WIDTH_PX,
                                maxWidth: TAB_MAX_WIDTH_PX,
                                boxSizing: 'border-box',
                                opacity: isDragged ? 0.55 : 1,
                                color: tab.active || tab.attention ? tokens.textPrimary : hoverText(isHovered, tokens.textSecondary),
                                fontWeight: tab.attention ? 600 : 400,
                                fontStyle: tab.unvisited ? 'italic' : 'normal',
                                background: tab.active
                                    ? withAlpha(tokens.accent, 0.2)
                                    : isPaneTarget
                                      ? withAlpha(tokens.accent, 0.14)
                                      : hoverFill(isHovered, 'transparent'),
                                boxShadow: tab.active ? `inset 0 0 0 1px ${withAlpha(tokens.accent, 0.75)}` : 'none',
                                outline: isPaneTarget ? `1.5px dashed ${tokens.accent}` : undefined,
                                outlineOffset: isPaneTarget ? -1.5 : undefined,
                                WebkitAppRegion: 'no-drag'
                            } as React.CSSProperties}
                            {...hover(key)}
                            onMouseDown={(event) => {
                                // A press does not move the caret off the pane (the rename field
                                // still takes its own clicks).
                                if (!isRenaming) event.preventDefault();
                            }}
                            onPointerDown={(event) => {
                                onPointerDown(tab, event);
                            }}
                            onClick={() => {
                                if (suppressClick.current) {
                                    suppressClick.current = false;
                                    return;
                                }
                                if (!tab.active) props.onSelect(tab.id);
                            }}
                            onDoubleClick={() => {
                                setRenaming(tab.id);
                            }}
                            onAuxClick={(event) => {
                                if (event.button !== 1 || !closable) return;
                                event.preventDefault();
                                props.onClose(tab.id);
                            }}
                            onContextMenu={(event) => {
                                event.preventDefault();
                                setMenu({ kind: 'tab', tab, x: event.clientX, y: event.clientY });
                            }}
                        >
                            {springing === tab.id ? <SpringFill /> : null}
                            {insertion === tab.index ? <InsertionMarker side="left" /> : null}
                            {marksAfter && insertion === tab.index + 1 ? <InsertionMarker side="right" /> : null}
                            <span
                                aria-hidden
                                data-testid={`workspace-tab-dot-${tab.id}`}
                                className="h-[7px] w-[7px] shrink-0 rounded-full"
                                style={
                                    tab.unvisited
                                        ? { border: `1.5px solid ${tokens.textTertiary}`, boxSizing: 'border-box' }
                                        : {
                                              background: statusColor(tab.status),
                                              boxShadow: tab.attention ? `0 0 0 3px ${withAlpha(tokens.statusWaiting, 0.28)}` : undefined
                                          }
                                }
                            />
                            {narrow ? null : (
                                <span className="shrink-0" style={{ opacity: 0.75, display: 'flex' }} aria-hidden>
                                    <ChromeIcon name={KIND_ICON[tab.kind]} size={12} />
                                </span>
                            )}
                            {isRenaming ? (
                                <RenameField
                                    initial={tab.named ? tab.title : ''}
                                    placeholder={tab.title}
                                    onCommit={(value, keyed) => {
                                        returnRenameCaret.current = keyed;
                                        commitRename(tab.id, value);
                                    }}
                                    onCancel={() => {
                                        returnRenameCaret.current = true;
                                        setRenaming(null);
                                    }}
                                />
                            ) : (
                                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                            )}
                            {tab.paneCount > 1 && !narrow ? (
                                <span
                                    title={`${String(tab.paneCount)} panes in this tab`}
                                    data-testid={`workspace-tab-count-${tab.id}`}
                                    className="flex shrink-0 items-center gap-[3px] text-[11px]"
                                    style={{ color: tokens.textTertiary, fontWeight: 400 }}
                                >
                                    <ChromeIcon name="layout" size={11} />
                                    {tab.paneCount}
                                </span>
                            ) : null}
                            {tab.zoomed && !narrow ? (
                                <span
                                    className="shrink-0 rounded px-1 text-[9px] font-bold tracking-wide"
                                    style={{ background: withAlpha('#D08237', 0.2), color: '#E5A565' }}
                                >
                                    ZOOM
                                </span>
                            ) : null}
                            {hints && tab.index < 9 ? (
                                <span className="shrink-0 text-[11px]" style={{ color: tokens.textTertiary, fontWeight: 400 }}>
                                    ⌥⌘{tab.index + 1}
                                </span>
                            ) : null}
                            {closable ? (
                                // Out of the accessibility tree (no button nested in a tab): the
                                // tab menu's Close Tab and ⌥⌘W are the accessible ways to close it.
                                <button
                                    type="button"
                                    data-testid={`workspace-tab-close-${tab.id}`}
                                    aria-hidden
                                    title="Close Tab (⌥⌘W)"
                                    tabIndex={-1}
                                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px]"
                                    style={{
                                        // The tab on screen always shows its ×; another tab, under the pointer.
                                        visibility: tab.active || isHovered ? 'visible' : 'hidden',
                                        color: tokens.textSecondary
                                    }}
                                    onPointerDown={(event) => {
                                        event.stopPropagation();
                                    }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        props.onClose(tab.id);
                                    }}
                                    onDoubleClick={(event) => {
                                        // Two quick clicks on × are two closes, never a rename.
                                        event.stopPropagation();
                                    }}
                                >
                                    <ChromeIcon name="close" size={10} />
                                </button>
                            ) : (
                                <span className="w-1 shrink-0" />
                            )}
                        </div>
                    );
                })}
            </div>
            {fitted.hidden.length > 0 ? (
                <button
                    ref={overflowRef}
                    type="button"
                    data-testid="workspace-tabs-overflow"
                    aria-label={`${String(fitted.hidden.length)} more tabs`}
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'overflow'}
                    className="ml-1 flex h-[22px] shrink-0 items-center gap-[5px] rounded-[3px] px-[7px] text-[12px]"
                    style={{ background: withAlpha('#E6E6EA', 0.06), color: tokens.textSecondary, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    onClick={() => {
                        setMenu(menu?.kind === 'overflow' ? null : { kind: 'overflow', ...menuAt(overflowRef.current) });
                    }}
                >
                    <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: statusColor(hiddenBusiest) }} />+
                    {fitted.hidden.length}
                </button>
            ) : null}
            <div className="ml-1 flex shrink-0 items-center">
                <button
                    ref={plusRef}
                    type="button"
                    data-testid="workspace-tab-new"
                    aria-label="New tab"
                    title="New Tab (⌥⌘T)"
                    className="flex h-[22px] w-6 items-center justify-center rounded-[3px]"
                    data-hovered={hovered === 'new' ? 'true' : 'false'}
                    style={{ color: hoverText(hovered === 'new', tokens.textSecondary), background: hoverFill(hovered === 'new') }}
                    {...hover('new')}
                    onClick={props.onNewTab}
                >
                    <ChromeIcon name="plus" size={12} />
                </button>
                <button
                    ref={chevronRef}
                    type="button"
                    data-testid="workspace-tab-new-menu"
                    aria-label="New tab options"
                    aria-haspopup="menu"
                    aria-expanded={menu?.kind === 'new'}
                    className="flex h-[22px] w-4 items-center justify-center rounded-[3px]"
                    data-hovered={hovered === 'new-menu' ? 'true' : 'false'}
                    style={{ color: hoverText(hovered === 'new-menu', tokens.textTertiary), background: hoverFill(hovered === 'new-menu') }}
                    {...hover('new-menu')}
                    onClick={() => {
                        setMenu(menu?.kind === 'new' ? null : { kind: 'new', ...menuAt(plusRef.current) });
                    }}
                >
                    <ChromeIcon name="chevron-down" size={10} />
                </button>
            </div>
            {paneDrop.dragging ? (
                <div
                    data-testid="workspace-tab-drop-slot"
                    data-tab-drop-slot={tabs.length}
                    className="mx-2 flex h-6 min-w-[56px] flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[3px] px-2.5 text-[12px]"
                    style={{
                        border: `1px dashed ${paneTarget?.kind === 'slot' && paneTarget.index === tabs.length ? tokens.accent : tokens.textTertiary}`,
                        color: tokens.textTertiary
                    }}
                >
                    <ChromeIcon name="plus" size={11} />
                    Drop here for a new tab
                </div>
            ) : (
                // The bar's own space: it drags the window (§3.3), however many tabs there are.
                <div aria-hidden className="h-full min-w-0 flex-1" />
            )}
            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    // A dropdown's own button closes it on a second click, rather than the
                    // dismissal closing it on mousedown and the click opening it again.
                    anchorRef={menu.kind === 'new' ? chevronRef : menu.kind === 'overflow' ? overflowRef : undefined}
                    autoFocus={menu.kind === 'tab' && menu.keyboard === true}
                    label={menu.kind === 'tab' ? 'Tab' : menu.kind === 'new' ? 'New tab' : 'More tabs'}
                    items={
                        menu.kind === 'tab'
                            ? tabMenu(menu.tab)
                            : menu.kind === 'new'
                              ? props.newTabMenuItems
                              : fitted.hidden.map((tab) => ({
                                    id: `show-tab:${tab.id}`,
                                    label: tab.index < 9 ? `${tab.title}  ⌥⌘${String(tab.index + 1)}` : tab.title,
                                    // Only in a bar too narrow for any tab is the one on screen here.
                                    checked: tab.active,
                                    onSelect: () => {
                                        if (!tab.active) props.onSelect(tab.id);
                                    }
                                }))
                    }
                    onClose={() => {
                        setMenu(null);
                    }}
                />
            )}
        </div>
    );
}

/** The hold before a tab under a dragged pane opens: a wash that fills the tab once. */
function SpringFill(): ReactElement {
    return (
        <span
            aria-hidden
            data-testid="workspace-tab-spring"
            // The sweep's length is `TAB_SPRING_MS`, written in styles.css (`.kelpi-tab-spring`).
            className="kelpi-tab-spring pointer-events-none absolute inset-0 rounded-[3px]"
            style={{ background: withAlpha(tokens.accent, 0.22) }}
        />
    );
}

function InsertionMarker(props: { readonly side: 'left' | 'right' }): ReactElement {
    return (
        <span
            aria-hidden
            data-testid="workspace-tab-insertion"
            className="pointer-events-none absolute top-[1px] h-[22px] w-[2px] rounded-[1px]"
            style={{
                [props.side]: -2,
                background: tokens.accent,
                boxShadow: `0 0 0 3px ${withAlpha(tokens.accent, 0.2)}`
            }}
        />
    );
}

function RenameField(props: {
    readonly initial: string;
    readonly placeholder: string;
    /** `keyed`: Enter ended it (the field goes without a blur), not a blur elsewhere. */
    readonly onCommit: (value: string, keyed: boolean) => void;
    readonly onCancel: () => void;
}): ReactElement {
    const done = useRef(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const latestProps = useRef(props);
    latestProps.current = props;
    /*
     * Taken away mid-edit (a workspace switch, the tab gone elsewhere): what was typed is kept, as
     * a pane rename keeps it when its field goes. A removed field gets no blur, so the unmount is
     * the last word. A node still in the document is a test renderer's double mount, not an unmount.
     */
    useEffect(() => {
        // Held here: React has already cleared the ref by the time an unmount's cleanup runs.
        const input = inputRef.current;
        return () => {
            if (done.current || input === null || input.isConnected) return;
            done.current = true;
            latestProps.current.onCommit(input.value, false);
        };
    }, []);
    return (
        <input
            ref={inputRef}
            data-testid="workspace-tab-rename"
            aria-label="Tab name"
            autoFocus
            defaultValue={props.initial}
            placeholder={props.placeholder}
            className="h-5 min-w-0 flex-1 rounded px-1.5 text-[12px] outline-none"
            style={{ background: tokens.windowBackground, border: `1px solid ${tokens.accent}`, color: tokens.textPrimary, fontStyle: 'normal' }}
            onFocus={(event) => {
                event.currentTarget.select();
            }}
            onPointerDown={(event) => {
                event.stopPropagation();
            }}
            onClick={(event) => {
                // A click in the field of a tab behind is not a click on that tab.
                event.stopPropagation();
            }}
            onDoubleClick={(event) => {
                event.stopPropagation();
            }}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                    done.current = true;
                    props.onCommit(event.currentTarget.value, true);
                } else if (event.key === 'Escape') {
                    done.current = true;
                    props.onCancel();
                }
            }}
            onBlur={(event) => {
                if (done.current) return;
                done.current = true;
                props.onCommit(event.currentTarget.value, false);
            }}
        />
    );
}
