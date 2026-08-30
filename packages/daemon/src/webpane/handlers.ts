/**
 * The `web-*` command family (web-pane.md §8) — the daemon half of M6.
 *
 * Each handler does the same four things in the same order:
 *
 *   1. **resolve scope** (`./resolve.ts`) — pane target, web-pane-ness, active tab;
 *   2. **mint ids the contract pre-mints** (pane + tab UUIDs) and answer with them
 *      *immediately*, before any effect runs (§17.1/§17.4 — a CLI reply must be able to echo
 *      concrete ids, and the ack is deliberately optimistic);
 *   3. **mutate the state the daemon owns** (the `webPanes` sidecar: tabs, active tab, private
 *      flag) and mirror it to the host as a fire-and-forget notification;
 *   4. **forward to the host and await** for anything that only exists in a real browser.
 *
 * That split is what makes the port work headlessly: `kelpi web open`, `kelpi web tabs` and
 * `kelpi web console` answer with no Electron shell attached (the pane exists, the buffers are
 * the daemon's), while `kelpi web click` fails honestly with `no web pane host connected`.
 * The per-verb policy is spelled out in `./HOST_PROTOCOL.md` §6.
 */

import { resolvePaneTarget } from '@kelpi/core/resolve';
import type { JsonObject, JsonValue } from '@kelpi/protocol';

import { forCommand, uuidOut } from '../handlers/app/common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from '../handlers/app/context.js';
import {
    normalizeURLInput,
    resolveStateOf,
    visiblePane,
    workspaceByID,
    workspaceContainingVisiblePane
} from '../store/index.js';
import type { DaemonState } from '../store/index.js';
import type { ReplyHandle } from '../seams.js';
import { NO_HOST_ERROR } from './host.js';
import { serializeInspectResult } from './inspect.js';
import { NO_ACTIVE_TAB_ERROR, resolveTabRef, resolveWebPane, type ResolvedWebPane } from './resolve.js';
import type { WebPaneService } from './service.js';
import { HOST_TIMEOUT_CAPTURE_MS, HOST_TIMEOUT_EXEC_MS, waitTimeoutMs } from './verbs.js';

/** §8.4 capture modes; anything else is rejected before the host is bothered. */
export const CAPTURE_MODES = ['meta', 'text', 'screenshot', 'dom', 'all'] as const;

export const LAST_TAB_ERROR =
    'cannot close the only tab in a web pane, use `kelpi pane close` to close the pane itself';
export const ARM_FAILED_ERROR = 'failed to arm inspector for active tab';
export const NO_ACTIVE_WORKSPACE_ERROR = 'no active workspace';
export const COOKIE_SCOPE_ERROR = '--all and --domain are mutually exclusive';

type ScopeFields = { pane_id?: string | undefined; target?: string | undefined; workspace?: string | undefined };

interface WebTargetHandlerOptions {
    /** Reject a tab-less pane with `web pane has no active tab` before running. */
    readonly requireActiveTab?: boolean;
}

/** The ids every success reply carries (§8.2). */
function baseFields(target: ResolvedWebPane): Record<string, unknown> {
    return { pane_id: uuidOut(target.paneID), workspace_id: uuidOut(target.workspace.id) };
}

/**
 * Merge the daemon's ids into an envelope the host produced. `ok:false` envelopes (e.g. "no
 * match for selector") ride this same path — the CLI turns them into exit 1 (§8.2).
 */
function sendEnvelope(
    reply: ReplyHandle | null,
    envelope: JsonObject,
    fields: Record<string, unknown>
): void {
    if (reply === null) return;
    const { ok: okValue, ...rest } = envelope;
    reply.send({ ok: okValue === true, ...rest, ...fields });
    reply.close();
}

function resolveScope(
    ctx: AppContext,
    fields: ScopeFields,
    reply: ReplyHandle | null,
    options: WebTargetHandlerOptions = {}
): ResolvedWebPane | null {
    const resolution = resolveWebPane(ctx.store.getState(), fields);
    if (!resolution.ok) {
        fail(reply, resolution.error);
        return null;
    }
    if (options.requireActiveTab === true && resolution.target.activeTab === null) {
        fail(reply, NO_ACTIVE_TAB_ERROR);
        return null;
    }
    return resolution.target;
}

/**
 * WEB-064's close half. `web-tab-close` removes the tab the find may have been running on, so
 * the new active tab has to be read back out of the post-dispatch state before the needle can be
 * re-applied — which is why this cannot be inlined the way `tab-select` can.
 */
