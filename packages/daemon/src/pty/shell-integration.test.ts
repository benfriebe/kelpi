/**
 * The zsh integration that makes a pane's directory follow the shell (`shell-integration.ts`).
 *
 * Two halves. The spawn half is pure: which spawns get `ZDOTDIR` pointed at the integration,
 * and that the user's own `ZDOTDIR` travels past it. The shell half runs a real zsh in a real
 * PTY and reads its output through the daemon's own OSC 7 parser, because what matters is that
 * the bytes zsh writes become the directory the daemon stores: the logical path, decoded, and
 * only for the shell's own `cd`s.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createTerminalStateService } from '../term/service.js';
import { createPtyManager, type KelpiPtyManager } from './manager.js';
import { ZSHENV, ZSH_ZDOTDIR_ENV, installShellIntegration, type ShellIntegration } from './shell-integration.js';
import type { PtyProcessHandle, PtySpawnRequest, PtySpawner } from './types.js';

const INTEGRATION: ShellIntegration = { zshDir: '/data/shell-integration/zsh' };

function stubSpawner(): { spawner: PtySpawner; requests: PtySpawnRequest[] } {
    const requests: PtySpawnRequest[] = [];
    const spawner: PtySpawner = (request) => {
        requests.push(request);
        const handle: PtyProcessHandle = {
            pid: 4242,
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
            onData: () => undefined,
            onExit: () => undefined
        };
        return handle;
    };
    return { spawner, requests };
}

/** Runs `body` with `ZDOTDIR` and the carrier absent from the daemon env, then restores them. */
function withoutInheritedZdotdir<T>(body: () => T): T {
    const saved = [process.env['ZDOTDIR'], process.env[ZSH_ZDOTDIR_ENV]] as const;
    delete process.env['ZDOTDIR'];
    delete process.env[ZSH_ZDOTDIR_ENV];
    try {
        return body();
    } finally {
        if (saved[0] !== undefined) process.env['ZDOTDIR'] = saved[0];
        if (saved[1] !== undefined) process.env[ZSH_ZDOTDIR_ENV] = saved[1];
    }
}

function spawnOne(
    options: { shell: string; command?: string; env?: ReadonlyArray<readonly [string, string]>; integration?: ShellIntegration | undefined }
): Readonly<Record<string, string>> {
    const { spawner, requests } = stubSpawner();
    const manager = createPtyManager({
        spawner,
        isDirectory: () => true,
        shellIntegration: 'integration' in options ? options.integration : INTEGRATION
    });
    manager.spawn({
        paneID: 'pane-a',
        cwd: '/work/repo',
        env: options.env ?? [],
        cols: 80,
        rows: 24,
        shell: options.shell,
        ...(options.command !== undefined ? { command: options.command } : {})
    });
    return requests[0]?.env ?? {};
}

describe('which spawns get the zsh integration', () => {
    it('points an interactive zsh at it, and says the user had no ZDOTDIR', () => {
        const env = withoutInheritedZdotdir(() => spawnOne({ shell: '/bin/zsh' }));
        expect(env['ZDOTDIR']).toBe(INTEGRATION.zshDir);
        expect(env[ZSH_ZDOTDIR_ENV]).toBeUndefined();
    });

    it("carries the daemon's ZDOTDIR past it, so the user's own files are still the ones read", () => {
        const env = withoutInheritedZdotdir(() => {
            process.env['ZDOTDIR'] = '/Users/me/.config/zsh';
            return spawnOne({ shell: '/opt/homebrew/bin/zsh' });
        });
        expect(env['ZDOTDIR']).toBe(INTEGRATION.zshDir);
        expect(env[ZSH_ZDOTDIR_ENV]).toBe('/Users/me/.config/zsh');
    });

    it("carries a profile's ZDOTDIR too: the overlay is applied before the injection", () => {
        const env = withoutInheritedZdotdir(() =>
            spawnOne({ shell: '/bin/zsh', env: [['ZDOTDIR', '/Users/me/work-zsh']] })
        );
        expect(env['ZDOTDIR']).toBe(INTEGRATION.zshDir);
        expect(env[ZSH_ZDOTDIR_ENV]).toBe('/Users/me/work-zsh');
    });

    it('never hands our own directory back as the user\'s, nor a stale carrier', () => {
        const env = withoutInheritedZdotdir(() => {
            process.env['ZDOTDIR'] = INTEGRATION.zshDir;
            process.env[ZSH_ZDOTDIR_ENV] = '/stale';
            return spawnOne({ shell: '/bin/zsh' });
        });
        expect(env['ZDOTDIR']).toBe(INTEGRATION.zshDir);
        expect(env[ZSH_ZDOTDIR_ENV]).toBeUndefined();
    });

    it('leaves other shells, a hosted command, and a daemon without the integration alone', () => {
        withoutInheritedZdotdir(() => {
            expect(spawnOne({ shell: '/bin/bash' })['ZDOTDIR']).toBeUndefined();
            expect(spawnOne({ shell: '/bin/zsh', command: "vi '/a.md'" })['ZDOTDIR']).toBeUndefined();
            expect(spawnOne({ shell: '/bin/zsh', integration: undefined })['ZDOTDIR']).toBeUndefined();
        });
    });
});

describe('installShellIntegration', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it('writes .zshenv once and rewrites it only when the content differs', () => {
        const root = mkdtempSync(join(tmpdir(), 'kelpi-shell-integration-'));
        roots.push(root);
        const { zshDir } = installShellIntegration(join(root, 'shell-integration'));
        const file = join(zshDir, '.zshenv');
        expect(readFileSync(file, 'utf8')).toBe(ZSHENV);

        const before = statSync(file).mtimeMs;
        installShellIntegration(join(root, 'shell-integration'));
        expect(statSync(file).mtimeMs).toBe(before);

        writeFileSync(file, '# an older build\n');
        installShellIntegration(join(root, 'shell-integration'));
        expect(readFileSync(file, 'utf8')).toBe(ZSHENV);
    });

    it('names the carrier the spawn side sets', () => {
        expect(ZSHENV).toContain(`$${ZSH_ZDOTDIR_ENV}`);
    });
});

