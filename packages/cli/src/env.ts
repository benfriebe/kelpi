/**
 * Environment reads (cli.md §4). One module so the table in the spec has exactly one
 * implementation, and so tests can drive a synthetic environment.
 *
 * `NEX_PANE_ID` has two distinct readings and both are load-bearing:
 *   - `requirePaneID()` — the caller-pane subject. **Unset ⇒ silent exit 0** so hooks and
 *     scripts run outside Nex do nothing rather than fail. A value that is set-but-empty is
 *     used verbatim (the Swift `guard let` has no `isEmpty` check).
 *   - `originPaneID()` — the label-scoping hint attached to most payloads, which DOES drop
 *     the empty string (`flatMap { $0.isEmpty ? nil : $0 }` in the Swift source).
 * `nex md` / `nex open` / `nex diff` deliberately use the *first* reading when forwarding
 * `pane_id`, so they ship an empty string where other commands omit the key.
 */

import { homedir } from 'node:os';

import { exit } from './io.js';

export type Env = NodeJS.ProcessEnv;

let current: Env = process.env;

export function setEnv(env: Env): void {
    current = env;
}

export function env(): Env {
    return current;
}

export function envValue(name: string): string | undefined {
    return current[name];
}

/** The caller pane, or a silent `exit(0)` when `NEX_PANE_ID` is unset. */
export function requirePaneID(): string {
    const value = current['NEX_PANE_ID'];
    if (value === undefined) exit(0);
    return value;
}

/** `NEX_PANE_ID` when set AND non-empty — the label-scoping hint. */
export function originPaneID(): string | undefined {
    const value = current['NEX_PANE_ID'];
    return value !== undefined && value.length > 0 ? value : undefined;
}

/** `NEX_PANE_ID` when set, empty string included (`open` / `md` / `diff` forward this). */
export function rawPaneID(): string | undefined {
    return current['NEX_PANE_ID'];
}

/** `$HOME`, falling back to the passwd-database home directory (the Swift fallback). */
export function homeDirectory(): string {
    const home = current['HOME'];
    if (home !== undefined && home.length > 0) return home;
    return homedir();
}

/** `NEX_SILENT` — any value suppresses fire-and-forget transport warnings. */
export function silentRequested(): boolean {
    return current['NEX_SILENT'] !== undefined;
}

/** `NEX_VERBOSE_HOOKS` — any value re-enables warnings for `nex event …`. */
export function verboseHooksRequested(): boolean {
    return current['NEX_VERBOSE_HOOKS'] !== undefined;
}

/** Default request/response read timeout in seconds; `NEX_REPLY_TIMEOUT` overrides. */
export function replyTimeoutSeconds(): number {
    const raw = current['NEX_REPLY_TIMEOUT'];
    if (raw !== undefined && /^[+-]?\d+$/.test(raw)) {
        const parsed = Number.parseInt(raw, 10);
        if (parsed > 0) return parsed;
    }
    return 5;
}
