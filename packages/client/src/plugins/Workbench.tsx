import type { PluginChrome } from './chrome';
import { featureBindings, type BundledFeatureBinding } from '../features/feature';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { PLUGIN_BAND_HEIGHTS, isPluginID, isPluginPlacement, type JsonObject, type JsonValue, type PluginPlacement } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { ChromeIcon } from '../chrome/icons';
import { ContextMenu, menuAnchorFromEvent } from '../chrome/ContextMenu';
import { tokens } from '../chrome/tokens';
import { PluginView } from './PluginView';
import { usePlugins } from './client';
import { contributedSlots, DEFAULT_SLOTS, MAX_CONTAINER_DEPTH, planComposedViews, readWorkbenchSelections, resolveSidebarViews, resolveSlot, selectWorkbenchView, slotViews, viewRegistry, type SidebarPlacement, type ViewContribution, type WorkbenchSelections } from './registry';
import { renderRegisteredView, type ViewRenderContext, type ViewRenderers } from './renderers';
import { PluginHostUIContext } from './host-ui';
import type { PluginNavigation } from './navigation';
import type { UIServiceModel } from './ui-services';
import { INTERACTION_PLACEMENTS, type InteractionPlacement } from '../interaction/contract';
import { clearInteractionPresenterFailure, interactionPresenterFailures, subscribeInteractionPresenters } from '../interaction/presenter';
import { SETTINGS_PLACEMENT, clearSettingsPresenterFailure, settingsPresenterFailures, subscribeSettingsPresenters } from '../settings/presenter';
import { PANE_CHROME_PLACEMENT } from '../pane-chrome/contract';
import { clearPaneChromePresenterFailure, paneChromePresenterFailure, subscribePaneChromePresenters } from '../pane-chrome/presenter';
import { PANE_SEARCH_PLACEMENT } from '../pane-search/contract';
import { clearPaneSearchPresenterFailure, paneSearchPresenterFailure, subscribePaneSearchPresenters } from '../pane-search/presenter';
import { DEFAULT_ARRANGEMENT, arrangementStorageKey, isArrangementSlotBand, readArrangement, sameArrangement, zenModeActive, type RootArrangement } from './arrangement';

export type WorkbenchSlotID = Exclude<PluginPlacement, 'pane'>;
interface WorkbenchLayout {
    views: readonly ViewContribution[];
    selections: WorkbenchSelections;
    sidebars: Record<SidebarPlacement, ViewContribution>;
    activeTabs: Readonly<Record<string, string>>;
    select(slot: WorkbenchSlotID, id: string): void;
    activateTab(containerID: string, slotID: string): void;
    /**
     * Which root bands are showing, and Zen Mode (`./arrangement.ts`). Optional so a host that
     * never hides anything (a standalone test, a window that has not built its layout) reads as
     * the default arrangement rather than as a crash.
     */
    arrangement?: RootArrangement;
    /** Stable across renders: `App.tsx` closes over it once, in the sidebar setters. */
    arrange?(update: (current: RootArrangement) => RootArrangement): void;
}
interface Workbench extends WorkbenchLayout {
    features: ReadonlyMap<string, BundledFeatureBinding>;
    runtime: KelpiRuntime;
    workspaceID?: string | undefined;
    chords: readonly string[];
}
const WorkbenchContext = createContext<Workbench | null>(null);
/**
 * Every root slot a plugin may DISCOVER through `ui.getWorkbench().slots`, the three presented
 * interaction surfaces included, and every one it may SELECT itself into. The two lists differ by
 * exactly those surfaces.
 *
 * Any plugin can already put itself in the topbar programmatically, and that is fine: it replaces
 * its own chrome. A prompts or notifications presenter renders OTHER plugins' requests - including
 * an `ui.showInput({ password: true })` that no other slot has ever been able to see - so the
 * choice stays the user's, made in Settings, and `ui.selectView` refuses it.
 */
const ROOT_SLOTS = ['sidebar.primary', 'sidebar.secondary', 'topbar', 'statusbar', 'panel.bottom', 'workspace', 'settings', 'document.markdown', 'document.scratchpad', 'document.diff', 'terminal', 'browser', 'interaction.palette', 'interaction.prompts', 'interaction.notifications', 'settings.window', 'pane.chrome', 'pane.search'] as const;
/**
 * The presented surfaces: the three interaction placements, the Settings window, every pane's
 * header band and the find bar over the pane being searched. Discoverable, never selectable by a
 * plugin, and the only slots whose bundled entry names itself.
 *
 * Pane chrome is here for the reason the other four are, one surface wider: a header presenter
 * draws EVERY pane's chrome, including the close ✕ and other plugins' `pane.header` items, so the
 * choice of who draws it is the user's and is made in Settings. Pane search is here for a sharper
 * one: it owns a TEXT INPUT and the caret for as long as a search is open, so a plugin that could
 * select itself into it could take the keyboard from a ⌘F the user pressed over their own shell.
 */
