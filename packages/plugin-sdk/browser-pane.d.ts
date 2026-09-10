import type { Json } from './index.js';

/** A native page belongs to one daemon and its currently registered Electron host. */
export interface BrowserSnapshot {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly isPrivate: boolean;
    readonly activeTabID: string | null;
    readonly tabs: readonly BrowserTab[];
    readonly host: { readonly available: boolean; readonly id: string | null; readonly name: string | null; readonly windowID: string | null };
    readonly favourites: readonly BrowserFavourite[];
    readonly inspection: BrowserInspection;
}
/** Bounded picker metadata. A revision change invalidates batch.state() and inspectResult(). */
export interface BrowserInspection {
    readonly revision: number;
    readonly armed: boolean;
    readonly tabID: string | null;
    readonly pendingResults: number;
    readonly batchVisible: boolean;
    readonly batchItems: number;
    readonly batchFocusedID: string | null;
}
export interface BrowserTab {
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
    /** ISO-8601 creation time. */
    readonly createdAt: string;
    readonly label: string;
}
export interface BrowserOperationResult {
    readonly paneID: string;
    readonly workspaceID?: string;
    readonly tabID?: string;
    readonly url?: string;
}
export interface BrowserTabTarget { readonly tabID?: string }
export type BrowserCaptureMode = 'meta' | 'text' | 'screenshot' | 'dom' | 'all';
export interface BrowserCaptureResult extends BrowserOperationResult {
    readonly mode: BrowserCaptureMode;
    readonly title?: string;
    readonly byteCount?: number;
    readonly text?: string;
    readonly html?: string;
    readonly path?: string;
    readonly pngBase64?: string;
}
export interface BrowserInspectResult {
    readonly tabID?: string;
    readonly selector: string;
    readonly xpath?: string;
    readonly tag: string;
    readonly id?: string;
    readonly outerHtml?: string;
    /** Page-owned attribute names are preserved verbatim. */
    readonly attributes?: Readonly<Record<string, string>>;
    readonly rect?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    readonly text?: string;
    readonly contextHtml?: string;
    readonly url: string;
    readonly capturedAt?: string;
    readonly comment?: string;
}
export type BrowserInspectReply = BrowserOperationResult &
    ({ readonly armed: false } | { readonly armed: true; readonly sendTo: string; readonly submit: boolean });
