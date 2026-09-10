import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import type { BrowserSnapshot } from '../../../plugin-sdk/browser-pane';
import type { KelpiRuntime } from '../state';
import { PluginView } from '../plugins/PluginView';
import { useWorkbenchLayout } from '../plugins/Workbench';
import { getCurrentPlugins, pluginRequest } from '../plugins/client';
import { resolveSlot, slotViews } from '../plugins/registry';
import { tokens } from '../chrome/tokens';
import { useBrowserShortcuts } from '../app/browser-shortcuts';
import { createWebPaneCommands } from '../webpane/commands';
import { readShellWindowID } from '../webpane/shell-window';
import type { WebPaneProps } from '../webpane/WebPane';
import { bindBrowserFeature } from './browsers';
import { BROWSER_FEATURE } from './definitions';

export interface BrowserFeaturePaneProps extends Omit<WebPaneProps, 'tabs' | 'activeTabID' | 'commands'> {
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    readonly tabs?: WebPaneProps['tabs'];
    readonly activeTabID?: WebPaneProps['activeTabID'];
    readonly commands?: WebPaneProps['commands'];
    readonly claimedChords?: readonly string[] | undefined;
}

interface SnapshotState {
    readonly runtime: KelpiRuntime;
    readonly paneID: string;
    readonly value: BrowserSnapshot | null;
    readonly error: string | null;
}

/** Host ownership and navigation metadata are invalidation/read state, scoped to one daemon. */
function useBrowserSnapshot(runtime: KelpiRuntime, paneID: string): { value: BrowserSnapshot | null; error: string | null } {
    const [current, setCurrent] = useState<SnapshotState | null>(null);
    useEffect(() => {
        let stopped = false, reading = false, reread = false, generation = 0;
        const publish = (value: BrowserSnapshot | null, error: string | null): void => {
            if (!stopped) setCurrent({ runtime, paneID, value, error });
        };
        const refresh = (): void => {
            generation++; reread = true;
            if (reading || !runtime.connection.isConnected) return;
            reading = true;
            void (async () => {
                try {
                    do {
                        reread = false; const requested = generation;
                        try {
                            // Native assembly uses its existing transport budget. SDK replies
                            // remain bounded, so a large favourite/tab list must not disable
                            // the bundled browser's native page placement.
                            const value = await pluginRequest(runtime, 'browser-state', { paneID }) as unknown as BrowserSnapshot;
                            if (!stopped && requested === generation && runtime.connection.isConnected) publish(value, null);
                        } catch (error) {
                            if (!stopped && requested === generation) publish(null, error instanceof Error ? error.message : String(error));
                        }
                    } while (!stopped && reread && runtime.connection.isConnected);
                } finally { reading = false; }
            })();
        };
        // Subscribe before reading: an invalidation during the request causes another read,
        // and the older response is never published as the current host's authority.
        const offMessage = runtime.connection.on('message', message => {
            if (message['type'] === 'web-browser-changed' && (message['paneID'] === null || message['paneID'] === paneID)) refresh();
        });
        const offStatus = runtime.connection.on('status', status => {
            if (status === 'connected') refresh();
            else { generation++; publish(null, 'The daemon connection is unavailable.'); }
        });
        refresh();
        return () => { stopped = true; generation++; offMessage(); offStatus(); };
    }, [runtime, paneID]);
    return current?.runtime === runtime && current.paneID === paneID
        ? { value: current.value, error: current.error } : { value: null, error: null };
}

