/**
 * Where the control transport listens (wire-protocol.md §1, PLAN.md decisions).
 *
 * `/tmp/nex.sock` is the production path — the shipped Swift CLI hardcodes it, so it is not
 * configurable from the daemon's side without breaking `kelpi`. The two env overrides exist
 * for development, where the real Swift app owns that socket on this machine:
 *
 *   KELPID_SOCKET_PATH=/tmp/kelpid-dev.sock   (CLI reaches it via NEX_SOCKET / a symlink)
 *   KELPID_TCP_PORT=19400                   (CLI reaches it via NEX_SOCKET=tcp:…)
 *
 * The env vars win over the config file's `tcp-port` so a dev daemon can always be pushed
 * off the shared endpoints without editing the user's `~/.config/nex/config`.
 */

import { expandTilde } from '../lifecycle/rundir.js';

export const DEFAULT_CONTROL_SOCKET_PATH = '/tmp/nex.sock';
export const SOCKET_PATH_ENV = 'KELPID_SOCKET_PATH';
export const TCP_PORT_ENV = 'KELPID_TCP_PORT';

export interface ControlEndpoints {
    readonly socketPath: string;
    /** Absent = no TCP listener. */
    readonly tcpPort?: number | undefined;
    /** Where each value came from (diagnostics / `kelpi doctor`). */
    readonly source: { readonly socketPath: 'env' | 'config' | 'default'; readonly tcpPort: 'env' | 'config' | 'none' };
}

export interface ControlEndpointDefaults {
    /** From the config file, if the caller read one. */
    readonly socketPath?: string | undefined;
    /** `tcp-port = <port>` from `~/.config/nex/config`. */
    readonly tcpPort?: number | undefined;
}

/** A port is usable when it is an integer in `[0, 65535]`; anything else is ignored. */
function parsePort(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return undefined;
    const port = Number.parseInt(trimmed, 10);
    return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

export function resolveControlEndpoints(
    env: NodeJS.ProcessEnv = process.env,
    defaults: ControlEndpointDefaults = {}
): ControlEndpoints {
    const envPath = env[SOCKET_PATH_ENV]?.trim();
    const envPort = parsePort(env[TCP_PORT_ENV]);

    const socketPath =
        envPath !== undefined && envPath.length > 0
            ? expandTilde(envPath)
            : (defaults.socketPath ?? DEFAULT_CONTROL_SOCKET_PATH);
    const socketSource: ControlEndpoints['source']['socketPath'] =
        envPath !== undefined && envPath.length > 0 ? 'env' : defaults.socketPath !== undefined ? 'config' : 'default';

    const tcpPort = envPort ?? defaults.tcpPort;
    const tcpSource: ControlEndpoints['source']['tcpPort'] =
        envPort !== undefined ? 'env' : defaults.tcpPort !== undefined ? 'config' : 'none';

    return {
        socketPath,
        ...(tcpPort !== undefined ? { tcpPort } : {}),
        source: { socketPath: socketSource, tcpPort: tcpSource }
    };
}
