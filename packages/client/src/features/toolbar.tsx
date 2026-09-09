import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { PredefinedLayoutKind } from '@kelpi/core/layout';
import type { MenuItemSpec } from '../chrome/ContextMenu';
import { TopBar, type TopBarProps } from '../chrome/TopBar';
import type { CommandClient, CommandReply } from '../connection';
import type { ChromeSnapshot } from '../plugins/chrome';
import { TOOLBAR_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

export interface ToolbarActionHost {
    readonly commands: Pick<CommandClient, 'cycleLayout' | 'selectLayout' | 'setSyncInput'>;
    readonly activeWorkspaceID: () => string | null;
    readonly focusedPaneID: () => string | null;
    readonly run: (label: string, command: Promise<CommandReply>) => boolean;
    readonly setInspectorVisible: Dispatch<SetStateAction<boolean>>;
}
/** Legacy keyboard and palette bindings resolve live targets through feature-owned actions. */
export function createToolbarActions(host: ToolbarActionHost) {
    return {
        cycleLayout(): boolean {
            const paneID = host.focusedPaneID();
            return paneID === null ? false : host.run('Cycle layout', host.commands.cycleLayout({ paneID }));
        },
        selectLayout(layout: PredefinedLayoutKind): boolean {
            const paneID = host.focusedPaneID();
            return paneID === null ? false : host.run('Select layout', host.commands.selectLayout({ paneID, layout }));
        },
        toggleSyncInput(): boolean {
            const id = host.activeWorkspaceID();
            return id === null ? false : host.run('Synchronise input', host.commands.setSyncInput({ action: 'toggle', workspace: id }));
        },
        toggleInspector(): boolean { host.setInspectorVisible(current => !current); return true; },
    };
}
export interface ToolbarFeatureInput {
    readonly model: ChromeSnapshot;
    readonly presentation: Pick<TopBarProps, 'panes' | 'bucket' | 'connectionError' | 'dragRegion'>;
    readonly contributions: ReactNode;
    readonly execute: (id: string) => void;
}
/** JSX and native control wiring belong to the feature; the workbench supplies its host. */
export function bindToolbarFeature(input: ToolbarFeatureInput): BundledFeatureBinding {
    const { model, execute } = input;
    const sidebar = (side: 'left' | 'right'): string => {
        const view = model.sidebars[side];
        return `Toggle ${view.viewID === 'kelpi.workspaces' ? 'sidebar' : view.viewID === 'kelpi.inspector' ? 'inspector' : view.title}`;
    };
    const available = (id: string): (() => void) | undefined => model.commands.find(command => command.id === id)?.enabled ? () => execute(id) : undefined;
    const menuIDs: Readonly<Record<string, string>> = { 'kelpi.window.openPlugins': 'plugins', 'kelpi.window.openSettings': 'settings',
        'kelpi.inspector.toggle': 'inspector', 'kelpi.window.openHelp': 'help', 'kelpi.window.installCLI': 'install-cli',
        'kelpi.window.checkUpdates': 'check-updates', 'kelpi.window.restartSocket': 'restart-socket', 'kelpi.window.restartUI': 'restart-ui' };
    const overflowItems: MenuItemSpec[] = [];
    let previousSection: string | undefined;
    for (const command of model.commands.filter(command => command.group === 'menu')) {
        if (overflowItems.length && previousSection !== command.section) overflowItems.push({ id: `separator:${command.id}`, label: '', kind: 'separator' });
        overflowItems.push({ id: menuIDs[command.id] ?? command.id, label: command.title, disabled: !command.enabled,
            ...(command.checked === undefined ? {} : { checked: command.checked }), onSelect: () => execute(command.id) });
        previousSection = command.section;
    }
    return { definition: TOOLBAR_FEATURE, render: context => <TopBar
        {...input.presentation}
        contributions={input.contributions}
        workspaceName={model.workspace?.name ?? null}
        workspaceColor={model.workspace?.color as TopBarProps['workspaceColor']}
        connection={model.connection}
        currentLayout={(model.workspace?.layout as PredefinedLayoutKind | null) ?? null}
        onCycleLayout={available('kelpi.layout.cycle')}
        onSelectLayout={model.commands.some(command => command.group === 'layout' && command.enabled) ? layout => execute(`kelpi.layout.select.${layout}`) : undefined}
        syncInputActive={model.workspace?.syncInputActive ?? false}
        syncedPaneCount={model.workspace?.syncedPaneCount ?? 0}
        onToggleSyncInput={available('kelpi.input.toggleSync')}
        sizeControlledElsewhere={model.sizeControl === 'other-window'}
        onTakeSizeControl={available('kelpi.window.takeSizeControl')}
        onToggleSidebar={() => execute('kelpi.sidebar.left')}
        sidebarVisible={model.sidebars.left.visible}
        sidebarLabel={sidebar('left')}
        sidebarTooltip={`${sidebar('left')}${model.sidebars.left.viewID === 'kelpi.inspector' ? ' (⌘I)' : ''}`}
        onToggleInspector={() => execute('kelpi.sidebar.right')}
        inspectorVisible={model.sidebars.right.visible}
        inspectorLabel={sidebar('right')}
        inspectorTooltip={`${sidebar('right')}${model.sidebars.right.viewID === 'kelpi.inspector' ? ' (⌘I)' : ''}`}
        overflowItems={overflowItems}
        trafficLightInset={context.trafficLightInset}
    /> };
}
