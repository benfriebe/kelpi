/**
 * The environment a packaged Kelpi.app keeps from whoever launched it (#313).
 *
 * `open -a Kelpi.app` passes the caller's environment to the app, and every Kelpi pane exports
 * the variables that route its programs to ITS daemon: `KELPID_RUN_DIR`, `KELPID_HTTP_PORT`,
 * `KELPID_DB_PATH`, `KELPI_SOCKET`, `KELPI_PANE_ID` and the rest, and in a dev instance
 * `KELPI_HARNESS_SOCKET` too. On 2026-10-01 the app was relaunched from a dev-instance pane, and
 * it adopted the DEV daemon (newer, so adopted rather than replaced: an older one would have been
 * handed off), took over the dev window's web-pane role, and opened the dev instance's test-only
 * harness socket.
 *
 * So a packaged app drops those variables before anything reads them, and uses its own defaults.
 * They are launcher-scoped: they describe the shell the app was started FROM, never the app.
 * `KELPI_SHELL_ENV_OVERRIDES=1` keeps them, for the packaged runs that pass a sandbox through the
 * environment on purpose (`scripts/dev-instance.mjs --packaged`, the packaged audit lane, the
 * packaging smokes). A development shell (`electron .`) always keeps them: that is how every dev
 * stack is configured.
 *
 * Pure: `./shell-env-init.ts` applies it to `process.env` as the very first thing `main.ts` does.
 */

export const SHELL_ENV_OVERRIDES = 'KELPI_SHELL_ENV_OVERRIDES';

/** Variables that say which daemon, pane or test harness the LAUNCHING shell belongs to. */
export function launcherScopedKey(key: string): boolean {
    return (
        key.startsWith('KELPID_') ||
        key === 'KELPI_SOCKET' ||
        key === 'KELPI_PANE_ID' ||
        key === 'KELPI_PROFILE' ||
        key.startsWith('KELPI_HARNESS') ||
        key.startsWith('KELPI_AUDIT')
    );
}

export interface ShellEnvReport {
    /** Launcher-scoped variables removed (names only; their values are not logged). */
    readonly dropped: readonly string[];
    /** Launcher-scoped variables kept: a development shell, or the opt-in. */
    readonly kept: readonly string[];
    /** The run dir override that was kept, if any: the one variable that decides which daemon. */
    readonly runDir: string | undefined;
    readonly packaged: boolean;
    readonly optedIn: boolean;
}

/** Remove launcher-scoped variables from `env` in place (packaged, no opt-in) and report. */
export function applyShellEnvPolicy(env: NodeJS.ProcessEnv, packaged: boolean): ShellEnvReport {
    const optedIn = env[SHELL_ENV_OVERRIDES]?.trim() === '1';
    const scoped = Object.keys(env).filter(launcherScopedKey).sort();
    if (packaged && !optedIn) {
        for (const key of scoped) delete env[key];
        return { dropped: scoped, kept: [], runDir: undefined, packaged, optedIn };
    }
    const runDir = env['KELPID_RUN_DIR']?.trim();
    return {
        dropped: [],
        kept: scoped,
        runDir: runDir === undefined || runDir.length === 0 ? undefined : runDir,
        packaged,
        optedIn
    };
}

/** The log lines for a report: nothing when there was nothing to say. */
export function shellEnvLogLines(report: ShellEnvReport): string[] {
    if (report.dropped.length > 0) {
        return [
            `environment: ignoring ${report.dropped.join(', ')} from the shell that launched Kelpi ` +
                `(a packaged Kelpi uses its own daemon; ${SHELL_ENV_OVERRIDES}=1 keeps them)`
        ];
    }
    if (report.kept.length === 0) return [];
    const why = report.packaged ? `${SHELL_ENV_OVERRIDES}=1` : 'a development shell';
    return [
        ...(report.runDir === undefined ? [] : [`using KELPID_RUN_DIR from the environment: ${report.runDir}`]),
        `environment: keeping ${report.kept.join(', ')} (${why})`
    ];
}
