/**
 * One web-pane tab: an Electron `WebContentsView` plus its CDP session.
 *
 * This is the only module in the host that touches Electron, and it is where every "port note"
 * in `docs/current/web-pane.md` lands:
 *
 *   - **Injection** is `Page.addScriptToEvaluateOnNewDocument`, which runs in *all* frames, so
 *     the scripts carry their own `window !== window.top` guards (`./scripts.ts`). The same
 *     sources are also evaluated once against the *current* document, because
 *     `addScriptToEvaluateOnNewDocument` only applies to documents created after the call.
 *   - **Host↔page messaging** is `Runtime.addBinding('nexPost')` + the bridge shim, and the
 *     main-frame check the Swift host got for free from `WKScriptMessage.frameInfo` is
 *     reconstructed here from `Runtime.executionContextCreated` (context → frame) plus
 *     `Page.frameNavigated` (which frame is the main one).
 *   - **Evaluation** is `Runtime.evaluate {awaitPromise:true, returnByValue:true}` — `__nexAct.wait`
 *     returns a Promise and a plain evaluate would serialise it as `{}` (§8.2's bug class).
 *   - **Console** is the CDP branch (`Runtime.consoleAPICalled` / `exceptionThrown`,
 *     `Log.entryAdded`, `Network.loadingFailed` / `responseReceived`) formatted by
 *     `./console-format.ts` into the spec's own message strings.
 *   - **Background tabs keep running JS** (`backgroundThrottling: false`): agents race a `wait`
 *     in one tab while another is the visible one.
 *   - **`did-fail-load` ignores `-3` (ERR_ABORTED)**: a navigation the user (or a redirect)
 *     replaced is not a failure, and WKWebView never surfaced those either.
 *
 * ## v1 is an automation surface, not a rendered pane
 *
 * The views are created **hidden**: they are parented to an off-screen holder window that is
 * never shown, sized to a fixed viewport, so every non-visual verb (`navigate`, `capture`,
 * `exec`, the whole actuator surface) works against the real engine while the client still draws
 * a placeholder card for web panes. Visual embedding — re-parenting these same views into the
 * main window at the pane's rect — is the documented follow-up and touches nothing below except
 * `setBounds` / which window owns the view.
 *
 * The holder window is what gives the views a place to live; `Emulation.setDeviceMetricsOverride`
 * then pins their viewport, so layout (`innerText`, `getBoundingClientRect`) and screenshots are
 * the same 1280×800 regardless of the holder. Measured on Electron 43/macOS: a view in a window
 * that is never shown still lays out and still screenshots, including while it is the hidden
 * background tab of a pane — which is the whole premise of the headless surface.
 *
 * ## `webSecurity` stays ON
 *
 * The spec asks for a deliberate decision (port notes, "file:// loading"). We keep
 * `webSecurity: true`: Chromium already lets a `file://` document load *sibling subresources*
 * (`<img>`, `<script>`, `<link>`), which is the feature the spec cares about, so disabling web
 * security would buy only `fetch`/`XHR` between local files — at the cost of turning every page
 * an agent visits into a same-origin-free environment. The narrow gap (a local page that
 * `fetch()`es a sibling file) is a documented limitation, not an accident.
 */

import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';

import { log, warn } from '../log.js';
import {
    formatConsoleApiCall,
    formatErrorResponse,
    formatExceptionThrown,
    formatLoadingFailed,
    formatLogEntry,
    type ConsoleLinePayload,
    type ExceptionDetails,
    type LogEntry,
    type NetworkRequestInfo,
    type RemoteObject
} from './console-format.js';
import { clampZoom, type EvalOutcome, type TabController } from './dispatch.js';
import type { CreateTabInput, DestroyReason } from './registry.js';
import { BINDING_NAME, INSPECT_CHANNEL, injectedScriptSources } from './scripts.js';

/** The viewport every tab is laid out at, so captures do not depend on the holder window. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** In-flight `Network.requestWillBeSent` records; bounded so a chatty page cannot grow it. */
const REQUEST_CACHE_LIMIT = 512;