function retargetFind(ctx: AppContext, service: WebPaneService, paneID: string): void {
    const resolution = resolveWebPane(ctx.store.getState(), { pane_id: paneID, target: paneID });
    service.retargetFind(paneID, resolution.ok ? (resolution.target.activeTab?.id ?? null) : null);
}

/** `web-open` routing (§3.3): the caller's pane's workspace, else the active one. */
function routeWorkspace(state: DaemonState, paneID: string | undefined): string | null {
    if (paneID !== undefined) {
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace !== null) return workspace.id;
    }
    const active = state.lastActiveWorkspaceID;
    if (active === null || workspaceByID(state, active) === null) return null;
    return active;
}

export interface WebHandlerDeps {
    readonly service: WebPaneService;
    readonly uuid: () => string;
    readonly now: () => number;
    readonly persist: () => void;
}

export function webHandlerDeps(deps: AppDeps): WebHandlerDeps {
    return {
        service: deps.webPanes,
        uuid: deps.uuid,
        now: deps.now,
        persist: deps.persist
    };
}

export function webHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    const { service, uuid, now, persist } = webHandlerDeps(deps);

    /** Await one host RPC and answer with the merged envelope. */
    const forward = (
        reply: ReplyHandle | null,
        target: ResolvedWebPane,
        verb: string,
        args: JsonObject,
        fields: Record<string, unknown>,
        timeoutMs?: number
    ): void => {
        if (!service.hasHost) {
            fail(reply, NO_HOST_ERROR);
            return;
        }
        void service
            .call(verb, args, timeoutMs === undefined ? {} : { timeoutMs })
            .then((envelope) => {
                sendEnvelope(reply, envelope, { ...baseFields(target), ...fields });
            });
    };

    /**
     * The shared actuator dispatch (§8.2): one host verb (`actuate`) carrying the `__kelpiAct`
     * method name plus its argument list, always against the pane's ACTIVE tab.
     */
    const actuate = (
        msg: ScopeFields,
        ctx: AppContext,
        reply: ReplyHandle | null,
        method: string,
        args: readonly JsonValue[],
        timeoutMs?: number
    ): void => {
        const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
        if (target === null) return;
        const tabID = target.activeTab?.id ?? '';
        forward(
            reply,
            target,
            'actuate',
            { paneID: target.paneID, tabID, method, args: [...args] },
            { tab_id: tabID },
            timeoutMs
        );
    };

    return [
        // ── open ────────────────────────────────────────────────────────────
        forCommand('web-open', (msg, ctx, reply) => {
            const state = ctx.store.getState();
            const workspaceID = routeWorkspace(state, msg.pane_id);
            if (workspaceID === null) {
                fail(reply, NO_ACTIVE_WORKSPACE_ERROR);
                return;
            }
            /*
             * WEB-011: the GUI names the pane it splits off, and which way.
             *
             * The header globe (click = right, ⇧-click = down) and the pane context menu send
             * `target` + `direction`; the CLI sends neither, so `kelpi web open` keeps splitting
             * the FOCUSED pane exactly as Swift's `handleWebOpen` does. An anchor that is not a
             * visible pane of the routed workspace is ignored rather than honoured —
             * `openWebPane` splits ONE workspace's layout, so a cross-workspace anchor would
             * put the pane somewhere nobody pointed at.
             */
            const workspace = workspaceByID(state, workspaceID);
            const sourcePaneID =
                msg.target !== undefined &&
                workspace !== null &&
                visiblePane(workspace, msg.target) !== null
                    ? msg.target
                    : undefined;
            const paneID = uuid();
            const tabID = uuid();
            // §3.3: the reply goes out BEFORE the pane exists, carrying the real ids.
            ok(reply, {
                pane_id: uuidOut(paneID),
                tab_id: uuidOut(tabID),
                url: normalizeURLInput(msg.url),
                private: msg.private,
                workspace_id: uuidOut(workspaceID)
            });
            ctx.store.dispatch({
                type: 'open-web-pane',
                workspaceID,
                paneID,
                tabID,
                url: msg.url,
                now: now(),
                isPrivate: msg.private,
                sourcePaneID,
                direction: msg.direction
            });
            // The pane itself is daemon state; the host learns about it through the store
            // subscription in `./service.ts` (and on its next registration).
            persist();
        }),

        // ── navigation ──────────────────────────────────────────────────────
        forCommand('web-navigate', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            if (!service.hasHost) {
                fail(reply, NO_HOST_ERROR);
                return;
            }
            const url = normalizeURLInput(msg.url);
            const tabID = target.activeTab?.id ?? '';
            // §4.2: the normalized URL is written optimistically, so a save right now (or a
            // host that reconnects later) carries the intent.
            ctx.store.dispatch({
                type: 'web-navigate',
                workspaceID: target.workspace.id,
                paneID: target.paneID,
                url
            });
            persist();
            forward(
                reply,
                target,
                'navigate',
                { paneID: target.paneID, tabID, url },
                { tab_id: tabID, url }
            );
        }),

        forCommand('web-url', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            const tab = target.activeTab;
            const fallback = {
                ...baseFields(target),
                tab_id: tab?.id ?? '',
                url: tab?.url ?? '',
                title: tab?.title ?? ''
            };
            // §8.2: live values from the view, falling back to state when it is not built —
            // which, in the port, is exactly the case when no host is attached.
            if (!service.hasHost) {
                ok(reply, fallback);
                return;
            }
            void service
                .call('url', { paneID: target.paneID, tabID: tab?.id ?? '' })
                .then((envelope) => {
                    if (envelope['ok'] !== true) {
                        ok(reply, fallback);
                        return;
                    }
                    const url = typeof envelope['url'] === 'string' ? envelope['url'] : fallback.url;
                    const title =
                        typeof envelope['title'] === 'string' ? envelope['title'] : fallback.title;
                    ok(reply, { ...fallback, url, title });
                });
        }),

        forCommand('web-back', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            const tabID = target.activeTab?.id ?? '';
            forward(reply, target, 'back', { paneID: target.paneID, tabID }, { tab_id: tabID });
        }),

        forCommand('web-forward', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            const tabID = target.activeTab?.id ?? '';
            forward(reply, target, 'forward', { paneID: target.paneID, tabID }, { tab_id: tabID });
        }),

        forCommand('web-reload', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            const tabID = target.activeTab?.id ?? '';
            forward(
                reply,
                target,
                'reload',
                { paneID: target.paneID, tabID, hard: msg.hard },
                { tab_id: tabID }
            );
        }),

        forCommand('web-capture', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            if (!(CAPTURE_MODES as readonly string[]).includes(msg.mode)) {
                fail(
                    reply,
                    `unknown capture mode '${msg.mode}' (allowed: ${CAPTURE_MODES.join(', ')})`
                );
                return;
            }
            const tab = target.activeTab;
            const tabID = tab?.id ?? '';
            if (!service.hasHost) {
                fail(reply, NO_HOST_ERROR);
                return;
            }
            void service
                .call(
                    'capture',
                    { paneID: target.paneID, tabID, mode: msg.mode },
                    { timeoutMs: HOST_TIMEOUT_CAPTURE_MS }
                )
                .then((envelope) => {
                    // §8.4: url/title/mode ride every capture reply. The host's live values
                    // win; the pane's state is the fallback when it reported none.
                    const url = typeof envelope['url'] === 'string' ? envelope['url'] : (tab?.url ?? '');
                    const title =
                        typeof envelope['title'] === 'string' ? envelope['title'] : (tab?.title ?? '');
                    sendEnvelope(reply, envelope, {
                        ...baseFields(target),
                        tab_id: tabID,
                        mode: msg.mode,
                        url,
                        title
                    });
                });
        }),

        // ── tabs ────────────────────────────────────────────────────────────
        forCommand('web-tabs', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const activeID = target.activeTab?.id ?? null;
            ok(reply, {
                ...baseFields(target),
                tabs: target.web.tabs.map((tab, index) => ({
                    id: tab.id,
                    url: tab.url,
                    title: tab.title,
                    index,
                    active: tab.id === activeID
                }))
            });
        }),

        forCommand('web-tab-new', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const tabID = uuid();
            const url = normalizeURLInput(msg.url);
            ok(reply, {
                ...baseFields(target),
                tab_id: uuidOut(tabID),
                url,
                active: msg.make_active
            });
            ctx.store.dispatch({
                type: 'web-tab-open',
                workspaceID: target.workspace.id,
                paneID: target.paneID,
                tabID,
                url: msg.url,
                makeActive: msg.make_active
            });
            service.notify('tab-open', {
                paneID: target.paneID,
                tabID,
                url,
                makeActive: msg.make_active
            });
            persist();
        }),

        forCommand('web-tab-close', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const resolved = resolveTabRef(target.web, msg.tab);
            if (!resolved.ok) {
                fail(reply, resolved.error);
                return;
            }
            // §5: the GUI turns this into a whole-pane close; the wire refuses instead.
            if (target.web.tabs.length === 1) {
                fail(reply, LAST_TAB_ERROR);
                return;
            }
            ok(reply, { ...baseFields(target), tab_id: resolved.tab.id });
            // §WEB-019: the tab is about to be destroyed, so the per-tab daemon state that
            // would outlive it goes first — an inspector arm on THIS tab can never fire again.
            service.forgetTab(target.paneID, resolved.tab.id);
            ctx.store.dispatch({
                type: 'web-tab-close',
                workspaceID: target.workspace.id,
                paneID: target.paneID,
                tabID: resolved.tab.id
            });
            service.notify('tab-close', { paneID: target.paneID, tabID: resolved.tab.id });
            // WEB-064: an open find follows the pane, not the tab. The reducer has already
            // re-activated a neighbour, so this reads the NEW active tab and re-runs the needle.
            retargetFind(ctx, service, target.paneID);
            persist();
        }),

        forCommand('web-tab-select', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const resolved = resolveTabRef(target.web, msg.tab);
            if (!resolved.ok) {
                fail(reply, resolved.error);
                return;
            }
            ok(reply, { ...baseFields(target), tab_id: resolved.tab.id });
            ctx.store.dispatch({
                type: 'web-tab-select',
                workspaceID: target.workspace.id,
                paneID: target.paneID,
                tabID: resolved.tab.id
            });
            service.notify('tab-select', { paneID: target.paneID, tabID: resolved.tab.id });
            // WEB-064: clear the outgoing tab's marks and re-run the needle on the incoming one.
            service.retargetFind(target.paneID, resolved.tab.id);
            persist();
        }),

        // ── console ─────────────────────────────────────────────────────────
        forCommand('web-console', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const drain = service.console.drain(target.paneID, {
                since: msg.since,
                level: msg.level,
                clear: msg.clear
            });
            const body = {
                ...baseFields(target),
                lines: drain.lines,
                next_since: drain.next_since,
                dropped: drain.dropped,
                follow: msg.follow
            };
            if (!msg.follow || reply === null) {
                ok(reply, body);
                return;
            }
            // §9.3: the drain is line 1 of the stream and the handle stays OPEN. The
            // subscriber slot is released when the client hangs up (the control server fires
            // the handle's disconnect callbacks) or when the pane closes.
            reply.send({ ok: true, ...body });
            const unsubscribe = service.subscribeConsole(target.paneID, {
                push: (line) => {
                    reply.send(line);
                },
                end: () => {
                    reply.close();
                }
            });
            reply.onDisconnect(unsubscribe);
        }),

        // ── element picker ──────────────────────────────────────────────────
        forCommand('web-inspect', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: !msg.disarm });
            if (target === null) return;

            if (msg.disarm) {
                service.inspect.disarm(target.paneID);
                service.notify('inspect-disarm', { paneID: target.paneID });
                ok(reply, { ...baseFields(target), armed: false });
                return;
            }

            let sendTo: string | null = null;
            if (msg.send_to !== undefined && msg.send_to !== '') {
                const destination = resolveWebPaneDestination(ctx, msg, msg.send_to);
                if (!destination.ok) {
                    fail(reply, destination.error);
                    return;
                }
                sendTo = destination.paneID;
            }

            if (!service.hasHost) {
                fail(reply, NO_HOST_ERROR);
                return;
            }
            const tabID = target.activeTab?.id ?? '';
            const nonce = service.inspect.newNonce();
            void service
                .call('inspect-arm', { paneID: target.paneID, tabID, nonce, sticky: false })
                .then((envelope) => {
                    if (envelope['ok'] !== true) {
                        const error =
                            typeof envelope['error'] === 'string' && envelope['error'] !== ''
                                ? envelope['error']
                                : ARM_FAILED_ERROR;
                        fail(reply, error);
                        return;
                    }
                    service.inspect.arm({
                        paneID: target.paneID,
                        tabID,
                        nonce,
                        sendTo,
                        submit: msg.submit
                    });
                    ok(reply, {
                        ...baseFields(target),
                        tab_id: tabID,
                        armed: true,
                        send_to: sendTo === null ? '' : uuidOut(sendTo),
                        submit: msg.submit
                    });
                });
        }),

        forCommand('web-inspect-result', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            // §WEB-124: the single-shot queue FIRST, then anything a batch is still holding —
            // each batch item stamped with its own comment, which is the only place a `comment`
            // field ever comes from. A batch the user has not sent yet is pending work, and
            // `kelpi web inspect-result` is how a headless caller collects it.
            const queued = service.inspect.queued(target.paneID).map(serializeInspectResult);
            const batch = service.batch.sessionOf(target.paneID);
            const pending = (batch?.items ?? []).map((item) =>
                serializeInspectResult({ ...item.result, comment: item.comment })
            );
            ok(reply, { ...baseFields(target), results: [...queued, ...pending] });
            if (!msg.clear) return;
            service.inspect.clearQueue(target.paneID);
            // §WEB-125: `--clear` cancels the BATCH too — but only when there is one. An
            // independently armed single-shot `web inspect` keeps its arm either way.
            if (batch !== null) service.cancelBatch(target.paneID);
        }),

        // ── private mode ────────────────────────────────────────────────────
        forCommand('web-private', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const changed = target.web.isPrivate !== msg.private;
            ok(reply, { ...baseFields(target), private: msg.private, changed });
            if (!changed) return;
            ctx.store.dispatch({
                type: 'web-set-private',
                workspaceID: target.workspace.id,
                paneID: target.paneID,
                isPrivate: msg.private
            });
            // §6: the partition is sealed into the views, so the host rebuilds the pane.
            service.notify('pane-set-private', {
                paneID: target.paneID,
                isPrivate: msg.private,
                activeTabID: target.activeTab?.id ?? null,
                tabs: target.web.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
            });
            persist();
        }),

        // ── cookies (§13.2) ─────────────────────────────────────────────────
        forCommand('web-cookies-list', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const fields = { ...baseFields(target), private: target.web.isPrivate };
            // No coordinator (here: no host) ⇒ reads return empty, never an error.
            if (!service.hasHost) {
                ok(reply, { ...fields, cookies: [] });
                return;
            }
            void service.call('cookies-list', { paneID: target.paneID }).then((envelope) => {
                sendEnvelope(reply, envelope, fields);
            });
        }),

        forCommand('web-cookies-clear', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            if (msg.all && msg.domain !== undefined) {
                fail(reply, COOKIE_SCOPE_ERROR);
                return;
            }
            const domainField = msg.domain === undefined ? {} : { domain: msg.domain };
            if (!service.hasHost) {
                ok(reply, { ...baseFields(target), deleted: 0, ...domainField });
                return;
            }
            void service
                .call('cookies-clear', {
                    paneID: target.paneID,
                    all: msg.all,
                    ...(msg.domain === undefined ? {} : { domain: msg.domain })
                })
                .then((envelope) => {
                    sendEnvelope(reply, envelope, { ...baseFields(target), ...domainField });
                });
        }),

        forCommand('web-cookies-delete', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply);
            if (target === null) return;
            const domainField = msg.domain === undefined ? {} : { domain: msg.domain };
            const fields = { ...baseFields(target), name: msg.name, ...domainField };
            if (!service.hasHost) {
                ok(reply, { ...fields, deleted: 0 });
                return;
            }
            void service
                .call('cookies-delete', {
                    paneID: target.paneID,
                    name: msg.name,
                    ...(msg.domain === undefined ? {} : { domain: msg.domain })
                })
                .then((envelope) => {
                    sendEnvelope(reply, envelope, fields);
                });
        }),

        // ── actuator (§7.4 methods, one host verb) ──────────────────────────
        forCommand('web-click', (msg, ctx, reply) => {
            const options: JsonObject = {
                double: msg.double,
                right: msg.right,
                ...(msg.at_x !== undefined && msg.at_y !== undefined
                    ? { at: { x: msg.at_x, y: msg.at_y } }
                    : {})
            };
            actuate(msg, ctx, reply, 'click', [msg.selector, options]);
        }),

        forCommand('web-type', (msg, ctx, reply) => {
            // §8.2: `replace` is only shipped when false (the JS default is true).
            const options: JsonObject = { submit: msg.submit, ...(msg.replace ? {} : { replace: false }) };
            actuate(msg, ctx, reply, 'type', [msg.selector, msg.text, options]);
        }),

        forCommand('web-q-text', (msg, ctx, reply) => {
            const options: JsonObject = msg.max_bytes === undefined ? {} : { maxBytes: msg.max_bytes };
            actuate(msg, ctx, reply, 'text', [msg.selector, options]);
        }),

        forCommand('web-q-attr', (msg, ctx, reply) => {
            actuate(msg, ctx, reply, 'attr', [msg.selector, msg.attribute]);
        }),

        forCommand('web-q-count', (msg, ctx, reply) => {
            actuate(msg, ctx, reply, 'count', [msg.selector]);
        }),

        forCommand('web-q-exists', (msg, ctx, reply) => {
            actuate(msg, ctx, reply, 'exists', [msg.selector]);
        }),

        forCommand('web-q-dom', (msg, ctx, reply) => {
            const options: JsonObject = msg.max_bytes === undefined ? {} : { maxBytes: msg.max_bytes };
            actuate(msg, ctx, reply, 'dom', [msg.selector, options]);
        }),

        forCommand('web-wait', (msg, ctx, reply) => {
            const options: JsonObject = {
                ...(msg.selector === undefined ? {} : { selector: msg.selector }),
                ...(msg.url_match === undefined ? {} : { urlMatch: msg.url_match }),
                ...(msg.for === undefined ? {} : { for: msg.for }),
                ...(msg.timeout_ms > 0 ? { timeout: msg.timeout_ms } : {})
            };
            // The host's own JS timeout must fire first, so the daemon waits a little longer.
            actuate(msg, ctx, reply, 'wait', [options], waitTimeoutMs(msg.timeout_ms));
        }),

        forCommand('web-select', (msg, ctx, reply) => {
            actuate(msg, ctx, reply, 'select', [msg.selector, msg.value_or_label]);
        }),

        forCommand('web-scroll', (msg, ctx, reply) => {
            const options: JsonObject = { block: msg.block, behavior: msg.behavior };
            actuate(msg, ctx, reply, 'scroll', [msg.selector, options]);
        }),

        forCommand('web-hover', (msg, ctx, reply) => {
            actuate(msg, ctx, reply, 'hover', [msg.selector]);
        }),

        forCommand('web-key', (msg, ctx, reply) => {
            const options: JsonObject = msg.selector === undefined ? {} : { selector: msg.selector };
            actuate(msg, ctx, reply, 'key', [msg.key, options]);
        }),

        forCommand('web-exec', (msg, ctx, reply) => {
            const target = resolveScope(ctx, msg, reply, { requireActiveTab: true });
            if (target === null) return;
            const tabID = target.activeTab?.id ?? '';
            forward(
                reply,
                target,
                'exec',
                { paneID: target.paneID, tabID, script: msg.script },
                { tab_id: tabID },
                HOST_TIMEOUT_EXEC_MS
            );
        })
    ];
}

