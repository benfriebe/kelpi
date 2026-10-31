/**
 * The `gh` process layer for PR status (workspace-feature.md §11.2).
 *
 * Always `execFile` with an argument array, never a shell. The daemon's PATH is often
 * LaunchServices' bare one, so the Homebrew prefixes are searched after it, as the tailnet probe
 * does (`lifecycle/tailnet.ts`). `KELPI_GH` overrides alone, for tests and odd installs.
 *
 * gh's stderr can name hosts and accounts, so callers classify it and never log it.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A hung `gh` (network, keychain) must not hold a lookup slot for long. */
export const GH_TIMEOUT_MS = 15_000;

/** Nobody is at a prompt for a background lookup, and no output is for a terminal. */
export const BACKGROUND_GH_ENV: Readonly<Record<string, string>> = {
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    NO_COLOR: '1',
    GH_PAGER: 'cat'
};

export interface GhResult {
    /** The exit code; -1 when gh could not be run at all or was killed. */
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    /** No gh binary anywhere it was looked for. */
    readonly missing: boolean;
    readonly timedOut: boolean;
}

export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

function executableAt(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** Where to look, in order: `KELPI_GH` alone, else PATH, `/opt/homebrew/bin`, `/usr/local/bin`. */
export function ghBinaryCandidates(
    env: Readonly<Record<string, string | undefined>> = process.env
): readonly string[] {
    const override = env['KELPI_GH']?.trim();
    if (override !== undefined && override.length > 0) return [override];
    const fromPath = (env['PATH'] ?? '')
        .split(path.delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => path.join(entry, 'gh'));
    return [...fromPath, '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
}

/** The first candidate that is an executable file, or null. */
export function resolveGhExecutable(
    env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
    for (const candidate of ghBinaryCandidates(env)) {
        if (executableAt(candidate)) return candidate;
    }
    return null;
}

export interface CreateGhRunnerOptions {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly timeoutMs?: number | undefined;
}

/**
 * A runner that resolves the binary on each call until one is found, then keeps it: installing
 * gh while the daemon runs starts working at the next probe, and a found binary is not searched
 * for again unless it disappears (ENOENT).
 */
export function createGhRunner(options: CreateGhRunnerOptions = {}): GhRunner {
    const env = options.env ?? process.env;
    const timeout = options.timeoutMs ?? GH_TIMEOUT_MS;
    let pinned: string | null = null;
    return (args) => {
        pinned ??= resolveGhExecutable(env);
        const binary = pinned;
        if (binary === null) {
            return Promise.resolve({ code: -1, stdout: '', stderr: '', missing: true, timedOut: false });
        }
        return new Promise((resolve) => {
            execFile(
                binary,
                [...args],
                {
                    encoding: 'utf8',
                    timeout,
                    maxBuffer: 4 * 1024 * 1024,
                    env: { ...env, ...BACKGROUND_GH_ENV }
                },
                (error, stdout, stderr) => {
                    if (error === null) {
                        resolve({ code: 0, stdout, stderr, missing: false, timedOut: false });
                        return;
                    }
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        pinned = null;
                        resolve({ code: -1, stdout: '', stderr: '', missing: true, timedOut: false });
                        return;
                    }
                    const killed = (error as { killed?: unknown }).killed === true;
                    const code = (error as { code?: unknown }).code;
                    resolve({
                        code: !killed && typeof code === 'number' ? code : -1,
                        stdout,
                        stderr,
                        missing: false,
                        timedOut: killed
                    });
                }
            );
        });
    };
}
