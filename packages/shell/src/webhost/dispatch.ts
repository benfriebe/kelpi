/**
 * The host's verb dispatch — `host-rpc` / `host-notify` in, a CLI-shaped envelope out.
 *
 * This is the middle of the seam described by `daemon/src/webpane/HOST_PROTOCOL.md`: the daemon
 * owns pane/tab state and forwards anything that needs a real page here; everything below turns
 * one verb into calls on a `TabController` (one live browser view) and answers with the exact
 * object the CLI will see. The daemon merges `pane_id` / `workspace_id` / `tab_id` in and writes
 * it verbatim, so an `ok:false` here is a legitimate answer, not a protocol error.
 *
 * The module is deliberately **Electron-free**: `TabController` and `PaneStorage` are the only
 * things it knows about a browser, so every reply shape in web-pane.md §8.2/§8.4 is unit-testable
 * against fakes (`./dispatch.test.ts`) rather than only through a live smoke.
 *
 * Two rules from the spec shape almost every handler here:
 *
 *   - **Reads are byte-clamped on UTF-8 boundaries with explicit markers** (invariant 7), so a
 *     consumer can always tell content was cut — `./caps.ts` owns the budgets.
 *   - **Evaluation goes through the injected actuator, awaited** (§8.2's "same bug class" note):
 *     a plain evaluate would serialise a pending Promise as `{}`, so `TabController.evaluate`
 *     must use CDP `Runtime.evaluate {awaitPromise:true, returnByValue:true}`.
 */

import type { JsonObject, JsonValue } from '@kelpi/protocol';

import {
    DOM_CAPTURE_LIMIT,
    DOM_TRUNCATION_MARKER,
    POSTER_FAILED_ERROR,
    POSTER_MIME,
    POSTER_TOO_LARGE_ERROR,
    POSTER_UNAVAILABLE_ERROR,
    SCREENSHOT_INLINE_LIMIT,
    TEXT_CAPTURE_LIMIT,
    TEXT_TRUNCATION_MARKER,
    clampUtf8,
    posterWithinBudget
} from './caps.js';
import type { ViewBounds } from './geometry.js';
import type { RegistryPaneSpec, TabRegistry } from './registry.js';
import {
    CAPTURE_DOM_EXPRESSION,
    CAPTURE_TEXT_EXPRESSION,
    buildActuatorCall,
    buildBatchClearMarkers,
    buildBatchHighlight,
    buildBatchSetMarkers,
    buildBatchUnfocus,
    buildBatchUpdateComment,
    buildFindCall,
    buildInspectArm,
    buildInspectDisarm,
    wrapExecScript,
    type BatchMarkerInput,
    type FindAction
} from './scripts.js';

/** §4.2 zoom clamp. `null`/reset → 1.0. Per-tab, never persisted. */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;

/**
 * The clamp is applied here **and** in the tab implementation: the wire contract is the clamp,
 * so a future daemon verb (or a direct `TabController` caller) must not be able to skip it.
 */
export function clampZoom(factor: number): number {
    if (!Number.isFinite(factor)) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor));
}

/** §8.4 capture modes. The daemon rejects anything else before it reaches the host. */
export const CAPTURE_MODES = ['meta', 'text', 'screenshot', 'dom', 'all'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const SCREENSHOT_FAILED_ERROR = 'screenshot capture failed';
/** §8.4's other failure: the PNG was taken but could not be spilled to the temp dir. */
export const SCREENSHOT_WRITE_ERROR = 'failed to write screenshot';

/** The verbs answered with a `host-rpc-reply` (HOST_PROTOCOL §3.2–§3.4). */
export const RPC_VERBS = [
    'navigate',
    'back',
    'forward',
    'reload',
    'url',
    'capture',
    // Issue #12's still frame. Beside `capture` rather than inside it: same CDP call, different
    // question (`TabController.poster`).
    'poster',
    'actuate',
    'exec',
    'inspect-arm',
    'cookies-list',
    'cookies-clear',
    'cookies-delete',
    // §13.2's write half: the storage panel's add/edit form (WEB-051/WEB-052). Delete-then-set,
    // so a renamed cookie cannot leave a stale twin behind.
    'cookies-set',
    'find',
    'zoom'
] as const;

/**
 * The fire-and-forget verbs (HOST_PROTOCOL §3.1 + `inspect-disarm`).
 *
 * The `batch-*` family joins them because every one of them is *cosmetic*: a badge position, a
 * focus ring, a comment written back into a popover. The daemon owns the batch itself, so a
 * marker sync that arrives after the page navigated away has nothing to report and nothing to
 * fail — waiting for an ack would only add a round trip to a repaint.
 */
export const NOTIFY_VERBS = [
    'pane-open',
    'pane-close',
    'pane-set-private',
    'tab-open',
    'tab-close',
    'tab-select',
    'inspect-disarm',
    'batch-markers',
    'batch-clear',
    'batch-highlight',
    'batch-unfocus',
    'batch-comment'
] as const;

// ── the browser seam ────────────────────────────────────────────────────────────────

/** The outcome of one page evaluation; a rejection is data, never a thrown error. */
export type EvalOutcome =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: string };

