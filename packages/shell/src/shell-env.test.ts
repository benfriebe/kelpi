/**
 * #313: what a packaged Kelpi.app keeps from the shell that launched it.
 */

import { describe, expect, it } from 'vitest';

import { applyShellEnvPolicy, launcherScopedKey, shellEnvLogLines, SHELL_ENV_OVERRIDES } from './shell-env.js';

/** What `open -a Kelpi.app` from a dev-instance pane handed the app on 2026-10-01. */
function devInstancePane(): NodeJS.ProcessEnv {
    return {
        HOME: '/Users/x',
        PATH: '/usr/bin:/bin',
        LANG: 'en_AU.UTF-8',
        KELPID_RUN_DIR: '/var/folders/x/kelpi-dev-instance-Fap8bK/run',
        KELPID_HTTP_PORT: '61754',
        KELPID_DB_PATH: '/var/folders/x/kelpi-dev-instance-Fap8bK/nex.db',
        KELPID_ENTRY: '/Users/x/code/kelpi/packages/daemon/dist/kelpid.js',
        KELPI_SOCKET: 'tcp:127.0.0.1:61755',
        KELPI_PANE_ID: 'AAAAAAAA-0000-4000-8000-000000000001',
        KELPI_PROFILE: 'default',
        KELPI_HARNESS_SOCKET: '/var/folders/x/kelpi-dev-instance-Fap8bK/harness.sock',
        KELPI_UPDATE_FEED: 'https://example.invalid/feed'
    };
}

describe('the packaged shell environment (#313)', () => {
    it('drops everything that names the launching shell’s daemon, pane or harness', () => {
        const env = devInstancePane();
        const report = applyShellEnvPolicy(env, true);
        expect(Object.keys(env).sort()).toEqual(['HOME', 'KELPI_UPDATE_FEED', 'LANG', 'PATH']);
        expect(report.dropped).toEqual([
            'KELPID_DB_PATH',
            'KELPID_ENTRY',
            'KELPID_HTTP_PORT',
            'KELPID_RUN_DIR',
            'KELPI_HARNESS_SOCKET',
            'KELPI_PANE_ID',
            'KELPI_PROFILE',
            'KELPI_SOCKET'
        ]);
        const [line] = shellEnvLogLines(report);
        expect(line).toContain('ignoring KELPID_DB_PATH, KELPID_ENTRY');
        // Names only: the values (paths, the pane id) are nobody's business in a log.
        expect(line).not.toContain('kelpi-dev-instance');
    });

    it('keeps them with the opt-in, and says which run dir it is using', () => {
        const env: NodeJS.ProcessEnv = { ...devInstancePane(), [SHELL_ENV_OVERRIDES]: '1' };
        const report = applyShellEnvPolicy(env, true);
        expect(env.KELPID_RUN_DIR).toBe('/var/folders/x/kelpi-dev-instance-Fap8bK/run');
        expect(env.KELPI_HARNESS_SOCKET).toBeDefined();
        expect(shellEnvLogLines(report)).toEqual([
            'using KELPID_RUN_DIR from the environment: /var/folders/x/kelpi-dev-instance-Fap8bK/run',
            `environment: keeping ${report.kept.join(', ')} (${SHELL_ENV_OVERRIDES}=1)`
        ]);
    });

    it('leaves a development shell alone', () => {
        const env = devInstancePane();
        const report = applyShellEnvPolicy(env, false);
        expect(env).toEqual(devInstancePane());
        expect(report.dropped).toEqual([]);
        expect(shellEnvLogLines(report)[1]).toContain('(a development shell)');
    });

    it('says nothing when there was nothing to drop or keep', () => {
        const env: NodeJS.ProcessEnv = { HOME: '/Users/x', PATH: '/usr/bin' };
        expect(shellEnvLogLines(applyShellEnvPolicy(env, true))).toEqual([]);
    });

    it('scopes the launcher’s routing and the test lanes, not the app’s own knobs', () => {
        for (const key of ['KELPID_CONFIG_PATH', 'KELPID_LOG_FILE', 'KELPI_HARNESS', 'KELPI_AUDIT_WINDOW', 'KELPI_SOCKET']) {
            expect(launcherScopedKey(key)).toBe(true);
        }
        for (const key of ['KELPI_UPDATE_FEED', 'KELPI_CLI_INSTALL', 'KELPI_SKILL_SOURCE', 'HOME', SHELL_ENV_OVERRIDES]) {
            expect(launcherScopedKey(key)).toBe(false);
        }
    });
});
