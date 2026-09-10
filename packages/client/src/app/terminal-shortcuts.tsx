import { createContext, useContext } from 'react';
import { MENU_BAR_ACTIONS, actionForTrigger, keyTriggerKey, type KeyBindingMap, type KeyTrigger, type KelpiAction } from '@kelpi/core/config';
import { clientKeyBindings, triggerFromEvent, type KeyEventLike } from '../chrome/keys';
import { modalPresenceCount } from '../chrome/modal-presence';
import { chordKeysForTrigger } from '../content/bridge';
import { isOkReply, replyError } from '../connection';
import type { KelpiRuntime } from '../state';
import { paneHandle } from '../terminal/pane-registry';
import { copySelection, deferredClipboardWriter } from './clipboard';
import { LINE_EDIT_BYTES } from './line-editing';

const EDITING_ACTIONS = new Set<KelpiAction>(['copy', 'paste', 'kill_line_backward', 'move_to_line_start', 'move_to_line_end']);
export interface TerminalShortcutHost {
    readonly bindings: KeyBindingMap;
    readonly windowChords?: readonly string[] | undefined;
    readonly blocked?: (() => boolean) | undefined;
    readonly globalHotkey?: KeyTrigger | null | undefined;
    readonly onError?: ((title: string, message: string) => void) | undefined;
}
/** A remote terminal uses this window's bindings and clipboard, with its own daemon target. */
export const TerminalShortcutContext = createContext<TerminalShortcutHost | null>(null);
const DEFAULT_HOST: TerminalShortcutHost = { bindings: clientKeyBindings() };

/** Relay host menu actions; the existing window dispatcher retains its remote/modal guards. */
export function terminalWindowChords(bindings: KeyBindingMap): string[] {
    return [...new Set(['8/Comma', '8/Slash', '12/Slash', ...[...bindings.values()]
        .filter(binding => MENU_BAR_ACTIONS.has(binding.action)).flatMap(binding => chordKeysForTrigger(binding.trigger))])].sort();
}

export function terminalShortcutChords(host: TerminalShortcutHost, existing: readonly string[] = host.windowChords ?? []): string[] {
    const editing = [...host.bindings.values()].filter(binding => EDITING_ACTIONS.has(binding.action) &&
        (!host.globalHotkey || keyTriggerKey(binding.trigger) !== keyTriggerKey(host.globalHotkey)));
    const reserved = new Set(host.globalHotkey ? chordKeysForTrigger(host.globalHotkey) : []);
    return [...new Set([...existing, ...editing.flatMap(binding => chordKeysForTrigger(binding.trigger))])].filter(chord => !reserved.has(chord)).sort();
}

const ownedPane = (runtime: KelpiRuntime, paneID: string) => runtime.store.getState().daemon.state.workspaces
    .flatMap(workspace => workspace.panes).find(pane => pane.id === paneID);
const isTerminal = (pane: ReturnType<typeof ownedPane>): boolean => pane !== undefined && (pane.type === 'shell' || pane.externalEditorCommand != null);

/** Preserve native paste's text-then-PNG priority, always over the pane's owning connection. */
async function pasteIntoOwner(runtime: KelpiRuntime, paneID: string, clipboard: Clipboard | undefined): Promise<void> {
    const original = ownedPane(runtime, paneID);
    if (!isTerminal(original)) return;
    const stillOwned = (): boolean => {
        const pane = ownedPane(runtime, paneID);
        return isTerminal(pane) && pane?.createdAt === original?.createdAt && pane?.type === original?.type && pane?.externalEditorCommand === original?.externalEditorCommand;
    };
    if (!clipboard || typeof clipboard.readText !== 'function') throw new Error('this browser exposes no clipboard');
    const text = await clipboard.readText();
    if (!stillOwned()) return;
    if (text) {
        const reply = await runtime.commands.dropText({ paneID, text });
        if (!isOkReply(reply)) throw new Error(replyError(reply));
        return;
    }
    if (typeof clipboard.read !== 'function') return;
    let image: Blob | undefined;
    try {
        for (const item of await clipboard.read()) if (item.types.includes('image/png')) { image = await item.getType('image/png'); break; }
    } catch { return; } // An empty or unreadable non-text clipboard types nothing.
    if (!image) return;
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (!stillOwned()) return;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const reply = await runtime.commands.pasteImage({ paneID, data: btoa(binary) });
    if (!isOkReply(reply)) throw new Error(replyError(reply));
}

export function dispatchTerminalEditingShortcut(event: KeyEventLike, options: {
    runtime: KelpiRuntime; paneID: string; visible: boolean; host: TerminalShortcutHost;
    clipboard?: Clipboard | undefined;
}): boolean {
    const { runtime, paneID, host } = options;
    const trigger = triggerFromEvent(event), action = trigger && actionForTrigger(host.bindings, trigger);
    if (!action || !EDITING_ACTIONS.has(action)) return false;
    // An expired/hidden renderer's editing chord must never fall through to primary focus.
    if (!options.visible || host.blocked?.() || modalPresenceCount() > 0 ||
        (host.globalHotkey && trigger && keyTriggerKey(trigger) === keyTriggerKey(host.globalHotkey))) return true;
    const handle = paneHandle(paneID);
    const original = ownedPane(runtime, paneID);
    if (!handle || !isTerminal(original)) return true;
    const report = (title: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        if (host.onError) host.onError(title, message);
        else runtime.store.getState().pushToast({ id: `terminal-${paneID}`, kind: 'info', title, body: message, paneID, workspaceID: null, createdAt: Date.now() });
    };
    const clipboard = options.clipboard ?? navigator.clipboard;
    if (action === 'copy') {
        const interruptKey = event.code === 'KeyC' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
            ? { key: 'key' in event && typeof event.key === 'string' ? event.key : 'c', code: event.code, ctrlKey: true }
            : null;
        const selected = (text: string): string => {
            // Off macOS, empty-selection Ctrl+C falls through to the terminal's own encoder.
            // The iframe already relayed that physical key, so return it only to the same live
            // renderer after its selection reply. Empty Cmd+C remains a quiet copy attempt.
            const current = ownedPane(runtime, paneID);
            if (text === '' && interruptKey && paneHandle(paneID) === handle && handle.focusedOnScreen() &&
                !host.blocked?.() && modalPresenceCount() === 0 && isTerminal(current) &&
                current?.createdAt === original?.createdAt && current?.type === original?.type &&
                current?.externalEditorCommand === original?.externalEditorCommand) handle.dispatchKey(interruptKey);
            return text;
        };
        copySelection({ focusedPaneID: () => paneID,
            selectionFor: () => {
                const selection = handle.readSelection ? handle.readSelection() : handle.selection();
                return typeof selection === 'string' ? selected(selection) : selection.then(selected);
            },
            writeText: typeof clipboard?.writeText === 'function' ? text => clipboard.writeText(text) : null,
            writePendingText: deferredClipboardWriter(clipboard), onError: message => report('Copy', message) });
    } else if (action === 'paste') void pasteIntoOwner(runtime, paneID, clipboard).catch(error => report('Paste', error));
    else { const bytes = LINE_EDIT_BYTES[action]; if (bytes !== undefined) handle.write(bytes); }
    return true;
}

export function useTerminalShortcuts(runtime: KelpiRuntime, paneID: string, visible: boolean, existing?: readonly string[]) {
    const host = useContext(TerminalShortcutContext) ?? DEFAULT_HOST;
    return { chords: terminalShortcutChords(host, existing),
        onKey: (event: KeyEventLike) => dispatchTerminalEditingShortcut(event, { runtime, paneID, visible, host }) };
}
