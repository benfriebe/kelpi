/**
 * The round trip that the whole feature exists for: a legacy Swift `nex.db` on disk, one
 * `kelpid import`, and a REAL daemon booting on the result — workspaces, groups, labels, layout
 * trees and panes all where they were, and a pane that had an agent session resuming it
 * exactly as a Kelpi.app restart would (docs/current/persistence.md §6.2 steps 4–8, §7.3).
 *
 * Everything runs against private paths in a tmp directory: its own run dir, its own control
 * socket, its own database, its own HOME.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLineBuffer } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemon, type Daemon } from '../boot/index.js';
import { createPersistence } from '../db/index.js';
import { runImport } from './importer.js';
import {
    legacyGroup,
    legacyPane,
    legacyRepo,
    legacyRepoAssociation,
    legacyWorkspace,
    realLayoutJSON,
    realWorkspaceScalars,
    writeLegacyDatabase
} from './testing.js';

type Reply = Record<string, unknown>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

/** One request, one reply line, then EOF — exactly what the CLI does. */
function request(socketPath: string, message: Reply, timeoutMs = 10_000): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
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
                finish(() => resolve(JSON.parse(line) as Reply));
                return;
            }
        });
        socket.on('error', (error) => finish(() => reject(error)));
        socket.on('close', () => finish(() => reject(new Error('closed without a reply'))));
    });
}

async function eventually<T>(
    fn: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = 15_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T = await fn();
    while (!predicate(last)) {
        if (Date.now() > deadline) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await fn();
    }
    return last;
}

const SCALARS = realWorkspaceScalars();
const LAYOUTS = realLayoutJSON();
const WS_A = SCALARS[0]?.id as string;
const WS_B = SCALARS[1]?.id as string;
/** The three leaves of `LAYOUTS[0]`, in tree order. */
const PANE_A1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const PANE_A2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const PANE_A3 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const PANE_B1 = '9E8F6E9C-2DA2-41DE-94E3-44166C68FE1F';
const PANE_WEB = '4C4B2231-641C-493A-BA68-31639278ED15';
const PANE_PRIVATE = '2EBAAD98-4E01-41A7-93EB-C8DD48CB13B1';
const TAB_1 = '5F0C24D9-1111-4222-8333-444455556666';
const TAB_2 = '71AB24D9-1111-4222-8333-444455556667';
const GROUP_ID = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';
const REPO_ID = 'C1DFCF02-F226-4075-9944-86C5E5E42820';
const SESSION_ID = 'sess-abc123';

interface Scratch {
    readonly root: string;
    readonly home: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly dbPath: string;
    readonly configPath: string;
    readonly source: string;
    readonly notes: string;
}

function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-imp-it-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const notes = path.join(home, 'notes.md');
    fs.writeFileSync(notes, '# Imported\n\nstill here\n');
    return {
        root,
        home,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'kelpi.sock'),
        dbPath: path.join(root, 'nex.db'),
        configPath: path.join(root, 'config'),
        source: path.join(root, 'legacy.db'),
        notes
    };
}

function writeSource(paths: Scratch): void {
    writeLegacyDatabase(paths.source, {
        foreignTables: true,
        workspaces: [
            legacyWorkspace({
                id: WS_A,
                name: 'My App!',
                color: 'purple',
                layoutJSON: LAYOUTS[0] as string,
                focusedPaneID: PANE_A2,
                createdAt: SCALARS[0]?.createdAt ?? 0,
                lastAccessedAt: SCALARS[0]?.lastAccessedAt ?? 0,
                sortOrder: 0,
                // Legacy v3 row: the loader regenerates the slug.
                slug: '',
                labelsJSON: '["frontend","wip"]',
                icon: 'system:star.fill'
            }),
            legacyWorkspace({
                id: WS_B,
                name: 'Beta',
                layoutJSON: `{"split":{"_0":"vertical","ratio":0.5,"first":{"leaf":{"_0":"${PANE_B1}"}},"second":{"leaf":{"_0":"${PANE_WEB}"}}}}`,
                sortOrder: 1
            })
        ],
        panes: [
            legacyPane({
                id: PANE_A1,
                workspaceID: WS_A,
                label: 'coordinator',
                workingDirectory: paths.home
            }),
            legacyPane({
                id: PANE_A2,
                workspaceID: WS_A,
                label: 'agent',
                workingDirectory: paths.home,
                // A live Swift app would have written these together.
                status: 'running',
                agentSessionID: SESSION_ID,
                agentKind: 'codex'
            }),
            legacyPane({
                id: PANE_A3,
                workspaceID: WS_A,
                type: 'markdown',
                workingDirectory: paths.home,
                filePath: paths.notes
            }),
            legacyPane({ id: PANE_B1, workspaceID: WS_B, workingDirectory: paths.home }),
            legacyPane({
                id: PANE_WEB,
                workspaceID: WS_B,
                type: 'web',
                workingDirectory: paths.home,
                webTabsJSON: `[{"id":"${TAB_1}","url":"https://example.com","title":"Example"},{"id":"${TAB_2}","url":"http://localhost:3000","title":""}]`,
                webActiveTabID: TAB_2,
                // §5.4: the legacy single-URL column is a write-only fallback, ignored here.
                webURL: 'http://localhost:3000',
                webIsPrivate: 0
            }),
            // Off-layout on purpose: §3.1 says the loader never reconciles panes against the
            // layout tree, so this row must survive as a pane the tree does not mention.
            legacyPane({
                id: PANE_PRIVATE,
                workspaceID: WS_B,
                type: 'web',
                workingDirectory: paths.home,
                webIsPrivate: 1
            })
        ],
        repos: [legacyRepo({ id: REPO_ID, path: paths.home, name: 'home' })],
        repoAssociations: [
            legacyRepoAssociation({
                id: '22222222-2222-4222-8222-222222222222',
                workspaceID: WS_A,
                repoID: REPO_ID,
                worktreePath: paths.home,
                branchName: 'main'
            })
        ],
        groups: [
            legacyGroup({ id: GROUP_ID, name: 'agents', color: 'green', childOrderJSON: `["${WS_B}"]` })
        ],
        appState: [
            { key: 'activeWorkspaceID', value: WS_B },
            {
                key: 'topLevelOrder',
                value: `[{"workspace":{"_0":"${WS_A}"}},{"group":{"_0":"${GROUP_ID}"}}]`
            }
        ]
    });
}

