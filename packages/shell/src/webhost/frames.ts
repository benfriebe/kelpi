/**
 * Out-of-process frames: the child CDP sessions a tab's console pipeline has to own (WEB-073).
 *
 * The Swift host injected its console script with `forMainFrameOnly: false`, so a page's
 * iframes reported their lines through the same `WKScriptMessage` handler and landed in the
 * pane's ring buffer with the tab's own attribution. The CDP branch this port takes gets the
 * same coverage for free **only while the frame shares the tab's renderer**: an out-of-process
 * iframe (a cross-site frame under Chromium's site isolation, and every `<iframe>` in a
 * `site-per-process` build) is a *separate CDP target* with a *separate session*, and a
 * `Runtime.enable` on the tab's own session says nothing about it. Nobody attaches, so nothing
 * from that frame ever reaches the buffer.
 *
 * The fix is the standard target-hierarchy dance, kept in this module so it can be unit-tested
 * against a scripted session instead of a browser:
 *
 *   1. `Target.setAutoAttach {autoAttach, flatten, waitForDebuggerOnStart}` on the tab's own
 *      session. `flatten: true` is what makes every child's traffic arrive on the SAME
 *      `debugger.on('message')` channel tagged with a `sessionId`, rather than wrapped inside
 *      `Target.receivedMessageFromTarget` envelopes.
 *   2. On `Target.attachedToTarget`, enable `Runtime` + `Log` **on the child session** and arm
 *      the same auto-attach on it, so a frame nested inside the frame is attached too.
 *   3. `Runtime.runIfWaitingForDebugger` — `waitForDebuggerOnStart` is what buys the frame's
 *      *document-start* lines (the child is frozen until we resume it, so a `console.log` in
 *      the first inline `<script>` cannot outrun our `Runtime.enable`), and it is a promise to
 *      let it go again. A path that can skip the resume is a hung iframe, so every command is
 *      individually guarded and the resume runs even when the enables failed. The same flag can
 *      pause the TAB's own frame on a cross-process navigation without announcing it — see
 *      `ElectronTab.resumeIfWaiting`, which discharges that obligation from the other side.
 *   4. `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded` arriving on a
 *      known child session are formatted by the same `./console-format.ts` functions and handed
 *      to the same sink — so the line carries the TAB's id (attribution is per tab, never per
 *      frame, exactly as the Swift handler's `this.tabID` was) while its `url` is the frame's
 *      own address rather than the top document's.
 *
 * Churn and failure are the two things this has to survive:
 *
 *   - **Detach** (`Target.detachedFromTarget`) and **destruction** (`Target.targetDestroyed`)
 *     both drop the session, so a page that swaps its iframes on every navigation does not grow
 *     the map. `Target.targetInfoChanged` keeps a surviving frame's URL current. A hard cap
 *     (`SESSION_LIMIT`) is the backstop for a browser that somehow stops reporting either.
 *   - **A child session error is not a tab error.** Every send is caught and reported through
 *     the tab's `onError` hook; `handle()` never throws, so a hostile frame cannot take the
 *     tab's console, actuator or capture pipeline down with it.
 */

import {
    formatConsoleApiCall,
    formatExceptionThrown,
    formatLogEntry,
    type ConsoleLinePayload,
    type ExceptionDetails,
    type LogEntry,
    type RemoteObject
} from './console-format.js';

/** The auto-attach posture, named once because the child sessions re-arm it for nested frames. */
export const AUTO_ATTACH_PARAMS = {
    autoAttach: true,
    // See the module header: this is what makes a frame's document-start lines reachable.
    // It can also catch the TAB's own frame on a cross-process navigation, which nothing
    // announces — `ElectronTab.resumeIfWaiting` is this flag's other half.
    waitForDebuggerOnStart: true,
    flatten: true
} as const;

/**
 * Target types whose console output belongs in the pane's buffer.
 *
 * `iframe` is what Chromium calls an OOPIF. Workers (`worker`, `service_worker`) are auto-
 * attached too — we cannot filter what the browser hands us — but they are only *resumed*, not
 * subscribed: the Swift behaviour this item ports is `forMainFrameOnly:false`, which was about
 * frames, and a service worker's logs are not the pane's page.
 */
const FORWARDING_TARGET_TYPES: ReadonlySet<string> = new Set(['iframe', 'page', 'webview']);

/** Backstop against a session map that is never told about a detach. */
export const SESSION_LIMIT = 128;

