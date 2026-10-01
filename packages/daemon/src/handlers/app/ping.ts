/**
 * `ping` (socket-handlers.md §10) — the one command that always succeeds.
 *
 * `kelpi doctor` keys off every field: `version`/`build` flag CLI/app drift, `pid` tells a stale
 * socket file from a wedged daemon. `protocol` is ADDITIVE (the Swift app never sent it, and
 * the CLI ignores unknown keys) so a daemon-aware CLI can negotiate later.
 *
 * `persistence` is additive for the same reason, and it is not optional decoration: "always
 * succeeds" must never mean "always looks fine". A daemon whose database failed to open answers
 * `ping` perfectly well while losing every workspace on restart, so the reply carries the
 * degraded flag, the file and the errno — that is what `kelpid status` prints and what turns a
 * cheerful health check into an honest one.
 *
 * `terminals` is additive too (#311). `kelpid stop` reads it to say what a stop would end before
 * it sends the signal: a recalled `kelpid stop` once ended 42 terminals and three agents with no
 * question asked.
 */

import { forCommand } from './common.js';
import { ok, type AppContext, type AppHandler } from './context.js';

/** Live terminals and the agent sessions in them, as `ping` reports them (#311). */
export interface TerminalCounts {
    /** Panes, visible or parked, with a running PTY. */
    readonly live: number;
    /** Live panes with an agent session or an agent status. */
    readonly agents: number;
    readonly running: number;
    readonly waiting: number;
}

export function terminalCounts(ctx: Pick<AppContext, 'store' | 'pty'>): TerminalCounts {
    let live = 0;
    let agents = 0;
    let running = 0;
    let waiting = 0;
    for (const workspace of ctx.store.getState().workspaces) {
        for (const pane of [...workspace.panes, ...workspace.parkedPanes]) {
            if (!ctx.pty.has(pane.id)) continue;
            live += 1;
            if (pane.agentSessionID === null && pane.status === 'idle') continue;
            agents += 1;
            if (pane.status === 'running') running += 1;
            else if (pane.status === 'waitingForInput') waiting += 1;
        }
    }
    return { live, agents, running, waiting };
}

export function pingHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('ping', (_msg, ctx, reply) => {
            const health = ctx.persistenceHealth?.();
            const http = ctx.httpEndpoint?.();
            // §SET-021 / §AGNT-005: additive for the same reason `persistence` is. A daemon whose
            // `tcp-port` never bound answers `ping` on the Unix socket perfectly well while every
            // dev-container `KELPI_SOCKET=tcp:…` client times out; the reply is where that stops
            // being invisible (`kelpid status` prints it, Settings ▸ Network shows it).
            const transport = ctx.controlTransport?.();
            const tcp = transport?.tcp ?? null;
            // `compat` / `pane_route` are additive too. A compat socket owned by another Kelpi
            // (the Swift app) never answers here, so THIS reply — reached via the run-dir
            // socket or a pane's injected KELPI_SOCKET, is where a doctor learns why.
            const compat = transport?.compat ?? null;
            const paneRoute = transport?.paneRoute ?? null;
            ok(reply, {
                version: ctx.version.version,
                build: ctx.version.build,
                pid: process.pid,
                protocol: ctx.version.protocol,
                ...(http === undefined ? {} : { http }),
                ...(tcp === null
                    ? {}
                    : {
                          tcp: {
                              requested: tcp.requested,
                              host: tcp.host,
                              ...(tcp.bound !== null ? { bound: tcp.bound } : {}),
                              ...(tcp.error !== null ? { error: tcp.error } : {})
                          }
                      }),
                ...(compat === null ? {} : { compat: { path: compat.path, error: compat.error } }),
                ...(paneRoute === null ? {} : { pane_route: paneRoute }),
                terminals: terminalCounts(ctx),
                ...(health === undefined
                    ? {}
                    : {
                          persistence: {
                              ok: health.available && !health.degraded,
                              degraded: health.degraded,
                              path: health.path,
                              failed_saves: health.failedSaves,
                              last_save_at: health.lastSaveAt,
                              ...(health.error !== null ? { error: health.error } : {}),
                              ...(health.errno !== null ? { errno: health.errno } : {}),
                              ...(health.phase !== null ? { phase: health.phase } : {})
                          }
                      })
            });
        })
    ];
}