export interface BrowserCookie {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path?: string;
    readonly isSecure?: boolean;
    readonly isHttpOnly?: boolean;
    /** Unix seconds; session cookies may omit this. */
    readonly expires?: number;
}
export interface BrowserCookieWrite {
    readonly name: string; readonly value: string; readonly domain: string; readonly path: string;
    readonly isSecure: boolean; readonly isHttpOnly: boolean; readonly expires?: number;
}
export interface BrowserBatchItem {
    readonly id: string;
    readonly selector: string;
    readonly tag: string;
    readonly text: string;
    readonly url: string;
    readonly comment: string;
}
export interface BrowserBatch {
    readonly visible: boolean;
    readonly focusedID: string | null;
    readonly lastTarget: string | null;
    readonly submit: boolean;
    readonly items: readonly BrowserBatchItem[];
}
export interface BrowserBatchResult extends BrowserOperationResult {
    readonly batch: BrowserBatch | null;
    readonly armed?: boolean;
    readonly toggled?: 'started' | 'shown' | 'hidden';
    readonly sent?: number;
    readonly sendTo?: string;
}
export interface BrowserAPI {
    get(paneID?: string): Promise<BrowserSnapshot>;
    /** Subscribe to browser.changed / browser.closed before watching. Changed invalidates state; call get for the latest snapshot. */
    watch(paneID?: string): Promise<{ subscription: string; state: BrowserSnapshot }>;
    unwatch(subscription: string): Promise<void>;
    navigate(paneID: string, url: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    url(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult & { readonly url: string; readonly title: string }>;
    back(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    forward(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    reload(paneID: string, options?: BrowserTabTarget & { readonly hard?: boolean }): Promise<BrowserOperationResult>;
    stop(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    /** Focus the owning native page. Use a view's attached surface.focus() for local chrome handoff. */
    focus(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    blur(paneID: string): Promise<BrowserOperationResult>;
    toggleDevTools(paneID: string, options?: BrowserTabTarget): Promise<BrowserOperationResult>;
    tabs: {
        open(paneID: string, url?: string, options?: { readonly makeActive?: boolean }): Promise<BrowserOperationResult & { readonly tabID: string; readonly active: boolean }>;
        select(paneID: string, tabID: string): Promise<BrowserOperationResult>;
        close(paneID: string, tabID: string): Promise<BrowserOperationResult>;
        reorder(paneID: string, order: readonly string[]): Promise<BrowserOperationResult>;
    };
    /** Native views are rebuilt against the other cookie store; existing page JS state does not survive this explicit operation. */
    setPrivate(paneID: string, isPrivate: boolean): Promise<BrowserOperationResult & { readonly private: boolean; readonly changed: boolean }>;
    find(paneID: string, tabID: string, action: 'search' | 'next' | 'prev' | 'clear', needle?: string): Promise<BrowserOperationResult & { readonly total: number; readonly current: number }>;
    zoom(paneID: string, tabID: string, direction: 'in' | 'out' | 'reset'): Promise<BrowserOperationResult & { readonly zoom: number }>;
    favourites: {
        list(): Promise<readonly BrowserFavourite[]>;
        toggle(url: string, title?: string): Promise<{ readonly favourites: readonly BrowserFavourite[]; readonly added: boolean; readonly favouriteID?: string }>;
        remove(id: string): Promise<{ readonly favourites: readonly BrowserFavourite[] }>;
        rename(id: string, title: string): Promise<{ readonly favourites: readonly BrowserFavourite[] }>;
        move(from: number, to: number): Promise<{ readonly favourites: readonly BrowserFavourite[] }>;
    };
    /** Uses the existing native capture modes and 256 KiB plugin JSON reply limit. */
    capture(paneID: string, options?: BrowserTabTarget & { readonly mode?: BrowserCaptureMode }): Promise<BrowserCaptureResult>;
    inspect(paneID: string, options?: BrowserTabTarget & { readonly disarm?: boolean; readonly sendTo?: string; readonly submit?: boolean }): Promise<BrowserInspectReply>;
    inspectResult(paneID: string, options?: { readonly clear?: boolean }): Promise<readonly BrowserInspectResult[]>;
    /** Evaluated page data, including arbitrary object keys, is returned unchanged. */
    exec<T = Json>(paneID: string, script: string, options?: BrowserTabTarget): Promise<BrowserOperationResult & { readonly result: T }>;
    console(paneID: string, options?: { readonly since?: number; readonly level?: 'log' | 'debug' | 'info' | 'warn' | 'error'; readonly clear?: boolean }): Promise<BrowserOperationResult & { readonly lines: readonly { readonly seq: number; readonly level: string; readonly message: string }[]; readonly dropped?: number; readonly nextSince?: number }>;
    cookies: {
        list(paneID: string): Promise<readonly BrowserCookie[]>;
        clear(paneID: string, options?: { readonly all?: boolean; readonly domain?: string }): Promise<BrowserOperationResult & { readonly deleted: number; readonly clearedSiteData?: boolean }>;
        delete(paneID: string, name: string, options?: { readonly domain?: string }): Promise<BrowserOperationResult & { readonly deleted: number }>;
        set(paneID: string, cookie: BrowserCookieWrite, options?: { readonly original?: { readonly name: string; readonly domain: string; readonly path?: string } }): Promise<BrowserOperationResult>;
    };
    batch: {
        state(paneID: string): Promise<BrowserBatchResult>;
        toggle(paneID: string): Promise<BrowserBatchResult>;
        cancel(paneID: string): Promise<BrowserBatchResult>;
        remove(paneID: string, itemID: string): Promise<BrowserBatchResult>;
        comment(paneID: string, itemID: string, comment: string, options?: BrowserTabTarget): Promise<BrowserBatchResult>;
        focus(paneID: string, itemID: string | null, origin: 'panel' | 'page'): Promise<BrowserBatchResult>;
        send(paneID: string, sendTo: string | null): Promise<BrowserBatchResult>;
    };
}

/** Presentation is local to this granted view. A remote daemon may have a host without a displayable page in this window. */
export interface BrowserPresentation {
    readonly available: boolean;
    readonly reason?: string;
    readonly visible: boolean;
    readonly focused: boolean;
}
export type BrowserAction = { readonly type: 'focusAddress' | 'showFind' | 'focus' };
/** HTMLElement in a DOM authoring project; absent in a daemon-only TypeScript project. */
export type BrowserSurfaceElement = typeof globalThis extends { HTMLElement: { prototype: infer Element } } ? Element : never;
export interface BrowserAttachOptions {
    /** A real slot in this iframe. Kelpi measures and clips it; callers never supply pane/window IDs or native bounds. */
    readonly element: BrowserSurfaceElement;
    /** Bounded initial/latest delivery. Throwing fails the view and restores bundled chrome. Never await attach() from this callback. */
    readonly onPresentation: (value: BrowserPresentation) => void | Promise<void>;
    /** Window shortcuts and native focus gestures. Return void/null; rejections fail only the action. */
    readonly onAction?: (action: BrowserAction) => void | null | Promise<void | null>;
}
export interface BrowserSurface {
    readonly id: string;
    /** Hide the native page and its host card while drawing menus or other UI over the slot. */
    setCovered(covered: boolean): void;
    /** Blur plugin text input and hand focus to this visible, uncovered native page. */
    focus(): void;
    /** Idempotent. Removes geometry and observers without closing tabs or clearing page/session state. */
    dispose(): void;
}
export interface ViewBrowserAPI extends BrowserAPI {
    /** Available only in the selected browser replacement. One active or attaching surface per iframe. */
    attach(options: BrowserAttachOptions): Promise<BrowserSurface>;
}