// ---------------------------------------------------------------------------
// `--send-to` (§11.2)
// ---------------------------------------------------------------------------

type DestinationResolution =
    | { readonly ok: true; readonly paneID: string }
    | { readonly ok: false; readonly error: string };

/**
 * `--send-to` resolves through the standard pane-target rules, scoped exactly like the command
 * that carried it, and the destination must be a SHELL pane — only shells have a PTY to paste
 * into (§17.9). Every failure is prefixed `--send-to: ` so the CLI's one-line error names the
 * flag that was wrong.
 */
function resolveWebPaneDestination(
    ctx: AppContext,
    scope: ScopeFields,
    sendTo: string
): DestinationResolution {
    const state = ctx.store.getState();
    const resolution = resolvePaneTarget(resolveStateOf(state), {
        paneID: scope.pane_id,
        target: sendTo,
        workspaceFilter: scope.workspace
    });
    if (!resolution.ok) return { ok: false, error: `--send-to: ${resolution.error}` };
    const workspace = workspaceByID(state, resolution.workspace.id);
    const pane = workspace === null ? null : visiblePane(workspace, resolution.paneID);
    if (pane === null) {
        return { ok: false, error: `--send-to: pane not found: ${resolution.paneID}` };
    }
    if (pane.type !== 'shell') {
        return {
            ok: false,
            error: `--send-to: destination must be a shell pane (got: ${pane.type})`
        };
    }
    return { ok: true, paneID: pane.id };
}
