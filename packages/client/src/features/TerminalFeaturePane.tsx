import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import type { TerminalPaneProps } from '../terminal/TerminalPane';
import type { KelpiRuntime } from '../state';
import { PluginView } from '../plugins/PluginView';
import { useWorkbenchLayout } from '../plugins/Workbench';
import { getCurrentPlugins } from '../plugins/client';
import { resolveSlot, slotViews } from '../plugins/registry';
import { tokens } from '../chrome/tokens';
import { bindTerminalFeature } from './terminals';
import { TERMINAL_FEATURE } from './definitions';
import { useTerminalShortcuts } from '../app/terminal-shortcuts';

export interface TerminalFeaturePaneProps extends TerminalPaneProps {
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    readonly claimedChords?: readonly string[] | undefined;
}

/** One selected renderer attaches to the existing process, including external editors. */
export function TerminalFeaturePane(props: TerminalFeaturePaneProps): ReactElement {
    const { runtime, paneID, workspaceID } = props;
    /**
     * Does the window PTY geometry follows belong to this runtime's own client? (#166.)
     *
     * Read off the runtime's own store rather than passed down from `App.tsx`, and that is the
     * point: a remote host's panes render against THAT daemon's runtime
     * (`app/RemoteWorkspaceView.tsx`) and size ownership is per-daemon — one `sizeOwnerID` per
     * `createSyncHub` — so asking the store the pane is actually fed by is the only reading that
     * cannot name the wrong daemon's owner.
     *
     * It is the CHIP's rule, arm for arm (`features/chrome-source.ts` — `owner === null || client
     * === null ? 'unclaimed' : owner === client ? 'this-window' : 'other-window'`), because the two
     * must answer the same question the same way: the chip tells the user another window owns
     * sizing and the mirror is what that means on screen, so a pane that mirrored while no chip was
     * offered would be a letterbox with no way out. Both "unknown" arms therefore answer YES —
     * no owner broadcast yet, or no `welcome.clientID` yet — which is also what a single-window
     * session answers forever, so nothing about it changed with #166.
     *
     * Subscribed, not read once: `size-control` is a broadcast that arrives whenever ownership
     * moves, and the pane follows it in both directions (its effect puts the engine back on its
     * own box the moment this turns true again).
     */
    const ownsSize = useStore(runtime.store, (state) => {
        const owner = state.daemon.sizeControlOwnerID;
        const client = state.daemon.clientID;
        return owner === null || client === null || owner === client;
    });
    const shortcuts = useTerminalShortcuts(runtime, paneID, props.visible, props.claimedChords);
    const layout = useWorkbenchLayout(runtime);
    const selected = resolveSlot(layout.views, 'terminal', layout.selections.terminal);
    const viewID = selected?.id ?? TERMINAL_FEATURE.id;
    const plugin = getCurrentPlugins(runtime).find(item => item.manifest.id === selected?.pluginID);
    const generation = `${viewID}:${plugin?.revision ?? ''}:${plugin?.instanceID ?? ''}`;
    const [failure, setFailure] = useState<{ generation: string; message: string } | null>(null);
    const failed = failure?.generation === generation ? failure : null;
    const choices = slotViews(layout.views, 'terminal').filter(view => !view.container);
    const replacement = selected?.pluginID && !failed;
    // #166 rides with the rest of the pane's props, so a replacement renderer is told the same
    // thing the bundled one is. What a plugin renderer DOES with it is its own business: the
    // mirror is the native engine's, and the SDK's replay frame does not carry the grid yet.
    const paneProps: TerminalPaneProps = { ...props, ownsSize };
    return <div data-terminal-pane={paneID} data-terminal-renderer={replacement ? viewID : TERMINAL_FEATURE.id} className="flex h-full min-h-0 flex-col">
        {choices.length > 1 || failed ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: tokens.divider }}>
            <label>Terminal renderer <select aria-label="Terminal renderer" value={viewID} onChange={event => layout.select('terminal', event.target.value)}>
                {choices.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
            </select></label>
            {failed ? <><span role="status">{failed.message || 'Terminal renderer failed.'} The bundled terminal is active.</span><button onClick={() => setFailure(null)}>Retry renderer</button></> : null}
        </div> : null}
        <div className="min-h-0 flex-1">{replacement ? <PluginView runtime={runtime} paneID={paneID} workspaceID={workspaceID}
            pluginID={selected.pluginID!} viewID={viewID} visible={props.visible} focused={props.focused} claimedChords={shortcuts.chords} onTerminalKey={shortcuts.onKey}
            terminal={paneProps} onError={message => setFailure({ generation, message })} />
            : bindTerminalFeature(paneProps).render({ visible: props.visible, trafficLightInset: 0 })}</div>
    </div>;
}