const PRESENTED_SLOTS: readonly string[] = [...INTERACTION_PLACEMENTS, SETTINGS_PLACEMENT, PANE_CHROME_PLACEMENT, PANE_SEARCH_PLACEMENT];
const SELECTABLE_SLOTS: readonly string[] = ROOT_SLOTS.filter(slot => !PRESENTED_SLOTS.includes(slot));
const INTERACTION_SLOTS: readonly InteractionPlacement[] = INTERACTION_PLACEMENTS;
const SELECTIONS_CHANGED = 'kelpi-workbench-selections';
export function useWorkbench(): Workbench {
    const value = useContext(WorkbenchContext); if (!value) throw new Error('WorkbenchProvider is required'); return value;
}
/**
 * The same read for a host that must work WITHOUT a provider.
 *
 * `interaction/presenter-slot.tsx` is mounted by `InteractionHost`, which stands alone in its own
 * tests and in a window that has not built its workbench yet. No provider has to mean "the bundled
 * presenter draws", never a crash - the recovery floor cannot depend on the layout being up.
 */
export function useOptionalWorkbench(): Workbench | null {
    return useContext(WorkbenchContext);
}
/** What `useWorkbenchLayout` returns: always an arrangement, and the stable setter for it. */
export type ArrangedWorkbenchLayout = WorkbenchLayout & Required<Pick<WorkbenchLayout, 'arrangement' | 'arrange'>>;
export function useWorkbenchLayout(runtime: KelpiRuntime): ArrangedWorkbenchLayout {
    const { plugins, daemonID } = usePlugins(runtime);
    const key = `kelpi.workbench.v1:${daemonID ?? new URL(runtime.connection.target).host}`;
    const tabKey = key.replace('workbench.v1:', 'workbench.tabs.v1:');
    const read = (): Workbench['selections'] => {
        try {
            const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
            return readWorkbenchSelections(saved);
        } catch { return {}; }
    };
    const [selections, setSelections] = useState(read);
    useEffect(() => { setSelections(read()); }, [key]);
    useEffect(() => {
        const changed = (event: Event): void => { if ((event as CustomEvent).detail === key) setSelections(read()); };
        const storage = (event: StorageEvent): void => { if (event.key === key) setSelections(read()); };
        window.addEventListener(SELECTIONS_CHANGED, changed); window.addEventListener('storage', storage);
        return () => { window.removeEventListener(SELECTIONS_CHANGED, changed); window.removeEventListener('storage', storage); };
    }, [key]);
    const readTabs = (): Record<string, string> => {
        try {
            const saved: unknown = JSON.parse(localStorage.getItem(tabKey) ?? '{}');
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
            return Object.fromEntries(Object.entries(saved).filter(([id, slot]) => isPluginID(id) && isPluginID(slot)));
        } catch { return {}; }
    };
    const [activeTabs, setActiveTabs] = useState(readTabs);
    useEffect(() => { setActiveTabs(readTabs()); }, [tabKey]);
    /*
     * The root arrangement, in its own key beside the selections and deliberately NOT subscribed to
     * the `storage` event they listen to: a window reads it when it mounts (and when the daemon's
     * identity arrives) and writes it when it changes, so Zen Mode in one window leaves the others
     * alone.
     *
     * Every write is mirrored to the ADDRESS-keyed copy as well, which is the one read before the
     * daemon's identity is known. Without it a window opened in Zen Mode would draw its toolbar and
     * sidebars for the length of the identity round trip and then take them away again, resizing
     * every PTY twice on every launch.
     */
    const address = new URL(runtime.connection.target).host;
    const arrangementKey = arrangementStorageKey(daemonID ?? address);
    const arrangementKeys = useRef({ key: arrangementKey, address: arrangementStorageKey(address) });
    arrangementKeys.current = { key: arrangementKey, address: arrangementStorageKey(address) };
    const readSavedArrangement = (): RootArrangement => {
        try { return readArrangement(JSON.parse(localStorage.getItem(arrangementKey) ?? 'null')); } catch { return DEFAULT_ARRANGEMENT; }
    };
    const [arrangement, setArrangement] = useState(readSavedArrangement);
    const current = useRef(arrangement);
    current.current = arrangement;
    /** The key this window last wrote under, so a change made before the identity arrived survives it. */
    const lastWritten = useRef<string | null>(null);
    const persist = (next: RootArrangement): void => {
        const { key: target, address: hint } = arrangementKeys.current;
        lastWritten.current = target;
        try {
            const saved = JSON.stringify(next);
            localStorage.setItem(target, saved);
            if (hint !== target) localStorage.setItem(hint, saved);
        } catch { /* still applies for this session */ }
    };
    useEffect(() => {
        // The identity arrived after the user had already changed something under the address key
        // (⌃⌘↩ works before any workspace exists): carry that change over rather than replacing it
        // with the daemon's saved value, which would undo it and leave the two keys disagreeing.
        if (lastWritten.current !== null && lastWritten.current !== arrangementKey) { persist(current.current); return; }
        setArrangement(now => { const saved = readSavedArrangement(); return sameArrangement(now, saved) ? now : saved; });
    }, [arrangementKey]);
    const arrange = useCallback((update: (current: RootArrangement) => RootArrangement): void => {
        setArrangement(now => {
            const next = update(now);
            if (next === now) return now;
            persist(next);
            return next;
        });
    }, []);
    const views = useMemo(() => viewRegistry(plugins), [plugins]);
    return { views, selections, activeTabs, sidebars: resolveSidebarViews(views, selections), arrangement, arrange,
        select(slot, id) { setSelections(current => { const next = selectWorkbenchView(views, current, slot, id); try { localStorage.setItem(key, JSON.stringify(next)); queueMicrotask(() => window.dispatchEvent(new CustomEvent(SELECTIONS_CHANGED, { detail: key }))); } catch { /* still usable for this session */ } return next; }); },
        activateTab(containerID, slotID) {
            if (!views.find(view => view.id === containerID)?.container?.slots.some(slot => slot.id === slotID)) return;
            setActiveTabs(current => { const next = { ...current, [containerID]: slotID }; try { localStorage.setItem(tabKey, JSON.stringify(next)); } catch { /* session selection still works */ } return next; });
        }
    };
}
export function WorkbenchProvider(props: { navigationTrustedRuntimes?: ReadonlySet<KelpiRuntime>; layout: WorkbenchLayout; features?: readonly BundledFeatureBinding[]; chrome?: PluginChrome | null; navigation?: PluginNavigation | null; services?: UIServiceModel | null; runtime: KelpiRuntime; workspaceID?: string | undefined; chords: readonly string[]; children: ReactNode }): ReactElement {
    const features = useMemo(() => featureBindings(props.features ?? []), [props.features]);
    const value: Workbench = { features, ...props.layout, runtime: props.runtime, workspaceID: props.workspaceID, chords: props.chords };
    const request = (method: string, args: JsonObject): JsonValue => {
        const custom = contributedSlots(value.views);
        if (method === 'ui.getWorkbench') return {
            slots: [...ROOT_SLOTS.map(id => ({ id, title: id, viewID: (id === 'sidebar.primary' || id === 'sidebar.secondary' ? value.sidebars[id] : resolveSlot(value.views, id, value.selections[id]))?.id ?? null })),
                ...custom.map(slot => ({ id: slot.id, title: slot.title, viewID: resolveSlot(value.views, slot.id, value.selections[slot.id])?.id ?? null }))],
            views: value.views.map(view => ({ id: view.id, title: view.title, placements: [...view.placements, ...(!view.pluginID ? custom.filter(slot => slot.defaultView === view.id).map(slot => slot.id) : [])], ...(view.pluginID ? { pluginID: view.pluginID } : {}) })),
            activeTabs: Object.fromEntries(value.views.filter(view => view.container?.layout === 'tabs').map(view => [view.id, view.container!.slots.find(slot => slot.id === value.activeTabs[view.id])?.id ?? view.container!.slots[0]!.id]))
        };
        if (method === 'ui.selectView') {
            const slot = args['slot'], viewID = args['viewID'];
            if (!isPluginPlacement(slot) || slot === 'pane' || (!SELECTABLE_SLOTS.includes(slot) && !custom.some(item => item.id === slot))) throw new Error('Workbench slot is not registered.');
            if (typeof viewID !== 'string' || viewID.length > 160 || selectWorkbenchView(value.views, value.selections, slot, viewID) === value.selections) throw new Error('View is unavailable, incompatible with this slot, or would create a layout cycle.');
            flushSync(() => value.select(slot, viewID));
            return null;
        }
        if (method === 'ui.activateTab') {
            const container = value.views.find(view => view.id === args['containerID'])?.container;
            if (!container || container.layout !== 'tabs' || typeof args['slotID'] !== 'string' || !container.slots.some(slot => slot.id === args['slotID'])) throw new Error('Workbench tab is not registered in this container.');
            flushSync(() => value.activateTab(container.id, String(args['slotID'])));
            return null;
        }
        throw new Error('Workbench UI method is not supported.');
    };
    return <WorkbenchContext.Provider value={value}><PluginHostUIContext.Provider value={{ runtime: props.runtime, navigationTrustedRuntimes: props.navigationTrustedRuntimes, chrome: props.chrome, navigation: props.navigation, services: props.services, request }}>{props.children}</PluginHostUIContext.Provider></WorkbenchContext.Provider>;
}
interface NativeRenderers {
    readonly adapters: ViewRenderers;
    readonly paths: ReadonlyMap<string, string>;
    readonly mountedPaths: ReadonlySet<string>;
    readonly compact: boolean;
}
const NativeRendererContext = createContext<NativeRenderers>({ adapters: {}, paths: new Map(), mountedPaths: new Set(), compact: false });