/** One live tab. `./tab.ts` is the Electron implementation; tests pass a fake. */
export interface TabController {
    readonly paneID: string;
    readonly tabID: string;
    /** Live URL/title (the daemon falls back to its state copy when these are empty). */
    url(): string;
    title(): string;
    /** Start a load. §17.4: the ack is optimistic — do not wait for the load to finish. */
    navigate(url: string): void;
    back(): void;
    forward(): void;
    /** `hard` = bypass cache. A tab showing the error stub retries `lastAttemptedURL` (§4.3). */
    reload(hard: boolean): void;
    /**
     * WEB-032's stop half (the chrome's reload button wears an ✕ mid-load) and WEB-043's focus
     * handoff. Both optional so a test double — or a future non-Electron host — can omit them
     * and have the verb answer honestly instead of crashing.
     */
    stop?(): void;
    focusView?(): void;
    /** Main frame, page world, `awaitPromise:true, returnByValue:true` (§8.2). */
    evaluate(expression: string): Promise<EvalOutcome>;
    /** Visible-viewport PNG (§8.4). Rejects/throws are turned into the spec's failure envelope. */
    screenshot(): Promise<Uint8Array>;
    /**
     * Issue #12's still frame: base64 JPEG of the view AS IT IS ON SCREEN, or `null` when there
     * is no on-screen view to photograph.
     *
     * Deliberately a different method from `screenshot()` rather than a mode of it, because it
     * asks a different question. A capture is an *automation* read and is specified against the
     * pinned off-screen viewport (§8.4) so it answers the same on every machine; a poster is the
     * pane's own pixels, at the pane's own size and the display's own scale, and is worthless
     * unless it matches the hole the client is about to empty. A tab in the holder therefore has
     * a screenshot and no poster.
     *
     * Optional, like `stop`/`focusView`: a test double or a future non-Electron host omits it
     * and the verb answers honestly instead of crashing.
     */
    poster?(): Promise<string | null>;
    /**
     * An automation read is about to run - §8.4's `capture`, the actuator, `exec`. A view that
     * is parked off screen lays itself out at the pinned automation viewport first, so the read
     * answers the same on every machine; a view on screen is left alone, the pane's rect being
     * its viewport. The pin is applied here rather than when the view leaves the screen because
     * a pin is a reflow and most parks are a menu (`./viewport-pin.ts`).
     *
     * Optional, like `poster`: a test double or a host with no such distinction omits it.
     */
    pinViewport?(): Promise<void>;
    /** Clamped to [0.5, 3.0]; returns the applied factor. */
    setZoom(factor: number): number;
    zoom(): number;
    /**
     * Docked dev tools (§16.5); `undefined` toggles, and the return value is the resulting
     * state. Optional: a tab that cannot open them (a test double, a future non-Electron host)
     * simply omits it and the verb answers honestly.
     */
    setDevTools?(open?: boolean): boolean;
}

export interface CookieRecord {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly isSecure: boolean;
    readonly isHttpOnly: boolean;
    /** Unix **seconds**; absent for a session cookie. */
    readonly expires?: number | undefined;
    readonly sessionOnly?: boolean | undefined;
}

