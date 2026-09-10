/** A daemon-owned native document, independent of its selected renderer. */
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
    /** Opaque incarnation/revision token. A reopened document has a different incarnation. */
    readonly revision: string;
}
