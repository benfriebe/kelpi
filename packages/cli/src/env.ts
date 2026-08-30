/**
 * Environment reads (cli.md §4). One module so the table in the spec has exactly one
 * implementation, and so tests can drive a synthetic environment.
 *
 * `NEX_PANE_ID` has two distinct readings and both are load-bearing:
 *   - `requirePaneID()` — the caller-pane subject. **Unset ⇒ silent exit 0** so hooks and
 *     scripts run outside Kelpi do nothing rather than fail. A value that is set-but-empty is
 *     used verbatim (the Swift `guard let` has no `isEmpty` check).
 *   - `originPaneID()` — the label-scoping hint attached to most payloads, which DOES drop
 *     the empty string (`flatMap { $0.isEmpty ? nil : $0 }` in the Swift source).
 * `kelpi md` / `kelpi open` / `kelpi diff` deliberately use the *first* reading when forwarding
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

function paneIDValue(): string | undefined {
    return current['KELPI_PANE_ID'];
}

/** The caller pane, or a silent `exit(0)` when no pane id is set. */
export function requirePaneID(): string {
    const value = paneIDValue();
    if (value === undefined) exit(0);
    return value;
}

/** The pane id when set AND non-empty — the label-scoping hint. */
export function originPaneID(): string | undefined {
    const value = paneIDValue();
    return value !== undefined && value.length > 0 ? value : undefined;
}

/** The pane id when set, empty string included (`open` / `md` / `diff` forward this). */
export function rawPaneID(): string | undefined {
    return paneIDValue();
}

/** `$HOME`, falling back to the passwd-database home directory (the Swift fallback). */
export function homeDirectory(): string {
    const home = current['HOME'];
    if (home !== undefined && home.length > 0) return home;
    return homedir();
}

/** `KELPI_SILENT` — any value suppresses fire-and-forget transport warnings. */
export function silentRequested(): boolean {
    return current['KELPI_SILENT'] !== undefined;
}

/** `KELPI_VERBOSE_HOOKS` — any value re-enables warnings for `kelpi event …`. */
export function verboseHooksRequested(): boolean {
    return current['KELPI_VERBOSE_HOOKS'] !== undefined;
}

/** Default request/response read timeout in seconds; `KELPI_REPLY_TIMEOUT` overrides. */
export function replyTimeoutSeconds(): number {
    const raw = current['KELPI_REPLY_TIMEOUT'];
    if (raw !== undefined && /^[+-]?\d+$/.test(raw)) {
        const parsed = Number.parseInt(raw, 10);
        if (parsed > 0) return parsed;
    }
    return 5;
}
