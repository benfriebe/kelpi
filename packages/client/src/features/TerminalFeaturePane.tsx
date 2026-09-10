import { useState, type ReactElement } from 'react';
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
    const shortcuts = useTerminalShortcuts(runtime, paneID, props.visible, props.claimedChords);
    const layout = useWorkbenchLayout(runtime);
    const selected = resolveSlot(layout.views, 'terminal', layout.selections.terminal);
    const viewID = selected?.id ?? TERMINAL_FEATURE.id;
    const plugin = getCurrentPlugins(runtime).find(item => item.manifest.id === selected?.pluginID);
    const generation = `${viewID}:${plugin?.revision ?? ''}:${plugin?.instanceID ?? ''}`;
    const [failure, setFailure] = useState<{ generation: string; message: string } | null>(null);
    const failed = failure?.generation === generation ? failure.message : null;
    const choices = slotViews(layout.views, 'terminal').filter(view => !view.container);
    const replacement = selected?.pluginID && !failed;
    return <div data-terminal-pane={paneID} data-terminal-renderer={replacement ? viewID : TERMINAL_FEATURE.id} className="flex h-full min-h-0 flex-col">
        {choices.length > 1 || failed ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: tokens.divider }}>
            <label>Terminal renderer <select aria-label="Terminal renderer" value={viewID} onChange={event => layout.select('terminal', event.target.value)}>
                {choices.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
            </select></label>
            {failed ? <><span role="status">{failed} The bundled terminal is active.</span><button onClick={() => setFailure(null)}>Retry renderer</button></> : null}
        </div> : null}
        <div className="min-h-0 flex-1">{replacement ? <PluginView runtime={runtime} paneID={paneID} workspaceID={workspaceID}
            pluginID={selected.pluginID!} viewID={viewID} visible={props.visible} focused={props.focused} claimedChords={shortcuts.chords} onTerminalKey={shortcuts.onKey}
            terminal={props} onError={message => setFailure({ generation, message })} />
            : bindTerminalFeature(props).render({ visible: props.visible, trafficLightInset: 0 })}</div>
    </div>;
}
