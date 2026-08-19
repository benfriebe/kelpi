/**
 * `nexd import` as a CLI: the two paths it prints before acting, the refusals, and the shapes
 * of its human and `--json` output.
 *
 * The daemon-running refusal is exercised against a REAL daemon on a scratch run dir (the
 * pattern `main.test.ts` uses), because the whole point of the check is that it probes a live
 * control socket rather than trusting a pid file.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDaemon } from '../boot/index.js';
import { createPersistence } from '../db/index.js';
import { helpText, parseNexdArgs, runNexd, type CliIO } from '../main.js';
import {
    legacyGroup,
    legacyPane,
    legacyWorkspace,
    realLayoutJSON,
    writeLegacyDatabase
} from './testing.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

interface Captured extends CliIO {
    readonly stdout: string[];
    readonly stderr: string[];
    text(): string;
}

function io(env: NodeJS.ProcessEnv = {}): Captured {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        env,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
        text: () => [...stdout, ...stderr].join('\n')
    };
}

const WS_A = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const WS_B = '1DE27A23-1EDA-4967-B4A7-9746532F257A';
const PANE_A1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const PANE_A2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const PANE_A3 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const GROUP_ID = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';

interface Scratch {
    readonly root: string;
    readonly home: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly configPath: string;
    readonly source: string;
    readonly target: string;
}

function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-imp-cli-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const source = path.join(root, 'legacy.db');
    writeLegacyDatabase(source, {
        workspaces: [
            legacyWorkspace({
                id: WS_A,
                name: 'Alpha',
                layoutJSON: realLayoutJSON()[0] as string,
                sortOrder: 0
            }),
            legacyWorkspace({ id: WS_B, name: 'Beta', sortOrder: 1 })
        ],
        panes: [
            legacyPane({ id: PANE_A1, workspaceID: WS_A, workingDirectory: home }),
            legacyPane({
                id: PANE_A2,
                workspaceID: WS_A,
                workingDirectory: home,
                agentSessionID: 'sess-abc123',
                agentKind: 'codex'
            }),
            legacyPane({ id: PANE_A3, workspaceID: WS_A, workingDirectory: home }),
            legacyPane({ id: 'broken', workspaceID: WS_A })
        ],
        groups: [legacyGroup({ id: GROUP_ID, name: 'agents', childOrderJSON: `["${WS_B}"]` })],
        appState: [{ key: 'activeWorkspaceID', value: WS_A }]
    });
    return {
        root,
        home,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
        configPath: path.join(root, 'config'),
        source,
        target: path.join(root, 'nexd.db')
    };
}

function envFor(paths: Scratch): NodeJS.ProcessEnv {
    return {
        HOME: paths.home,
        NEXD_RUN_DIR: paths.runDir,
        NEXD_SOCKET_PATH: paths.socketPath,
        NEXD_DB_PATH: paths.target
    };
}

function workspaceNames(target: string): string[] {
    const persistence = createPersistence({ path: target });
    const snapshot = persistence.load();
    persistence.close();
    return (snapshot?.workspaces ?? []).map((workspace) => workspace.name);
}

describe('nexd import — argument parsing', () => {
    it('recognises the verb and its flags', () => {
        const args = parseNexdArgs(['import', '--from', '/a.db', '--to', '/b.db', '--force', '--dry-run', '--json']);
        expect(args).toMatchObject({
            command: 'import',
            from: '/a.db',
            to: '/b.db',
            force: true,
            dryRun: true,
            json: true
        });
        expect(args.error).toBeUndefined();
    });

    it('rejects a flag with no value', () => {
        expect(parseNexdArgs(['import', '--from']).error).toBe('--from needs a path');
        expect(parseNexdArgs(['import', '--to', '--json']).error).toBe('--to needs a path');
    });

    it('is documented in --help, including the recommended flow', () => {
        expect(helpText()).toContain('nexd import');
        expect(helpText()).toContain('--dry-run');
        expect(helpText()).toContain('nexd stop && nexd import && nexd start');
        expect(helpText()).toContain('~/Library/Application Support/Nex/nex.db');
    });

    it('exits 2 on a usage error', async () => {
        const captured = io();
        expect(await runNexd(['import', '--from'], captured)).toBe(2);
        expect(captured.stderr[0]).toBe('--from needs a path');
    });
});

describe('nexd import — with no daemon running', () => {
    it('prints both paths before acting, then the report', async () => {
        const paths = scratch();
        const captured = io(envFor(paths));

        expect(await runNexd(['import', '--from', paths.source], captured)).toBe(0);

        expect(captured.stdout[0]).toBe('nexd import');
        expect(captured.stdout[1]).toBe(`  from: ${paths.source}`);
        expect(captured.stdout[2]).toBe(`  to:   ${paths.target}`);
        expect(captured.text()).toContain('imported 2 workspace(s), 3 pane(s), 1 group(s)');
        expect(captured.text()).toContain('agent session(s) to resume on the next start: 1');
        expect(captured.text()).toContain('pane broken: unparseable pane id');
        expect(captured.text()).toContain('Next: `nexd start`');
        expect(workspaceNames(paths.target)).toEqual(['Alpha', 'Beta']);
    });

    it('defaults --from to the Swift app path and says so before failing on it', async () => {
        const paths = scratch();
        const captured = io(envFor(paths));

        expect(await runNexd(['import'], captured)).toBe(1);

        expect(captured.stdout[1]).toBe(
            `  from: ${path.join(paths.home, 'Library', 'Application Support', 'Nex', 'nex.db')}`
        );
        expect(captured.stderr.join('\n')).toContain('no legacy database at');
        expect(captured.stderr.join('\n')).toContain('Repair:');
        expect(fs.existsSync(paths.target)).toBe(false);
    });

    it('--dry-run writes nothing', async () => {
        const paths = scratch();
        const captured = io(envFor(paths));

        expect(await runNexd(['import', '--from', paths.source, '--dry-run'], captured)).toBe(0);

        expect(captured.stdout[0]).toBe('nexd import (dry run)');
        expect(captured.text()).toContain('would import 2 workspace(s)');
        expect(captured.text()).toContain('Nothing was written.');
        expect(fs.existsSync(paths.target)).toBe(false);
    });

    it('--json puts the report alone on stdout', async () => {
        const paths = scratch();
        const captured = io(envFor(paths));

        expect(await runNexd(['import', '--from', paths.source, '--json'], captured)).toBe(0);

        expect(captured.stdout).toHaveLength(1);
        const report = JSON.parse(captured.stdout[0] as string) as Record<string, unknown>;
        expect(report).toMatchObject({
            ok: true,
            from: paths.source,
            to: paths.target,
            written: true,
            workspaces: 2,
            panes: 3,
            groups: 1,
            resumable: 1,
            dryRun: false
        });
        // The paths still get announced, just not on the pipe carrying the JSON.
        expect(captured.stderr.join('\n')).toContain(`from: ${paths.source}`);
    });

    it('refuses a populated target, and replaces it with --force', async () => {
        const paths = scratch();
        const env = envFor(paths);

        expect(await runNexd(['import', '--from', paths.source], io(env))).toBe(0);

        const second = io(env);
        expect(await runNexd(['import', '--from', paths.source], second)).toBe(1);
        expect(second.stderr.join('\n')).toContain('already holds 2 workspace(s)');
        expect(second.stderr.join('\n')).toContain('--force');

        const forced = io(env);
        expect(await runNexd(['import', '--from', paths.source, '--force'], forced)).toBe(0);
        expect(forced.text()).toContain('backup:');
        expect(workspaceNames(paths.target)).toEqual(['Alpha', 'Beta']);
        expect(fs.readdirSync(paths.root).some((entry) => entry.endsWith('.bak'))).toBe(true);
    });

    it('reports a refusal as JSON when asked', async () => {
        const paths = scratch();
        const env = envFor(paths);
        expect(await runNexd(['import', '--from', paths.source], io(env))).toBe(0);

        const captured = io(env);
        expect(await runNexd(['import', '--from', paths.source, '--json'], captured)).toBe(1);
        expect(captured.stdout).toHaveLength(1);
        const reply = JSON.parse(captured.stdout[0] as string) as Record<string, unknown>;
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('already holds');
        expect(String(reply['repair'])).toContain('--force');
    });
});

describe('nexd import — with a daemon running', () => {
    it('refuses, and --force does not override it', async () => {
        const paths = scratch();
        const daemon = createDaemon({
            env: {},
            home: paths.home,
            runDir: paths.runDir,
            controlSocketPath: paths.socketPath,
            dbPath: paths.target,
            configPath: paths.configPath,
            httpPort: 0,
            settleMs: 0
        });
        cleanups.push(() => daemon.stop());
        await daemon.start();
        const env = envFor(paths);

        const captured = io(env);
        expect(await runNexd(['import', '--from', paths.source], captured)).toBe(1);
        expect(captured.stderr.join('\n')).toContain('nexd is running');
        expect(captured.stderr.join('\n')).toContain(`owns ${paths.target}`);
        expect(captured.stderr.join('\n')).toContain('nexd stop');

        const forced = io(env);
        expect(await runNexd(['import', '--from', paths.source, '--force'], forced)).toBe(1);
        expect(forced.stderr.join('\n')).toContain('--force does not override this');

        // Even a dry run is refused: the answer would be about to become wrong.
        const dry = io(env);
        expect(await runNexd(['import', '--from', paths.source, '--dry-run'], dry)).toBe(1);

        // The daemon's own database is untouched by any of that (a freshly booted daemon has
        // not even written its "Default" workspace yet — the import must not add ours).
        expect(workspaceNames(paths.target)).not.toContain('Alpha');
    }, 30_000);

    it('imports into an unrelated database with a warning', async () => {
        const paths = scratch();
        const daemon = createDaemon({
            env: {},
            home: paths.home,
            runDir: paths.runDir,
            controlSocketPath: paths.socketPath,
            dbPath: paths.target,
            configPath: paths.configPath,
            httpPort: 0,
            settleMs: 0
        });
        cleanups.push(() => daemon.stop());
        await daemon.start();

        const elsewhere = path.join(paths.root, 'elsewhere.db');
        const captured = io(envFor(paths));
        expect(await runNexd(['import', '--from', paths.source, '--to', elsewhere], captured)).toBe(0);
        expect(captured.stderr.join('\n')).toContain('is not the database it opened');
        expect(workspaceNames(elsewhere)).toEqual(['Alpha', 'Beta']);
        expect(workspaceNames(paths.target)).not.toContain('Alpha');
    }, 30_000);
});
