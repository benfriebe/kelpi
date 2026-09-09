import { useSyncExternalStore } from 'react';
import { pluginRecord, type JsonObject, type JsonValue } from '@kelpi/protocol';
import type { DocumentSnapshot } from '../../../plugin-sdk/documents';
import type { KelpiRuntime } from '../state';
import { getPluginDaemonID, pluginRequest } from './client';
import type { ContentApi } from '../content/client';

export interface DocumentDraft {
    readonly text: string; readonly revision: string; readonly viewID: string;
    readonly id: string; readonly session: string; readonly error?: string; readonly volatile?: boolean;
    readonly applied?: boolean; readonly nativeRevision?: number | undefined;
}
const session = crypto.randomUUID();
const windowID = (() => {
    try {
        const key = 'kelpi.document.window.v1', existing = sessionStorage.getItem(key);
        if (existing) return existing;
        const id = crypto.randomUUID(); sessionStorage.setItem(key, id); return id;
    } catch { return crypto.randomUUID(); }
})();
const cache = new Map<string, DocumentDraft | null>();
const listeners = new Set<() => void>();
const pending = new WeakMap<KelpiRuntime, Map<string, Set<Promise<unknown>>>>();
const keys = (runtime: KelpiRuntime, paneID: string): string[] => [...new Set([getPluginDaemonID(runtime), new URL(runtime.connection.target).origin].filter(Boolean))]
    .map(owner => `kelpi.document.draft.v1:${owner}:${windowID}:${paneID}`);
