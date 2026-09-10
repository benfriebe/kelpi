import { useContext } from 'react';
import { actionForTrigger, keyTriggerKey, type KelpiAction } from '@kelpi/core/config';
import { clientKeyBindings, triggerFromEvent, type KeyEventLike } from '../chrome/keys';
import { modalPresenceCount } from '../chrome/modal-presence';
import { isOkReply, replyError, type CommandReply } from '../connection';
import { chordKeysForTrigger } from '../content/bridge';
import type { KelpiRuntime } from '../state';
import type { WebPaneCommands } from '../webpane/commands';
import { chromeTextIsFocused, createWebPanePriority } from '../webpane/priority';
import { TerminalShortcutContext, type TerminalShortcutHost } from './terminal-shortcuts';

const NATIVE_CHORDS = new Set([
    '8/KeyL', '8/KeyR', '8/ArrowLeft', '8/ArrowRight', '8/KeyT', '8/KeyW',
    '12/BracketLeft', '12/BracketRight', '8/Equal', '12/Equal', '8/Minus', '8/Digit0',
]);
const BROWSER_ACTIONS = new Set<KelpiAction>([
    'web_focus_url_bar', 'web_back', 'web_forward', 'web_reload', 'web_tab_new', 'web_tab_close',
    'web_tab_prev', 'web_tab_next', 'web_zoom_in', 'web_zoom_out', 'web_zoom_reset', 'toggle_search', 'close_pane',
]);
const EDITING_ACTIONS = new Set<KelpiAction>(['copy', 'paste', 'kill_line_backward', 'move_to_line_start', 'move_to_line_end']);
const DEFAULT_HOST: TerminalShortcutHost = { bindings: clientKeyBindings() };

/** Keep HTML input editing in its iframe; native browser priority still owns its fixed chords. */
export function browserShortcutChords(host: TerminalShortcutHost, existing: readonly string[] = host.windowChords ?? []): string[] {
    const editing = new Set([...host.bindings.values()].filter(binding => EDITING_ACTIONS.has(binding.action)).flatMap(binding => chordKeysForTrigger(binding.trigger)));
    const browser = [...host.bindings.values()].filter(binding => BROWSER_ACTIONS.has(binding.action)).flatMap(binding => chordKeysForTrigger(binding.trigger));
    const reserved = new Set(host.globalHotkey ? chordKeysForTrigger(host.globalHotkey) : []);
    return [...new Set([...existing.filter(chord => !editing.has(chord)), ...NATIVE_CHORDS, ...browser])]
        .filter(chord => !reserved.has(chord)).sort();
}

export interface BrowserShortcutOptions {
    readonly runtime: KelpiRuntime;
    readonly paneID: string;
    readonly commands: WebPaneCommands;
    readonly visible: boolean;
    readonly claimedChords?: readonly string[] | undefined;
    readonly focusAddress: () => void | Promise<void>;
    readonly showFind: () => void | Promise<void>;
}

