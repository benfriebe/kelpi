/**
 * The phone shell (B1/B2/B3/B4/B6/B7 of docs/MOBILE-PLAN.md, plus the owner's requests of
 * 2026-09-08: a switch between one pane and the full layout, more than one host, a landing page
 * to pick a host, and every pane type on screen).
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Assembly (`App.tsx`) renders this INSTEAD of the desktop's title bar, sidebar, grid, inspector
 * and footer when the form factor is `phone`, and it renders it inside the same root with the
 * same store, the same `act` verbs, the same `renderPane` and the same overlays. Nothing here
 * reaches into App's internals: everything arrives as props, collected into one object at the
 * one place App builds it. The desktop branch is untouched and byte-identical.
 *
 * ## Three top-level states, one value (`phone/view.ts` `screen`)
 *
 *   `landing`  the host list, and one host's workspaces inside it (`PhoneLanding`). Where the
 *              phone starts when nothing is remembered, and where the header's Hosts button and
 *              the drawer's top row go back to. Not a sheet, so it registers no modal presence.
 *   `pane`     one pane filling the content box (`phone/view.ts` says why the focused one)
 *   `layout`   the workspace's `PaneGrid`, at phone size
 *
 * The last two draw the SAME pane, so B8 (issue #120) gives it one mounted body between them: the
 * shown pane's terminal is rendered into a DOM node the shell moves from the full box to the
 * grid's cell and back, rather than being destroyed and rebuilt on every tap of the toggle. The
 * `slot` block below carries the measurement and the reason.
 *
 * What is on screen in the last two:
 *
 *   header   hosts button · workspaces button · "host · workspace ▸ pane" title · agent dot ·
 *            view toggle · panes button · overflow
 *   sheets   the workspace drawer (hosts and their workspaces), the pane sheet, the overflow
 *            menu, the add-host form, the rename prompt
 *
 * Hosts: the origin (this page's daemon), the origin's configured `remote-daemon` peers (already
 * dialled by assembly, §1.7), and the phone's own list (`phone/hosts.ts`), each with its own
 * runtime. A remote host's workspace renders through `PhoneRemoteWorkspace`.
 *
 * ## Every pane type passes through (B7)
 *
 * The origin's panes are drawn by assembly's own `renderPane`, in BOTH modes, so a markdown
 * preview, a diff, a scratchpad and a markdown pane hosting `$EDITOR` are the very components the
 * Mac draws, unchanged - the shell filters nothing by type on the way in. Exactly one type is
 * answered here instead: a `web` pane becomes `PhoneWebCard` (MOBILE-PLAN.md §9, "web panes stay
 * a card on the phone"), because the page is a native view the Electron shell composites over the
 * document and there is no such shell behind a phone browser; that file carries the full reason.
 * The wrapper is what the grid gets too, so the two modes agree.
 *
 * The key bar (C9) is a TERMINAL's bar and belongs to the content box: `terminal/pane-registry.ts`
 * is the pane-type test (a handle exists only for a live terminal renderer), so a web card or a
 * content pane on screen leaves the bar off and gives its 45 px back to the pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';

import { layoutPaneOrder, type WorkspaceState } from '@kelpi/daemon/store';

import type { DaemonTarget, StorageLike } from '../app/config';
import { ConnectionSplash } from '../app/ConnectionScreen';
import { useRemoteDaemons, type RemoteDaemonRuntime, type RemoteRuntimeFactory } from '../app/remote-daemons';
import { type FormFactorWindow } from '../chrome/form-factor';
import { ChromeIcon } from '../chrome/icons';
import { agentCounts } from '../chrome/Sidebar';
import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ChromeWorkspace } from '../chrome/types';
import { PaneGrid, paneDisplayTitle, type PaneGridProps, type RenderPane } from '../grid';
import type { KelpiRuntime, KelpiState } from '../state';
import { PhoneKeyBar, type TerminalRendererFactory } from '../terminal';
import { usePhoneHosts } from './hosts';
import { originHostName } from './hosts';
import { ORIGIN_HOST_KEY, type PhoneHostModel, type PhoneWorkspaceSelection } from './model';
import { PhoneHostSheet } from './PhoneHostSheet';
import { PhoneLanding } from './PhoneLanding';
import { PhoneMenuSheet, type PhoneMenuItem } from './PhoneMenuSheet';
import { PhonePaneSheet } from './PhonePaneSheet';
import { PhonePromptSheet } from './PhonePromptSheet';
import { PhoneRemoteWorkspace, remoteShownPane } from './PhoneRemoteWorkspace';
import { PhoneWebCard, phoneWebCardTab } from './PhoneWebCard';
import { PhoneWorkspaceDrawer } from './PhoneWorkspaceDrawer';
import { useSheetHistory, type SheetHistoryLike } from './sheet-history';
import { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton, statusDotColor } from './ui';
import type { PhoneView } from './view';

/** The origin's verbs the shell needs, bound by assembly to its `act`. */
export interface PhoneShellActions {
    activateWorkspace(workspaceID: string): void;
    /** Create a workspace named by the phone's prompt (the desktop's form is a sidebar's). */
    createWorkspace(name: string): void;
    focusPane(paneID: string): void;
    closePane(paneID: string): void;
    renamePane(paneID: string, name: string): void;
    createPane(): void;
    toggleSyncInput(): void;
    openPalette(): void;
    openSettings(): void;
}

