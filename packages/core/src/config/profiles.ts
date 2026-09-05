/**
 * `profile = <name>:<KEY>=<value>` line parsing and serialization.
 * Spec: docs/config-keybindings.md §1.5, §1.6.
 */

import { parseConfigLines } from './lines.js';

export interface Profile {
    readonly name: string;
    readonly env: Readonly<Record<string, string>>;
}

export interface ParseProfilesOptions {
    /**
     * Expand a leading `~` in values (default true, matching the spawn-time parse).
     * The Settings editor parses with `false` so a UI round-trip never rewrites the
     * user's `~` paths. Expansion is a no-op unless `home` is supplied, since this
     * module performs no IO.
     */
    readonly expandTilde?: boolean | undefined;
    /** The value `~` expands to (the daemon passes `os.homedir()`). */
    readonly home?: string | undefined;
}

function expandLeadingTilde(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
    // `~user/...` needs a passwd lookup; leave it verbatim (Foundation does the same
    // for an unknown user).
    return value;
}

/**
 * One env var per line. Split the value at its FIRST `:` (name) and the remainder at its
 * FIRST `=` (key), so values may contain both `:` and `=`
 * (`work:URL=http://x:8080/a=b` → key `URL`, value `http://x:8080/a=b`).
 * Quotes are literal - never stripped. Repeated lines with the same profile name merge;
 * on env-key collision the LATER line wins. Order is first appearance in the file.
 */
export function parseProfiles(contents: string, options: ParseProfilesOptions = {}): Profile[] {
    const expandTilde = options.expandTilde ?? true;
    const home = options.home;
    const order: string[] = [];
    const byName = new Map<string, Record<string, string>>();

    for (const line of parseConfigLines(contents)) {
        if (line.key !== 'profile') continue;
        const nameSeparator = line.value.indexOf(':');
        if (nameSeparator < 0) continue;
        const name = line.value.slice(0, nameSeparator).trim();
        const assignment = line.value.slice(nameSeparator + 1);
        const valueSeparator = assignment.indexOf('=');
        if (valueSeparator < 0) continue;
        const envKey = assignment.slice(0, valueSeparator).trim();
        let envValue = assignment.slice(valueSeparator + 1).trim();
        if (name === '' || envKey === '') continue;
        if (expandTilde && home !== undefined && envValue.startsWith('~')) {
            envValue = expandLeadingTilde(envValue, home);
        }
        let env = byName.get(name);
        if (env === undefined) {
            env = {};
            byName.set(name, env);
            order.push(name);
        }
        env[envKey] = envValue;
    }

    return order.map((name) => ({ name, env: byName.get(name) ?? {} }));
}

/**
 * §1.6 step 2 - one line per env var, env keys sorted alphabetically within each
 * profile, profiles in array order. Profiles with a blank name and vars with a blank key
 * are skipped, so a profile needs at least one valid var to survive a round-trip.
 */
export function serializeProfileLines(profiles: readonly Profile[]): string[] {
    const lines: string[] = [];
    for (const profile of profiles) {
        const name = profile.name.trim();
        if (name === '') continue;
        const keys = Object.keys(profile.env)
            .filter((key) => key.trim() !== '')
            .sort();
        for (const key of keys) {
            lines.push(`profile = ${name}:${key.trim()}=${profile.env[key] ?? ''}`);
        }
    }
    return lines;
}
