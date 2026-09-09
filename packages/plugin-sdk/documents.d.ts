/** Source and save state of a native document on the plugin's owning daemon. */
export interface DocumentSnapshot {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly kind: 'markdown' | 'scratchpad' | 'diff';
    readonly mode: 'view' | 'edit';
    readonly path: string | null;
    readonly text: string;
    readonly loaded: boolean;
    readonly dirty: boolean;
    readonly error: string | null;
    /** Opaque token; changes and reopened documents invalidate retained edits. */
    readonly revision: string;
}
export interface DocumentsAPI {
    get(paneID?: string): Promise<DocumentSnapshot>;
    edit(paneID: string, text: string, revision: string): Promise<DocumentSnapshot>;
    save(paneID: string, revision: string): Promise<DocumentSnapshot>;
    setMode(paneID: string, mode: 'view' | 'edit', revision: string): Promise<DocumentSnapshot>;
    refresh(paneID: string, revision: string): Promise<DocumentSnapshot>;
    /** Listen to documents.changed / documents.closed events before attaching. Changed is an invalidation; call get for latest state. */
    watch(paneID?: string): Promise<{ subscription: string; state: DocumentSnapshot }>;
    unwatch(subscription: string): Promise<void>;
}
/** Drafts belong to this browser window and document pane. Available only in document renderers. */
export interface ViewDocumentsAPI extends DocumentsAPI {
    /** Persist every input before queueing daemon edits, so a reloaded/failed view can recover it. */
    stage(text: string, revision: string): Promise<{ id: string }>;
    /** Apply an exact staged draft with an explicit revision. A newer stage rejects a superseded ID. */
    applyDraft(id: string, revision: string): Promise<DocumentSnapshot>;
}
