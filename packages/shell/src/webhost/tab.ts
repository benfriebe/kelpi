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
import { forwardedChord, type ChordInput, type ForwardedChord } from './keys.js';
import {
    BATCH_MARKER_CHANNEL,
    BINDING_NAME,
    INSPECT_CHANNEL,
    injectedScriptSources
} from './scripts.js';

/** The viewport every tab is laid out at, so captures do not depend on the holder window. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** In-flight `Network.requestWillBeSent` records; bounded so a chatty page cannot grow it. */
const REQUEST_CACHE_LIMIT = 512;

/** Host → daemon events this tab produces (`host-event` payloads, HOST_PROTOCOL §4). */
export interface TabEventSink {
    console(paneID: string, tabID: string, payload: ConsoleLinePayload): void;
    pageState(paneID: string, tabID: string, payload: { url?: string; title?: string }): void;
    /**
     * WEB-032/WEB-033: the tab's live loading + history state.
     *
     * Chromium exposes no `estimatedProgress` (the KVO property the Swift progress strip bound
     * its width to), so what the host can honestly report is the *bracket* —
     * `did-start-loading` opens it, `did-stop-loading` closes it — and the client draws the
     * documented approximation (an indeterminate strip) between the two.
     * `canGoBack`/`canGoForward` ride the same event because they change at the same moments
     * and the chrome needs them to dim its nav buttons.
     */
    navState(
        paneID: string,
        tabID: string,
        payload: { loading: boolean; canGoBack: boolean; canGoForward: boolean }
    ): void;
    inspect(paneID: string, tabID: string, payload: Record<string, unknown>): void;
    /**
     * §7.3: a batch badge was clicked, a popover comment was typed, or its Done/Remove was
     * pressed. The daemon owns the batch, so these are intents, not state.
     */
    batchMarker(paneID: string, tabID: string, payload: Record<string, unknown>): void;
    /** The tab went away on its own (`window.close()`, a crashed renderer). */
    tabClosed(paneID: string, tabID: string): void;
}