/** The desktop grid's props that are NOT the workspace itself: assembly's bindings pass through. */
export type PhoneGridProps = Omit<
    PaneGridProps,
    'layout' | 'panes' | 'focusedPaneID' | 'zoomedPaneID' | 'syncActive' | 'syncExcludedPaneIDs' | 'homeDirectory' | 'renderPane' | 'focusFollowsMouse' | 'focusFollowsMouseDelayMs'
>;

export interface PhoneShellProps {
    readonly runtime: KelpiRuntime;
    /** The whole client state, for the connection splash; `ready` is its `daemon.hasSnapshot`. */
    readonly state: KelpiState;
    readonly ready: boolean;
    readonly target: DaemonTarget;
    readonly workspace: WorkspaceState | null;
    /** Assembly's echo-aware focused pane (`selectFocusedPaneID`). */
    readonly focusedPaneID: string | null;
    readonly view: PhoneView;
    readonly bucket: ChromeBucket;
    readonly homeDirectory: string;
    /** The origin's configured `remote-daemon` runtimes, alive in assembly. */
    readonly configuredDaemons: readonly RemoteDaemonRuntime[];
    readonly renderPane: RenderPane;
    readonly grid: PhoneGridProps;
    readonly actions: PhoneShellActions;
    /** The command palette element, rendered by assembly with its own props. */
    readonly palette: ReactNode;
    readonly createRenderer?: TerminalRendererFactory | undefined;
    /**
     * The window the KEY BAR reads its form factor and its software keyboard from. Undefined on a
     * device, where the bar reads the page's own window exactly as the desktop's mount does; a
     * jsdom test hands in the fake phone window it drives everything else through, which is what
     * lets an assembly test see the bar go when a web pane takes the screen.
     */
    readonly formFactorWindow?: FormFactorWindow | undefined;
    /** Test seams: where the host list is remembered, how a host runtime is built, the page's host. */
    readonly hostStorage?: StorageLike | null | undefined;
    readonly remoteRuntimeFactory?: RemoteRuntimeFactory | undefined;
    readonly location?: { readonly hostname: string } | null | undefined;
    /** The history the sheets own an entry in (`sheet-history.ts`); a test hands in a fake. */
    readonly sheetHistory?: SheetHistoryLike | null | undefined;
}

type Sheet = 'none' | 'workspaces' | 'panes' | 'menu' | 'host' | 'rename' | 'new-workspace';

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 } as const;
const EMPTY_IDS: readonly string[] = [];

function defaultLocation(): { readonly hostname: string } | null {
    const loc = (globalThis as { location?: { hostname: string } }).location;
    return loc ?? null;
}