/** Browser operations always address the view's owning runtime, including a remote pane. */
export function dispatchBrowserShortcut(event: KeyEventLike, options: BrowserShortcutOptions & { readonly host: TerminalShortcutHost; readonly nativeChrome?: boolean }): boolean {
    const { host, runtime, paneID, commands } = options;
    const trigger = triggerFromEvent(event);
    if (!trigger) return false;
    const action = actionForTrigger(host.bindings, trigger);
    const native = chordKeysForTrigger(trigger).some(chord => NATIVE_CHORDS.has(chord));
    if (!native && (!action || !BROWSER_ACTIONS.has(action))) return false;
    // A stale or covered frame must not fall through into the primary daemon's focus.
    if (!options.visible || host.blocked?.() || modalPresenceCount() > 0
        || (host.globalHotkey && keyTriggerKey(trigger) === keyTriggerKey(host.globalHotkey))) return true;
    const owner = () => {
        const workspace = runtime.store.getState().daemon.state.workspaces.find(value => value.panes.some(pane => pane.id === paneID && pane.type === 'web'));
        if (!workspace) return null;
        const web = workspace.webPanes[paneID], tabs = web?.tabs ?? [];
        const active = tabs.find(tab => tab.id === web?.activeTabID) ?? tabs[0] ?? null;
        return { paneID, workspaceID: workspace.id, tabs, tabID: active?.id ?? null, tabCount: tabs.length };
    };
    if (!owner()) return true;
    const report = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        if (host.onError) host.onError('Browser', message);
        else runtime.store.getState().pushToast({ id: `browser-${paneID}`, kind: 'info', title: 'Browser', body: message,
            paneID, workspaceID: owner()?.workspaceID ?? null, createdAt: Date.now() });
    };
    const run = (operation: () => Promise<CommandReply> | Promise<void> | void): void => {
        try {
            void Promise.resolve(operation()).then(reply => { if (reply !== undefined && !isOkReply(reply)) throw new Error(replyError(reply)); }).catch(report);
        } catch (error) { report(error); }
    };
    const cycleTab = (offset: number): void => {
        const pane = owner();
        if (!pane || pane.tabs.length < 2) return;
        const at = Math.max(0, pane.tabs.findIndex(tab => tab.id === pane.tabID));
        const next = pane.tabs[(at + offset + pane.tabs.length) % pane.tabs.length];
        if (next) run(() => commands.selectTab(paneID, next.id));
    };
    const zoom = (direction: 'in' | 'out' | 'reset'): void => {
        const tabID = owner()?.tabID;
        if (tabID) run(() => commands.zoom(paneID, tabID, direction));
    };
    const priority = createWebPanePriority({
        focusedWebPane: owner,
        isChromeTextEditing: () => chromeTextIsFocused(typeof document === 'undefined' ? null : document.activeElement),
        focusURLBar: () => run(options.focusAddress),
        reload: () => run(() => commands.reload(paneID)),
        back: () => run(() => commands.back(paneID)),
        forward: () => run(() => commands.forward(paneID)),
        newTab: () => run(() => commands.newTab(paneID)),
        closeTab: (_paneID, tabID) => run(() => commands.closeTab(paneID, tabID)),
        cycleTab: (_paneID, offset) => cycleTab(offset),
        zoom: (_paneID, direction) => zoom(direction),
    });
    const handled = priority(trigger, event);
    // The SDK leaves native HTML editing chords untouched before relaying. If a
    // delayed action reaches a now-editing frame, do not reinterpret it globally.
    if (handled !== null) return handled === false && options.nativeChrome ? false : true;
    switch (action) {
        case 'web_focus_url_bar': run(options.focusAddress); return true;
        case 'web_back': run(() => commands.back(paneID)); return true;
        case 'web_forward': run(() => commands.forward(paneID)); return true;
        case 'web_reload': run(() => commands.reload(paneID)); return true;
        case 'web_tab_new': run(() => commands.newTab(paneID)); return true;
        case 'web_tab_close': {
            const pane = owner();
            if (pane && pane.tabCount > 1 && pane.tabID) run(() => commands.closeTab(paneID, pane.tabID!));
            else run(() => runtime.commands.closePane({ paneID }));
            return true;
        }
        case 'close_pane': run(() => runtime.commands.closePane({ paneID })); return true;
        case 'web_tab_prev': cycleTab(-1); return true;
        case 'web_tab_next': cycleTab(1); return true;
        case 'web_zoom_in': zoom('in'); return true;
        case 'web_zoom_out': zoom('out'); return true;
        case 'web_zoom_reset': zoom('reset'); return true;
        case 'toggle_search': run(options.showFind); return true;
        default: return false;
    }
}

export function useBrowserShortcuts(options: BrowserShortcutOptions) {
    const host = useContext(TerminalShortcutContext) ?? DEFAULT_HOST;
    return { chords: browserShortcutChords(host, options.claimedChords),
        onKey: (event: KeyEventLike) => dispatchBrowserShortcut(event, { ...options, host }),
        onNativeKey: (event: KeyEventLike) => dispatchBrowserShortcut(event, { ...options, host, nativeChrome: true }) };
}
