/**
 * `ping` (socket-handlers.md §10) — the one command that always succeeds.
 *
 * `nex doctor` keys off every field: `version`/`build` flag CLI/app drift, `pid` tells a stale
 * socket file from a wedged daemon. `protocol` is ADDITIVE (the Swift app never sent it, and
 * the CLI ignores unknown keys) so a daemon-aware CLI can negotiate later.
 *
 * `persistence` is additive for the same reason, and it is not optional decoration: "always
 * succeeds" must never mean "always looks fine". A daemon whose database failed to open answers
 * `ping` perfectly well while losing every workspace on restart, so the reply carries the
 * degraded flag, the file and the errno — that is what `nexd status` prints and what turns a
 * cheerful health check into an honest one.
 */

import { forCommand } from './common.js';
import { ok, type AppHandler } from './context.js';

export function pingHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('ping', (_msg, ctx, reply) => {
            const health = ctx.persistenceHealth?.();
            ok(reply, {
                version: ctx.version.version,
                build: ctx.version.build,
                pid: process.pid,
                protocol: ctx.version.protocol,
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