/** A cookie the storage panel is asking to write (§13.2's add/edit form). */
export interface CookieWrite {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly isSecure: boolean;
    readonly isHttpOnly: boolean;
    /** Unix **seconds**; absent means a session cookie ("Session only" ticked). */
    readonly expires?: number | undefined;
}

/** The pane's cookie/site-data store (§13.2). */
export interface PaneStorage {
    list(paneID: string): Promise<readonly CookieRecord[]>;
    /** `--all`: every site-data type since the epoch. */
    clearAllSiteData(paneID: string): Promise<void>;
    /** Delete by name and/or canonical domain; returns how many were removed. */
    remove(paneID: string, filter: { name?: string | undefined; domain?: string | undefined }): Promise<number>;
    /**
     * WEB-051/WEB-052: write one cookie, deleting `original` first so a *renamed* cookie does
     * not leave its old self behind. Optional — a host with no write surface simply omits it and
     * the verb answers honestly rather than pretending.
     */
    set?(
        paneID: string,
        cookie: CookieWrite,
        original?: { name: string; domain: string; path?: string | undefined } | undefined
    ): Promise<void>;
}

export interface DispatchDeps<V extends TabController = TabController> {
    readonly registry: TabRegistry<V>;
    readonly storage: PaneStorage;
    /** §8.4 spill path for a screenshot over the inline budget; returns the written path. */
    readonly writeScreenshot: (paneID: string, png: Uint8Array) => Promise<string>;
    /**
     * Issue #12: where a pane's view is placed right now, and how to say that in the client's
     * own CSS pixels (`cssScale` multiplies DIP → CSS px).
     *
     * The poster is a photograph OF THAT BOX, and the client has to lay it out on that box or
     * the swap is a visible jump — the shell rounds and clamps each edge (`viewBounds`), and the
     * client's own CSS rect is neither rounded nor clamped. Optional: a host that cannot say
     * where the view is answers the frame without a box, and the client falls back to the hole.
     */
    readonly viewPlacement?:
        | ((paneID: string) => { bounds: ViewBounds; cssScale: number } | null)
        | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface VerbDispatcher {
    call(verb: string, args: JsonObject): Promise<JsonObject>;
    notify(verb: string, args: JsonObject): void;
}

// ── argument readers ────────────────────────────────────────────────────────────────

function str(args: JsonObject, key: string): string {
    const value = args[key];
    return typeof value === 'string' ? value : '';
}

function optionalStr(args: JsonObject, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function bool(args: JsonObject, key: string): boolean {
    return args[key] === true;
}

function num(args: JsonObject, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(args: JsonObject, key: string): readonly JsonValue[] {
    const value = args[key];
    return Array.isArray(value) ? value : [];
}

/** `{paneID, isPrivate, activeTabID, tabs:[{id,url,title}]}` → a registry spec. */
export function paneSpecOf(args: JsonObject): RegistryPaneSpec {
    const tabs = list(args, 'tabs').flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
        const record = entry as JsonObject;
        const id = str(record, 'id');
        if (id === '') return [];
        return [{ id, url: str(record, 'url'), title: str(record, 'title') }];
    });
    return {
        paneID: str(args, 'paneID'),
        isPrivate: bool(args, 'isPrivate'),
        activeTabID: optionalStr(args, 'activeTabID') ?? null,
        tabs
    };
}

// ── envelopes ───────────────────────────────────────────────────────────────────────

const OK: JsonObject = { ok: true };

function failure(error: string): JsonObject {
    return { ok: false, error };
}

/** §8.2: a tab the host no longer has a view for. */
export function noLiveTabError(tabID: string): string {
    return `web pane has no live tab ${tabID}`;
}

/**
 * §8.2's evaluation-failure branch. `label` is `actuator` for the actuator dispatch and `exec`
 * for `web exec`, exactly as the Swift host labelled them.
 */
function evaluationFailure(label: string, detail: string): JsonObject {
    return failure(`${label} evaluation failed: ${detail}`);
}

/**
 * The injected wrappers always return a JSON **string** carrying one object; anything else means
 * the page (or the evaluation) went wrong. `reply not valid utf8` — the third detail the Swift
 * host could produce — cannot happen over CDP, which hands us a decoded JS string.
 */
function parseEnvelope(label: string, outcome: EvalOutcome): JsonObject {
    if (!outcome.ok) return evaluationFailure(label, outcome.error);
    if (typeof outcome.value !== 'string') {
        return evaluationFailure(label, `${label} returned non-string reply`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(outcome.value);
    } catch {
        return evaluationFailure(label, 'reply not JSON object');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return evaluationFailure(label, 'reply not JSON object');
    }
    return parsed as JsonObject;
}

// ── the dispatcher ──────────────────────────────────────────────────────────────────

export function createVerbDispatcher<V extends TabController>(deps: DispatchDeps<V>): VerbDispatcher {
    const { registry, storage } = deps;

    const report = (error: unknown, context: string): void => {
        deps.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    /**
     * Resolve the addressed tab. The daemon always names a concrete tab id, so a miss means the
     * host's view set and the daemon's state have diverged (a crashed renderer, a tab the page
     * closed on its own) — the spec's own error for that is `web pane has no live tab <uuid>`.
     */
    const tabOf = (args: JsonObject): { tab: V } | { error: JsonObject } => {
        const paneID = str(args, 'paneID');
        const tabID = str(args, 'tabID');
        const tab = tabID === '' ? registry.activeView(paneID) : registry.view(paneID, tabID);
        if (tab === null) return { error: failure(noLiveTabError(tabID)) };
        return { tab };
    };

    // ── capture (§8.4) ──────────────────────────────────────────────────────────────

    const captureText = async (tab: TabController): Promise<{ text: string; byteCount: number }> => {
        const outcome = await tab.evaluate(CAPTURE_TEXT_EXPRESSION);
        const raw = outcome.ok && typeof outcome.value === 'string' ? outcome.value : '';
        const clamped = clampUtf8(raw, TEXT_CAPTURE_LIMIT, TEXT_TRUNCATION_MARKER);
        return { text: clamped.text, byteCount: clamped.byteCount };
    };

    const captureDom = async (tab: TabController): Promise<{ html: string; byteCount: number }> => {
        const outcome = await tab.evaluate(CAPTURE_DOM_EXPRESSION);
        const raw = outcome.ok && typeof outcome.value === 'string' ? outcome.value : '';
        const clamped = clampUtf8(raw, DOM_CAPTURE_LIMIT, DOM_TRUNCATION_MARKER);
        return { html: clamped.text, byteCount: clamped.byteCount };
    };

    /**
     * §8.4's inline-vs-path split: at or below 1,000,000 bytes the PNG rides the reply as
     * base64; larger it is written to the OS temp dir and only the path travels (a multi-megabyte
     * base64 blob would otherwise cross the control socket one line at a time).
     */
    const captureScreenshot = async (
        paneID: string,
        tab: TabController
    ): Promise<{ ok: true; fields: JsonObject } | { ok: false; error: string }> => {
        let png: Uint8Array;
        try {
            png = await tab.screenshot();
        } catch (error) {
            report(error, 'screenshot');
            return { ok: false, error: SCREENSHOT_FAILED_ERROR };
        }
        if (png.byteLength === 0) return { ok: false, error: SCREENSHOT_FAILED_ERROR };
        if (png.byteLength <= SCREENSHOT_INLINE_LIMIT) {
            return {
                ok: true,
                fields: { png_base64: Buffer.from(png).toString('base64'), bytes: png.byteLength }
            };
        }
        try {
            const path = await deps.writeScreenshot(paneID, png);
            return { ok: true, fields: { path, bytes: png.byteLength } };
        } catch (error) {
            report(error, 'screenshot-write');
            // The writer names the path it tried (§8.4's `failed to write screenshot to <path>`),
            // which is the only actionable detail — a full disk, an unwritable temp dir.
            const detail = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                error: detail.startsWith(SCREENSHOT_WRITE_ERROR) ? detail : SCREENSHOT_WRITE_ERROR
            };
        }
    };

    const capture = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const tab = found.tab;
        const paneID = str(args, 'paneID');
        const mode = str(args, 'mode') === '' ? 'meta' : str(args, 'mode');
        // url/title ride EVERY capture reply; the daemon falls back to its state copy when the
        // host reports none (§8.4 common fields).
        const base: JsonObject = { ok: true, url: tab.url(), title: tab.title() };

        if (mode === 'meta') return base;
        if (!(CAPTURE_MODES as readonly string[]).includes(mode)) {
            return failure(`unknown capture mode '${mode}' (allowed: ${CAPTURE_MODES.join(', ')})`);
        }
        // Every read below is specified against the automation viewport (§8.4): a parked view
        // lays out there first. `meta` reads no layout, so it did not wait for one.
        await tab.pinViewport?.();
        if (mode === 'text') {
            const { text, byteCount } = await captureText(tab);
            return { ...base, text, byte_count: byteCount };
        }
        if (mode === 'dom') {
            const { html, byteCount } = await captureDom(tab);
            return { ...base, html, byte_count: byteCount };
        }
        if (mode === 'screenshot') {
            const shot = await captureScreenshot(paneID, tab);
            // A failed screenshot is `ok:false` in single mode (it is the whole reply)...
            if (!shot.ok) return failure(shot.error);
            const { bytes, ...rest } = shot.fields;
            return { ...base, ...rest, byte_count: bytes ?? 0 };
        }
        if (mode === 'all') {
            const [text, dom, shot] = await Promise.all([
                captureText(tab),
                captureDom(tab),
                captureScreenshot(paneID, tab)
            ]);
            const composite: JsonObject = {
                ...base,
                text: text.text,
                text_byte_count: text.byteCount,
                html: dom.html,
                html_byte_count: dom.byteCount
            };
            // ...but in `all` it degrades to a field while `ok` stays true.
            if (!shot.ok) return { ...composite, screenshot_error: shot.error };
            const { bytes, ...rest } = shot.fields;
            return { ...composite, ...rest, screenshot_byte_count: bytes ?? 0 };
        }
        // Unreachable: the mode was checked against `CAPTURE_MODES` above.
        return failure(`unknown capture mode '${mode}' (allowed: ${CAPTURE_MODES.join(', ')})`);
    };

    // ── the poster (issue #12) ──────────────────────────────────────────────────────

    /**
     * One still frame of a pane's page, for the hole to wear while the view is parked.
     *
     * Every refusal is `ok:false` with a stated reason rather than an empty success, because the
     * client branches on exactly that: a pane whose host cannot poster stops holding its view
     * back for one (`client/src/webpane/poster.ts`), and it can only learn that from an honest
     * no. The noes are different facts — no tab, no on-screen view, a frame too big to send —
     * and all of them end the same way: the pane parks the way it always did.
     *
     * **`transient` is the one distinction that matters, and it was learned the hard way.** "The
     * view was not on screen" is a fact about WHEN the client asked, not about what this host can
     * do: the commonest cause is the client's own park landing mid-capture (a menu that raised a
     * dialog, a workspace switch), and a pane that treated it as a verdict stopped waiting for
     * frames — which made every later capture race a park it could not win, so it never got one
     * again. Caught by the `web-popup-layering` audit; the flag is what keeps a self-inflicted no
     * from turning into a permanent one. Everything else (no poster surface at all, a frame over
     * the budget, a capture that threw) really is about this host, and is not marked.
     */
    const poster = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const take = found.tab.poster?.bind(found.tab);
        if (take === undefined) return failure(POSTER_UNAVAILABLE_ERROR);
        let data: string | null;
        try {
            data = await take();
        } catch (error) {
            report(error, 'poster');
            return failure(POSTER_FAILED_ERROR);
        }
        if (data === null) return { ...failure(POSTER_UNAVAILABLE_ERROR), transient: true };
        if (data === '') return failure(POSTER_FAILED_ERROR);
        if (!posterWithinBudget(data.length)) return failure(POSTER_TOO_LARGE_ERROR);
        // The box the frame is OF, so the client can stand the picture exactly where the view
        // stood. Without it the client lays the image out on its own CSS rect and the swap moves
        // the page: the shell rounds every edge and the browser then sizes a replaced element
        // from its intrinsic aspect, which on a 2× display came out 0.76% too large.
        const placement = deps.viewPlacement?.(str(args, 'paneID')) ?? null;
        // `base64_bytes`, not §8.4's `byte_count`: this is the size of the payload AS IT RIDES
        // THE REPLY (the base64 string), which is what the budget is expressed in and what a
        // reader of the log line can compare against. The decoded JPEG is about a quarter
        // smaller and nothing here has a use for that number.
        return {
            ok: true,
            image_base64: data,
            mime: POSTER_MIME,
            base64_bytes: data.length,
            ...(placement === null
                ? {}
                : {
                      bounds: {
                          x: placement.bounds.x,
                          y: placement.bounds.y,
                          width: placement.bounds.width,
                          height: placement.bounds.height
                      },
                      css_scale: placement.cssScale
                  })
        };
    };