/** Adapters are scoped to one host. A composed layout can wrap its native view, never duplicate it. */
function NativeRendererScope(props: { selected: ViewContribution; adapters: NativeRenderers['adapters']; compact?: boolean; children: ReactNode }): ReactElement {
    const host = useWorkbench();
    const plan = planComposedViews(host.views, host.selections, props.selected, new Set(Object.keys(props.adapters)));
    return <NativeRendererContext.Provider value={{ adapters: props.adapters, paths: plan.nativePaths, mountedPaths: plan.paths, compact: props.compact ?? false }}>{props.children}</NativeRendererContext.Provider>;
}

function RegisteredView(props: { view: ViewContribution; path: string; ancestors?: readonly string[]; visible?: boolean }): ReactElement {
    const host = useWorkbench();
    const native = useContext(NativeRendererContext);
    const { view, path, ancestors = [] } = props;
    if (ancestors.includes(view.id) || (view.container && ancestors.length >= MAX_CONTAINER_DEPTH)) return <div role="status" className="p-3 text-xs">This layout contains a cycle or is nested too deeply. Choose another view or restore its default.</div>;
    if (!native.mountedPaths.has(path)) return <div role="status" className="p-3 text-xs">This layout has too many views. Choose another view or empty a slot.</div>;
    if (view.container) return <WorkbenchContainer view={view} path={path} ancestors={[...ancestors, view.id]} visible={props.visible ?? true} />;
    if (view.pluginID) return <PluginView runtime={host.runtime} pluginID={view.pluginID} viewID={view.id} workspaceID={host.workspaceID} claimedChords={host.chords} visible={props.visible ?? true} />;
    const adapter = native.adapters[view.id];
    if (!adapter) return <div role="status" className="p-3 text-xs">{view.title} is unavailable in this host. Choose another view.</div>;
    if (native.paths.get(view.id) !== path) return <div role="status" className="p-3 text-xs">{view.title} is already displayed in another slot.</div>;
    return <>{renderRegisteredView(native.adapters, view.id, () => null, { visible: props.visible ?? true, trafficLightInset: 0 })}</>;
}