// ---------------------------------------------------------------------------
// A real zsh
// ---------------------------------------------------------------------------

const ZSH = '/bin/zsh';
const PANE = 'pane-zsh';

describe.skipIf(!existsSync(ZSH))('a real zsh under the integration', () => {
    const managers: KelpiPtyManager[] = [];
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(managers.splice(0).map((manager) => manager.killAll()));
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    /**
     * A zsh in its own fake home, whose rc files leave markers, with the PTY's output read by
     * the daemon's terminal service: `reports` is every OSC 7 directory it parsed.
     */
    function startZsh(options: { userZdotdir?: boolean } = {}) {
        const root = mkdtempSync(join(tmpdir(), 'kelpi-zsh-'));
        roots.push(root);
        const home = join(root, 'home');
        const rcDir = options.userZdotdir === true ? join(root, 'zdot') : home;
        mkdirSync(rcDir, { recursive: true });
        mkdirSync(home, { recursive: true });
        writeFileSync(join(rcDir, '.zshenv'), 'export KELPI_TEST_ZSHENV=read\n');
        // The prompt shows the last status, so a hook that clobbers $? would show up in it.
        writeFileSync(join(rcDir, '.zshrc'), "KELPI_TEST_ZSHRC=read\nPROMPT='P[%?]> '\n");
        // Reached through a symlink, as /var/folders is: the report must keep the path given.
        mkdirSync(join(root, 'real', 'with space', '100%'), { recursive: true });
        symlinkSync(join(root, 'real'), join(root, 'link'));
        const cwd = join(root, 'link');

        const integration = installShellIntegration(join(root, 'data', 'shell-integration'));
        const manager = createPtyManager({ shellIntegration: integration });
        managers.push(manager);

        const reports: string[] = [];
        let output = '';
        const term = createTerminalStateService({
            onDirectoryChange: (_paneID, directory) => {
                reports.push(directory);
            }
        });
        term.attach(PANE, 120, 30);
        manager.onData((_paneID, data) => {
            output += Buffer.from(data).toString('utf8');
            term.feed(PANE, data);
        });

        withoutInheritedZdotdir(() => {
            manager.spawn({
                paneID: PANE,
                cwd,
                env: [
                    ['HOME', home],
                    // Terminal.app's /etc/zshrc hook reports OSC 7 too; keep it out of this.
                    ['TERM_PROGRAM', ''],
                    ...(options.userZdotdir === true ? ([['ZDOTDIR', rcDir]] as const) : [])
                ],
                cols: 120,
                rows: 30,
                shell: ZSH
            });
        });

        return {
            root,
            cwd,
            rcDir,
            reports,
            output: () => output,
            run: (line: string) => manager.write(PANE, `${line}\r`),
            dispose: () => term.disposeAll()
        };
    }

    async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await delay(20);
        }
        throw new Error('waitFor: condition not met within timeout');
    }

    it('reports the logical directory at the first prompt and after each cd', { timeout: 30_000 }, async () => {
        const shell = startZsh();
        try {
            // node-pty sets PWD to the cwd it was given, which is what keeps zsh on the
            // symlinked path rather than the getcwd() one.
            await waitFor(() => shell.reports.includes(shell.cwd));
            expect(shell.reports.some((directory) => directory.startsWith('/private/'))).toBe(false);

            const target = join(shell.cwd, 'with space', '100%');
            shell.run(`cd ${JSON.stringify(target)}`);
            await waitFor(() => shell.reports.at(-1) === target);

            // A subshell's cd is not the shell's, even when its output goes to the terminal, and
            // a captured one writes into the capture: neither may report `/`.
            const before = shell.reports.length;
            shell.run('( cd / && print -r -- "SUB[$PWD]" ); print -r -- "CAPTURED[$(cd / && pwd)]"');
            await waitFor(() => shell.output().includes('SUB[/]') && shell.output().includes('CAPTURED[/]'));
            await waitFor(() => shell.reports.length > before);
            expect(shell.reports.slice(before).every((directory) => directory === target)).toBe(true);
        } finally {
            shell.dispose();
        }
    });

    it("reads the user's rc files, restores ZDOTDIR and keeps $? for the prompt", { timeout: 30_000 }, async () => {
        const shell = startZsh();
        try {
            await waitFor(() => shell.reports.length > 0);
            shell.run('print -r -- "ENV[$KELPI_TEST_ZSHENV] RC[$KELPI_TEST_ZSHRC] ZD[${ZDOTDIR-unset}] KZ[${KELPI_ZSH_ZDOTDIR-unset}]"');
            await waitFor(() => shell.output().includes('ENV[read] RC[read] ZD[unset] KZ[unset]'));

            shell.run('false');
            await waitFor(() => shell.output().includes('P[1]> '));
        } finally {
            shell.dispose();
        }
    });

    it("hands a user's own ZDOTDIR back and reads their files from it", { timeout: 30_000 }, async () => {
        const shell = startZsh({ userZdotdir: true });
        try {
            await waitFor(() => shell.reports.length > 0);
            shell.run('print -r -- "ENV[$KELPI_TEST_ZSHENV] RC[$KELPI_TEST_ZSHRC] ZD[${ZDOTDIR-unset}]"');
            await waitFor(() => shell.output().includes(`ENV[read] RC[read] ZD[${shell.rcDir}]`));
        } finally {
            shell.dispose();
        }
    });
});
