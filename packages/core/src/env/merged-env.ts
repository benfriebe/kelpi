/**
 * Spawn-time environment composition - the ONLY point where profile env reaches a PTY.
 * Spec: docs/current/config-keybindings.md §9.1–9.3, workspace-feature.md §3.4.
 */

import type { Profile } from '../config/profiles.js';

/** The built-in baseline profile; `profileName == null` resolves to it. */
export const DEFAULT_PROFILE_NAME = 'default';

export const NEX_PROFILE_ENV_KEY = 'NEX_PROFILE';
export const NEX_PANE_ID_ENV_KEY = 'NEX_PANE_ID';

/** Built-ins always win; a profile line defining either is silently ignored. */
export const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([NEX_PANE_ID_ENV_KEY, 'PATH']);

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
 * `resolveEnv(name)`: the named profile's vars plus a canonical `NEX_PROFILE` marker
 * merged LAST, so a config line spoofing `NEX_PROFILE` loses. An undefined profile
 * resolves to just the marker.
 */
export function resolveProfileEnv(
    profiles: readonly Profile[],
    name: string
): Record<string, string> {
    const found = profiles.find((profile) => profile.name === name);
    const env: Record<string, string> = { ...(found?.env ?? {}) };
    env[NEX_PROFILE_ENV_KEY] = name;
    return env;
}

/** `helpersDir` is prepended so the bundled `nex` CLI shadows the app binary. */
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
    readonly profileEnv: Readonly<Record<string, string>>;
}

/**
 * Ordering is contractual: `NEX_PANE_ID`, then `PATH`, then the profile's vars sorted by
 * key with the reserved keys filtered out.
 */
export function mergedEnvVars(input: MergedEnvInput): EnvVar[] {
    const result: EnvVar[] = [
        { key: NEX_PANE_ID_ENV_KEY, value: input.paneID },
        { key: 'PATH', value: input.path }
    ];
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
        profileEnv: resolveProfileEnv(input.profiles, name)
    });
}