function WorkbenchContainer(props: { view: ViewContribution; path: string; ancestors: readonly string[]; visible: boolean }): ReactElement {
    const host = useWorkbench();
    const container = props.view.container!;
    const { compact } = useContext(NativeRendererContext);
    const tabPrefix = useId();
    const active = host.activeTabs[container.id];
    const setActive = (slotID: string): void => host.activateTab(container.id, slotID);
    const activeSlot = container.slots.some(slot => slot.id === active) ? active : container.slots[0]?.id;
    const tabs = container.layout === 'tabs';
    const previousTab = useRef(activeSlot);
    useLayoutEffect(() => {
        const previous = previousTab.current;
        previousTab.current = activeSlot;
        if (!tabs || previous === activeSlot) return;
        const oldIndex = container.slots.findIndex(slot => slot.id === previous);
        const newIndex = container.slots.findIndex(slot => slot.id === activeSlot);
        const oldPanel = document.getElementById(`${tabPrefix}-panel-${oldIndex}`);
        if (oldPanel?.contains(document.activeElement)) document.getElementById(`${tabPrefix}-tab-${newIndex}`)?.focus();
    }, [activeSlot, container.slots, tabPrefix, tabs]);
    return <section data-workbench-container={container.id} aria-label={container.title} className="flex h-full min-h-0 min-w-0 w-full flex-col" style={{ background: tokens.surfaceBackground, color: tokens.textPrimary }}>
        {tabs ? <div role="tablist" aria-label={container.title} className="flex shrink-0 overflow-x-auto border-b" style={{ borderColor: tokens.divider }}>{container.slots.map((slot, index) => <button
            key={slot.id} type="button" role="tab" id={`${tabPrefix}-tab-${index}`} aria-controls={`${tabPrefix}-panel-${index}`} aria-selected={activeSlot === slot.id} tabIndex={activeSlot === slot.id ? 0 : -1}
            className={`shrink-0 text-xs ${compact ? 'px-2 py-0.5' : 'px-3 py-2'}`} style={{ background: activeSlot === slot.id ? tokens.selectionFill : undefined }}
            onClick={() => setActive(slot.id)} onKeyDown={event => {
                const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!offset && event.key !== 'Home' && event.key !== 'End') return;
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? container.slots.length - 1 : (index + offset + container.slots.length) % container.slots.length;
                setActive(container.slots[next]!.id);
                document.getElementById(`${tabPrefix}-tab-${next}`)?.focus();
            }}
        >{slot.title}</button>)}</div> : null}
        <div className={`flex min-h-0 min-w-0 flex-1 ${container.layout === 'row' ? 'flex-row' : 'flex-col'}`}>
            {container.slots.map((slot, index) => {
                const selected = resolveSlot(host.views, slot.id, host.selections[slot.id]);
                const shown = !tabs || activeSlot === slot.id;
                const choices = slotViews(host.views, slot.id).filter(view => !props.ancestors.includes(view.id));
                return <div key={slot.id} data-workbench-slot={slot.id} data-view-id={selected?.id} id={`${tabPrefix}-panel-${index}`}
                    {...(tabs ? { role: 'tabpanel', 'aria-labelledby': `${tabPrefix}-tab-${index}` } : { role: 'group', 'aria-label': slot.title })}
                    hidden={!shown} className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ flex: `${slot.weight ?? 1} 1 0`, display: shown ? undefined : 'none' }}>
                    {!compact ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1" style={{ borderColor: tokens.divider }}>
                        <label className="min-w-0 flex-1 text-xs"><span className="sr-only">{slot.title} view</span><select className="w-full min-w-0" aria-label={`${slot.title} view`} value={selected?.id ?? ''} onChange={event => host.select(slot.id, event.target.value)}>
                            <option value="">Empty</option>{choices.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
                        </select></label>
                        <button type="button" className="shrink-0 text-xs" aria-label={`Restore ${slot.title}`} title="Restore default view" onClick={() => host.select(slot.id, slot.defaultView ?? '')}>Reset</button>
                    </div> : null}
                    <div className="min-h-0 min-w-0 flex-1">{selected ? <RegisteredView view={selected} path={`${props.path}/${slot.id}`} ancestors={props.ancestors} visible={props.visible && shown} /> : <div role="status" className="p-3 text-xs">Choose a view for {slot.title}.</div>}</div>
                </div>;
            })}
        </div>
    </section>;
}

