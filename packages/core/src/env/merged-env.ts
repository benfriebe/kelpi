/**
 * Spawn-time environment composition - the ONLY point where profile env reaches a PTY.
 *
 * Panes are addressed by `KELPI_*` variables, with `NEX_*` duplicates injected beside them:
 * hooks, skills and CLIs written before the Kelpi rename (the shipped Swift `nex` included)
 * read the old names, and a duplicate env var costs nothing. The `KELPI_*` names are canonical;
 * the `NEX_*` names are the compatibility surface.
 */

import type { Profile } from '../config/profiles.js';

/** The built-in baseline profile; `profileName == null` resolves to it. */
export const DEFAULT_PROFILE_NAME = 'default';

export const KELPI_PROFILE_ENV_KEY = 'KELPI_PROFILE';
export const KELPI_PANE_ID_ENV_KEY = 'KELPI_PANE_ID';
export const KELPI_SOCKET_ENV_KEY = 'KELPI_SOCKET';

/** Pre-rename names, still injected and still honoured on the read side. */
export const NEX_PROFILE_ENV_KEY = 'NEX_PROFILE';
export const NEX_PANE_ID_ENV_KEY = 'NEX_PANE_ID';
export const NEX_SOCKET_ENV_KEY = 'NEX_SOCKET';

/** Built-ins always win; a profile line defining any of these is silently ignored. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
    KELPI_PANE_ID_ENV_KEY,
    KELPI_SOCKET_ENV_KEY,
    NEX_PANE_ID_ENV_KEY,
    NEX_SOCKET_ENV_KEY,
    'PATH'
]);

/** Used when the daemon process has no inherited PATH. */
export const FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface EnvVar {
    readonly key: string;
    readonly value: string;
}

/**
 * `normalizedAssignment(raw)`: trim; empty or the literal `default` → null. So `default`,
 * `--clear`, an empty string, and a fresh workspace are ONE stored state.
 */
export function normalizedAssignment(raw: string | null | undefined): string | null {
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed === '' || trimmed === DEFAULT_PROFILE_NAME) return null;
    return trimmed;
}

/** The profile name a workspace actually spawns with. */
export function effectiveProfileName(profileName: string | null | undefined): string {
    return profileName ?? DEFAULT_PROFILE_NAME;
}

/** True when the name has at least one `profile` line (drives the undefined-profile warning). */
export function isDefinedProfile(profiles: readonly Profile[], name: string): boolean {
    return profiles.some((profile) => profile.name === name);
}

/**
 * `resolveEnv(name)`: the named profile's vars plus canonical `KELPI_PROFILE` / `NEX_PROFILE`
 * markers merged LAST, so a config line spoofing either loses. An undefined profile resolves
 * to just the markers.
 */
export function resolveProfileEnv(
    profiles: readonly Profile[],
    name: string
): Record<string, string> {
    const found = profiles.find((profile) => profile.name === name);
    const env: Record<string, string> = { ...(found?.env ?? {}) };
    env[KELPI_PROFILE_ENV_KEY] = name;
    env[NEX_PROFILE_ENV_KEY] = name;
    return env;
}

/** `helpersDir` is prepended so the bundled `kelpi` CLI shadows the app binary. */
export function buildPanePath(helpersDir: string, inheritedPath?: string | null): string {
    const inherited = inheritedPath === null || inheritedPath === undefined || inheritedPath === ''
        ? FALLBACK_PATH
        : inheritedPath;
    return `${helpersDir}:${inherited}`;
}

export interface MergedEnvInput {
    readonly paneID: string;
    /** The fully composed PATH (see `buildPanePath`). */
    readonly path: string;
    /**
     * `KELPI_SOCKET` / `NEX_SOCKET` value routing this pane's CLI back to the daemon that
     * spawned it (`tcp:127.0.0.1:<port>`). Every CLI generation honors `tcp:` and silently
     * falls back to its default socket for anything else, so this is the ONE form that routes
     * correctly no matter which binary the pane's PATH resolves — the shared default socket
     * may belong to another instance entirely. Null/absent = no injection.
     */
    readonly socketRoute?: string | null | undefined;
    readonly profileEnv: Readonly<Record<string, string>>;
}

/**
 * Ordering is contractual: `KELPI_PANE_ID`, `NEX_PANE_ID`, then `PATH`, then `KELPI_SOCKET`
 * and `NEX_SOCKET` (only when a route is given), then the profile's vars sorted by key with
 * the reserved keys filtered out.
 */
export function mergedEnvVars(input: MergedEnvInput): EnvVar[] {
    const result: EnvVar[] = [
        { key: KELPI_PANE_ID_ENV_KEY, value: input.paneID },
        { key: NEX_PANE_ID_ENV_KEY, value: input.paneID },
        { key: 'PATH', value: input.path }
    ];
    if (input.socketRoute !== undefined && input.socketRoute !== null && input.socketRoute !== '') {
        result.push({ key: KELPI_SOCKET_ENV_KEY, value: input.socketRoute });
        result.push({ key: NEX_SOCKET_ENV_KEY, value: input.socketRoute });
    }
    for (const key of Object.keys(input.profileEnv).sort()) {
        if (RESERVED_ENV_KEYS.has(key)) continue;
        result.push({ key, value: input.profileEnv[key] ?? '' });
    }
    return result;
}

export interface PaneSpawnEnvInput {
    readonly paneID: string;
    readonly helpersDir: string;
    readonly inheritedPath?: string | null | undefined;
    /** See `MergedEnvInput.socketRoute`. */
    readonly socketRoute?: string | null | undefined;
    /** The workspace's stored assignment; null = the built-in `default` baseline. */
    readonly profileName: string | null | undefined;
    readonly profiles: readonly Profile[];
}

/** Every spawn path resolves the profile the same way: `resolveEnv(profileName ?? "default")`. */
export function paneSpawnEnvVars(input: PaneSpawnEnvInput): EnvVar[] {
    const name = effectiveProfileName(normalizedAssignment(input.profileName));
    return mergedEnvVars({
        paneID: input.paneID,
        path: buildPanePath(input.helpersDir, input.inheritedPath),
        ...(input.socketRoute !== undefined ? { socketRoute: input.socketRoute } : {}),
        profileEnv: resolveProfileEnv(input.profiles, name)
    });
}
