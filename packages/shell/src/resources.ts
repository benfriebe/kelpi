/**
 * The packaged app's `Contents/Resources` layout — one module, shared by the three parties
 * that must agree on it: the Forge config that *writes* it, `daemon.ts` which *reads* it at
 * launch, and `scripts/packaged-smoke.mjs` which *asserts* it.
 *
 * ```
 * Nex.app/Contents/Resources/
 * ├─ app.asar                the shell itself (dist/main.js + package.json), asar-packed
 * ├─ daemon/                 the daemon payload — OUTSIDE the asar on purpose
 * │  ├─ nexd.js              …a detached `node` process has to execute this file, and
 * │  ├─ nexd.js.map           node-pty has to dlopen a .node from a real directory; neither
 * │  ├─ payload.json          works from inside an archive. (packages/daemon/scripts/
 * │  └─ node_modules/node-pty stage-payload.mjs owns everything under here.)
 * ├─ client/                 the built web UI, handed to the daemon as NEXD_CLIENT_DIR
 * │  └─ index.html
 * └─ node                    a Node 24 runtime for the daemon (NOT Electron — stack.md's
 *                            "do not use ELECTRON_RUN_AS_NODE")
 * ```
 *
 * Nothing here touches Electron, so the build scripts can import it as freely as the main
 * process does.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Directory/file names inside `Contents/Resources`. Change here, and everywhere follows. */
export const RESOURCE_NAMES = {
    /** The daemon payload directory (`nexd.js` + `node_modules/node-pty`). */
    daemon: 'daemon',
    /** The built web client (`index.html` + assets). */
    client: 'client',
    /** The bundled Node runtime that runs the daemon. */
    node: 'node'
} as const;

/** The daemon entry script inside a packaged app (`daemon.ts` looks here third). */
export function packagedDaemonEntry(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.daemon, 'nexd.js');
}

/** The client build inside a packaged app — what the shell hands the daemon as its client dir. */
export function packagedClientDir(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.client);
}

/** The bundled Node runtime inside a packaged app (`resolveNodeBinary` looks here second). */
export function packagedNodeBinary(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.node);
}

/**
 * Is this directory a usable client build?
 *
 * The daemon's static route needs an `index.html` to serve; without one it answers its own
 * "client not built" page. Pointing it at an empty directory would therefore be worse than
 * leaving `NEXD_CLIENT_DIR` unset, because it looks configured and behaves as if it is not.
 */
export function hasClientBuild(dir: string | undefined): boolean {
    if (dir === undefined || dir.length === 0) return false;
    try {
        return statSync(path.join(dir, 'index.html')).isFile();
    } catch {
        return false;
    }
}

/** True when `resourcesPath` looks like a packaged app that carries a daemon payload. */
export function hasDaemonPayload(resourcesPath: string | undefined): boolean {
    if (resourcesPath === undefined || resourcesPath.length === 0) return false;
    return existsSync(packagedDaemonEntry(resourcesPath));
}