/**
 * Native and external renderers use one resolution path, including named container slots.
 *
 * The three root bands (toolbar, status bar, bottom panel) can also be HIDDEN by the root
 * arrangement. A hidden band keeps its selection; a plugin view in it stays mounted with
 * `display: none` and is told `visible=false`, exactly as a hidden container tab is, so showing the
 * band again costs no reload. The bundled bars are simply not drawn: their models live in the host
 * and keep running either way. A plugin view's band is the height its manifest declares
 * (`bandHeights`, validated at install against `PLUGIN_BAND_HEIGHTS`) or the band's long-standing
 * default, and the bottom panel is further held to half the window, which no manifest can know.
 */
export function WorkbenchSlot(props: { placement: WorkbenchSlotID; children?: ReactNode | ((context: ViewRenderContext) => ReactNode); className?: string; trafficLightInset?: number }): ReactElement {
    const host = useWorkbench();
    const selected = resolveSlot(host.views, props.placement, host.selections[props.placement]);
    const native = (context: ViewRenderContext): ReactNode => typeof props.children === 'function' ? props.children(context)
        : props.children ?? host.features.get(DEFAULT_SLOTS[props.placement] ?? '')?.render(context);
    const band = isArrangementSlotBand(props.placement) ? props.placement : null;
    const hidden = band !== null && !(host.arrangement ?? DEFAULT_ARRANGEMENT).visible[band];
    if (!selected?.pluginID) return <>{hidden ? null : native({ visible: true, trafficLightInset: props.trafficLightInset ?? 0 })}</>;
    const height = band === null ? undefined : selected.bandHeights?.[band] ?? PLUGIN_BAND_HEIGHTS[band].default;
    return <div data-workbench-slot={props.placement} data-view-id={selected.id} data-band-hidden={hidden ? 'true' : undefined} className={props.className ?? 'flex h-full min-h-0 w-full'}
        style={height === undefined ? undefined : { height, flexShrink: 0, ...(band === 'panel.bottom' ? { maxHeight: '50vh' } : {}), ...(hidden ? { display: 'none' } : {}) }}>
        {props.placement === 'topbar' && props.trafficLightInset ? <div data-titlebar-drag="true" style={{ width: props.trafficLightInset, flexShrink: 0, height: '100%' }} /> : null}
        <NativeRendererScope selected={selected} compact={props.placement === 'topbar' || props.placement === 'statusbar'} adapters={DEFAULT_SLOTS[props.placement] ? { [DEFAULT_SLOTS[props.placement]!]: native } : {}}><RegisteredView view={selected} path="root" visible={!hidden} /></NativeRendererScope>
    </div>;
}

