/**
 * The daemon's identity: what `ping` reports and what a client checks for drift.
 *
 * `version` / `build` are compiled-in constants (kept in step with
 * `packages/daemon/package.json`) so a single-file bundle needs no package.json beside it.
 * Both are env-overridable — the packaging step can stamp a real build number without a
 * rebuild, and `kelpi doctor`'s version check gets something truthful either way.
 *
 * `protocol` is NOT overridable: it is the compiled-in `PROTOCOL_VERSION`, which also names
 * the run-dir socket (`daemon-v<N>.sock`). Lying about it would let two daemons that cannot
 * talk to each other's clients share a socket.
 */

import { PROTOCOL_VERSION } from '@kelpi/protocol';

/** Keep in step with `packages/daemon/package.json`. */
export const DAEMON_VERSION = '0.1.0';
export const DAEMON_BUILD = '1';

export const VERSION_ENV = 'KELPID_VERSION';
export const BUILD_ENV = 'KELPID_BUILD';

export interface DaemonVersion {
    readonly version: string;
    readonly build: string;
    readonly protocol: number;
}

function override(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
    const raw = env[key]?.trim();
    return raw !== undefined && raw.length > 0 ? raw : fallback;
}

export function resolveDaemonVersion(env: NodeJS.ProcessEnv = process.env): DaemonVersion {
    return {
        version: override(env, VERSION_ENV, DAEMON_VERSION),
        build: override(env, BUILD_ENV, DAEMON_BUILD),
        protocol: PROTOCOL_VERSION
    };
}