const notify = (): void => { for (const listener of listeners) listener(); };
function read(key: string): DocumentDraft | null {
    if (cache.has(key)) return cache.get(key) ?? null;
    let result: DocumentDraft | null = null;
    try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (pluginRecord(value) && typeof value['text'] === 'string' && typeof value['revision'] === 'string' && typeof value['viewID'] === 'string' && typeof value['id'] === 'string' && typeof value['session'] === 'string') result = value as unknown as DocumentDraft;
    } catch { /* No usable recovery record. */ }
    cache.set(key, result); return result;
}
export function getDocumentDraft(runtime: KelpiRuntime, paneID: string): DocumentDraft | null {
    return keys(runtime, paneID).map(read).find(Boolean) ?? null;
}
export function stageDocumentDraft(runtime: KelpiRuntime, paneID: string, text: string, revision: string, viewID: string, nativeRevision?: number): DocumentDraft {
    const draft = { text, revision, viewID, session, id: crypto.randomUUID(), ...(nativeRevision === undefined ? {} : { nativeRevision }) };
    const key = keys(runtime, paneID)[0]!;
    // A view may disappear before its edit RPC completes. Persist before sending the edit.
    try { localStorage.setItem(key, JSON.stringify(draft)); }
    catch {
        const message = 'Recovery storage is unavailable. These edits are only held in this window until saved.';
        cache.set(key, { ...draft, error: message, volatile: true }); notify();
        throw new Error(message);
    }
    cache.set(key, draft);
    for (const old of keys(runtime, paneID).filter(candidate => candidate !== key)) { localStorage.removeItem(old); cache.set(old, null); }
    notify(); return draft;
}
export function clearDocumentDraft(runtime: KelpiRuntime, paneID: string, id?: string): void {
    for (const key of keys(runtime, paneID)) if (id === undefined || read(key)?.id === id) {
        try { localStorage.removeItem(key); } catch { /* In-memory recovery still works when storage is unavailable. */ }
        cache.set(key, null);
    }
    notify();
}
export function useDocumentDraft(runtime: KelpiRuntime, paneID: string): DocumentDraft | null {
    return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => getDocumentDraft(runtime, paneID), () => null);
}
export const isRecoveredDocumentDraft = (draft: DocumentDraft): boolean => draft.session !== session;
export async function documentRequest(runtime: KelpiRuntime, method: string, args: JsonObject): Promise<DocumentSnapshot> {
    return await pluginRequest(runtime, 'document', { method, args }) as unknown as DocumentSnapshot;
}
export async function runDocumentEdit(runtime: KelpiRuntime, paneID: string, text: string, revision: string, viewID: string, invoke: () => Promise<JsonValue>, staged?: DocumentDraft): Promise<JsonValue> {
    const draft = staged ?? stageDocumentDraft(runtime, paneID, text, revision, viewID);
    const byPane = pending.get(runtime) ?? new Map<string, Set<Promise<unknown>>>(); pending.set(runtime, byPane);
    const calls = byPane.get(paneID) ?? new Set<Promise<unknown>>(); byPane.set(paneID, calls);
    const request = invoke(); calls.add(request);
    try {
        const result = await request;
        if (getDocumentDraft(runtime, paneID)?.id === draft.id && pluginRecord(result) && result['text'] === draft.text) {
            const key = keys(runtime, paneID)[0]!, applied = { ...draft, applied: true };
            try { localStorage.setItem(key, JSON.stringify(applied)); } catch { /* The original source is already persisted. */ }
            cache.set(key, applied); notify();
        }
        return result;
    }
    catch (error) {
        if (getDocumentDraft(runtime, paneID)?.id === draft.id) {
            const key = keys(runtime, paneID)[0]!, failed = { ...draft, error: error instanceof Error ? error.message : String(error) };
            try { localStorage.setItem(key, JSON.stringify(failed)); } catch { /* The original draft is already persisted. */ }
            cache.set(key, failed); notify();
        }
        throw error;
    } finally { calls.delete(request); if (!calls.size) byPane.delete(paneID); }
}
/** Called before removing a view/pane. An ambiguous or rejected write stays recoverable. */
export async function prepareDocumentViewsClose(runtime: KelpiRuntime, paneIDs: readonly string[]): Promise<void> {
    for (const paneID of paneIDs) {
        await Promise.allSettled([...(pending.get(runtime)?.get(paneID) ?? [])]);
        const draft = getDocumentDraft(runtime, paneID); if (!draft) continue;
        const current = await documentRequest(runtime, 'get', { paneID });
        if (current.text !== draft.text) throw new Error('Document has unapplied local edits. Restore or discard the recovery draft before closing.');
        const saved = await documentRequest(runtime, 'save', { paneID, revision: current.revision });
        const latest = getDocumentDraft(runtime, paneID);
        if ((latest && latest.id !== draft.id) || saved.text !== draft.text) throw new Error('Document changed while preparing to close. Save the latest edits before closing.');
        if (saved.dirty) throw new Error(saved.error ?? 'Document could not be saved.');
        clearDocumentDraft(runtime, paneID, draft.id);
    }
}
export function registerDocumentCloseGuard(runtime: KelpiRuntime, content: ContentApi, onlyPaneID?: string): () => void {
    return runtime.commands.registerCloseGuard(payload => {
        let command = payload;
        // Plugin commands use the same window transport, inside the existing API envelope.
        if (payload['command'] === 'plugin' && payload['action'] === 'api' && typeof payload['text'] === 'string') {
            try { const input: unknown = JSON.parse(payload['text']); if (pluginRecord(input) && input['method'] === 'command' && pluginRecord(input['args']) && pluginRecord(input['args']['payload'])) command = input['args']['payload'] as JsonObject; } catch { return; }
        }
        const cascade = command['command'] === 'group-delete' && command['cascade'] === true;
        if (!cascade && !['pane-close', 'workspace-delete', 'delete-workspace'].includes(String(command['command']))) return;
        const current = runtime.store.getState(), workspaces = current.daemon.state.workspaces;
        const workspace = cascade ? undefined : command['workspace_id'] ?? command['workspace'] ?? command['name'];
        const nameOrID = (id: string, name: string, value: unknown): boolean => typeof value === 'string' && (id.toUpperCase() === value.toUpperCase() || name === value);
        const members = cascade ? current.daemon.state.groups.find(group => nameOrID(group.id, group.name, command['name']))?.childOrder ?? [] : null;
        const paneTarget = command['target'] ?? command['pane_id'];
        const ids = workspaces.filter(row => (!members || members.includes(row.id)) && (workspace === undefined || nameOrID(row.id, row.name, workspace))).flatMap(row => [...row.panes, ...row.parkedPanes].filter(pane => {
            if (onlyPaneID && pane.id !== onlyPaneID) return false;
            if (!['markdown', 'scratchpad', 'diff'].includes(pane.type)) return false;
            return command['command'] !== 'pane-close' || nameOrID(pane.id, pane.label ?? '', paneTarget) || (paneTarget === undefined && row.id === current.ui.activeWorkspaceID && pane.id === row.focusedPaneID);
        }).map(pane => pane.id));
        if (!ids.length) return;
        return (async () => { for (const id of ids) await content.flush(id); await prepareDocumentViewsClose(runtime, ids); })();
    });
}
