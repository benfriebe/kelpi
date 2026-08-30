/**
 * Graft's LAUNCH wiring (graft-git.md §GIT-034, §GIT-044): the two things `boot/compose.ts` has
 * to install before anyone asks for them, proven against a real daemon rather than by reading
 * the composer.
 *
 *   1. **Orphan detection runs at boot over the registry roots**, including the first-run path
 *      where the loaded state has no workspaces at all. A breadcrumb inside a registered repo
 *      has to surface as an interrupted graft even though the workspace that started it is
 *      gone — otherwise the banner never appears and the user's stash stays buried.
 *
 *   2. **The session-update subscription is installed unconditionally**, so a graft started
 *      from the CLI (no client, no inspector, possibly no workspace of its own) is still
 *      visible to `graft status`, still reaches attached clients as a `graft-changed`
 *      broadcast, and is still unwound by the quit flush.
 *
 * Everything is private to a `mkdtemp` sandbox: its own run dir, its own control socket, its
 * own database, an ephemeral HTTP port.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createLineBuffer, WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDaemon, type Daemon, type DaemonInfo } from '../boot/compose.js';
import { createPersistence } from '../db/index.js';
import { resolveGitExecutable } from '../git/index.js';
import type { PersistedSnapshot } from '../store/index.js';
import { breadcrumbPath, encodeBreadcrumb } from './breadcrumb.js';

const GIT = resolveGitExecutable();

function gitAvailable(): boolean {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const HAS_GIT = gitAvailable();

type Json = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

interface Scratch {
    readonly root: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly dbPath: string;
    readonly home: string;
    readonly configPath: string;
}

/** Short paths: a unix socket path is capped near 104 bytes on macOS. */
function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-graft-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'kelpi.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath: path.join(root, 'config')
    };
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'kelpi',
            GIT_AUTHOR_EMAIL: 'kelpi@example.com',
            GIT_COMMITTER_NAME: 'kelpi',
            GIT_COMMITTER_EMAIL: 'kelpi@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null'
        }
    });
}

interface Repo {
    readonly parent: string;
    readonly worktree: string;
}

function repoFixture(root: string): Repo {
    const parent = path.join(root, 'repo');
    fs.mkdirSync(parent, { recursive: true });
    git(parent, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(parent, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'original\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'initial');

    const worktree = path.join(root, 'wt-feature');
    git(parent, 'worktree', 'add', '-b', 'feature', worktree);
    fs.writeFileSync(path.join(worktree, 'MIRROR.md'), 'from the worktree\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'worktree work');

    fs.writeFileSync(path.join(parent, 'keep.txt'), 'local edit\n');
    return { parent: fs.realpathSync(parent), worktree: fs.realpathSync(worktree) };
}

const REPO_ID = 'EEEEEEEE-0000-4000-8000-000000000001';
const ASSOC_ID = 'CCCCCCCC-0000-4000-8000-000000000001';

/** A database that has a repo REGISTRY but not a single workspace — the first-run shape. */
function seedRegistryOnly(dbPath: string, repoPath: string): void {
    const snapshot: PersistedSnapshot = {
        version: 1,
        workspaces: [],
        groups: [],
        topLevelOrder: [],
        activeWorkspaceID: null,
        repos: [
            {
                id: REPO_ID,
                path: repoPath,
                name: 'repo',
                remoteURL: null,
                lastAccessedAt: 1_700_000_000,
                isAutoDiscovered: false
            }
        ],
        labelPresets: []
    };
    const persistence = createPersistence({ path: dbPath });
    expect(persistence.saveNow(snapshot)).toBe(true);
    persistence.close();
}

function daemonFor(paths: Scratch): Daemon {
    const daemon = createDaemon({
        env: {},
        home: paths.home,
        runDir: paths.runDir,
        controlSocketPath: paths.socketPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        httpPort: 0,
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' }
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

/** One request, one reply line, then EOF — exactly what the `kelpi` CLI does. */
function request(socketPath: string, message: Json, timeoutMs = 30_000): Promise<Json> {
    return new Promise<Json>((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn();
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error(`timeout: ${String(message['command'])}`))),
            timeoutMs
        );
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                finish(() => resolve(JSON.parse(line) as Json));
                return;
            }
        });
        socket.on('error', (error) => finish(() => reject(error)));
        socket.on('close', () => finish(() => reject(new Error('closed without a reply'))));
    });
}

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await tick(40);
    }
    if (!condition()) throw new Error('waitFor: condition not met');
}

interface Client {
    readonly messages: Json[];
    command(id: string, payload: Json): void;
    reply(id: string): Json | undefined;
    ofType(type: string): Json[];
}

async function connect(info: DaemonInfo): Promise<Client> {
    const socket = new WebSocket(`${info.url}/ws?token=${encodeURIComponent(info.token)}`);
    const messages: Json[] = [];
    socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        messages.push(JSON.parse(data.toString('utf8')) as Json);
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    cleanups.push(() => socket.close());
    socket.send(
        JSON.stringify({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token: info.token,
            client: { kind: 'browser', name: 'graft-boot-test' }
        })
    );
    await waitFor(() => messages.some((message) => message['type'] === 'snapshot'));
    return {
        messages,
        command(id, payload) {
            socket.send(JSON.stringify({ type: 'command', id, payload }));
        },
        reply(id) {
            const message = messages.find(
                (entry) => entry['type'] === 'command-reply' && entry['id'] === id
            );
            return message?.['reply'] as Json | undefined;
        },
        ofType(type) {
            return messages.filter((message) => message['type'] === type);
        }
    };
}