export interface FrameSessionTransport {
    /** Exactly Electron's `debugger.sendCommand(method, params, sessionId)`. */
    send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

export interface FrameSessionOptions {
    readonly transport: FrameSessionTransport;
    /** Where a forwarded line goes: the tab's own console sink, so attribution stays per tab. */
    readonly console: (payload: ConsoleLinePayload) => void;
    /** The tab's URL, used only when a child event carries no URL of its own. */
    readonly fallbackURL: () => string;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly log?: ((message: string) => void) | undefined;
    readonly limit?: number | undefined;
}

export interface AttachedFrameSession {
    readonly sessionID: string;
    readonly targetID: string;
    readonly type: string;
    readonly url: string;
    /** False for workers: attached and resumed, but not subscribed (see the type set above). */
    readonly forwards: boolean;
}

export interface FrameSessions {
    /** Arm auto-attach on the tab's own session. Never rejects. */
    start(): Promise<void>;
    /**
     * Feed one CDP message.
     *
     * Returns `true` when the message was child-session traffic (or target bookkeeping) and the
     * tab must NOT run it through its own root-session handler — a child's `Page.frameNavigated`
     * is not the tab's main frame moving.
     */
    handle(method: string, params: Record<string, unknown>, sessionID?: string | undefined): boolean;
    /** Resolves once every in-flight attach has finished its commands (tests, teardown). */
    settled(): Promise<void>;
    /** Attached sessions, newest last. */
    list(): readonly AttachedFrameSession[];
    readonly size: number;
    /** Debugger detached / tab disposed: forget everything. */
    clear(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

interface SessionEntry {
    readonly targetID: string;
    readonly type: string;
    url: string;
    readonly forwards: boolean;
}

export function createFrameSessions(options: FrameSessionOptions): FrameSessions {
    const limit = options.limit ?? SESSION_LIMIT;
    /** Insertion-ordered, which is what makes the overflow eviction "oldest first". */
    const sessions = new Map<string, SessionEntry>();
    /** Reverse index so `Target.targetDestroyed` / `targetInfoChanged` can find the session. */
    const byTarget = new Map<string, string>();
    const pending = new Set<Promise<void>>();

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    /**
     * One CDP command on a child session, with the failure absorbed.
     *
     * Each call is separately guarded on purpose: a `Log.enable` that a target type rejects must
     * not skip the `Runtime.runIfWaitingForDebugger` that unfreezes it.
     */
    const trySend = async (
        method: string,
        sessionID: string,
        params: Record<string, unknown> = {}
    ): Promise<void> => {
        try {
            await options.transport.send(method, params, sessionID);
        } catch (error) {
            report(error, `child-session ${method}`);
        }
    };

    const track = (promise: Promise<void>): void => {
        pending.add(promise);
        void promise.finally(() => {
            pending.delete(promise);
        });
    };

    const forget = (sessionID: string): void => {
        const entry = sessions.get(sessionID);
        if (entry === undefined) return;
        sessions.delete(sessionID);
        if (byTarget.get(entry.targetID) === sessionID) byTarget.delete(entry.targetID);
    };

    const attach = (params: Record<string, unknown>): void => {
        const sessionID = text(params['sessionId']);
        const info = isRecord(params['targetInfo']) ? params['targetInfo'] : {};
        if (sessionID === undefined) return;
        const type = text(info['type']) ?? 'other';
        const targetID = text(info['targetId']) ?? sessionID;
        const url = text(info['url']) ?? '';
        const forwards = FORWARDING_TARGET_TYPES.has(type);

        const existing = sessions.get(sessionID);
        if (existing !== undefined) {
            // A re-announced target (Chromium repeats the event after a cross-process swap on
            // the same session): refresh the URL and do not double-enable.
            existing.url = url;
            return;
        }
        // The overflow guard: drop the oldest record rather than grow without bound. The session
        // itself stays attached browser-side — we simply stop forwarding it, which is the safe
        // half of the trade (a leak here would be unbounded memory in the main process).
        while (sessions.size >= limit) {
            const oldest = sessions.keys().next();
            if (oldest.done === true) break;
            forget(oldest.value);
        }
        sessions.set(sessionID, { targetID, type, url, forwards });
        byTarget.set(targetID, sessionID);
        options.log?.(
            `attached child cdp session ${sessionID} (${type}${forwards ? '' : ', resume-only'}) ${url}`
        );

        track(
            (async (): Promise<void> => {
                if (forwards) {
                    // Runtime first: it replays the contexts that already exist, so a frame that
                    // logged before we got here is not silently missed.
                    await trySend('Runtime.enable', sessionID);
                    await trySend('Log.enable', sessionID);
                }
                // A frame inside the frame is another target again.
                await trySend('Target.setAutoAttach', sessionID, { ...AUTO_ATTACH_PARAMS });
                // Unconditional, and last: `waitForDebuggerOnStart` froze this target, and a
                // path that reaches the end without resuming it is a hung iframe. Harmless when
                // the target was not waiting.
                await trySend('Runtime.runIfWaitingForDebugger', sessionID);
            })()
        );
    };

    const forward = (sessionID: string, method: string, params: Record<string, unknown>): void => {
        const entry = sessions.get(sessionID);
        if (entry === undefined || !entry.forwards) return;
        // The frame's own address beats the tab's for `url`, but a frame that has not committed
        // a document yet reports `""` — then the tab's URL is the honest fallback.
        const url = entry.url === '' ? options.fallbackURL() : entry.url;
        let payload: ConsoleLinePayload | null = null;
        switch (method) {
            case 'Runtime.consoleAPICalled': {
                const args = Array.isArray(params['args']) ? (params['args'] as readonly RemoteObject[]) : [];
                const type = text(params['type']);
                payload = formatConsoleApiCall({ ...(type === undefined ? {} : { type }), args }, url);
                break;
            }
            case 'Runtime.exceptionThrown': {
                const details = isRecord(params['exceptionDetails'])
                    ? (params['exceptionDetails'] as ExceptionDetails)
                    : undefined;
                if (details === undefined) return;
                payload = formatExceptionThrown(details, url);
                break;
            }
            case 'Log.entryAdded': {
                const entry_ = isRecord(params['entry']) ? (params['entry'] as LogEntry) : undefined;
                if (entry_ === undefined) return;
                payload = formatLogEntry(entry_, url);
                break;
            }
            default:
                return;
        }
        if (payload === null) return;
        options.console(payload);
    };

    return {
        async start(): Promise<void> {
            try {
                await options.transport.send('Target.setAutoAttach', { ...AUTO_ATTACH_PARAMS });
            } catch (error) {
                // Non-fatal by construction: without it the tab keeps exactly today's behaviour
                // (same-process frames covered, out-of-process ones not), which is a degraded
                // console rather than a broken tab.
                report(error, 'target-auto-attach');
            }
        },

        handle(method, params, sessionID): boolean {
            try {
                switch (method) {
                    case 'Target.attachedToTarget':
                        attach(params);
                        return true;
                    case 'Target.detachedFromTarget': {
                        const gone = text(params['sessionId']);
                        if (gone !== undefined) forget(gone);
                        return true;
                    }
                    case 'Target.targetDestroyed': {
                        const targetID = text(params['targetId']);
                        const owner = targetID === undefined ? undefined : byTarget.get(targetID);
                        if (owner !== undefined) forget(owner);
                        return true;
                    }
                    case 'Target.targetInfoChanged': {
                        const info = isRecord(params['targetInfo']) ? params['targetInfo'] : {};
                        const targetID = text(info['targetId']);
                        const owner = targetID === undefined ? undefined : byTarget.get(targetID);
                        const entry = owner === undefined ? undefined : sessions.get(owner);
                        if (entry !== undefined) entry.url = text(info['url']) ?? entry.url;
                        return true;
                    }
                    default:
                        break;
                }
                // Root-session traffic (`''` on Electron) stays the tab's own business.
                if (sessionID === undefined || sessionID === '') return false;
                forward(sessionID, method, params);
                return true;
            } catch (error) {
                report(error, `child-session ${method}`);
                // Consumed: a child event that blew up here is still not root traffic.
                return sessionID !== undefined && sessionID !== '';
            }
        },

        async settled(): Promise<void> {
            // Attach work can attach more work (nested frames), so drain until quiet.
            while (pending.size > 0) await Promise.all([...pending]);
        },

        list(): readonly AttachedFrameSession[] {
            return [...sessions.entries()].map(([sessionID, entry]) => ({
                sessionID,
                targetID: entry.targetID,
                type: entry.type,
                url: entry.url,
                forwards: entry.forwards
            }));
        },

        get size(): number {
            return sessions.size;
        },

        clear(): void {
            sessions.clear();
            byTarget.clear();
        }
    };
}
