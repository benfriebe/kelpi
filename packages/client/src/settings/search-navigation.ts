import type { SettingsOverlayProps } from './SettingsOverlay';
import { tcpBindError } from './GeneralTab';
import { orphanLabels } from './model';
import type { SettingsIndexEntry } from './sections';

export interface SettingsSearchDestination {
    readonly testID: string;
    readonly message?: string;
}

/** Host-only availability, kept separate from the immutable, navigation-only catalog. */
export function settingsSearchDestination(
    entry: SettingsIndexEntry,
    context: Pick<SettingsOverlayProps, 'settings' | 'transport' | 'domain' | 'onBrowseForFolder' | 'web'>
): SettingsSearchDestination {
    const { settings } = context;
    if (entry.testID === 'tcp-port' && settings.general.tcpPort <= 0)
        return { testID: 'tcp-listener-row', message: 'Enable TCP listener to choose a port.' };
    if (entry.testID === 'tcp-bind-error' && tcpBindError(settings.general.tcpPort, context.transport) === null)
        return { testID: 'tcp-listener-row', message: 'No TCP bind failure is reported. Listener status is shown here.' };
    if (entry.testID === 'focus-delay-row' && !settings.general.focusFollowsMouse)
        return { testID: 'focus-follows-mouse-row', message: 'Enable Focus follows mouse to change its delay.' };
    if (entry.groupID === 'appearance-status-bar' && entry.testID !== 'stats-master-row' && !settings.chrome.showSystemStats)
        return { testID: 'stats-master-row', message: 'Enable Show system stats to reveal this control.' };
    if (entry.testID === 'terminal-background' && settings.appearance.theme !== null)
        return { testID: 'terminal-background-locked', message: 'The terminal theme owns this colour. Choose None (Custom) in Theme to edit it.' };
    if (entry.testID === 'global-hotkey-clear' && ['none', ''].includes(settings.general.globalHotkey ?? ''))
        return { testID: 'global-hotkey-row', message: 'No global hotkey is configured. Record a shortcut here.' };
    if (entry.testID === 'remote-pair-copy' || entry.testID === 'remote-pair-qr')
        return { testID: 'remote-pair-go', message: 'Pair a device to generate its connection link and QR code.' };
    if (entry.testID === 'repo-browse' && context.onBrowseForFolder === undefined)
        return { testID: 'repo-path', message: 'Folder browsing is unavailable here. Enter a repository path instead.' };
    if (entry.testID === 'label-orphans' && orphanLabels(context.domain.workspaces, context.domain.labelPresets).length === 0)
        return { testID: 'label-presets', message: 'There are no workspace labels awaiting a definition.' };
    if (entry.sectionID === 'labels' && entry.testID === 'label-presets' && entry.label !== 'Labels' && context.domain.labelPresets.length === 0)
        return { testID: 'label-add', message: 'Create a label before editing, moving or removing it.' };
    if (entry.testID === 'repo-list' && (context.domain.repos?.length ?? 0) === 0)
        return { testID: 'repo-path', message: 'Add a repository before renaming or removing it.' };
    if (entry.testID === 'repo-list' && context.domain.repos?.every(repo => repo.isAutoDiscovered === true))
        return { testID: 'repo-show-auto', message: 'Enable Show auto-detected to view the discovered repositories.' };
    if (entry.sectionID === 'web' && entry.label !== 'Favourites' && (context.web?.favourites.length ?? 0) === 0)
        return { testID: 'settings-favourites', message: 'Save a web favourite before renaming, moving or removing it.' };
    // ProfilesTab always supplies a baseline profile, even when the snapshot has no profiles.
    // Remote collections load in their own tab; their entries deliberately point at the collection
    // and explain which device/daemon to select, rather than promising a nonexistent instance.
    return { testID: entry.testID };
}