describe.skipIf(!HAS_GIT)('graft at launch', () => {
    it('detects an interrupted graft over the registry roots on a first run with no workspaces', async () => {
        const paths = scratch();
        const repo = repoFixture(paths.root);
        seedRegistryOnly(paths.dbPath, repo.parent);
        // What a daemon that died mid-graft leaves behind.
        fs.writeFileSync(
            breadcrumbPath(repo.parent),
            encodeBreadcrumb({
                version: 1,
                stashed: false,
                assocId: ASSOC_ID,
                stashRef: null,
                worktreePath: repo.worktree,
                branch: 'feature',
                preGraftBranch: 'main',
                preGraftSha: git(repo.parent, 'rev-parse', 'HEAD').trim(),
                worktreePreGraftSha: null
            })
        );

        const daemon = daemonFor(paths);
        const info = await daemon.start();
        await daemon.restored;

        // The load really was the first-run shape: nothing but the registry came back, and the
        // Default workspace had to be minted.
        expect(info.loadStatus).toBe('empty');
        expect(daemon.store.getState().workspaces.map((workspace) => workspace.name)).toEqual([
            'Default'
        ]);
        expect(daemon.store.getState().repos.map((entry) => entry.path)).toEqual([repo.parent]);

        // Detection ran anyway, over the registry root rather than any workspace.
        expect(daemon.graftOrphans).toHaveLength(1);
        expect(daemon.graftOrphans[0]?.parentRepoRoot).toBe(repo.parent);
        expect(daemon.graftOrphans[0]?.worktreePath).toBe(repo.worktree);
        expect(daemon.graftOrphans[0]?.id).toBe(ASSOC_ID);

        // …and it reaches a client that attaches afterwards, which is what puts the banner on
        // screen (the inspector asks on open; this is that ask).
        const client = await connect(info);
        client.command('list-1', { command: 'graft-session-list', refresh: true });
        await waitFor(() => client.reply('list-1') !== undefined);
        const reply = client.reply('list-1') as Json;
        expect(reply['ok']).toBe(true);
        const orphans = reply['orphans'] as Json[];
        expect(orphans).toHaveLength(1);
        expect(orphans[0]?.['parent_repo_root']).toBe(repo.parent);
        expect(reply['sessions']).toEqual([]);
    }, 60_000);

    it('keeps a CLI-started graft visible to status, to clients and to the quit flush', async () => {
        const paths = scratch();
        const repo = repoFixture(paths.root);
        const daemon = daemonFor(paths);
        const info = await daemon.start();
        await daemon.restored;
        expect(info.loadStatus).toBe('empty');

        // The repo + association a `cd` (auto-detect) or the inspector would have produced.
        const workspaceID = daemon.store.getState().workspaces[0]?.id as string;
        daemon.store.dispatch({
            type: 'add-repo',
            repo: {
                id: REPO_ID,
                path: repo.parent,
                name: 'repo',
                remoteURL: null,
                lastAccessedAt: 1_700_000_000,
                isAutoDiscovered: false
            }
        });
        daemon.store.dispatch({
            type: 'add-repo-association',
            workspaceID,
            association: {
                id: ASSOC_ID,
                repoID: REPO_ID,
                worktreePath: repo.worktree,
                branchName: 'feature',
                isAutoDetected: false
            }
        });

        // A client is attached before anything starts, so the broadcast has somewhere to land.
        const client = await connect(info);

        // `kelpi graft start --workspace Default`, over the real control socket.
        const started = await request(paths.socketPath, {
            command: 'graft-start',
            workspace: 'Default'
        });
        expect(started['ok']).toBe(true);
        expect((started['started'] as Json[]).length).toBe(1);
        expect(fs.readFileSync(path.join(repo.parent, 'MIRROR.md'), 'utf8')).toBe(
            'from the worktree\n'
        );
        expect(fs.existsSync(breadcrumbPath(repo.parent))).toBe(true);

        // §GIT-044: the boot-time subscription re-broadcast the engine's own event, unasked.
        await waitFor(() => client.ofType('graft-changed').length > 0);
        const changed = client.ofType('graft-changed').at(-1) as Json;
        const sessions = changed['sessions'] as Json[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.['association_id']).toBe(ASSOC_ID);
        expect(sessions[0]?.['parent_repo_root']).toBe(repo.parent);

        // …and `kelpi graft status` answers from the service, not from any client mirror.
        const status = await request(paths.socketPath, { command: 'graft-status' });
        expect(status['ok']).toBe(true);
        expect((status['sessions'] as Json[])).toHaveLength(1);

        // §5 quit flush: stopping the daemon unwinds it and clears the breadcrumb.
        await daemon.stop();
        expect(fs.existsSync(breadcrumbPath(repo.parent))).toBe(false);
        expect(fs.existsSync(path.join(repo.parent, 'MIRROR.md'))).toBe(false);
        expect(fs.readFileSync(path.join(repo.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
        expect(git(repo.parent, 'stash', 'list').trim()).toBe('');
    }, 60_000);
});
