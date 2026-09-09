import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLineBuffer, type JsonObject } from '@kelpi/protocol';
import { afterEach, expect, it } from 'vitest';

import { createDaemon } from '../boot/compose.js';
import { createGitService, resolveGitExecutable } from '../git/index.js';
import { breadcrumbPath } from '../graft/breadcrumb.js';

const GIT = resolveGitExecutable();
const PLUGIN = 'test.shutdown';
const PROVIDER = `${PLUGIN}.git`;
const REPO_ID = 'EEEEEEEE-0000-4000-8000-000000000001';
const ASSOC_ID = 'CCCCCCCC-0000-4000-8000-000000000001';
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_AUTHOR_NAME: 'Kelpi test',
            GIT_AUTHOR_EMAIL: 'kelpi@example.com',
            GIT_COMMITTER_NAME: 'Kelpi test',
            GIT_COMMITTER_EMAIL: 'kelpi@example.com'
        }
    });
}

/** The same request/reply transport as the CLI; all listeners and files stay in this fixture. */
function request(socketPath: string, message: JsonObject): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;
        const finish = (result: JsonObject | Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            if (result instanceof Error) reject(result); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error(`request timed out: ${String(message['command'])}`)), 30_000);
        socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                try { finish(JSON.parse(line) as JsonObject); }
                catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
                return;
            }
        });
        socket.once('error', finish);
        socket.once('close', () => finish(new Error('closed without a reply')));
    });
}

function providerSource(root: string, historyPath: string): string {
    const source = path.join(root, 'provider');
    fs.mkdirSync(source);
    const methods = Object.keys(createGitService());
    fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
        id: PLUGIN, name: 'Shutdown Git provider', version: '1.0.0', apiVersion: 1,
        trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
        contributes: {
            providers: [{ id: PROVIDER, title: 'Shutdown Git provider', service: 'kelpi.git', version: 1, methods, timeoutMs: 30_000 }]
        }
    }));
    // The log uses the backend's own filesystem access so its final deactivation record
    // survives shutdown, when new host API calls are deliberately refused.
    fs.writeFileSync(path.join(source, 'backend.mjs'), `
        import fs from 'node:fs';
        const historyPath = ${JSON.stringify(historyPath)};
        const methods = ${JSON.stringify(methods)};
        const record = event => fs.appendFileSync(historyPath, JSON.stringify(event) + '\\n');
        export function activate(api) {
            record({ phase: 'activate' });
            const dispose = api.providers.register(${JSON.stringify(PROVIDER)}, Object.fromEntries(
                methods.map(method => [method, async args => {
                    record({ phase: 'start', method, args });
                    const result = await api.services.call('kelpi.git', 1, method, args, { provider: 'bundled' });
                    record({ phase: 'complete', method, args });
                    return result;
                }])
            ));
            return () => { record({ phase: 'deactivate' }); dispose(); };
        }
    `);
    return source;
}