/** The picker belongs to the host, so a plugin can always be swapped out. */
function SidebarViewPicker(props: { placement: SidebarPlacement; compact: boolean; onManagePlugins(): void }): ReactElement {
    const host = useWorkbench();
    const button = useRef<HTMLButtonElement>(null);
    const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
    const selected = host.sidebars[props.placement];
    const side = props.placement === 'sidebar.primary' ? 'Left' : 'Right';
    const views = host.views.filter(view => view.placements.includes(props.placement));
    useEffect(() => {
        if (!anchor) return;
        // A click inside a plugin iframe does not bubble into the host document.
        const close = (): void => setAnchor(null);
        window.addEventListener('blur', close);
        return () => window.removeEventListener('blur', close);
    }, [anchor]);
    return <>
        <button
            ref={button}
            type="button"
            aria-label={`${side} sidebar view`}
            aria-haspopup="menu"
            aria-expanded={anchor !== null}
            data-testid={`sidebar-view-picker-${props.placement}`}
            data-view-id={selected?.id}
            className="flex min-w-0 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--kelpi-selection-fill)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
            style={{ color: tokens.textPrimary, outlineColor: tokens.accent }}
            title={`Change ${side.toLowerCase()} sidebar view`}
            onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect();
                setAnchor(current => current ? null : menuAnchorFromEvent({ clientX: rect.left, clientY: rect.bottom + 4 }));
            }}
        >
            {props.compact ? <ChromeIcon name={props.placement === 'sidebar.primary' ? 'sidebar' : 'sidebar-right'} size={14} /> : <span className="truncate text-[13px] font-semibold">{selected?.title}</span>}
            <span className="shrink-0" style={{ color: tokens.textTertiary }}><ChromeIcon name="chevron-down" size={10} /></span>
        </button>
        {anchor ? <ContextMenu
            {...anchor}
            anchorRef={button}
            autoFocus
            label={`${side} sidebar views`}
            items={[
                ...views.map(view => ({ id: view.id, label: view.title, checked: selected?.id === view.id, onSelect: () => host.select(props.placement, view.id) })),
                { id: 'separator', label: '', kind: 'separator' },
                { id: 'manage-plugins', label: 'Manage plugins…', onSelect: props.onManagePlugins }
            ]}
            onClose={() => { setAnchor(null); button.current?.focus({ preventScroll: true }); }}
        /> : null}
    </>;
}

export function WorkbenchSidebar(props: {
    placement: SidebarPlacement;
    nativeViewID: 'kelpi.workspaces' | 'kelpi.inspector';
    onManagePlugins(): void;
    onClose?(): void;
    children?(picker: ReactNode): ReactNode;
}): ReactElement {
    const host = useWorkbench();
    const selected = host.sidebars[props.placement];
    const picker = <SidebarViewPicker placement={props.placement} compact={selected?.id === 'kelpi.workspaces'} onManagePlugins={props.onManagePlugins} />;
    const native = (context: ViewRenderContext): ReactNode => props.children ? props.children(picker)
        : host.features.get(props.nativeViewID)?.render({ ...context, side: props.placement === 'sidebar.primary' ? 'left' : 'right', viewPicker: picker });
    if (!selected?.pluginID) return <>{native({ visible: true, trafficLightInset: 0 })}</>;
    return <div
        data-workbench-slot={props.placement}
        data-view-id={selected.id}
        className="flex h-full min-h-0 w-full flex-col"
        style={{ background: tokens.sidebarBackground, color: tokens.textPrimary }}
    >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: tokens.divider }}>
            <div className="min-w-0 flex-1">{picker}</div>
            {props.onClose ? <button type="button" className="shrink-0 rounded p-1" aria-label={`Close ${props.placement === 'sidebar.primary' ? 'left' : 'right'} sidebar`} onClick={props.onClose} style={{ color: tokens.textSecondary }}><ChromeIcon name="clear" size={12} /></button> : null}
        </div>
        <div className="min-h-0 flex-1">
            <NativeRendererScope selected={selected} adapters={{ [props.nativeViewID]: native }}><RegisteredView view={selected} path="root" /></NativeRendererScope>
        </div>
    </div>;
}

/**
 * Does this sidebar placement actually MOUNT its bundled view?
 *
 * True for the plain selection, and true for a plugin CONTAINER that wraps the bundled view in one
 * of its slots - `registration.test.tsx`'s "Wrapped Workspaces" mounts the native sidebar just as
 * the plain selection does, tab-hidden or not. The same walk `NativeRendererScope` performs, asked
 * one render earlier, so the answer cannot disagree with what the slot goes on to draw.
 *
 * A surface that belongs to a bundled sidebar but is drawn OUTSIDE it asks this before hosting its
 * own copy. §WS-075's create sheet is the one: a window modal (`ContentView.swift:289-294`) raised
 * from ⌘N, File ▸ New Workspace, the palette and the empty state, whose only consumer used to be
 * the native `Sidebar` - so with a plugin view in the slot the gesture did nothing at all
 * (issue #201). Exactly one host, whatever occupies the placement.
 */
