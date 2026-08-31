/**
 * Environment reads (cli.md §4). One module so the table in the spec has exactly one
 * implementation, and so tests can drive a synthetic environment.
 *
 * `KELPI_PANE_ID` has two distinct readings and both are load-bearing:
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

/**
 * `KELPI_PROFILE` — the effective profile name the pane's PTY was spawned with (the daemon
 * injects it unconditionally). Non-empty only; hooks attach it beside `session_id` so the
 * daemon can resume the session under the same profile.
 */
export function profileName(): string | undefined {
    const value = current['KELPI_PROFILE'];
    return value !== undefined && value.length > 0 ? value : undefined;
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

/**
 * `KELPI_REQUIRE_SOCKET` — the sandbox-harness guard (cli.md §4): any value refuses the
 * default Unix socket, so a missing or malformed `KELPI_SOCKET` fails THAT run loudly
 * instead of silently addressing the live daemon at `/tmp/kelpi.sock`. Exists because the
 * 2026-08-31 promote's UI audit did exactly that — its sandbox still exported the
 * pre-rename `NEX_SOCKET`, every CLI call fell back to the real daemon, and the audit's
 * delete-every-workspace step wiped the live instance.
 */
export function requireSocketRequested(): boolean {
    return current['KELPI_REQUIRE_SOCKET'] !== undefined;
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
