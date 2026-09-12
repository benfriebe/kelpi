import { PREDEFINED_LAYOUT_DISPLAY_NAMES, PREDEFINED_LAYOUT_ORDER, type PredefinedLayoutKind } from '@kelpi/core/layout';
import { syncedPaneIDs } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { footerGitStats, type FooterAssociation } from '../chrome/StatusFooter';
import { compactStatLabel, detailStatLabel, SYSTEM_STAT_META, visibleStatKinds } from '../chrome/stats';
import { isOkReply, replyError, type CommandReply } from '../connection';
import { selectActiveWorkspace, selectFocusedPaneID, type KelpiRuntime } from '../state';
import type { ChromeCommand, ChromeItem, ChromeSnapshot, ChromeSource } from '../plugins/chrome';
import type { usePluginCommands } from '../plugins/commands';
import type { ViewContribution } from '../plugins/registry';
import { statusbarModel } from './statusbar';

export interface ChromeFeatureHost {
    readonly runtime: KelpiRuntime;
    readonly sidebars: Readonly<Record<'sidebar.primary' | 'sidebar.secondary', ViewContribution>>;
    readonly sidebarVisible: boolean;
    readonly inspectorVisible: boolean;
    readonly remoteWorkspaceSelected: () => boolean;
    readonly shellAvailable: boolean;
    readonly associations: { readonly workspaceID: string | null; readonly values: readonly FooterAssociation[] };
    readonly plugins: ReturnType<typeof usePluginCommands>;
    readonly toggleSidebar: () => void;
    readonly toggleInspector: () => void;
    readonly openSettings: (section?: 'plugins') => void;
    readonly openHelp: () => void;
    /**
     * Opens the palette through the window's interaction surface with the `native:chrome-command`
     * owner, not by writing `ui.palette.open`. The surface is what refuses a palette raised over
     * a visible modal prompt, holds the single modal registration, and parks the window's native
     * pages while the session is painted.
     */
    readonly openPalette: () => void;
    readonly shellAction: (action: 'install-cli' | 'check-for-updates') => void;
    readonly restartControlServer: () => void;
    readonly restartUI: () => void;
    readonly selectPane: (workspaceID: string, paneID: string) => void;
}
/** The registry produces both native controls and SDK discovery, and rechecks live state on invocation. */
export function createChromeFeatureSource(host: ChromeFeatureHost): ChromeSource {
    const ready = (): boolean => { const state = host.runtime.store.getState(); return state.ui.connection === 'connected' && state.daemon.hasSnapshot && !state.daemon.desynced; };
    const swapped = (): boolean => host.sidebars['sidebar.primary'].id === 'kelpi.inspector' || host.sidebars['sidebar.secondary'].id === 'kelpi.workspaces';
    const sidebar = (side: 'left' | 'right') => {
        const view = host.sidebars[side === 'left' ? 'sidebar.primary' : 'sidebar.secondary'];
        return { viewID: view.id, title: view.title, visible: (side === 'left') !== swapped() ? host.sidebarVisible : host.inspectorVisible };
    };
    const commands = (): ChromeCommand[] => {
        const state = host.runtime.store.getState(), workspace = selectActiveWorkspace(state), focused = selectFocusedPaneID(state);
        const windowEnabled = ready() && !host.remoteWorkspaceSelected();
        const domainEnabled = windowEnabled && !!workspace;
        return [
            { id: 'kelpi.layout.cycle', title: 'Cycle Layout', enabled: domainEnabled && !!focused, group: 'layout' },
            ...PREDEFINED_LAYOUT_ORDER.map((layout, index): ChromeCommand => ({ id: `kelpi.layout.select.${layout}`, title: PREDEFINED_LAYOUT_DISPLAY_NAMES[layout],
                enabled: domainEnabled && !!focused, checked: workspace?.currentLayoutIndex === index, group: 'layout' })),
            { id: 'kelpi.input.toggleSync', title: 'Synchronise Input', enabled: domainEnabled, checked: workspace?.isSyncInputActive ?? false, group: 'window' },
            { id: 'kelpi.sidebar.left', title: `${sidebar('left').visible ? 'Hide' : 'Show'} ${sidebar('left').title}`, enabled: true, group: 'window' },
            { id: 'kelpi.sidebar.right', title: `${sidebar('right').visible ? 'Hide' : 'Show'} ${sidebar('right').title}`, enabled: true, group: 'window' },
            { id: 'kelpi.window.takeSizeControl', title: 'Take Size Control', enabled: ready(), group: 'window' },
            { id: 'kelpi.pane.focus', title: 'Focus Pane', enabled: ready(), group: 'window' },
            // Recovery floor: id, title and the unconditional `enabled` are the route back to the
            // palette while a presenter is failed, so none of the three is state-dependent.
            { id: 'kelpi.window.openPalette', title: 'Command Palette', enabled: true, group: 'window' },
            ...host.plugins.menu('workspace').map((item): ChromeCommand => ({ id: `menu:${item.id}`, title: item.title, enabled: windowEnabled && item.enabled, group: 'menu', section: `plugins:${item.group ?? ''}` })),
            { id: 'kelpi.window.openPlugins', title: 'Plugins…', enabled: true, group: 'menu', section: 'primary' },
            { id: 'kelpi.window.openSettings', title: 'Settings…', enabled: true, group: 'menu', section: 'primary' },
            { id: 'kelpi.inspector.toggle', title: host.inspectorVisible ? 'Hide Inspector' : 'Show Inspector', enabled: true, group: 'menu', section: 'primary' },
            { id: 'kelpi.window.openHelp', title: 'Kelpi Help', enabled: true, group: 'menu', section: 'primary' },
            ...(host.shellAvailable ? [
                { id: 'kelpi.window.installCLI', title: 'Install CLI', enabled: ready(), group: 'menu' as const, section: 'shell' },
                { id: 'kelpi.window.checkUpdates', title: 'Check for Updates…', enabled: ready(), group: 'menu' as const, section: 'shell' }
            ] : []),
            { id: 'kelpi.window.restartSocket', title: 'Restart Socket Server', enabled: ready(), group: 'menu', section: 'recovery' },
            { id: 'kelpi.window.restartUI', title: 'Restart UI', enabled: true, group: 'menu', section: 'recovery' }
        ];
    };
    const items = (): ChromeItem[] => (['workspace.header', 'statusbar'] as const).flatMap(placement => host.plugins.items(placement).map(item => ({
        id: item.id, placement, text: item.text, ...(item.tooltip === undefined ? {} : { tooltip: item.tooltip }), ...(item.badge === undefined ? {} : { badge: item.badge }),
        tone: item.tone, enabled: ready() && !host.remoteWorkspaceSelected() && item.enabled,
        commandID: item.command ? `item:${placement}:${item.id}` : null
    })));
    const complete = async (promise: Promise<CommandReply>): Promise<void> => { const reply = await promise; if (!isOkReply(reply)) throw new Error(replyError(reply)); };
    return {
        snapshot(): ChromeSnapshot {
            const state = host.runtime.store.getState(), workspace = selectActiveWorkspace(state);
            const status = statusbarModel(state, host.associations.workspaceID === workspace?.id ? host.associations.values : []), pane = status.focusedPane;
            const owner = state.daemon.sizeControlOwnerID, client = state.daemon.clientID;
            return {
                connection: state.ui.connection, ready: ready(), remoteWorkspaceSelected: host.remoteWorkspaceSelected(),
                workspace: workspace ? { id: workspace.id, name: workspace.name, color: workspace.color, paneCount: workspace.panes.length,
                    layout: workspace.currentLayoutIndex === null ? null : PREDEFINED_LAYOUT_ORDER[workspace.currentLayoutIndex] ?? null,
                    syncInputActive: workspace.isSyncInputActive, syncedPaneCount: syncedPaneIDs(workspace).length } : null,
                focusedPane: pane ? { id: pane.id, title: pane.label ?? pane.title ?? pane.workingDirectory, type: pane.type,
                    workingDirectory: pane.workingDirectory, gitBranch: pane.gitBranch,
                    status: pane.status, agentKind: pane.agentKind, agentStartedAt: pane.agentStartedAt } : null,
                sidebars: { left: sidebar('left'), right: sidebar('right') },
                sizeControl: owner === null || client === null ? 'unclaimed' : owner === client ? 'this-window' : 'other-window',
                layouts: PREDEFINED_LAYOUT_ORDER.map(id => ({ id, title: PREDEFINED_LAYOUT_DISPLAY_NAMES[id] })), commands: commands(),
                agents: status.summary,
                agentPanes: (['running', 'waiting', 'inactive'] as const).flatMap(bucket => status.bucketItems(bucket).map(item => ({
                    workspaceID: item.workspaceID, workspaceName: item.workspaceName, paneID: item.paneID, title: item.paneTitle, bucket, agentStartedAt: item.agentStartedAt ?? null
                }))),
                git: pane ? footerGitStats(status.associations, pane.workingDirectory, pane.workingDirectoryReal) : null,
                systemStats: !status.systemStats ? null : visibleStatKinds(status.systemStats.showSystemStats, status.systemStats.enabled).map(id => ({
                    id, title: SYSTEM_STAT_META[id].displayName, text: compactStatLabel(id, status.systemStats!.stats), detail: detailStatLabel(id, status.systemStats!.stats)
                })), items: items()
            };
        },
        execute(id: string, target: JsonObject): void | Promise<void> {
            // Items retain their own enablement/visibility rules instead of bypassing them by command ID.
            const item = items().find(item => item.commandID === id);
            const command = commands().find(command => command.id === id);
            if (!item?.enabled && !command?.enabled) throw new Error('Chrome command is unavailable or disabled.');
            const workspace = selectActiveWorkspace(host.runtime.store.getState());
            if (id.startsWith('kelpi.layout.') || id === 'kelpi.input.toggleSync') {
                if (!workspace || target['workspaceID'] !== workspace.id || host.remoteWorkspaceSelected()) throw new Error('Chrome command workspace is no longer selected.');
            }
            if ((id.startsWith('menu:') || id.startsWith('item:')) && (workspace?.id !== target['workspaceID'] || host.remoteWorkspaceSelected())) throw new Error('Chrome command workspace is no longer selected.');
            const paneID = selectFocusedPaneID(host.runtime.store.getState());
            if (item) { if (!host.plugins.runItem(item.placement, item.id)) throw new Error('Chrome item is no longer available.'); return; }
            if (id.startsWith('menu:')) {
                const entry = host.plugins.menu('workspace').find(item => `menu:${item.id}` === id);
                if (!entry?.run()) throw new Error('Chrome menu is no longer available.'); return;
            }
            if (id.startsWith('kelpi.layout.select.') && paneID) return complete(host.runtime.commands.selectLayout({ paneID, layout: id.slice('kelpi.layout.select.'.length) as PredefinedLayoutKind }));
            switch (id) {
                case 'kelpi.layout.cycle': if (paneID) return complete(host.runtime.commands.cycleLayout({ paneID })); break;
                case 'kelpi.input.toggleSync': return complete(host.runtime.commands.setSyncInput({ action: 'toggle', workspace: workspace!.id }));
                case 'kelpi.sidebar.left': (swapped() ? host.toggleInspector : host.toggleSidebar)(); return;
                case 'kelpi.sidebar.right': (swapped() ? host.toggleSidebar : host.toggleInspector)(); return;
                case 'kelpi.inspector.toggle': host.toggleInspector(); return;
                case 'kelpi.window.takeSizeControl': host.runtime.commands.takeSizeControl(); return;
                case 'kelpi.window.openPlugins': host.openSettings('plugins'); return;
                case 'kelpi.window.openSettings': host.openSettings(); return;
                case 'kelpi.window.openHelp': host.openHelp(); return;
                case 'kelpi.window.openPalette': host.openPalette(); return;
                case 'kelpi.window.installCLI': host.shellAction('install-cli'); return;
                case 'kelpi.window.checkUpdates': host.shellAction('check-for-updates'); return;
                case 'kelpi.window.restartSocket': host.restartControlServer(); return;
                case 'kelpi.window.restartUI': host.restartUI(); return;
                case 'kelpi.pane.focus':
                    if (typeof target['workspaceID'] !== 'string' || typeof target['paneID'] !== 'string') throw new Error('Status navigation requires workspaceID and paneID.');
                    host.selectPane(target['workspaceID'], target['paneID']); return;
            }
            throw new Error('Chrome command target is unavailable.');
        }
    };
}