export function useSidebarNativeMounted(placement: SidebarPlacement, nativeViewID: string): boolean {
    const host = useWorkbench();
    const selected = host.sidebars[placement];
    if (!selected?.pluginID) return true;
    return planComposedViews(host.views, host.selections, selected, new Set([nativeViewID])).nativePaths.has(nativeViewID);
}

/**
 * The route BACK to the bundled presenter, said out loud.
 *
 * Every root slot's select has always listed the bundled view for the slot - `kelpi.palette`,
 * `kelpi.prompts` and `kelpi.interaction.notifications` are in `BUNDLED_FEATURE_DEFINITIONS` and in
 * `slotViews`, and selecting one really does hand the placement back. What the presented surfaces
 * lack is any OTHER route: a sidebar or a toolbar shows you which view is drawing, so "Toolbar" in
 * a list reads as the original, while a palette you replaced looks the same as a palette you did
 * not, and "Command palette" beside "Interaction Lab palette" does not say which one is the floor.
 * Recovery must never depend on a guess, so the bundled entry names itself here (the status row
 * below prints the same word). Only the presented placements: the rest are not recovery surfaces.
 */
function optionTitle(slot: string, view: ViewContribution): string {
    return view.pluginID === undefined && PRESENTED_SLOTS.includes(slot)
        ? `${view.title} (bundled)`
        : view.title;
}

/** The Settings status line: "every band shown", "Zen Mode", or the bands the user has hidden by hand. */
function describeArrangement(arrangement: RootArrangement): string {
    if (zenModeActive(arrangement)) return 'Zen Mode';
    const names: Readonly<Record<string, string>> = { topbar: 'toolbar', statusbar: 'status bar', 'panel.bottom': 'bottom panel' };
    const hidden = Object.keys(names).filter(band => isArrangementSlotBand(band) && !arrangement.visible[band]).map(band => `${names[band]!} hidden`);
    return hidden.length ? hidden.join(', ') : 'every band shown';
}