/** A plugin replaces browser chrome; the selected native host retains every page and session. */
export function BrowserFeaturePane(props: BrowserFeaturePaneProps): ReactElement {
    const { runtime, paneID, workspaceID } = props;
    const snapshot = useBrowserSnapshot(runtime, paneID);
    const workspace = useStore(runtime.store, state => state.daemon.state.workspaces.find(item => item.id === workspaceID));
    const pane = workspace?.panes.find(item => item.id === paneID && item.type === 'web');
    const web = pane ? workspace?.webPanes[paneID] : undefined;
    const state = snapshot.value?.paneID === paneID && snapshot.value.workspaceID === workspaceID ? snapshot.value : null;
    const commands = useMemo(() => props.commands ?? createWebPaneCommands(runtime.commands), [runtime.commands, props.commands]);
    const [localFindToken, setFindToken] = useState(0), [localURLToken, setURLToken] = useState(0);
    const focusAddress = useCallback((): void => setURLToken(value => value + 1), []);
    const showFind = useCallback((): void => setFindToken(value => value + 1), []);
    const shortcuts = useBrowserShortcuts({ runtime, paneID, commands, visible: props.visible !== false,
        claimedChords: props.claimedChords, focusAddress, showFind });
    const tabs = props.tabs ?? web?.tabs ?? state?.tabs ?? [];
    const activeTabID = props.activeTabID !== undefined ? props.activeTabID : web?.activeTabID ?? state?.activeTabID ?? null;
    const active = state?.tabs.find(tab => tab.id === activeTabID) ?? state?.tabs[0];
    const available = props.embedded === true && pane !== undefined && state?.host.available === true
        && state.host.windowID !== null && state.host.windowID === readShellWindowID();
    const reason = available ? undefined : snapshot.error ?? (!state ? 'Connecting to the browser host…'
        : !state.host.available ? 'No Kelpi app is connected to host this page.'
        : props.embedded !== true ? 'This client can control browser tabs. The page is displayed in the owning Kelpi app.'
        : 'This page belongs to another Kelpi window.');
    const native: WebPaneProps = { ...props, paneID, tabs, activeTabID, commands,
        isPrivate: props.isPrivate ?? web?.isPrivate ?? state?.isPrivate ?? false,
        embedded: available,
        loading: props.loading ?? active?.loading ?? false,
        canGoBack: props.canGoBack ?? active?.canGoBack ?? false,
        canGoForward: props.canGoForward ?? active?.canGoForward ?? false,
        favourites: props.favourites ?? state?.favourites.map(item => ({ ...item, created_at: item.createdAt })) ?? [],
        findToken: (props.findToken ?? 0) + localFindToken, focusURLToken: (props.focusURLToken ?? 0) + localURLToken,
        onFocusRequest: props.onFocusRequest ?? (id => runtime.focusPane(workspaceID, id)) };
    const layout = useWorkbenchLayout(runtime);
    const selected = resolveSlot(layout.views, 'browser', layout.selections.browser);
    const viewID = selected?.id ?? BROWSER_FEATURE.id;
    const plugin = getCurrentPlugins(runtime).find(item => item.manifest.id === selected?.pluginID);
    const generation = `${viewID}:${plugin?.revision ?? ''}:${plugin?.instanceID ?? ''}`;
    const [failure, setFailure] = useState<{ generation: string; message: string } | null>(null);
    const failed = failure?.generation === generation ? failure : null;
    const replacement = selected?.pluginID && !failed;
    const choices = slotViews(layout.views, 'browser').filter(view => !view.container);
    return <div data-browser-pane={paneID} data-browser-renderer={replacement ? viewID : BROWSER_FEATURE.id} className="flex h-full min-h-0 flex-col">
        {choices.length > 1 || failed ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: tokens.divider }}>
            <label>Browser renderer <select aria-label="Browser renderer" value={viewID} onChange={event => layout.select('browser', event.target.value)}>
                {choices.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
            </select></label>
            {failed ? <><span role="status">{failed.message || 'Browser renderer failed.'} The bundled browser is active.</span><button onClick={() => setFailure(null)}>Retry renderer</button></> : null}
        </div> : null}
        <div className="min-h-0 flex-1" onKeyDownCapture={replacement ? undefined : event => {
            // Primary window capture may already have handled this chord. Remote bundled
            // chrome instead reaches this owner-scoped handler; native HTML editing remains
            // untouched when the browser priority explicitly declines to consume it.
            if (!event.defaultPrevented && shortcuts.onNativeKey(event)) { event.preventDefault(); event.stopPropagation(); }
        }}>{replacement ? <PluginView runtime={runtime} paneID={paneID} workspaceID={workspaceID}
            pluginID={selected.pluginID!} viewID={viewID} visible={props.visible} focused={props.focused}
            claimedChords={shortcuts.chords} onBrowserKey={shortcuts.onKey} browser={{ ...native, available, reason }}
            onError={message => setFailure({ generation, message })} />
            : bindBrowserFeature(native).render({ visible: props.visible ?? true, trafficLightInset: 0 })}</div>
    </div>;
}
