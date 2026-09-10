/** The daemon owns tabs and sessions; the host owns their native page views. */
export interface BrowserHostSnapshot {
    readonly available: boolean;
    readonly id: string | null;
    readonly name: string | null;
    /** Only the UI inside this window can display the native page. */
    readonly windowID: string | null;
}

export interface BrowserTabSnapshot {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly live: boolean;
    readonly loading: boolean;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
}

export interface BrowserFavourite {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly label: string;
    readonly createdAt: string;
}

/** Small live inspector metadata; read batch.state/inspectResult when revision changes. */
export interface BrowserInspectionSnapshot {
    readonly revision: number;
    readonly armed: boolean;
    readonly tabID: string | null;
    readonly pendingResults: number;
    readonly batchVisible: boolean;
    readonly batchItems: number;
    readonly batchFocusedID: string | null;
}

/** A browser's current state, independent of its selected chrome renderer. */
export interface BrowserSnapshot {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly isPrivate: boolean;
    readonly activeTabID: string | null;
    readonly tabs: readonly BrowserTabSnapshot[];
    readonly host: BrowserHostSnapshot;
    readonly favourites: readonly BrowserFavourite[];
    /** Includes native picker results and edits even when tabs/navigation are unchanged. */
    readonly inspection: BrowserInspectionSnapshot;
}