async function boot(paths: Scratch): Promise<Daemon> {
    const daemon = createDaemon({
        env: {},
        home: paths.home,
        runDir: paths.runDir,
        controlSocketPath: paths.socketPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        httpPort: 0,
        // The spec's 2 s PTY settle; a test does not need to sit through it.
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' }
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

describe('import → boot', () => {
    it('restores the imported state and resumes the imported agent session', async () => {
        const paths = scratch();
        writeSource(paths);

        const report = runImport({ from: paths.source, to: paths.dbPath });
        expect(report.written).toBe(true);
        expect(report).toMatchObject({ workspaces: 2, panes: 6, groups: 1, repos: 1, resumable: 1 });

        const daemon = await boot(paths);
        const info = await daemon.start();

        // ── the daemon sees a populated database, not a fresh install ────────
        expect(info.loadStatus).toBe('ok');
        expect(info.workspaces).toBe(2);
        expect(info.resumeTuples).toBe(1);

        const state = daemon.store.getState();
        expect(state.workspaces.map((workspace) => workspace.name)).toEqual(['My App!', 'Beta']);

        const alpha = state.workspaces[0];
        expect(alpha?.color).toBe('purple');
        expect(alpha?.icon).toEqual({ kind: 'system', name: 'star.fill' });
        expect(alpha?.labels).toEqual(['frontend', 'wip']);
        expect(alpha?.slug).toBe('my-app-a4e8a251');
        expect(alpha?.focusedPaneID).toBe(PANE_A2);
        expect(alpha?.repoAssociations[0]?.branchName).toBe('main');
        expect(state.repos.map((repo) => repo.path)).toEqual([paths.home]);
        expect(state.labelPresets.map((preset) => preset.name)).toEqual(['frontend', 'wip']);

        // ── the layout tree survived as a tree, not as text ──────────────────
        expect(alpha?.layout).toEqual({
            kind: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: {
                kind: 'split',
                direction: 'vertical',
                ratio: 0.5,
                first: { kind: 'leaf', paneID: PANE_A1 },
                second: { kind: 'leaf', paneID: PANE_A2 }
            },
            second: { kind: 'leaf', paneID: PANE_A3 }
        });
        expect(state.workspaces[1]?.layout).toEqual({
            kind: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: PANE_B1 },
            second: { kind: 'leaf', paneID: PANE_WEB }
        });

        // ── webTabsJSON came back as the per-workspace web sidecar ───────────
        const beta = state.workspaces[1];
        expect(beta?.webPanes[PANE_WEB]).toEqual({
            tabs: [
                { id: TAB_1, url: 'https://example.com', title: 'Example' },
                { id: TAB_2, url: 'http://localhost:3000', title: '' }
            ],
            activeTabID: TAB_2,
            isPrivate: false
        });
        // §9.10: a private pane comes back private and BLANK — its tabs never persisted.
        expect(beta?.webPanes[PANE_PRIVATE]).toEqual({ tabs: [], activeTabID: null, isPrivate: true });

        // ── sidebar shape ────────────────────────────────────────────────────
        expect(state.groups.map((group) => group.name)).toEqual(['agents']);
        expect(state.groups[0]?.childOrder).toEqual([WS_B]);
        expect(state.groups[0]?.color).toBe('green');
        expect(state.topLevelOrder).toEqual([
            { kind: 'workspace', id: WS_A },
            { kind: 'group', id: GROUP_ID }
        ]);
        expect(state.lastActiveWorkspaceID).toBe(WS_B);

        // ── panes, through the wire surface the CLI uses ─────────────────────
        const listed = await request(paths.socketPath, { command: 'pane-list' });
        expect(listed['ok']).toBe(true);
        const panes = listed['panes'] as Reply[];
        // All six rows are in the store…
        expect(state.workspaces.reduce((total, entry) => total + entry.panes.length, 0)).toBe(6);
        // …but `pane-list` walks the LAYOUT tree, and the private pane was deliberately left
        // out of it — the loader never reconciles panes against the tree (§3.1).
        expect(panes).toHaveLength(5);
        expect(panes.map((entry) => entry['id'])).not.toContain(PANE_PRIVATE);
        const coordinator = panes.find((entry) => entry['id'] === PANE_A1);
        expect(coordinator).toMatchObject({
            label: 'coordinator',
            type: 'shell',
            workspace_name: 'My App!',
            working_directory: paths.home,
            // §7.2: a persisted `running` never survives a boot.
            status: 'idle'
        });
        expect(panes.find((entry) => entry['id'] === PANE_A3)).toMatchObject({ type: 'markdown' });
        // §2.2 / §7.1: agentKind is a last-known display value and is NOT cleared on load.
        expect(panes.find((entry) => entry['id'] === PANE_A2)).toMatchObject({ agent: 'codex' });

        // ── the imported markdown pane kept its file and its non-terminal-ness ──
        expect(alpha?.panes.find((pane) => pane.id === PANE_A3)?.filePath).toBe(paths.notes);
        const markdown = await request(paths.socketPath, { command: 'pane-capture', target: PANE_A3 });
        expect(markdown['ok']).toBe(false);
        expect(String(markdown['error'])).toContain('markdown');

        // ── the resume: PTYs for the shell panes, then the codex command ─────
        const outcome = await daemon.restored;
        expect(outcome.spawned).toEqual([PANE_A1, PANE_A2, PANE_B1]);
        expect(outcome.resumed).toEqual([PANE_A2]);
        expect(outcome.skipped).toEqual([]);

        // The command really reached the PTY — and `agentKind` picked the codex verb rather
        // than `claude --resume`.
        const captured = await eventually(
            () => request(paths.socketPath, { command: 'pane-capture', target: PANE_A2, scrollback: true }),
            (reply) => typeof reply['text'] === 'string' && reply['text'].includes(`codex resume ${SESSION_ID}`)
        );
        expect(String(captured['text'])).toContain(`codex resume ${SESSION_ID}`);
        expect(String(captured['text'])).not.toContain('claude --resume');

        // ── and the session id is cleared on disk only after the resume ──────
        expect(daemon.store.getState().workspaces[0]?.panes[1]?.agentSessionID).toBeNull();
        await daemon.stop();
        const reopened = createPersistence({ path: paths.dbPath });
        const snapshot = reopened.load();
        reopened.close();
        const agentPane = snapshot?.workspaces[0]?.panes.find((pane) => pane.id === PANE_A2);
        expect(agentPane?.agentSessionID).toBeNull();
        expect(agentPane?.agentKind).toBe('codex');
        expect(snapshot?.workspaces.map((workspace) => workspace.name)).toEqual(['My App!', 'Beta']);
    }, 60_000);

    it('a second import over the daemon-written database needs --force and keeps a backup', async () => {
        const paths = scratch();
        writeSource(paths);
        runImport({ from: paths.source, to: paths.dbPath });

        const daemon = await boot(paths);
        await daemon.start();
        await daemon.restored;
        expect((await request(paths.socketPath, { command: 'workspace-create', name: 'later' }))['ok']).toBe(
            true
        );
        await daemon.stop();

        expect(() => runImport({ from: paths.source, to: paths.dbPath })).toThrow(/already holds/);

        const forced = runImport({ from: paths.source, to: paths.dbPath, force: true });
        expect(forced.backupPath).not.toBeNull();

        const reopened = createPersistence({ path: paths.dbPath });
        const snapshot = reopened.load();
        reopened.close();
        expect(snapshot?.workspaces.map((workspace) => workspace.name)).toEqual(['My App!', 'Beta']);

        // The workspace created after the first import is still recoverable from the backup.
        const backup = createPersistence({ path: forced.backupPath as string });
        const saved = backup.load();
        backup.close();
        expect(saved?.workspaces.map((workspace) => workspace.name)).toContain('later');
    }, 60_000);
});
