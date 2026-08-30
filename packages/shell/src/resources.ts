/**
 * The packaged app's `Contents/Resources` layout — one module, shared by the three parties
 * that must agree on it: the Forge config that *writes* it, `daemon.ts` which *reads* it at
 * launch, and `scripts/packaged-smoke.mjs` which *asserts* it.
 *
 * ```
 * Kelpi.app/Contents/Resources/
 * ├─ app.asar                the shell itself (dist/main.js + package.json), asar-packed
 * ├─ daemon/                 the daemon payload — OUTSIDE the asar on purpose
 * │  ├─ kelpid.js              …a detached `node` process has to execute this file, and
 * │  ├─ kelpid.js.map           node-pty has to dlopen a .node from a real directory; neither
 * │  ├─ payload.json          works from inside an archive. (packages/daemon/scripts/
 * │  └─ node_modules/node-pty stage-payload.mjs owns everything under here.)
 * ├─ client/                 the built web UI, handed to the daemon as KELPID_CLIENT_DIR
 * │  └─ index.html
 * ├─ cli/                    the `kelpi` CLI, so the app can install it (`./cli-install.ts`)
 * │  ├─ kelpi                  …a POSIX-sh launcher: it is what `/usr/local/bin/kelpi` points at,
 * │  ├─ kelpi.js                and it execs the bundle under the app's own `node`, so a machine
 * │  └─ kelpi.js.map            with no Node on PATH still gets a working CLI.
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
    /** The daemon payload directory (`kelpid.js` + `node_modules/node-pty`). */
    daemon: 'daemon',
    /** The built web client (`index.html` + assets). */
    client: 'client',
    /** The `kelpi` CLI payload (`kelpi` launcher + `kelpi.js` bundle). */
    cli: 'cli',
    /** The bundled Node runtime that runs the daemon. */
    node: 'node'
} as const;

/** The launcher `/usr/local/bin/kelpi` is symlinked to (`./cli-install.ts`). */
export const CLI_LAUNCHER_NAME = 'kelpi';
/**
 * The pre-rename launcher name, staged beside `kelpi` with identical content. Healed legacy
 * `/usr/local/bin/nex` links point here, so every hook installed before the Kelpi rename keeps
 * resolving without a rewrite.
 */
export const CLI_COMPAT_LAUNCHER_NAME = 'nex';
/** The esbuild bundle the launcher executes. */
export const CLI_BUNDLE_NAME = 'kelpi.js';

/** The daemon entry script inside a packaged app (`daemon.ts` looks here third). */
export function packagedDaemonEntry(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.daemon, 'kelpid.js');
}

/** The client build inside a packaged app — what the shell hands the daemon as its client dir. */
export function packagedClientDir(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.client);
}

/** The CLI launcher inside a packaged app — the symlink target `./cli-install.ts` installs. */
export function packagedCliLauncher(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.cli, CLI_LAUNCHER_NAME);
}

/** The pre-rename `nex` compat launcher — the heal target for legacy `/usr/local/bin/nex` links. */
export function packagedCliCompatLauncher(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.cli, CLI_COMPAT_LAUNCHER_NAME);
}

/** The CLI payload directory — what the shell hands the daemon as `KELPID_HELPERS_DIR`. */
export function packagedCliDir(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.cli);
}

/** The bundled Claude Code skill's name — `kelpi install-hooks` is what installs it. */
export const BUNDLED_SKILL_NAME = 'nex-agentic';

/**
 * `Contents/Resources/cli/skills/nex-agentic` — staged beside the CLI bundle by
 * `scripts/stage-resources.mjs`, because `kelpi install-hooks` looks for it there first.
 */
export function packagedSkillDir(resourcesPath: string): string {
    return path.join(resourcesPath, RESOURCE_NAMES.cli, 'skills', BUNDLED_SKILL_NAME);
}

/** True when `resourcesPath` carries a CLI payload we could install. */
export function hasCliPayload(resourcesPath: string | undefined): boolean {
    if (resourcesPath === undefined || resourcesPath.length === 0) return false;
    return existsSync(packagedCliLauncher(resourcesPath));
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
 * leaving `KELPID_CLIENT_DIR` unset, because it looks configured and behaves as if it is not.
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
