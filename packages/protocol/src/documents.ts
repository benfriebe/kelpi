/** A daemon-owned native document, independent of its selected renderer. */
export interface DocumentSnapshot {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly kind: 'markdown' | 'scratchpad' | 'diff' | 'csv';
    readonly mode: 'view' | 'edit';
    readonly path: string | null;
    readonly text: string;
    readonly loaded: boolean;
    readonly dirty: boolean;
    readonly error: string | null;
    /** Opaque incarnation/revision token. A reopened document has a different incarnation. */
    readonly revision: string;
    /**
     * #324: a csv document's `text` is its raw source only in raw-text mode (⌘E), and is cut
     * (with this flag set) when it would not fit the plugin JSON cap. Use the `csv*` calls for
     * rows. Absent for every other kind.
     */
    readonly truncated?: boolean;
}
