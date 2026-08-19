/**
 * The CLI's own identity (cli.md §3.1, port note 9).
 *
 * The Swift binary walked symlinks to the enclosing `Nex.app/Contents/Info.plist` because the
 * CLI and the app were one artifact; a bundled TS CLI has no bundle to walk, so the version is
 * compiled in and overridable at runtime by the packaging step. `"dev"` stays the unknown
 * fallback, and `nex --version` still prints `nex <version>`.
 *
 * `build` matters as much as `version` here: in the new architecture the CLI and the daemon
 * are SEPARATE artifacts, so doctor compares the whole identity (and, ahead of it, the wire
 * protocol number) rather than assuming one bundle shipped both. See `doctor/checks.ts`.
 */

import { PROTOCOL_VERSION } from '@nex/protocol';

/** Keep in step with `packages/cli/package.json`. */
export const CLI_VERSION = '0.1.0';
/** Stamped by the packaging step through `NEX_CLI_BUILD`; a local build is just "dev". */
export const CLI_BUILD = 'dev';

export const VERSION_ENV = 'NEX_CLI_VERSION';
export const BUILD_ENV = 'NEX_CLI_BUILD';

function override(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
    const raw = env[key]?.trim();
    return raw !== undefined && raw.length > 0 ? raw : fallback;
}

export interface CliIdentity {
    readonly version: string;
    readonly build: string;
    readonly protocol: number;
}

export function resolveCliIdentity(env: NodeJS.ProcessEnv = process.env): CliIdentity {
    return {
        version: override(env, VERSION_ENV, CLI_VERSION),
        build: override(env, BUILD_ENV, CLI_BUILD),
        protocol: PROTOCOL_VERSION
    };
}