export function PlacementSettings(): ReactElement {
    const host = useWorkbench();
    const failures = useSyncExternalStore(subscribeInteractionPresenters, interactionPresenterFailures, interactionPresenterFailures);
    const settingsFailures = useSyncExternalStore(subscribeSettingsPresenters, settingsPresenterFailures, settingsPresenterFailures);
    const settingsFailure = settingsFailures[SETTINGS_PLACEMENT];
    const settingsSelected = resolveSlot(host.views, SETTINGS_PLACEMENT, host.selections[SETTINGS_PLACEMENT]);
    const chromeFailure = useSyncExternalStore(subscribePaneChromePresenters, paneChromePresenterFailure, paneChromePresenterFailure);
    const chromeSelected = resolveSlot(host.views, PANE_CHROME_PLACEMENT, host.selections[PANE_CHROME_PLACEMENT]);
    const searchFailure = useSyncExternalStore(subscribePaneSearchPresenters, paneSearchPresenterFailure, paneSearchPresenterFailure);
    const searchSelected = resolveSlot(host.views, PANE_SEARCH_PLACEMENT, host.selections[PANE_SEARCH_PLACEMENT]);
    const arrangement = host.arrangement ?? DEFAULT_ARRANGEMENT;
    return <div className="flex flex-col gap-3" data-testid="plugin-placements">
        <strong>Workbench views</strong>
        {ROOT_SLOTS.map(slot => <label key={slot} className="flex items-center justify-between gap-3 text-xs">{slot}{isArrangementSlotBand(slot) && !arrangement.visible[slot] ? ' (hidden)' : ''}<select aria-label={slot} value={slot === 'sidebar.primary' || slot === 'sidebar.secondary' ? host.sidebars[slot].id : resolveSlot(host.views, slot, host.selections[slot])?.id ?? ''} onChange={event => host.select(slot, event.target.value)}>
            {slot === 'panel.bottom' ? <option value="">Hidden</option> : null}
            {host.views.filter(view => view.placements.includes(slot)).map(view => <option key={view.id} value={view.id}>{optionTitle(slot, view)}</option>)}
        </select></label>)}
        {contributedSlots(host.views).map(slot => <label key={slot.id} className="flex items-center justify-between gap-3 text-xs">{slot.title}<select aria-label={slot.id} value={resolveSlot(host.views, slot.id, host.selections[slot.id])?.id ?? ''} onChange={event => host.select(slot.id, event.target.value)}>
            <option value="">Empty</option>{slotViews(host.views, slot.id).map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
        </select></label>)}
        {/*
          * The presented surfaces get a status row as well as a select: a prompt has no persistent
          * chrome to hang one on, so the report of a failure and the explicit Retry live where the
          * selection lives. Same shape as the terminal renderer's picker-plus-retry row
          * (`features/TerminalFeaturePane.tsx`), relocated.
          */}
        {INTERACTION_SLOTS.map(slot => {
            const failure = failures[slot as keyof typeof failures];
            const selected = resolveSlot(host.views, slot, host.selections[slot]);
            const status = failure ? `Failed: ${failure.detail}` : !selected?.pluginID ? 'Bundled' : selected.title;
            return <div key={`presenter-${slot}`} className="flex items-center justify-between gap-3 text-xs">
                <span role="status" data-testid={`interaction-presenter-status-${slot}`}>{slot} presenter: {status}</span>
                {failure ? <button type="button" className="shrink-0" data-testid={`interaction-presenter-retry-${slot}`}
                    onClick={() => clearInteractionPresenterFailure(slot)}>Retry presenter</button> : null}
            </div>;
        })}
        {/*
          * The Settings window's own row, beside the interaction ones and on the same terms. It is
          * the row a user reaches for after a presenter has taken the dialog: the section it lives
          * in is permanently native, so this row is drawn by the HOST whoever is painting, and
          * Retry is the only thing that clears a latch the window has not already moved past.
          */}
        <div className="flex items-center justify-between gap-3 text-xs">
            <span role="status" data-testid={`settings-presenter-status-${SETTINGS_PLACEMENT}`}>{SETTINGS_PLACEMENT} presenter: {settingsFailure ? `Failed: ${settingsFailure.detail}` : !settingsSelected?.pluginID ? 'Bundled' : settingsSelected.title}</span>
            {settingsFailure ? <button type="button" className="shrink-0" data-testid={`settings-presenter-retry-${SETTINGS_PLACEMENT}`}
                onClick={() => clearSettingsPresenterFailure(SETTINGS_PLACEMENT)}>Retry presenter</button> : null}
        </div>
        {/*
          * The pane chrome row, on the same terms as the four above and for a sharper reason: a
          * failed header presenter takes every pane's title, close and split with it, and the only
          * surface left saying what happened is this one. The latch is keyed
          * `viewID:revision:instanceID`, so a reload, a rollback or a different selection clears it
          * by moving the generation; Retry is what clears one the window has not moved past.
          */}
        <div className="flex items-center justify-between gap-3 text-xs">
            <span role="status" data-testid={`pane-chrome-presenter-status-${PANE_CHROME_PLACEMENT}`}>{PANE_CHROME_PLACEMENT} presenter: {chromeFailure ? `Failed: ${chromeFailure.detail}` : !chromeSelected?.pluginID ? 'Bundled' : chromeSelected.title}</span>
            {chromeFailure ? <button type="button" className="shrink-0" data-testid={`pane-chrome-presenter-retry-${PANE_CHROME_PLACEMENT}`}
                onClick={() => clearPaneChromePresenterFailure()}>Retry presenter</button> : null}
        </div>
        {/*
          * The pane search row, on the same terms again. A failed search presenter is the one
          * failure a user can be holding the keyboard through - the caret was in its frame a moment
          * ago - so the row that says what happened has to be somewhere that never depended on it.
          * This section is permanently native, and Retry is what clears a latch the window has not
          * already moved past.
          */}
        <div className="flex items-center justify-between gap-3 text-xs">
            <span role="status" data-testid={`pane-search-presenter-status-${PANE_SEARCH_PLACEMENT}`}>{PANE_SEARCH_PLACEMENT} presenter: {searchFailure ? `Failed: ${searchFailure.detail}` : !searchSelected?.pluginID ? 'Bundled' : searchSelected.title}</span>
            {searchFailure ? <button type="button" className="shrink-0" data-testid={`pane-search-presenter-retry-${PANE_SEARCH_PLACEMENT}`}
                onClick={() => clearPaneSearchPresenterFailure()}>Retry presenter</button> : null}
        </div>
        {/*
          * The root arrangement's route back, beside the selections' one and on the same terms:
          * the Plugins section is always drawn by the bundled panel, so whatever is hidden and
          * whoever draws Settings, this row says so and the Reset is reachable.
          */}
        <span role="status" className="text-xs" data-testid="window-arrangement-status">Window arrangement: {describeArrangement(arrangement)}</span>
        <div className="flex gap-3">
            <button className="self-start text-xs" onClick={() => { for (const slot of ROOT_SLOTS) host.select(slot, DEFAULT_SLOTS[slot] ?? ''); }}>Restore bundled views</button>
            {host.arrange ? <button className="self-start text-xs" data-testid="reset-window-arrangement" onClick={() => host.arrange?.(() => DEFAULT_ARRANGEMENT)}>Reset window arrangement</button> : null}
        </div>
    </div>;
}
