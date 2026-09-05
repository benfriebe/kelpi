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
 */

import { forCommand } from './common.js';
import { ok, type AppHandler } from './context.js';

export function pingHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('ping', (_msg, ctx, reply) => {
            const health = ctx.persistenceHealth?.();
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