/** Host → daemon events this tab produces (`host-event` payloads, HOST_PROTOCOL §4). */
export interface TabEventSink {
    console(paneID: string, tabID: string, payload: ConsoleLinePayload): void;
    pageState(paneID: string, tabID: string, payload: { url?: string; title?: string }): void;
    inspect(paneID: string, tabID: string, payload: Record<string, unknown>): void;
    /** The tab went away on its own (`window.close()`, a crashed renderer). */
    tabClosed(paneID: string, tabID: string): void;
}

export interface TabFactoryOptions {
    /** The off-screen holder every view is parented to. Built lazily by `./index.ts`. */
    readonly holder: () => BaseWindow;
    /** The pane's storage partition — persistent, or in-memory when the pane is private (§6). */
    readonly sessionFor: (paneID: string, isPrivate: boolean) => Session;
    readonly events: TabEventSink;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

/** A tab plus the bits only the host (not the dispatcher) needs. */
export interface HostTab extends TabController {
    setVisible(visible: boolean): void;
    dispose(reason: DestroyReason): void;
}

interface CdpContext {
    readonly frameId: string;
    readonly isDefault: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

class ElectronTab implements HostTab {
    readonly paneID: string;
    readonly tabID: string;

    private readonly view: WebContentsView;
    private readonly contents: WebContents;
    private readonly events: TabEventSink;
    private readonly onError: ((error: Error, context: string) => void) | undefined;

    /** Resolves once the CDP session is enabled and the scripts are installed. */
    private readonly ready: Promise<void>;
    private attached = false;
    private disposed = false;

    /** §4.2/§4.3 bookkeeping: what the tab was last asked to show, so `reload` can retry it. */
    private lastAttemptedURL: string;
    private failedLoad = false;
    private zoomFactor = 1;

    private mainFrameId: string | null = null;
    private readonly contexts = new Map<number, CdpContext>();
    private readonly requests = new Map<string, NetworkRequestInfo & { frameId?: string }>();

    constructor(input: CreateTabInput, options: TabFactoryOptions) {
        this.paneID = input.paneID;
        this.tabID = input.tabID;
        this.events = options.events;
        this.onError = options.onError;
        this.lastAttemptedURL = input.url;

        const viewport = options.viewport ?? DEFAULT_VIEWPORT;
        this.view = new WebContentsView({
            webPreferences: {
                session: options.sessionFor(input.paneID, input.isPrivate),
                // Ordinary remote-content posture, restated because it is load-bearing: the page
                // is arbitrary web content an agent pointed us at.
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                webviewTag: false,
                // See the module header: kept ON deliberately.
                webSecurity: true,
                spellcheck: false,
                // Agents race a `wait` in a hidden tab against a visible one.
                backgroundThrottling: false
            }
        });
        this.contents = this.view.webContents;

        this.view.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height });
        this.view.setVisible(false);
        options.holder().contentView.addChildView(this.view);

        this.wireContentsEvents();
        this.ready = this.bootstrap(viewport).catch((error: unknown) => {
            this.report(error, 'cdp-attach');
        });
        // `navigate` awaits `ready`, so the real page is only loaded once the scripts are
        // installed — which is what makes them run at document start.
        if (input.url !== '') this.navigate(input.url);
    }

    // ── setup ───────────────────────────────────────────────────────────────────────

    private report(error: unknown, context: string): void {
        this.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    }