export function PhoneShell(props: PhoneShellProps): ReactElement {
    const { view, actions } = props;
    const [sheet, setSheet] = useState<Sheet>('none');
    /*
     * The sheets own one history entry between them (`sheet-history.ts`): opening pushes it, the
     * phone's back gesture pops it and closes whatever is open, and a Close/scrim/row tap pops
     * it too. There is deliberately NO edge swipe to open the drawer: on the owner's phone the
     * edge is the system's back gesture (device round, 2026-09-08), and a gesture that races the
     * OS for the same edge loses on the days it matters. The button is the drawer's opener.
     */
    const history = useSheetHistory(() => setSheet('none'), props.sheetHistory);
    useEffect(() => {
        history.sync(sheet !== 'none');
    }, [history, sheet]);
    const closeSheet = useCallback(() => history.close(), [history]);
    /**
     * C9 - the content box, for the phone's ONE key bar (`terminal/PhoneKeyBar.tsx`). The bar
     * sits out of flow at this box's bottom edge and pads the box by its own height plus the
     * software keyboard's inset, so whatever is on screen - one pane or the whole grid, the
     * origin's or a remote host's - shrinks above it. The desktop mounts the same component on
     * its content row; on a phone that row is not on screen, so it is mounted here instead.
     */
    const contentRef = useRef<HTMLDivElement | null>(null);

    // ── hosts ───────────────────────────────────────────────────────────────────────

    const phoneHosts = usePhoneHosts(props.hostStorage);
    const phoneEntries = useMemo(
        () => phoneHosts.hosts.map((entry) => ({ name: entry.id, url: entry.url })),
        [phoneHosts.hosts]
    );
    const phoneRuntimes = useRemoteDaemons(phoneEntries, props.remoteRuntimeFactory);

    const hosts = useMemo<readonly PhoneHostModel[]>(() => {
        const origin: PhoneHostModel = {
            key: ORIGIN_HOST_KEY,
            name: originHostName(props.location === undefined ? defaultLocation() : props.location),
            kind: 'origin',
            runtime: props.runtime,
            removable: false
        };
        const configured = props.configuredDaemons.map<PhoneHostModel>((held) => ({
            key: `configured:${held.name}`,
            name: held.name,
            kind: 'configured',
            runtime: held.runtime,
            removable: false
        }));
        const own: PhoneHostModel[] = [];
        for (const entry of phoneHosts.hosts) {
            const held = phoneRuntimes.get(entry.id);
            if (held === undefined) continue;
            own.push({ key: `phone:${entry.id}`, name: entry.name, kind: 'phone', runtime: held.runtime, removable: true });
        }
        return [origin, ...configured, ...own];
    }, [props.location, props.runtime, props.configuredDaemons, phoneHosts.hosts, phoneRuntimes]);

    /** Forget one of the phone's OWN hosts; the origin and the configured peers are not the phone's to drop. */
    const removeHost = useCallback(
        (hostKey: string): void => {
            const entry = phoneHosts.hosts.find((candidate) => `phone:${candidate.id}` === hostKey);
            if (entry !== undefined) phoneHosts.remove(entry.id);
        },
        [phoneHosts]
    );

    const remoteHost = view.remote === null ? null : (hosts.find((host) => host.key === view.remote?.host) ?? null);

    /*
     * The host keys this phone KNOWS about, read straight from the lists rather than from the
     * dialled runtimes.
     *
     * B7: a remembered place (`phone/place.ts`) can name a remote host, and `useRemoteDaemons`
     * builds its runtimes in an effect, so on the first commit after a reopen the runtime map is
     * empty and `remoteHost` is null for a host that is perfectly real. Dropping the selection on
     * that reading would throw the restore away one frame after making it. The names are known
     * synchronously - the phone's list comes out of `localStorage` and the configured peers out of
     * assembly - so the "this host is gone" test asks the LISTS, and the runtime's absence is just
     * "not dialled yet".
     */
    const knownHostKeys = useMemo(() => {
        const keys = new Set<string>([ORIGIN_HOST_KEY]);
        for (const held of props.configuredDaemons) keys.add(`configured:${held.name}`);
        for (const entry of phoneHosts.hosts) keys.add(`phone:${entry.id}`);
        return keys;
    }, [props.configuredDaemons, phoneHosts.hosts]);

    // A host that is gone (removed from the phone, dropped from the origin's config) takes its
    // selection with it: the shell falls back to the origin's active workspace, which is the one
    // host that cannot go away.
    useEffect(() => {
        if (view.remote !== null && !knownHostKeys.has(view.remote.host)) view.selectRemote(null);
    }, [view, knownHostKeys]);

    // ── the workspace on screen ─────────────────────────────────────────────────────

    const activeStore = (remoteHost ?? hosts[0] ?? { runtime: props.runtime }).runtime.store;
    const remoteWorkspaceID = view.remote?.workspaceID ?? null;
    const remoteWorkspace = useStore(activeStore, (state) =>
        remoteHost === null || remoteWorkspaceID === null
            ? null
            : (state.daemon.state.workspaces.find((entry) => entry.id === remoteWorkspaceID) ?? null)
    );
    const remoteEcho = useStore(activeStore, (state) => state.ui.focusEcho);

    const workspace = remoteHost === null ? props.workspace : remoteWorkspace;
    const shownPaneID =
        remoteHost === null
            ? view.shownPaneID
            : remoteWorkspace === null
              ? null
              : remoteShownPane(remoteWorkspace, remoteEcho);
    const panes = workspace?.panes ?? [];
    const shownPane = shownPaneID === null ? null : (panes.find((pane) => pane.id === shownPaneID) ?? null);
    const counts = useMemo(() => agentCounts(workspace === null ? [] : [workspace as unknown as ChromeWorkspace]), [workspace]);
    const agentDot = counts.waiting > 0 ? tokens.statusWaiting : counts.running > 0 ? tokens.statusRunning : null;

    const selection: PhoneWorkspaceSelection | null =
        remoteHost !== null && remoteWorkspaceID !== null
            ? { host: remoteHost.key, workspaceID: remoteWorkspaceID }
            : props.workspace === null
              ? null
              : { host: ORIGIN_HOST_KEY, workspaceID: props.workspace.id };

    /** The verbs for whichever host is on screen: assembly's for the origin, the runtime's for a remote. */
    const verbs = useMemo(() => {
        if (remoteHost === null) {
            return {
                focusPane: actions.focusPane,
                createPane: actions.createPane,
                closePane: actions.closePane,
                renamePane: actions.renamePane
            };
        }
        const runtime = remoteHost.runtime;
        const workspaceID = remoteWorkspaceID;
        return {
            focusPane: (paneID: string): void => {
                if (workspaceID !== null) runtime.focusPane(workspaceID, paneID);
            },
            createPane: (): void => {
                if (workspaceID !== null) void runtime.commands.createPane({ workspace: workspaceID });
            },
            closePane: (paneID: string): void => {
                void runtime.commands.closePane({ paneID });
            },
            renamePane: (paneID: string, name: string): void => {
                void runtime.commands.renamePane({ paneID, name });
            }
        };
    }, [remoteHost, remoteWorkspaceID, actions]);

    const onSelectWorkspace = useCallback(
        (next: PhoneWorkspaceSelection): void => {
            // B7: picking a workspace is what leaves the landing page, and it is the only thing
            // that does. The place is remembered from the selection this leaves behind
            // (`phone/view.ts`), so there is nothing to write here.
            view.openWorkspace();
            if (next.host === ORIGIN_HOST_KEY) {
                view.selectRemote(null);
                actions.activateWorkspace(next.workspaceID);
                return;
            }
            view.selectRemote({ host: next.host, workspaceID: next.workspaceID });
        },
        [view, actions]
    );

    // ── the overflow menu ───────────────────────────────────────────────────────────

    const atLanding = view.atLanding;

    const menuItems = useMemo<readonly PhoneMenuItem[]>(() => {
        const items: PhoneMenuItem[] = [];
        // The landing page has no workspace and no pane, so it offers only what the whole app
        // has: the palette and Settings.
        if (workspace !== null && !atLanding) {
            items.push({ id: 'new-pane', label: 'New pane', onSelect: verbs.createPane });
            if (shownPane !== null) {
                items.push({ id: 'rename-pane', label: 'Rename pane', onSelect: () => setSheet('rename') });
            }
            if (remoteHost === null) {
                const on = workspace.isSyncInputActive;
                items.push({ id: 'sync-input', label: on ? 'Stop syncing input' : 'Sync input to all panes', onSelect: actions.toggleSyncInput });
            }
        }
        items.push({ id: 'palette', label: 'Command palette', onSelect: actions.openPalette });
        items.push({ id: 'settings', label: 'Settings', onSelect: actions.openSettings });
        if (shownPane !== null && !atLanding) {
            items.push({ id: 'close-pane', label: 'Close pane', danger: true, onSelect: () => verbs.closePane(shownPane.id) });
        }
        return items;
    }, [workspace, shownPane, remoteHost, verbs, actions, atLanding]);

    // ── render ──────────────────────────────────────────────────────────────────────

    /**
     * B7 - the origin's panes, with the ONE type this client cannot draw answered here.
     *
     * Everything else goes to assembly's `renderPane` untouched, which is how a markdown preview,
     * a diff, a scratchpad and a markdown pane hosting `$EDITOR` reach the phone as the very
     * components the Mac draws. A `web` pane becomes `PhoneWebCard` instead: `PhoneWebCard.tsx`
     * carries the reason (the page is a native view the Electron shell composites over this
     * document, and there is no such shell behind a phone browser), and MOBILE-PLAN.md §9 is the
     * rule. Wrapping rather than branching at the two call sites is what keeps `pane` mode and the
     * grid in `layout` mode agreeing about what a web pane looks like.
     */
    const originWorkspace = props.workspace;
    const originPaneTypes = useMemo(() => {
        const types = new Map<string, string>();
        for (const pane of originWorkspace?.panes ?? []) types.set(pane.id, pane.type);
        return types;
    }, [originWorkspace]);
    const appRenderPane = props.renderPane;
    const paneBody = useCallback<RenderPane>(
        (paneID, frame, focused, renderState) => {
            if (originPaneTypes.get(paneID) !== 'web') return appRenderPane(paneID, frame, focused, renderState);
            return <PhoneWebCard paneID={paneID} tab={phoneWebCardTab(originWorkspace, paneID)} />;
        },
        [appRenderPane, originPaneTypes, originWorkspace]
    );

    /**
     * B8 - the shown pane's body is mounted ONCE and MOVED between the two views (issue #120).
     *
     * Owner, real Android phone, device round 10: "there is still garbage landing into the console
     * when swapping between single and multi pane view." Measured in the harness on the base
     * commit, with a split workspace and a ruler on screen
     * (`docs/audit/b8/`, step `phone-view-toggle`):
     *
     *     pane mode    box 390x754   data-terminal-rows 50   data-terminal-resizes 3   live
     *     +75 ms       box     -     data-terminal-rows  0   data-terminal-resizes 0   LOADING, 0 canvases
     *     layout mode  box 194x730   data-terminal-rows 48   data-terminal-resizes 2   live
     *
     * The resize count going DOWN is the whole story: it counts resizes since the pane MOUNTED, so
     * it can only fall if the pane unmounted. `pane` mode renders the shown pane's body in a box of
     * the shell's own and `layout` mode renders it in a `PaneGrid` cell, which are different
     * positions in the React tree, so one tap of the toggle destroyed the pane's engine and built
     * another: `detach-pane`, then `attach-pane` at the other view's grid, then a fresh WASM
     * terminal, a fresh server-side snapshot and a fresh replay - twice per round trip. In between
     * the pane is blank for ~75 ms and NOTHING is attached to the PTY, so a query the application
     * asks in that window (DA, DSR, a kitty flags read - the things a prompt asks every time it
     * repaints, and SIGWINCH is what makes it repaint) is answered by nobody and its reply never
     * arrives.
     *
     * `grid/PaneGrid.tsx` already holds exactly the invariant this broke - "Pane identity is
     * sacred ... React never unmounts, remounts, or even reorders the node, and the terminal canvas
     * inside it keeps its scrollback and its PTY" - and the phone's second view was the one place
     * in the app that did not. So the fix is to give the shown pane ONE position for both views.
     *
     * It cannot be a React position: `pane` mode's box and the grid's cell have different
     * ancestors, and React reconciles by position, so no arrangement of components keeps the
     * subtree alive across the swap. What CAN stay the same is a DOM node. `slot` below is created
     * once per shell, the body is rendered into it through a portal that never changes container,
     * and the two views each render an empty host that the node is appended into. Moving a DOM node
     * is not an unmount: React knows nothing about `slot`'s parent, the engine's canvas keeps its
     * bitmap and its listeners, the registry keeps its handle (so C9's key bar keeps its target),
     * and the PTY stream is never detached. The toggle becomes what it always should have been -
     * one debounced `resize-pane` on a live stream, the same message a desktop divider drag sends.
     *
     * **This is an owner-directed divergence from the shipped Swift app** like every phone rule
     * here: there is no Swift phone UI and no second view to move a surface between.
     */
    const [slot] = useState<HTMLDivElement | null>(() => {
        if (typeof document === 'undefined') return null;
        const node = document.createElement('div');
        // The host it lands in is `absolute inset-0` (`pane` mode) or the grid's `relative` body,
        // so filling the host is all this has to do. `TerminalPane`'s root is `h-full w-full`.
        node.className = 'absolute inset-0';
        return node;
    });
    /**
     * The empty host each view renders where the body goes; the ref moves `slot` into it.
     *
     * A ref callback rather than an effect, because React detaches the outgoing host's ref and
     * attaches the incoming one's inside the SAME commit's layout phase - before the browser lays
     * anything out and long before it paints. `slot` is out of the document for that instant and
     * for nothing else. Nothing is removed on the null call: the outgoing host has already been
     * taken out of the document by the mutation phase, and removing `slot` from it would only cost
     * a second detach.
     */
    const mountPaneSlot = useCallback(
        (node: HTMLDivElement | null): void => {
            if (node === null || slot === null) return;
            if (slot.parentNode !== node) node.appendChild(slot);
        },
        [slot]
    );

    /**
     * The pane whose body rides the slot, and it changes hands as SELDOM as possible.
     *
     * Null on the landing page and on a remote host, where the origin has nothing on screen -
     * exactly the cases whose branches below draw no pane of the origin's at all, so the portal
     * renders nothing and the body unmounts as it does today.
     *
     * Otherwise `pane` mode has one answer and only one: the pane it shows, because that is the
     * only pane on screen. `layout` mode has a cell for EVERY pane, so the slot keeps the pane it
     * already holds - and it has to, or a focus move in the layout would take that pane out of the
     * slot and put another one in, remounting TWO engines to spare the toggle one. (Measured: with
     * the slot following focus, `phone-key-bar-split`'s round-9 caret hand-off went through a
     * rebuilt engine and its focus trail grew a `focusout` that handed the caret to nothing.) It
     * falls back to the shown pane when the pane it holds has been closed.
     *
     * The ref is read and written during render on purpose: this is "which pane does the slot hold
     * now", derived from the props of this very render, and a state update would apply it one
     * commit late - which is one commit with the wrong pane in the slot. It is idempotent, so a
     * double render (StrictMode) or a discarded one leaves the same answer.
     */
    const slotRef = useRef<string | null>(null);
    const slotEligible = remoteHost === null && !atLanding && props.workspace !== null;
    const heldStillOpen = slotRef.current !== null && panes.some((pane) => pane.id === slotRef.current);
    const slotPaneID = !slotEligible ? null : view.mode === 'layout' && heldStillOpen ? slotRef.current : (shownPane?.id ?? null);
    slotRef.current = slotPaneID;
    const paneSlot = <div ref={mountPaneSlot} className="absolute inset-0" data-testid={`phone-pane-slot-${slotPaneID ?? ''}`} />;

    /** What the grid draws for a pane: the slot's empty host for the shown one, the body for the rest. */
    const renderPane = useCallback<RenderPane>(
        (paneID, frame, focused, renderState) =>
            paneID === slotPaneID ? paneSlot : paneBody(paneID, frame, focused, renderState),
        // `paneSlot` is one element with a stable ref callback; it is rebuilt on every render like
        // the rest of the tree and carries no state of its own.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [paneBody, slotPaneID, mountPaneSlot]
    );

    /**
     * The pane the key bar aims at: the shown pane, or the grid's focused one on the origin, and
     * NOTHING on the landing page, where no pane is on screen at all.
     */
    const keyBarPaneID = atLanding ? null : view.mode === 'pane' || remoteHost !== null ? shownPaneID : props.focusedPaneID;
    const keyBarPane = keyBarPaneID === null ? null : (panes.find((pane) => pane.id === keyBarPaneID) ?? null);
    /*
     * C9's `reserve` holds the bar's 45 px across a pane switch so the incoming terminal attaches
     * at the grid it will keep (owner device round 9: "garbage symbols flash into a pane when
     * swapping"; measured 53 rows then 50). It is asked of a pane with a TERMINAL, which is
     * `shell` OR a content pane hosting `$EDITOR` (CONT-081: `externalEditorCommand`, not the pane
     * type, decides whether there is a surface to draw) - the same test `App.tsx`'s
     * `terminalCandidates` uses to decide what to mount. A web card or a preview reserves nothing,
     * and the bar is off for them anyway because the registry has no handle.
     */
    const keyBarReserve = keyBarPane !== null && (keyBarPane.type === 'shell' || keyBarPane.externalEditorCommand !== null);

    const paneTitle = shownPane === null ? null : paneDisplayTitle(shownPane, props.homeDirectory);
    const hostLabel = remoteHost === null ? null : remoteHost.name;
    const workspaceLabel = workspace?.name ?? (props.ready ? 'No workspace' : 'Kelpi');

    let content: ReactNode;
    if (atLanding) {
        content = (
            <PhoneLanding
                hosts={hosts}
                selection={selection}
                bucket={props.bucket}
                onSelect={onSelectWorkspace}
                onAddHost={() => setSheet('host')}
                onRemoveHost={removeHost}
            />
        );
    } else if (view.remote !== null && remoteHost === null) {
        // The remembered host is real but its runtime is one effect away (see `knownHostKeys`).
        content = (
            <div className="flex h-full items-center justify-center text-[13px]" data-testid="phone-host-dialling" style={{ color: tokens.textTertiary }}>
                Connecting…
            </div>
        );
    } else if (remoteHost !== null && remoteWorkspaceID !== null) {
        content = (
            <PhoneRemoteWorkspace
                hostName={remoteHost.name}
                runtime={remoteHost.runtime}
                workspaceID={remoteWorkspaceID}
                mode={view.mode}
                createRenderer={props.createRenderer}
            />
        );
    } else if (props.workspace === null) {
        content = props.ready ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="phone-no-workspace">
                <span className="text-[15px]" style={{ color: tokens.textSecondary }}>
                    No workspace selected
                </span>
                <PhoneButton testID="phone-no-workspace-create" onClick={() => setSheet('new-workspace')}>
                    <ChromeIcon name="plus" size={12} />
                    New workspace
                </PhoneButton>
            </div>
        ) : null;
    } else if (view.mode === 'layout') {
        content = (
            <PaneGrid
                {...props.grid}
                layout={props.workspace.layout}
                panes={props.workspace.panes}
                focusedPaneID={props.focusedPaneID}
                zoomedPaneID={props.workspace.zoomedPaneID ?? null}
                syncActive={props.workspace.isSyncInputActive}
                syncExcludedPaneIDs={props.workspace.syncInputExcluded ?? EMPTY_IDS}
                homeDirectory={props.homeDirectory}
                renderPane={renderPane}
            />
        );
    } else if (shownPane === null) {
        content = (
            <div className="flex h-full items-center justify-center text-[13px]" data-testid="phone-empty-workspace" style={{ color: tokens.textTertiary }}>
                No panes in this workspace.
            </div>
        );
    } else {
        // The same attributes the grid's wrapper carries (`data-pane-id`, `data-focused`,
        // `pane-body-<id>`): the audit's phone lane finds the pane it borrowed by them.
        content = (
            <div
                data-testid={`pane-${shownPane.id}`}
                data-pane-id={shownPane.id}
                data-hidden="false"
                data-focused="true"
                data-zoomed="false"
                className="flex h-full w-full flex-col overflow-hidden"
            >
                <div data-testid={`pane-body-${shownPane.id}`} className="relative min-h-0 flex-1">
                    {/* B8 (#120) - the empty host the ONE mounted body is moved into. The body
                        itself is rendered by the portal below, in both views. */}
                    {paneSlot}
                </div>
            </div>
        );
    }

    return (
        <div
            data-testid="phone-shell"
            data-phone-mode={view.mode}
            // B7's third top-level state, read as one value by the audit: `landing`, `pane` or
            // `layout`. `data-phone-mode` keeps meaning the VIEW mode, which survives a trip to
            // the landing page, so the two attributes answer different questions.
            data-phone-screen={view.screen}
            data-phone-host={remoteHost?.key ?? ORIGIN_HOST_KEY}
            className="flex min-h-0 flex-1 flex-col"
            style={{ paddingLeft: PHONE_SAFE_AREA.left, paddingRight: PHONE_SAFE_AREA.right, paddingBottom: PHONE_SAFE_AREA.bottom }}
        >
            <div
                data-testid="phone-header"
                className="flex shrink-0 items-center border-b"
                style={{
                    background: tokens.headerBackground,
                    borderColor: tokens.divider,
                    minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                    paddingTop: PHONE_SAFE_AREA.top
                }}
            >
                {/* B7 - the way back to the landing page, one tap from anywhere. The drawer's top
                    row is the other one; the owner asked for either, so the shell has both. On the
                    landing page itself it is not drawn: there is nowhere to go back to. */}
                {atLanding ? null : (
                    <PhoneButton testID="phone-open-landing" ariaLabel="Hosts" onClick={view.showLanding}>
                        <ChromeIcon name="network" size={16} />
                    </PhoneButton>
                )}
                {atLanding ? null : (
                    <PhoneButton testID="phone-open-workspaces" ariaLabel="Workspaces" ariaExpanded={sheet === 'workspaces'} onClick={() => setSheet('workspaces')}>
                        <ChromeIcon name="sidebar" size={16} />
                    </PhoneButton>
                )}
                <button
                    type="button"
                    data-testid="phone-title"
                    className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px`, color: tokens.textPrimary }}
                    onClick={() => {
                        if (!atLanding) setSheet('panes');
                    }}
                >
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[12px]" style={{ color: tokens.textTertiary }} data-testid="phone-title-workspace">
                            {atLanding ? 'Hosts' : hostLabel === null ? workspaceLabel : `${hostLabel} · ${workspaceLabel}`}
                        </span>
                        {atLanding || shownPane === null ? null : (
                            <span
                                className="truncate text-[14px] font-semibold"
                                data-testid={`pane-header-${shownPane.id}`}
                                data-focused="true"
                            >
                                {paneTitle}
                            </span>
                        )}
                    </span>
                    {atLanding || agentDot === null ? null : (
                        <span
                            aria-label={`${String(counts.waiting)} waiting, ${String(counts.running)} running`}
                            data-testid="phone-agent-dot"
                            data-waiting={counts.waiting}
                            data-running={counts.running}
                            className="h-[8px] w-[8px] shrink-0 rounded-full"
                            style={{ background: agentDot }}
                        />
                    )}
                    {atLanding || shownPane === null ? null : statusDotColor(shownPane.status) === null ? null : (
                        <span
                            aria-hidden
                            data-testid="phone-pane-status"
                            data-status={shownPane.status}
                            className="h-[6px] w-[6px] shrink-0 rounded-full"
                            style={{ background: statusDotColor(shownPane.status) ?? undefined }}
                        />
                    )}
                </button>
                {/* The landing page has no workspace on screen, so it has neither a view to
                    toggle nor panes to list; Add host takes their place. */}
                {atLanding ? (
                    <PhoneButton testID="phone-landing-add-host-header" ariaLabel="Add host" onClick={() => setSheet('host')}>
                        <ChromeIcon name="plus" size={16} />
                    </PhoneButton>
                ) : (
                    <>
                        <PhoneButton
                            testID="phone-view-toggle"
                            ariaLabel={view.mode === 'pane' ? 'Show full layout' : 'Show one pane'}
                            onClick={view.toggleMode}
                            className={view.mode === 'layout' ? 'opacity-100' : 'opacity-70'}
                        >
                            <ChromeIcon name="layout" size={16} filled={view.mode === 'layout'} />
                        </PhoneButton>
                        <PhoneButton testID="phone-open-panes" ariaLabel="Panes" ariaExpanded={sheet === 'panes'} onClick={() => setSheet('panes')}>
                            <ChromeIcon name="stack" size={16} />
                            <span className="text-[12px]" data-testid="phone-pane-count">
                                {panes.length}
                            </span>
                        </PhoneButton>
                    </>
                )}
                <PhoneButton testID="phone-more" ariaLabel="More" ariaExpanded={sheet === 'menu'} onClick={() => setSheet('menu')}>
                    <ChromeIcon name="ellipsis" size={16} />
                </PhoneButton>
            </div>

            <div ref={contentRef} data-testid="phone-content" className="relative min-h-0 flex-1">
                {content}
                {/*
                 * B8 (#120) - the shown pane's body, mounted ONCE for both views.
                 *
                 * Its React position is this one line in every mode, and its DOM container is the
                 * `slot` node above, which never changes identity - so the toggle moves the node
                 * and unmounts nothing.
                 *
                 * The render state is the one the view it is standing in would have passed: in
                 * `pane` mode this pane is the only thing on screen, so it is focused and visible
                 * by construction; in `layout` mode it is one cell among many, so it holds the
                 * ring only when it is the focused pane and it is hidden when the daemon has
                 * zoomed a sibling - which is exactly what `PaneGrid` tells the panes it draws.
                 */}
                {slot === null || slotPaneID === null
                    ? null
                    : createPortal(
                          paneBody(slotPaneID, ZERO_RECT, view.mode === 'pane' || props.focusedPaneID === slotPaneID, {
                              visible: view.mode === 'pane' || (props.workspace?.zoomedPaneID ?? null) === null || props.workspace?.zoomedPaneID === slotPaneID,
                              zoomed: view.mode === 'layout' && props.workspace?.zoomedPaneID === slotPaneID,
                              dragging: false
                          }),
                          slot
                      )}
                {props.ready ? null : <ConnectionSplash runtime={props.runtime} state={props.state} target={props.target} />}
                {props.palette}
                {/* Last in the box, so it paints over the pane and under the palette's scrim. The
                    bar aims at the pane that holds the caret's claim: the shown pane in `pane`
                    mode, the focused one in the grid, on whichever host is on screen. */}
                <PhoneKeyBar
                    paneID={keyBarPaneID}
                    contentRow={contentRef}
                    reserve={keyBarReserve}
                    formFactorWindow={props.formFactorWindow}
                />
            </div>

            <PhoneWorkspaceDrawer
                open={sheet === 'workspaces'}
                hosts={hosts}
                selection={selection}
                bucket={props.bucket}
                onSelect={onSelectWorkspace}
                onNewWorkspace={() => setSheet('new-workspace')}
                onAddHost={() => setSheet('host')}
                onRemoveHost={removeHost}
                onShowLanding={view.showLanding}
                onClose={closeSheet}
            />
            <PhonePaneSheet
                open={sheet === 'panes'}
                workspaceName={workspace?.name ?? null}
                panes={panes}
                shownPaneID={shownPaneID}
                homeDirectory={props.homeDirectory}
                onShow={verbs.focusPane}
                onNewPane={workspace === null ? null : verbs.createPane}
                onClosePane={workspace === null ? null : verbs.closePane}
                onClose={closeSheet}
            />
            <PhoneMenuSheet open={sheet === 'menu'} title={paneTitle ?? workspaceLabel} items={menuItems} onClose={closeSheet} />
            <PhoneHostSheet
                open={sheet === 'host'}
                existingNames={hosts.map((host) => host.name)}
                onAdd={(name, url) => {
                    phoneHosts.add(name, url);
                }}
                // Back where it was opened from: the drawer, or the landing page (which is a
                // screen, so closing the sheet is all there is to do).
                onClose={() => {
                    if (atLanding) closeSheet();
                    else setSheet('workspaces');
                }}
            />
            <PhonePromptSheet
                open={sheet === 'new-workspace'}
                title="New workspace"
                initial=""
                placeholder="workspace name"
                submitLabel="Create"
                onSubmit={actions.createWorkspace}
                onClose={closeSheet}
            />
            <PhonePromptSheet
                open={sheet === 'rename'}
                title="Rename pane"
                initial={shownPane?.label ?? paneTitle ?? ''}
                placeholder="pane name"
                onSubmit={(name) => {
                    if (shownPane !== null) verbs.renamePane(shownPane.id, name);
                }}
                onClose={closeSheet}
            />
        </div>
    );
}