    // ── automation ──────────────────────────────────────────────────────────────────

    const actuate = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const method = str(args, 'method');
        if (method === '') return failure('actuator method is required');
        // The actuator reads and clicks layout (element rects, `wait`): a parked view lays out
        // at the automation viewport first (`TabController.pinViewport`).
        await found.tab.pinViewport?.();
        const outcome = await found.tab.evaluate(buildActuatorCall(method, list(args, 'args')));
        return parseEnvelope('actuator', outcome);
    };

    const exec = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const script = str(args, 'script');
        if (script.trim() === '') return failure('script is required');
        // Arbitrary page script is an automation read too: whatever it measures is measured
        // against the same viewport `capture` answers with.
        await found.tab.pinViewport?.();
        return parseEnvelope('exec', await found.tab.evaluate(wrapExecScript(script)));
    };

    const inspectArm = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const nonce = str(args, 'nonce');
        if (nonce === '') return failure('inspect nonce is required');
        const outcome = await found.tab.evaluate(buildInspectArm(nonce, bool(args, 'sticky')));
        if (!outcome.ok) return failure(outcome.error);
        // The page returns false when the picker script never installed (a page that replaced
        // its globals, an about: URL with no document). The daemon substitutes its own message
        // when we do not name one, but naming it keeps the shell's log honest.
        if (outcome.value !== true) return failure('failed to arm inspector for active tab');
        return OK;
    };

    const find = async (args: JsonObject): Promise<JsonObject> => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const raw = str(args, 'action') === '' ? 'search' : str(args, 'action');
        if (!['search', 'next', 'prev', 'clear'].includes(raw)) {
            return failure(`unknown find action '${raw}' (allowed: search, next, prev, clear)`);
        }
        const outcome = await found.tab.evaluate(buildFindCall(raw as FindAction, str(args, 'needle')));
        if (!outcome.ok) return failure(outcome.error);
        const value = outcome.value;
        // §7.5's contract is `{total, current}` with current === -1 when there is no match.
        if (typeof value !== 'object' || value === null) return failure('find is not installed');
        const record = value as Record<string, unknown>;
        const total = typeof record['total'] === 'number' ? record['total'] : 0;
        const current = typeof record['current'] === 'number' ? record['current'] : -1;
        return { ok: true, total, current };
    };

    /** §4.2: `reset` (or no directive) → 1.0, `factor` sets, `delta` nudges; clamped either way. */
    const zoom = (args: JsonObject): JsonObject => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const factor = num(args, 'factor');
        const delta = num(args, 'delta');
        const next = bool(args, 'reset')
            ? 1
            : factor !== undefined
              ? factor
              : delta !== undefined
                ? found.tab.zoom() + delta
                : 1;
        return { ok: true, zoom: found.tab.setZoom(clampZoom(next)) };
    };

    /** §16.5's `</>` button. `open` absent = toggle, which is what a button press means. */
    const devtools = (args: JsonObject): JsonObject => {
        const found = tabOf(args);
        if ('error' in found) return found.error;
        const setter = found.tab.setDevTools?.bind(found.tab);
        if (setter === undefined) return failure('dev tools are not available for this tab');
        const wanted = typeof args['open'] === 'boolean' ? args['open'] : undefined;
        return { ok: true, open: wanted === undefined ? setter() : setter(wanted) };
    };

    // ── cookies (§13.2) ─────────────────────────────────────────────────────────────

    const serializeCookie = (cookie: CookieRecord): JsonObject => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        is_secure: cookie.isSecure,
        is_http_only: cookie.isHttpOnly,
        ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
        ...(cookie.sessionOnly === true ? { session_only: true } : {})
    });

    const cookiesList = async (args: JsonObject): Promise<JsonObject> => {
        const cookies = await storage.list(str(args, 'paneID'));
        return { ok: true, cookies: cookies.map(serializeCookie) };
    };

    const cookiesClear = async (args: JsonObject): Promise<JsonObject> => {
        const paneID = str(args, 'paneID');
        if (bool(args, 'all')) {
            await storage.clearAllSiteData(paneID);
            // The count is unknowable once every storage type is dropped, so the reply says so.
            return { ok: true, cleared_site_data: true };
        }
        const domain = optionalStr(args, 'domain');
        return { ok: true, deleted: await storage.remove(paneID, { domain }) };
    };

    /** §13.2's write: delete the original first (WEB-052), then set the new record. */
    const cookiesSet = async (args: JsonObject): Promise<JsonObject> => {
        const write = storage.set?.bind(storage);
        if (write === undefined) return failure('this host cannot write cookies');
        const raw = args['cookie'];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            return failure('cookie is required');
        }
        const cookie = raw as JsonObject;
        const name = str(cookie, 'name');
        const domain = str(cookie, 'domain');
        // The Swift form disables Save until both are non-empty; the host refuses the same pair
        // so a scripted caller cannot write a cookie no store can address.
        if (name === '') return failure('cookie name is required');
        if (domain === '') return failure('cookie domain is required');
        const rawOriginal = args['original'];
        const original =
            typeof rawOriginal === 'object' && rawOriginal !== null && !Array.isArray(rawOriginal)
                ? {
                      name: str(rawOriginal as JsonObject, 'name'),
                      domain: str(rawOriginal as JsonObject, 'domain'),
                      ...(optionalStr(rawOriginal as JsonObject, 'path') === undefined
                          ? {}
                          : { path: optionalStr(rawOriginal as JsonObject, 'path') })
                  }
                : undefined;
        const expires = num(cookie, 'expires');
        await write(
            str(args, 'paneID'),
            {
                name,
                value: str(cookie, 'value'),
                domain,
                path: str(cookie, 'path') === '' ? '/' : str(cookie, 'path'),
                isSecure: bool(cookie, 'is_secure'),
                isHttpOnly: bool(cookie, 'is_http_only'),
                ...(expires === undefined ? {} : { expires })
            },
            original === undefined || original.name === '' ? undefined : original
        );
        return { ok: true, name, domain };
    };

    const cookiesDelete = async (args: JsonObject): Promise<JsonObject> => {
        const name = str(args, 'name');
        if (name === '') return failure('cookie name is required');
        const deleted = await storage.remove(str(args, 'paneID'), {
            name,
            domain: optionalStr(args, 'domain')
        });
        return { ok: true, deleted };
    };

    // ── lifecycle (fire-and-forget) ─────────────────────────────────────────────────

    const disarmPane = (paneID: string): void => {
        const pane = registry.pane(paneID);
        if (pane === null) return;
        // Disarm every tab, not just the active one: a `tab-select` between arm and disarm would
        // otherwise leave a live picker (and a crosshair cursor) on the tab that lost focus.
        for (const tab of pane.tabs) {
            void tab.view.evaluate(buildInspectDisarm()).catch((error: unknown) => {
                report(error, 'inspect-disarm');
            });
        }
    };

    /**
     * The batch surfaces live in the ACTIVE tab's page. `tabOf` falls back to the active view
     * when no tab is named, which is exactly right here: markers belong to whatever the user is
     * looking at, and a sync for a pane whose views are gone is a silent no-op.
     */
    const batchEval = (args: JsonObject, expression: string): void => {
        const found = tabOf(args);
        if ('error' in found) return;
        void found.tab.evaluate(expression).catch((error: unknown) => {
            report(error, 'batch-markers');
        });
    };

    const batchMarkerItems = (args: JsonObject): readonly BatchMarkerInput[] =>
        list(args, 'items').flatMap((entry) => {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
            const record = entry as JsonObject;
            const selector = str(record, 'selector');
            if (selector === '') return [];
            return [
                {
                    id: str(record, 'id'),
                    selector,
                    label: str(record, 'label'),
                    comment: str(record, 'comment')
                }
            ];
        });

    const runNotify = (verb: string, args: JsonObject): boolean => {
        switch (verb) {
            case 'batch-markers':
                batchEval(args, buildBatchSetMarkers(batchMarkerItems(args)));
                return true;
            case 'batch-clear':
                batchEval(args, buildBatchClearMarkers());
                return true;
            case 'batch-highlight':
                batchEval(
                    args,
                    buildBatchHighlight(str(args, 'itemID'), args['scrollIntoView'] !== false)
                );
                return true;
            case 'batch-unfocus':
                batchEval(args, buildBatchUnfocus());
                return true;
            case 'batch-comment':
                batchEval(args, buildBatchUpdateComment(str(args, 'itemID'), str(args, 'comment')));
                return true;
            case 'pane-open':
                registry.openPane(paneSpecOf(args));
                return true;
            case 'pane-close':
                registry.closePane(str(args, 'paneID'));
                return true;
            case 'pane-set-private':
                registry.setPrivate(paneSpecOf(args));
                return true;
            case 'tab-open':
                registry.openTab(
                    str(args, 'paneID'),
                    str(args, 'tabID'),
                    str(args, 'url'),
                    bool(args, 'makeActive')
                );
                return true;
            case 'tab-close':
                registry.closeTab(str(args, 'paneID'), str(args, 'tabID'));
                return true;
            case 'tab-select':
                registry.selectTab(str(args, 'paneID'), str(args, 'tabID'));
                return true;
            case 'inspect-disarm':
                disarmPane(str(args, 'paneID'));
                return true;
            default:
                return false;
        }
    };

    const runRpc = async (verb: string, args: JsonObject): Promise<JsonObject> => {
        switch (verb) {
            case 'navigate': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                found.tab.navigate(str(args, 'url'));
                return OK;
            }
            case 'back':
            case 'forward': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                if (verb === 'back') found.tab.back();
                else found.tab.forward();
                return OK;
            }
            case 'reload': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                found.tab.reload(bool(args, 'hard'));
                return OK;
            }
            case 'stop': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                if (found.tab.stop === undefined) return failure('this host cannot stop a load');
                found.tab.stop();
                return OK;
            }
            case 'focus-view': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                if (found.tab.focusView === undefined) return failure('this host cannot focus a view');
                found.tab.focusView();
                return OK;
            }
            case 'url': {
                const found = tabOf(args);
                if ('error' in found) return found.error;
                return { ok: true, url: found.tab.url(), title: found.tab.title() };
            }
            case 'capture':
                return await capture(args);
            case 'poster':
                return await poster(args);
            case 'actuate':
                return await actuate(args);
            case 'exec':
                return await exec(args);
            case 'inspect-arm':
                return await inspectArm(args);
            case 'find':
                return await find(args);
            case 'zoom':
                return zoom(args);
            case 'devtools':
                return devtools(args);
            case 'cookies-list':
                return await cookiesList(args);
            case 'cookies-clear':
                return await cookiesClear(args);
            case 'cookies-delete':
                return await cookiesDelete(args);
            case 'cookies-set':
                return await cookiesSet(args);
            default:
                return failure(`unsupported host verb '${verb}'`);
        }
    };

    return {
        async call(verb, args) {
            try {
                // A lifecycle verb that arrives as an RPC (a future daemon that wants an ack)
                // still runs, and acks — the state change is the same either way.
                if (runNotify(verb, args)) return OK;
                return await runRpc(verb, args);
            } catch (error) {
                report(error, `host-rpc ${verb}`);
                return failure(error instanceof Error ? error.message : String(error));
            }
        },

        notify(verb, args) {
            try {
                if (runNotify(verb, args)) return;
                report(new Error(`unknown host-notify verb '${verb}'`), 'host-notify');
            } catch (error) {
                report(error, `host-notify ${verb}`);
            }
        }
    };
}
