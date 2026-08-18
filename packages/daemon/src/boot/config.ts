/**
 * Reading `~/.config/nex/config` on the daemon's behalf.
 *
 * Spec: docs/current/config-keybindings.md §1 (the file lives at literally `~/.config/nex/config`
 * with `~` expanded to `$HOME` — no XDG lookup), §1.5 (profiles), §10 (`tcp-port`).
 * Parsing itself is `@nex/core/config`; this module only does the IO and the "missing file is
 * not an error" policy.
 *
 * Two consumers, two lifetimes:
 *  - general settings are read ONCE at boot (`tcp-port` picks the control listener, and the
 *    listener cannot be re-bound under a live CLI anyway);
 *  - profiles are re-read PER SPAWN (workspace-feature.md §3.4: definitions stay fresh without
 *    a watcher), which `createProfileReader` provides. Boot passes a single batch-cached read
 *    to the restore path instead, per app-state-core.md §12.3 step 7 ("cache per launch batch").
 *
 * `NEXD_CONFIG_PATH` overrides the location. It is additive (the Swift app has no such
 * override) and exists so a dev daemon and tests never read the developer's real config.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
    DEFAULT_GENERAL_SETTINGS,
    parseGeneralSettings,
    parseProfiles,
    type GeneralSettings,
    type Profile
} from '@nex/core/config';

import { expandTilde } from '../lifecycle/rundir.js';

export const CONFIG_PATH_ENV = 'NEXD_CONFIG_PATH';

export interface ConfigLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
}

/** `~/.config/nex/config`, or whatever `NEXD_CONFIG_PATH` names. Does not create anything. */
export function resolveConfigPath(lookup: ConfigLookup = {}): string {
    const env = lookup.env ?? process.env;
    const home = lookup.home ?? homedir();
    const override = env[CONFIG_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) {
        return path.resolve(expandTilde(override, home));
    }
    return path.join(home, '.config', 'nex', 'config');
}

/** File contents, or `''` for "no config" — a missing/unreadable file is never fatal. */
export function readConfigContents(configPath: string): string {
    try {
        return fs.readFileSync(configPath, 'utf8');
    } catch {
        return '';
    }
}

export interface DaemonConfig {
    readonly path: string;
    readonly exists: boolean;
    readonly general: GeneralSettings;
    readonly profiles: readonly Profile[];
}

export interface LoadConfigOptions extends ConfigLookup {
    /** Use this path verbatim instead of resolving one. */
    readonly path?: string | undefined;
}

/** One read, both parses. Values keep `~` expanded against `home` (the spawn-time contract). */
export function loadDaemonConfig(options: LoadConfigOptions = {}): DaemonConfig {
    const home = options.home ?? homedir();
    const configPath =
        options.path ?? resolveConfigPath({ ...(options.env !== undefined ? { env: options.env } : {}), home });
    const contents = readConfigContents(configPath);
    if (contents === '') {
        return { path: configPath, exists: false, general: DEFAULT_GENERAL_SETTINGS, profiles: [] };
    }
    return {
        path: configPath,
        exists: true,
        general: parseGeneralSettings(contents),
        profiles: parseProfiles(contents, { expandTilde: true, home })
    };
}

/**
 * The `ctx.profiles` seam: re-reads the file on every call so a profile edited while the
 * daemon runs applies to the next pane spawned, with no watcher and no restart.
 */
export function createProfileReader(
    options: LoadConfigOptions = {}
): () => readonly Profile[] {
    const home = options.home ?? homedir();
    const configPath =
        options.path ?? resolveConfigPath({ ...(options.env !== undefined ? { env: options.env } : {}), home });
    return () => parseProfiles(readConfigContents(configPath), { expandTilde: true, home });
}

/** `tcp-port = <port>`; `0` (the parser's default) means "no TCP listener". */
export function configuredTcpPort(config: DaemonConfig): number | undefined {
    return config.general.tcpPort > 0 ? config.general.tcpPort : undefined;
}