    private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
        if (this.disposed || this.contents.isDestroyed() || !this.attached) {
            return Promise.reject(new Error(`web pane has no live tab ${this.tabID}`));
        }
        return this.contents.debugger.sendCommand(method, params ?? {}) as Promise<unknown>;
    }

    /**
     * Attach CDP and install the injected scripts, in the one order that works.
     *
     * **A fresh `WebContentsView` has no renderer process**, and every CDP command that needs one
     * (`Page.enable`, `Runtime.enable`, `Page.addScriptToEvaluateOnNewDocument`, …) simply never
     * answers until it exists — `debugger.sendCommand` neither resolves nor rejects. Loading
     * `about:blank` first is what brings the renderer up, so the sequence is:
     *
     *     attach → load about:blank → enable domains + addBinding + inject → (caller loads the URL)
     *
     * Doing the setup before the real navigation is also what keeps
     * `addScriptToEvaluateOnNewDocument` meaningful: the scripts are registered before the target
     * document exists, so they run at document start exactly as the `WKUserScript`s did.
     */
    private async bootstrap(viewport: { width: number; height: number }): Promise<void> {
        try {
            this.contents.debugger.attach('1.3');
        } catch (error) {
            // A debugger that will not attach (dev tools already open, an Electron quirk) leaves
            // the tab usable for navigation; every evaluation then answers honestly instead.
            this.report(error, 'debugger-attach');
            return;
        }
        this.attached = true;
        this.contents.debugger.on('detach', () => {
            this.attached = false;
        });
        this.contents.debugger.on('message', (_event, method: string, params: unknown) => {
            try {
                this.onCdpEvent(method, isRecord(params) ? params : {});
            } catch (error) {
                this.report(error, `cdp ${method}`);
            }
        });

        // The renderer-raising load. It is a navigation the daemon must not see as a page state
        // change (`about:blank` is the placeholder §4.4 exists to ignore), which is why the
        // `did-navigate` handler drops it.
        await this.contents.loadURL('about:blank').catch((error: unknown) => {
            this.report(error, 'bootstrap-blank');
        });

        await this.send('Page.enable');
        const tree = await this.send('Page.getFrameTree');
        if (isRecord(tree) && isRecord(tree['frameTree']) && isRecord(tree['frameTree']['frame'])) {
            this.mainFrameId = text(tree['frameTree']['frame']['id']) ?? this.mainFrameId;
        }
        // Runtime.enable replays the contexts that already exist, which is what populates the
        // context→frame map the binding guard reads.
        await this.send('Runtime.enable');
        await this.send('Log.enable');
        await this.send('Network.enable');
        await this.send('Runtime.addBinding', { name: BINDING_NAME });
        for (const source of injectedScriptSources()) {
            await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
            // …and into the document that already exists (about:blank on a fresh view).
            await this.send('Runtime.evaluate', { expression: source, returnByValue: true }).catch(
                (error: unknown) => {
                    this.report(error, 'inject-current-document');
                }
            );
        }
        await this.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            // 1, not 0 ("system default"): on a retina Mac the default would double every
            // screenshot's byte count for no extra information, and push captures over §8.4's
            // 1 MB inline budget for pages that have no business spilling to a temp file.
            deviceScaleFactor: 1,
            mobile: false
        }).catch((error: unknown) => {
            // Non-fatal: the holder window's size then decides layout.
            this.report(error, 'device-metrics');
        });
    }

    private wireContentsEvents(): void {
        const contents = this.contents;

        contents.setWindowOpenHandler(() => {
            // The daemon mints tab ids, so the host cannot conjure a tab for `window.open`.
            // Denying keeps the tab set exactly what the daemon believes it is; surfacing the
            // request as a new tab needs a host→daemon verb that does not exist yet.
            log(`web pane ${this.paneID}: window.open denied (no host→daemon tab request yet)`);
            return { action: 'deny' as const };
        });

        contents.on('did-navigate', (_event, url) => {
            this.failedLoad = false;
            this.applyZoom();
            // The bootstrap `about:blank` load (see `bootstrap`) is not a page state change: the
            // daemon ignores placeholder URLs (§4.4) but would still take the empty title with it,
            // blanking a restored tab's header for the moment before the real load lands.
            if (url === '' || url === 'about:blank') return;
            this.events.pageState(this.paneID, this.tabID, { url, title: contents.getTitle() });
        });
        contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
            if (!isMainFrame) return;
            this.events.pageState(this.paneID, this.tabID, { url });
        });
        contents.on('page-title-updated', (_event, title) => {
            this.events.pageState(this.paneID, this.tabID, { title });
        });
        contents.on('did-finish-load', () => {
            this.applyZoom();
        });
        contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
            // -3 is ERR_ABORTED: a navigation that was replaced (redirect, a second loadURL, a
            // user-cancelled load). WKWebView never reported those, and neither do we.
            if (!isMainFrame || code === -3) return;
            this.failedLoad = true;
            warn(`web pane ${this.paneID} tab ${this.tabID}: load failed ${url} (${String(code)} ${description})`);
        });
        contents.on('render-process-gone', (_event, details) => {
            warn(`web pane ${this.paneID} tab ${this.tabID}: renderer gone (${details.reason})`);
            this.events.tabClosed(this.paneID, this.tabID);
        });
        contents.on('destroyed', () => {
            if (this.disposed) return; // our own teardown, already mirrored daemon-side
            this.events.tabClosed(this.paneID, this.tabID);
        });
    }

    // ── CDP events ──────────────────────────────────────────────────────────────────

    private rememberRequest(params: Record<string, unknown>): void {
        const requestId = text(params['requestId']);
        const request = isRecord(params['request']) ? params['request'] : undefined;
        if (requestId === undefined || request === undefined) return;
        if (this.requests.size >= REQUEST_CACHE_LIMIT) {
            const oldest = this.requests.keys().next();
            if (!oldest.done) this.requests.delete(oldest.value);
        }
        const type = text(params['type']);
        const frameId = text(params['frameId']);
        this.requests.set(requestId, {
            method: text(request['method']) ?? 'GET',
            url: text(request['url']) ?? '',
            ...(type === undefined ? {} : { type }),
            ...(frameId === undefined ? {} : { frameId })
        });
    }

    private emitConsole(payload: ConsoleLinePayload | null): void {
        if (payload === null) return;
        this.events.console(this.paneID, this.tabID, payload);
    }

    private onBindingCalled(params: Record<string, unknown>): void {
        if (text(params['name']) !== BINDING_NAME) return;
        const contextId = typeof params['executionContextId'] === 'number' ? params['executionContextId'] : -1;
        const context = this.contexts.get(contextId);
        // §7's main-frame pin: `Page.addScriptToEvaluateOnNewDocument` runs everywhere, so the
        // guard the scripts carry is backed up here — an iframe (or an isolated world) that
        // reached the binding is not the picker.
        if (context === undefined || !context.isDefault) return;
        if (this.mainFrameId !== null && context.frameId !== this.mainFrameId) return;

        let envelope: unknown;
        try {
            envelope = JSON.parse(text(params['payload']) ?? '');
        } catch {
            return;
        }
        if (!isRecord(envelope)) return;
        if (envelope['channel'] !== INSPECT_CHANNEL) return; // find counts come off the evaluate
        const body = envelope['body'];
        if (!isRecord(body)) return;
        this.events.inspect(this.paneID, this.tabID, body);
    }

    private onCdpEvent(method: string, params: Record<string, unknown>): void {
        switch (method) {
            case 'Runtime.executionContextCreated': {
                const context = isRecord(params['context']) ? params['context'] : undefined;
                if (context === undefined) return;
                const id = typeof context['id'] === 'number' ? context['id'] : undefined;
                const auxData = isRecord(context['auxData']) ? context['auxData'] : {};
                if (id === undefined) return;
                this.contexts.set(id, {
                    frameId: text(auxData['frameId']) ?? '',
                    isDefault: auxData['isDefault'] !== false
                });
                return;
            }
            case 'Runtime.executionContextDestroyed': {
                const id = typeof params['executionContextId'] === 'number' ? params['executionContextId'] : undefined;
                if (id !== undefined) this.contexts.delete(id);
                return;
            }
            case 'Runtime.executionContextsCleared':
                this.contexts.clear();
                return;
            case 'Runtime.bindingCalled':
                this.onBindingCalled(params);
                return;
            case 'Runtime.consoleAPICalled': {
                const args = Array.isArray(params['args']) ? (params['args'] as readonly RemoteObject[]) : [];
                const type = text(params['type']);
                this.emitConsole(
                    formatConsoleApiCall({ ...(type === undefined ? {} : { type }), args }, this.url())
                );
                return;
            }
            case 'Runtime.exceptionThrown': {
                const details = isRecord(params['exceptionDetails'])
                    ? (params['exceptionDetails'] as ExceptionDetails)
                    : undefined;
                if (details === undefined) return;
                this.emitConsole(formatExceptionThrown(details, this.url()));
                return;
            }
            case 'Log.entryAdded': {
                const entry = isRecord(params['entry']) ? (params['entry'] as LogEntry) : undefined;
                if (entry === undefined) return;
                this.emitConsole(formatLogEntry(entry, this.url()));
                return;
            }
            case 'Page.frameNavigated': {
                const frame = isRecord(params['frame']) ? params['frame'] : undefined;
                if (frame === undefined) return;
                if (text(frame['parentId']) !== undefined) return;
                this.mainFrameId = text(frame['id']) ?? this.mainFrameId;
                return;
            }
            case 'Network.requestWillBeSent':
                this.rememberRequest(params);
                return;
            case 'Network.responseReceived': {
                const request = this.requests.get(text(params['requestId']) ?? '');
                const response = isRecord(params['response']) ? params['response'] : undefined;
                if (request === undefined || response === undefined) return;
                const statusText = text(response['statusText']);
                const type = text(params['type']);
                this.emitConsole(
                    formatErrorResponse(request, {
                        ...(typeof response['status'] === 'number' ? { status: response['status'] } : {}),
                        ...(statusText === undefined ? {} : { statusText }),
                        ...(type === undefined ? {} : { type })
                    })
                );
                return;
            }
            case 'Network.loadingFailed': {
                const requestId = text(params['requestId']) ?? '';
                const request = this.requests.get(requestId);
                this.requests.delete(requestId);
                if (request === undefined) return;
                // The main frame's own document failure is `did-fail-load`'s business; reporting
                // it here too would label a navigation failure as a failed <iframe>.
                if (params['type'] === 'Document' && request.frameId === this.mainFrameId) return;
                const errorText = text(params['errorText']);
                const failureType = text(params['type']);
                this.emitConsole(
                    formatLoadingFailed(request, {
                        ...(errorText === undefined ? {} : { errorText }),
                        ...(params['canceled'] === true ? { canceled: true } : {}),
                        ...(failureType === undefined ? {} : { type: failureType })
                    })
                );
                return;
            }
            case 'Network.loadingFinished':
                this.requests.delete(text(params['requestId']) ?? '');
                return;
            default:
                return;
        }
    }

    // ── TabController ───────────────────────────────────────────────────────────────

    url(): string {
        if (this.disposed || this.contents.isDestroyed()) return this.lastAttemptedURL;
        const live = this.contents.getURL();
        // §4.4's placeholder guard, applied at the source: an empty/about:blank URL shows up
        // early in a load and after a failure, and must not wipe what the caller asked for.
        if (live === '' || live === 'about:blank') return this.lastAttemptedURL === '' ? live : this.lastAttemptedURL;
        return live;
    }

    title(): string {
        if (this.disposed || this.contents.isDestroyed()) return '';
        return this.contents.getTitle();
    }

    navigate(url: string): void {
        if (url === '') return;
        this.lastAttemptedURL = url;
        this.failedLoad = false;
        void this.ready.then(() => {
            if (this.disposed || this.contents.isDestroyed()) return;
            // §4.2: a `file://` load gets read access to the file's own directory so sibling
            // assets resolve. `loadFile` would re-encode the path; `loadURL` keeps the exact
            // URL the daemon normalized.
            void this.contents.loadURL(url).catch((error: unknown) => {
                // A failed load is reported through `did-fail-load` (and the console pipeline);
                // the promise rejection is the same event and must not become an unhandled one.
                const message = error instanceof Error ? error.message : String(error);
                if (!message.includes('ERR_ABORTED')) this.report(error, 'load');
            });
        });
    }

    back(): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        this.failedLoad = false;
        if (this.contents.navigationHistory.canGoBack()) this.contents.navigationHistory.goBack();
    }

    forward(): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        this.failedLoad = false;
        if (this.contents.navigationHistory.canGoForward()) this.contents.navigationHistory.goForward();
    }

    reload(hard: boolean): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        // §4.3: a tab that failed its last load retries what it was asked for rather than
        // reloading the failure.
        if (this.failedLoad && this.lastAttemptedURL !== '') {
            this.navigate(this.lastAttemptedURL);
            return;
        }
        if (hard) this.contents.reloadIgnoringCache();
        else this.contents.reload();
    }

    async evaluate(expression: string): Promise<EvalOutcome> {
        await this.ready;
        if (this.disposed || this.contents.isDestroyed()) {
            return { ok: false, error: `web pane has no live tab ${this.tabID}` };
        }
        if (!this.attached) return { ok: false, error: 'cdp session is not attached' };
        let result: unknown;
        try {
            result = await this.send('Runtime.evaluate', {
                expression,
                // The whole point (§8.2): `__nexAct.wait` returns a Promise.
                awaitPromise: true,
                returnByValue: true,
                // Lets an actuated click open a popup / start audio like a real one would.
                userGesture: true
            });
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!isRecord(result)) return { ok: false, error: 'evaluation returned no result' };
        const details = result['exceptionDetails'];
        if (isRecord(details)) {
            const exception = isRecord(details['exception']) ? details['exception'] : {};
            return {
                ok: false,
                error: text(exception['description']) ?? text(details['text']) ?? 'evaluation threw'
            };
        }
        const value = isRecord(result['result']) ? result['result']['value'] : undefined;
        return { ok: true, value };
    }

    /**
     * §8.4's visible-viewport PNG.
     *
     * A plain `Page.captureScreenshot` works for a view in the never-shown holder window, and for
     * a *hidden* (background-tab) view too — Chromium renders it without a compositor frame. What
     * does NOT work is `captureBeyondViewport`/`clip`: on a hidden view that request never answers
     * at all (measured, Electron 43/macOS), which would burn the daemon's whole 20 s capture
     * budget. The viewport is pinned by `Emulation.setDeviceMetricsOverride` instead, so the image
     * is deterministic without asking Chromium to render past the viewport.
     */
    async screenshot(): Promise<Uint8Array> {
        await this.ready;
        const result = await this.send('Page.captureScreenshot', { format: 'png' });
        const data = isRecord(result) ? text(result['data']) : undefined;
        if (data === undefined) throw new Error('no screenshot data');
        return Buffer.from(data, 'base64');
    }

    private applyZoom(): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        // Electron stores zoom per ORIGIN in the session, so a navigation (or another tab of the
        // same pane on the same origin) can move it. Re-applying after every load is what keeps
        // it per-tab, as the spec's port note asks.
        try {
            this.contents.setZoomFactor(this.zoomFactor);
        } catch (error) {
            this.report(error, 'zoom');
        }
    }

    setZoom(factor: number): number {
        this.zoomFactor = clampZoom(factor);
        this.applyZoom();
        return this.zoomFactor;
    }

    zoom(): number {
        return this.zoomFactor;
    }

    setVisible(visible: boolean): void {
        if (this.disposed) return;
        this.view.setVisible(visible);
    }

    dispose(reason: DestroyReason): void {
        if (this.disposed) return;
        this.disposed = true;
        try {
            if (this.attached) this.contents.debugger.detach();
        } catch {
            // Already detached (the renderer went away first).
        }
        try {
            this.view.setVisible(false);
        } catch {
            // The view is already gone.
        }
        try {
            if (!this.contents.isDestroyed()) this.contents.close();
        } catch (error) {
            this.report(error, `tab-dispose (${reason})`);
        }
    }

    /** The Electron view, for whoever owns the window layout (today: the holder). */
    get contentsView(): WebContentsView {
        return this.view;
    }
}

/** Build the registry hooks that create/destroy/show real browser views. */
export function createTabHooks(options: TabFactoryOptions): {
    create(input: CreateTabInput): HostTab;
    destroy(tab: HostTab, reason: DestroyReason): void;
    show(tab: HostTab, visible: boolean): void;
} {
    return {
        create(input) {
            return new ElectronTab(input, options);
        },
        destroy(tab, reason) {
            const holder = options.holder();
            const view = tab instanceof ElectronTab ? tab.contentsView : null;
            if (view !== null) {
                try {
                    holder.contentView.removeChildView(view);
                } catch {
                    // Not parented (or the holder is gone) — disposal below still runs.
                }
            }
            tab.dispose(reason);
        },
        show(tab, visible) {
            tab.setVisible(visible);
        }
    };
}