it('keeps the selected Git provider alive until native graft shutdown restores dirty parent files', async () => {
    // Short enough for macOS's Unix socket path limit; never uses the user's Kelpi paths.
    const root = fs.mkdtempSync('/tmp/kelpi-git-quit-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const parent = path.join(root, 'repo');
    const worktree = path.join(root, 'feature');
    const home = path.join(root, 'home');
    fs.mkdirSync(parent);
    fs.mkdirSync(home);
    git(parent, 'init', '--initial-branch=main');
    git(parent, 'config', 'user.name', 'Kelpi test');
    git(parent, 'config', 'user.email', 'kelpi@example.com');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'original\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'initial');
    git(parent, 'worktree', 'add', '-b', 'feature', worktree);
    fs.writeFileSync(path.join(worktree, 'MIRROR.md'), 'from the worktree\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'feature content');

    // An unrelated stash must survive the graft's include-untracked stash/pop pair.
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'older stashed edit\n');
    git(parent, 'stash', 'push', '-m', 'existing stash');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'local tracked edit\n');
    fs.writeFileSync(path.join(parent, 'untracked.txt'), 'local untracked edit\n');
    const initialHead = git(parent, 'rev-parse', 'HEAD').trim();
    const initialStatus = git(parent, 'status', '--porcelain');
    const initialStashes = git(parent, 'stash', 'list', '--format=%H');
    const historyPath = path.join(root, 'provider-history.jsonl');
    const source = providerSource(root, historyPath);
    const socketPath = path.join(root, 'control.sock');
    const daemon = createDaemon({
        env: {}, home,
        runDir: path.join(root, 'run'), controlSocketPath: socketPath,
        dbPath: path.join(root, 'state.db'), configPath: path.join(root, 'config'),
        httpPort: 0, settleMs: 0, spawn: { shell: '/bin/sh', cols: 80, rows: 24 }
    });
    cleanups.push(() => daemon.stop());
    await daemon.start();
    await daemon.restored;
    expect(await request(socketPath, {
        command: 'plugin', action: 'install', text: JSON.stringify({ path: source, trust: true })
    })).toMatchObject({ ok: true });
    expect(await request(socketPath, {
        command: 'plugin', action: 'service-select',
        text: JSON.stringify({ service: 'kelpi.git', version: 1, providerID: PROVIDER })
    })).toMatchObject({ ok: true });

    const workspace = daemon.store.getState().workspaces[0]!;
    daemon.store.dispatch({
        type: 'add-repo',
        repo: { id: REPO_ID, path: fs.realpathSync(parent), name: 'repo', remoteURL: null, lastAccessedAt: 1_700_000_000, isAutoDiscovered: false }
    });
    daemon.store.dispatch({
        type: 'add-repo-association', workspaceID: workspace.id,
        association: { id: ASSOC_ID, repoID: REPO_ID, worktreePath: fs.realpathSync(worktree), branchName: 'feature', isAutoDetected: false }
    });
    expect(await request(socketPath, { command: 'graft-start', workspace: workspace.id })).toMatchObject({ ok: true, started: [expect.anything()] });
    expect(fs.readFileSync(path.join(parent, 'MIRROR.md'), 'utf8')).toBe('from the worktree\n');
    expect(fs.existsSync(breadcrumbPath(parent))).toBe(true);
    expect(git(parent, 'stash', 'list', '--format=%H').trim().split('\n')).toHaveLength(2);

    fs.appendFileSync(historyPath, JSON.stringify({ phase: 'shutdown-requested' }) + '\n');
    await daemon.stop();

    expect(git(parent, 'branch', '--show-current').trim()).toBe('main');
    expect(git(parent, 'rev-parse', 'HEAD').trim()).toBe(initialHead);
    expect(fs.readFileSync(path.join(parent, 'keep.txt'), 'utf8')).toBe('local tracked edit\n');
    expect(fs.readFileSync(path.join(parent, 'untracked.txt'), 'utf8')).toBe('local untracked edit\n');
    expect(fs.existsSync(path.join(parent, 'MIRROR.md'))).toBe(false);
    expect(fs.existsSync(breadcrumbPath(parent))).toBe(false);
    expect(git(parent, 'status', '--porcelain')).toBe(initialStatus);
    expect(git(parent, 'stash', 'list', '--format=%H')).toBe(initialStashes);

    const history = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as JsonObject);
    const shutdown = history.findIndex(event => event['phase'] === 'shutdown-requested');
    const deactivated = history.findIndex(event => event['phase'] === 'deactivate');
    expect(shutdown).toBeGreaterThan(0);
    expect(deactivated).toBeGreaterThan(shutdown);
    for (const method of ['checkoutBranchForce', 'resetHard', 'stashPopRef']) {
        const restored = history.findIndex((event, index) => index > shutdown && event['phase'] === 'complete' && event['method'] === method);
        expect(restored, `${method} must finish through the provider before deactivation`).toBeGreaterThan(shutdown);
        expect(restored).toBeLessThan(deactivated);
    }
    expect(history.slice(deactivated + 1)).toEqual([]);
}, 60_000);