export interface TabFactoryOptions {
    /** The off-screen holder every view is parented to. Built lazily by `./index.ts`. */
    readonly holder: () => BaseWindow;
    /**
     * Called before a tab is destroyed, so whoever else is holding the view can let go first —
     * today the embed controller, which must drop a view it has parented into the shell window
     * rather than try to remove it after Electron has torn it down.
     */
    readonly beforeDestroy?: ((tab: HostTab) => void) | undefined;
    /** The pane's storage partition — persistent, or in-memory when the pane is private (§6). */
    readonly sessionFor: (paneID: string, isPrivate: boolean) => Session;
    readonly events: TabEventSink;
    /**
     * Replay a browser chord the page just swallowed into Nex's own renderer (`./keys.ts`).
     *
     * Without it the web-pane priority key layer is unreachable the moment a user clicks the
     * page: a `WebContentsView` is a separate renderer with its own keyboard focus, so ⌘F / ⌘L /
     * ⌘T never reach the window that implements them. The Swift app had no equivalent problem —
     * its `WKWebView` sat inside the app's own window, behind an NSEvent monitor.
     */
    readonly forwardChord?: ((chord: ForwardedChord) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

/** A tab plus the bits only the host (not the dispatcher) needs. */
export interface HostTab extends TabController {
    setVisible(visible: boolean): void;
    /**
     * The view moved between the off-screen holder and the shell window (`./embed.ts`).
     *
     * It exists because the two homes want *opposite* layout rules. In the holder the viewport is
     * **pinned** to `DEFAULT_VIEWPORT` at 1× by `Emulation.setDeviceMetricsOverride`, so
     * `capture`, element rects and `wait` answer the same on every machine whatever the holder
     * window happens to be. Inside the shell window the pane's rect IS the viewport, and a pinned
     * one is a defect the user sees: a 1280×800 page painted into a 516×673 hole shows its
     * top-left corner — clipped, non-responsive, and at 1× on a retina panel (run-B L2).
     *
     * So the override is cleared while embedded (Chromium then lays the page out at the widget's
     * real size and the window's real scale factor) and re-applied the moment it goes back.
     */
    setEmbedded(embedded: boolean): void;
    dispose(reason: DestroyReason): void;
    /**
     * The Electron view, for whoever owns the window layout: the holder by default, the shell
     * window while the pane is embedded (`./embed.ts`).
     */
    readonly contentsView: WebContentsView;
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
    /** `./keys.ts`: replay a chord the page swallowed into Nex's own renderer. */
    private readonly forwardChord: ((chord: ForwardedChord) => void) | undefined;

    /** Resolves once the CDP session is enabled and the scripts are installed. */
    private readonly ready: Promise<void>;
    private attached = false;
    private disposed = false;

    /** §4.2/§4.3 bookkeeping: what the tab was last asked to show, so `reload` can retry it. */
    private lastAttemptedURL: string;
    private failedLoad = false;
    private zoomFactor = 1;

    /** WEB-033: true once a real URL has been asked for, so the bootstrap load stays silent. */
    private navigated = false;
    /** The last `nav-state` payload, so an unchanged repeat is not put on the wire. */
    private lastNavState: { loading: boolean; canGoBack: boolean; canGoForward: boolean } | null = null;

    /** The pinned automation viewport, re-applied whenever the view returns to the holder. */
    private readonly viewport: { readonly width: number; readonly height: number };
    /** True while the view lives in the shell window, where the pane's rect is the viewport. */
    private embedded = false;

    private mainFrameId: string | null = null;
    private readonly contexts = new Map<number, CdpContext>();
    private readonly requests = new Map<string, NetworkRequestInfo & { frameId?: string }>();

    constructor(input: CreateTabInput, options: TabFactoryOptions) {
        this.paneID = input.paneID;
        this.tabID = input.tabID;
        this.events = options.events;
        this.onError = options.onError;
        this.forwardChord = options.forwardChord;
        this.lastAttemptedURL = input.url;

        const viewport = options.viewport ?? DEFAULT_VIEWPORT;
        this.viewport = viewport;
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
        await this.applyViewportPin();
    }

    /**
     * Pin (or unpin) the layout viewport, per `HostTab.setEmbedded`.
     *
     * Off-screen the tab is an automation surface and the viewport is fixed at `DEFAULT_VIEWPORT`
     * @1×, so `capture`, `q-rect` and `wait` are deterministic. Embedded in the shell window the
     * pane's rect is the viewport, so the override has to go — otherwise the page lays out at
     * 1280×800 inside whatever hole the client drew and the user sees its clipped top-left corner.
     */
    private async applyViewportPin(): Promise<void> {
        if (this.embedded) {
            await this.send('Emulation.clearDeviceMetricsOverride').catch((error: unknown) => {
                // Non-fatal: the page keeps the pinned viewport, i.e. today's behaviour.
                this.report(error, 'device-metrics-clear');
            });
            return;
        }
        await this.send('Emulation.setDeviceMetricsOverride', {
            width: this.viewport.width,
            height: this.viewport.height,
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

        const forward = this.forwardChord;
        if (forward !== undefined) {
            contents.on('before-input-event', (event, input) => {
                const chord = forwardedChord(input as unknown as ChordInput);
                if (chord === null) return;
                // Taken from the page and given to Nex — both halves matter: without the
                // `preventDefault` the page would ALSO act on it (⌘F would open Chromium's own
                // find alongside ours).
                event.preventDefault();
                log(`web pane ${this.paneID}: forwarding meta${chord.shift ? '+shift' : ''}+${chord.code} to the Nex window`);
                forward(chord);
            });
        }

        contents.setWindowOpenHandler(() => {
            // The daemon mints tab ids, so the host cannot conjure a tab for `window.open`.
            // Denying keeps the tab set exactly what the daemon believes it is; surfacing the
            // request as a new tab needs a host→daemon verb that does not exist yet.
            log(`web pane ${this.paneID}: window.open denied (no host→daemon tab request yet)`);
            return { action: 'deny' as const };
        });

        // WEB-032/WEB-033. The bracket: `did-start-loading` opens it, `did-stop-loading` closes
        // it, and `did-navigate` re-reports history so back/forward dim at the right moment.
        // The bootstrap `about:blank` load raises the renderer before any URL is asked for; a
        // bracket for it would flash a progress strip on a pane the user never navigated, so
        // nothing is reported until the tab has actually been asked to go somewhere.
        contents.on('did-start-loading', () => {
            this.emitNavState(true);
        });
        contents.on('did-stop-loading', () => {
            this.emitNavState(false);
        });
        contents.on('did-navigate', (_event, url) => {
            this.failedLoad = false;
            this.applyZoom();
            this.emitNavState(contents.isLoading());
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
            // A failure ends the load as surely as a success: without this the strip would sit
            // at "loading" forever on a dead host (`did-stop-loading` does fire, but only after
            // Chromium's own error page commits — this is the immediate, honest close).
            this.emitNavState(false);
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

    /**
     * Report the tab's loading + history state, suppressing the pre-navigation noise.
     *
     * `navigated` flips on the first real `navigate()`, so the renderer-raising `about:blank`
     * load cannot open a bracket. Identical consecutive reports are dropped — Chromium fires
     * `did-navigate` and `did-stop-loading` back to back on a fast page, and the Swift
     * coordinator suppressed duplicate `(progress,isLoading)` posts for the same reason.
     */
    private emitNavState(loading: boolean): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        if (!this.navigated) return;
        const payload = {
            loading,
            canGoBack: this.contents.navigationHistory.canGoBack(),
            canGoForward: this.contents.navigationHistory.canGoForward()
        };
        const last = this.lastNavState;
        if (
            last !== null &&
            last.loading === payload.loading &&
            last.canGoBack === payload.canGoBack &&
            last.canGoForward === payload.canGoForward
        ) {
            return;
        }
        this.lastNavState = payload;
        this.events.navState(this.paneID, this.tabID, payload);
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
        const channel = envelope['channel'];
        // Find counts come off the evaluate, not the binding, so only two channels land here.
        if (channel !== INSPECT_CHANNEL && channel !== BATCH_MARKER_CHANNEL) return;
        const body = envelope['body'];
        if (!isRecord(body)) return;
        if (channel === BATCH_MARKER_CHANNEL) {
            this.events.batchMarker(this.paneID, this.tabID, body);
            return;
        }
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
        // From here on the tab has been asked to show something, so its load brackets are real
        // (WEB-033) — the bootstrap `about:blank` that raised the renderer is not.
        this.navigated = true;
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

    /** WEB-032: the reload button wears a stop glyph mid-load, and that glyph stops the load. */
    stop(): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        this.contents.stop();
        this.emitNavState(false);
    }

    /**
     * WEB-043: give the page keyboard focus.
     *
     * The pane's page is a separate renderer, so focus does not follow the Nex window's own
     * focus ring — a pane focused by ⌘]/⌘[ or from the sidebar would keep typing into the
     * client until it was clicked. The URL-bar exemption is the CLIENT's (it only sends this
     * when no chrome text field has the caret), mirroring the Swift `claimFirstResponder`
     * guard's `firstResponder is NSText` test.
     */
    focusView(): void {
        if (this.disposed || this.contents.isDestroyed()) return;
        // Logged because it is otherwise unobservable from outside: keyboard focus lives in
        // another renderer, so this line is what the visual audit asserts the handoff by.
        log(`web pane ${this.paneID}: focusing the page view (tab ${this.tabID})`);
        this.contents.focus();
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

    setEmbedded(embedded: boolean): void {
        if (this.disposed || this.embedded === embedded) return;
        this.embedded = embedded;
        // Sequenced behind `ready`: a view can be placed before its CDP session exists (the
        // client's first geometry report races the bootstrap), and an override applied to a
        // renderer that is not there yet never resolves.
        void this.ready.then(() => this.applyViewportPin()).catch((error: unknown) => {
            this.report(error, 'device-metrics-embed');
        });
    }

    /**
     * §16.5's `</>` button. Electron's `openDevTools({mode:'bottom'})` replaces the whole
     * WebKit private-SPI + container-view dance the Swift app needed; `undefined` means toggle,
     * which is what a button press is.
     */
    setDevTools(open?: boolean): boolean {
        if (this.disposed || this.contents.isDestroyed()) return false;
        const wanted = open ?? !this.contents.isDevToolsOpened();
        try {
            if (wanted) this.contents.openDevTools({ mode: 'bottom' });
            else this.contents.closeDevTools();
        } catch (error) {
            this.report(error, 'devtools');
            return this.contents.isDevToolsOpened();
        }
        return wanted;
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
            // Whoever else parented this view (the shell window, while embedded) drops it
            // first: `removeChildView` after `close()` is a throw, and a stale placement would
            // point the embed controller at a destroyed view.
            options.beforeDestroy?.(tab);
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
