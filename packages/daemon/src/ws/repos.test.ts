/**
 * The workspace inspector's wire surface: the repo registry read, the per-association git
 * status read, association add/remove, the add-a-worktree-to-this-workspace verb, and the two
 * bulk workspace verbs the multi-select context menu drives.
 *
 * Each goes through a real `SyncHub` session rather than calling the handler directly — the
 * thing worth protecting is the whole path: matched before the wire decode (these verbs are
 * deliberately absent from `WIRE_COMMANDS`), dispatched into the store actions that already
 * exist, and answered on the connection that asked.
 */

import { isWireCommand, WS_PROTOCOL_VERSION, type JsonObject } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, seededState, W1, W2, HOME } from '../store/testing.js';
import type { RepoGitStatus } from '../git/index.js';
import { isRepoCommand, REPO_COMMANDS, type RepoChannel, type RepoCommandGit } from './repos.js';
import { createSyncHub, isWsOnlyCommand, type SyncHub, type SyncSession } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const PANE = 'dddddddd-0000-4000-8000-000000000100';
const REPO_ID = 'eeeeeeee-0000-4000-8000-000000000001';

const noopDispatcher: ControlDispatcher = (_message, reply) => {
    reply?.send({ ok: true });
    reply?.close();
};

interface GitCalls {
    readonly worktreeAdds: { repoPath: string; worktreePath: string; branchName: string; updateMain: boolean }[];
    readonly removals: { repoPath: string; worktreePath: string }[];
}

interface StubGitOptions {
    readonly roots?: Record<string, { worktreeRoot: string; parentRepoRoot: string }> | undefined;
    readonly branches?: Record<string, string> | undefined;
    readonly worktreeAddError?: Error | undefined;
    readonly removeError?: Error | undefined;
}

function stubGit(options: StubGitOptions = {}): { git: RepoCommandGit; calls: GitCalls } {
    const calls: GitCalls = { worktreeAdds: [], removals: [] };
    const git: RepoCommandGit = {
        async resolveRepoRoot(directory) {
            return options.roots?.[directory] ?? null;
        },
        async getCurrentBranch(repoPath) {
            return options.branches?.[repoPath] ?? null;
        },
        async getStatus(): Promise<RepoGitStatus> {
            return { kind: 'clean' };
        },
        async getRemoteURL() {
            return 'git@example.invalid:acme/app.git';
        },
        async worktreeAdd(request) {
            calls.worktreeAdds.push({
                repoPath: request.repoPath,
                worktreePath: request.worktreePath,
                branchName: request.branchName,
                updateMain: request.updateMain
            });
            if (options.worktreeAddError !== undefined) throw options.worktreeAddError;
        },
        async removeWorktree(repoPath, worktreePath) {
            calls.removals.push({ repoPath, worktreePath });
            if (options.removeError !== undefined) throw options.removeError;
        }
    };
    return { git, calls };
}

interface Fixture {
    readonly hub: SyncHub;
    readonly store: ReturnType<typeof storeHarness>;
    readonly calls: GitCalls;
    readonly statuses: Map<string, RepoGitStatus>;
    readonly refreshed: string[];
    connect(): { session: SyncSession; transport: RecordedTransport };
}

function fixture(options: StubGitOptions & { repos?: boolean } = {}): Fixture {
    const store = storeHarness(seededState(W1, PANE));
    const { git, calls } = stubGit(options);
    const statuses = new Map<string, RepoGitStatus>();
    const refreshed: string[] = [];
    let counter = 0;
    const channel: RepoChannel = {
        store: store.store,
        git,
        worktreeBasePath: '~/nex/worktrees/<repo>',
        uuid: () => {
            counter += 1;
            return `ffffffff-0000-4000-8000-${String(counter).padStart(12, '0')}`;
        },
        now: () => 1_700_000_000_000,
        status: {
            statusFor: (id) => statuses.get(id) ?? { kind: 'unknown' },
            refresh: async (id) => {
                refreshed.push(id);
            }
        }
    };
    const hub = createSyncHub({
        store: store.store,
        dispatcher: noopDispatcher,
        daemon: DAEMON,
        now: () => 1_700_000_000_000,
        ...(options.repos === false ? {} : { repos: channel })
    });
    return {
        hub,
        store,
        calls,
        statuses,
        refreshed,
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(
                JSON.stringify({
                    type: 'hello',
                    protocolVersion: WS_PROTOCOL_VERSION,
                    client: { kind: 'browser' }
                })
            );
            return { session, transport };
        }
    };
}

async function ask(
    session: SyncSession,
    transport: RecordedTransport,
    payload: JsonObject
): Promise<JsonObject> {
    const id = `req-${String(transport.json.length)}`;
    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
    // The repo verbs are asynchronous (they shell out to git), so the reply lands on a later
    // microtask than the message that asked for it.
    for (let tick = 0; tick < 50; tick += 1) {
        const reply = [...transport.json]
            .reverse()
            .find((message) => message['type'] === 'command-reply' && message['id'] === id);
        if (reply !== undefined) return reply['reply'] as JsonObject;
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`no reply for ${JSON.stringify(payload)}`);
}

function seedRepo(f: Fixture, path = '/src/app'): void {
    f.store.dispatch({
        type: 'add-repo',
        repo: {
            id: REPO_ID,
            path,
            name: 'app',
            remoteURL: null,
            lastAccessedAt: 1_700_000_000,
            isAutoDiscovered: true
        }
    });
}

describe('repo verbs are WS-only', () => {
    it('is not part of the CLI vocabulary', () => {
        for (const command of REPO_COMMANDS) {
            expect(isRepoCommand(command)).toBe(true);
            expect(isWireCommand(command)).toBe(false);
            expect(isWsOnlyCommand(command)).toBe(false);
        }
    });

    it('says so plainly when the daemon has no repo channel', async () => {
        const f = fixture({ repos: false });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, { command: 'repo-registry' });
        expect(reply).toEqual({ ok: false, error: 'repo commands are not available' });
    });
});

describe('repo-registry', () => {
    it('resolves each repo’s worktree base path daemon-side', async () => {
        const f = fixture();
        seedRepo(f);
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, { command: 'repo-registry' });
        expect(reply['ok']).toBe(true);
        const repos = reply['repos'] as JsonObject[];
        expect(repos).toHaveLength(1);
        expect(repos[0]?.['name']).toBe('app');
        // `~` and `<repo>` both expand here: the client's mirror has no home directory.
        expect(repos[0]?.['worktree_base']).toBe(`${HOME}/nex/worktrees/app`);
    });
});

describe('workspace-repo-status', () => {
    it('reports branch, dirtiness and diff stats per association, main checkout first', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch(
            {
                type: 'add-repo-association',
                workspaceID: W1,
                association: {
                    id: 'assoc-main',
                    repoID: REPO_ID,
                    worktreePath: '/src/app',
                    branchName: 'main',
                    isAutoDetected: false
                }
            },
            {
                type: 'add-repo-association',
                workspaceID: W1,
                association: {
                    id: 'assoc-wt',
                    repoID: REPO_ID,
                    worktreePath: '/src/worktrees/feature',
                    branchName: 'feature',
                    isAutoDetected: false
                }
            }
        );
        f.statuses.set('assoc-wt', { kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 });

        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'workspace-repo-status',
            workspace_id: W1
        });
        expect(reply['ok']).toBe(true);
        const rows = reply['associations'] as JsonObject[];
        expect(rows.map((row) => row['id'])).toEqual(['assoc-main', 'assoc-wt']);
        expect(rows[0]?.['is_worktree']).toBe(false);
        expect(rows[0]?.['repo_name']).toBe('app');
        expect(rows[0]?.['status']).toEqual({ kind: 'unknown', changed_files: 0, additions: 0, deletions: 0 });
        expect(rows[1]?.['is_worktree']).toBe(true);
        expect(rows[1]?.['branch']).toBe('feature');
        expect(rows[1]?.['status']).toEqual({
            kind: 'dirty',
            changed_files: 3,
            additions: 27,
            deletions: 12
        });
    });

    it('re-reads every association when asked to refresh', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'assoc-main',
                repoID: REPO_ID,
                worktreePath: '/src/app',
                branchName: 'main',
                isAutoDetected: false
            }
        });
        const { session, transport } = f.connect();
        await ask(session, transport, { command: 'workspace-repo-status', workspace_id: W1 });
        expect(f.refreshed).toEqual([]);
        await ask(session, transport, {
            command: 'workspace-repo-status',
            workspace_id: W1,
            refresh: true
        });
        expect(f.refreshed).toEqual(['assoc-main']);
    });

    it('refuses an unknown workspace', async () => {
        const f = fixture();
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'workspace-repo-status',
            workspace_id: W2
        });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('no workspace matches');
    });
});

describe('add-repo-association', () => {
    it('registers an unknown repo and associates its worktree root', async () => {
        const f = fixture({
            roots: { '/src/app/packages/api': { worktreeRoot: '/src/app', parentRepoRoot: '/src/app' } },
            branches: { '/src/app': 'main' }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'add-repo-association',
            workspace_id: W1,
            path: '/src/app/packages/api'
        });
        expect(reply['ok']).toBe(true);
        const state = f.store.state();
        expect(state.repos).toHaveLength(1);
        // A deliberate gesture registers a KEPT repo, never an auto-discovered one.
        expect(state.repos[0]?.isAutoDiscovered).toBe(false);
        expect(state.repos[0]?.remoteURL).toBe('git@example.invalid:acme/app.git');
        const association = state.workspaces[0]?.repoAssociations[0];
        expect(association?.worktreePath).toBe('/src/app');
        expect(association?.branchName).toBe('main');
        expect((reply['association'] as JsonObject)['is_worktree']).toBe(false);
    });

    it('associates a linked worktree while registering its PARENT repo', async () => {
        const f = fixture({
            roots: {
                '/src/wt/feature': { worktreeRoot: '/src/wt/feature', parentRepoRoot: '/src/app' }
            },
            branches: { '/src/wt/feature': 'feature' }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'add-repo-association',
            workspace_id: W1,
            path: '/src/wt/feature'
        });
        expect(reply['ok']).toBe(true);
        const state = f.store.state();
        expect(state.repos[0]?.path).toBe('/src/app');
        expect(state.workspaces[0]?.repoAssociations[0]?.worktreePath).toBe('/src/wt/feature');
        expect((reply['association'] as JsonObject)['is_worktree']).toBe(true);
    });

    it('reuses an already-registered repo instead of duplicating it', async () => {
        const f = fixture({
            roots: { '/src/app': { worktreeRoot: '/src/app', parentRepoRoot: '/src/app' } }
        });
        seedRepo(f);
        const { session, transport } = f.connect();
        await ask(session, transport, {
            command: 'add-repo-association',
            workspace_id: W1,
            path: '/src/app'
        });
        expect(f.store.state().repos).toHaveLength(1);
        expect(f.store.state().workspaces[0]?.repoAssociations[0]?.repoID).toBe(REPO_ID);
    });

    it('refuses a path that is not inside a repository, and a duplicate association', async () => {
        const f = fixture({
            roots: { '/src/app': { worktreeRoot: '/src/app', parentRepoRoot: '/src/app' } }
        });
        const { session, transport } = f.connect();
        const notARepo = await ask(session, transport, {
            command: 'add-repo-association',
            workspace_id: W1,
            path: '/tmp/elsewhere'
        });
        expect(notARepo['ok']).toBe(false);
        expect(String(notARepo['error'])).toContain('not inside a git repository');

        await ask(session, transport, { command: 'add-repo-association', workspace_id: W1, path: '/src/app' });
        const duplicate = await ask(session, transport, {
            command: 'add-repo-association',
            workspace_id: W1,
            path: '/src/app'
        });
        expect(duplicate['ok']).toBe(false);
        expect(String(duplicate['error'])).toContain('already associated');
    });
});

describe('remove-repo-association', () => {
    it('drops the association', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'assoc-main',
                repoID: REPO_ID,
                worktreePath: '/src/app',
                branchName: 'main',
                isAutoDetected: false
            }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'remove-repo-association',
            workspace_id: W1,
            association_id: 'assoc-main'
        });
        expect(reply['ok']).toBe(true);
        expect(f.store.state().workspaces[0]?.repoAssociations).toHaveLength(0);
    });

    it('runs a non-forcing worktree remove for "Remove & Delete Worktree"', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'assoc-wt',
                repoID: REPO_ID,
                worktreePath: '/src/worktrees/feature',
                branchName: 'feature',
                isAutoDetected: false
            }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'remove-repo-association',
            workspace_id: W1,
            association_id: 'assoc-wt',
            delete_worktree: true
        });
        expect(reply['ok']).toBe(true);
        expect(f.calls.removals).toEqual([{ repoPath: '/src/app', worktreePath: '/src/worktrees/feature' }]);
        expect(f.store.state().workspaces[0]?.repoAssociations).toHaveLength(0);
    });

    it('keeps the row when git refuses to delete the worktree', async () => {
        const f = fixture({ removeError: new Error('fatal: contains modified or untracked files') });
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'assoc-wt',
                repoID: REPO_ID,
                worktreePath: '/src/worktrees/feature',
                branchName: 'feature',
                isAutoDetected: false
            }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'remove-repo-association',
            workspace_id: W1,
            association_id: 'assoc-wt',
            delete_worktree: true
        });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('modified or untracked');
        // The directory still exists, so the association that points at it must survive.
        expect(f.store.state().workspaces[0]?.repoAssociations).toHaveLength(1);
    });

    it('refuses to delete the main checkout as if it were a worktree', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: {
                id: 'assoc-main',
                repoID: REPO_ID,
                worktreePath: '/src/app',
                branchName: 'main',
                isAutoDetected: false
            }
        });
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'remove-repo-association',
            workspace_id: W1,
            association_id: 'assoc-main',
            delete_worktree: true
        });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('main checkout');
        expect(f.calls.removals).toEqual([]);
    });
});

describe('workspace-add-worktree', () => {
    it('creates the worktree under the resolved base path and associates it', async () => {
        const f = fixture();
        seedRepo(f);
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'workspace-add-worktree',
            workspace_id: W1,
            repo_id: REPO_ID,
            name: 'Fix Login Bug',
            update_main: true
        });
        expect(reply['ok']).toBe(true);
        // Sanitization is the daemon's, and it is the same one the CLI's `--worktree` uses.
        expect(f.calls.worktreeAdds).toEqual([
            {
                repoPath: '/src/app',
                worktreePath: `${HOME}/nex/worktrees/app/Fix-Login-Bug`,
                branchName: 'Fix-Login-Bug',
                updateMain: true
            }
        ]);
        expect(reply['branch']).toBe('Fix-Login-Bug');
        const association = f.store.state().workspaces[0]?.repoAssociations[0];
        expect(association?.worktreePath).toBe(`${HOME}/nex/worktrees/app/Fix-Login-Bug`);
        expect(association?.branchName).toBe('Fix-Login-Bug');
    });

    it('honours a hand-edited branch name and refuses names that sanitize to nothing', async () => {
        const f = fixture();
        seedRepo(f);
        const { session, transport } = f.connect();
        const branched = await ask(session, transport, {
            command: 'workspace-add-worktree',
            workspace_id: W1,
            repo_id: REPO_ID,
            name: 'spike',
            branch: 'feature/spike'
        });
        expect(branched['ok']).toBe(true);
        expect(f.calls.worktreeAdds[0]?.branchName).toBe('feature/spike');

        const rejected = await ask(session, transport, {
            command: 'workspace-add-worktree',
            workspace_id: W1,
            repo_id: REPO_ID,
            name: '///'
        });
        expect(rejected['ok']).toBe(false);
        expect(String(rejected['error'])).toContain("isn't a usable worktree name");
    });

    it('surfaces git’s own diagnostic and writes nothing when the add fails', async () => {
        const error = Object.assign(new Error('git failed'), {
            name: 'GitCommandError',
            stderr: "Preparing worktree (new branch 'x')\nfatal: 'x' already exists",
            code: 128,
            args: [] as string[]
        });
        const f = fixture({ worktreeAddError: error });
        seedRepo(f);
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'workspace-add-worktree',
            workspace_id: W1,
            repo_id: REPO_ID,
            name: 'x'
        });
        expect(reply['ok']).toBe(false);
        expect(f.store.state().workspaces[0]?.repoAssociations).toHaveLength(0);
    });
});

describe('bulk workspace verbs', () => {
    function bulkFixture(): Fixture {
        const f = fixture();
        f.store.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: 'dddddddd-0000-4000-8000-000000000200',
            name: 'second',
            color: 'green',
            now: 1_700_000_000_000
        });
        return f;
    }

    it('recolours every selected workspace in one dispatch', async () => {
        const f = bulkFixture();
        const before = f.store.batches.length;
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'set-bulk-color',
            workspace_ids: [W1, W2],
            color: 'purple'
        });
        expect(reply['ok']).toBe(true);
        expect(f.store.state().workspaces.map((workspace) => workspace.color)).toEqual([
            'purple',
            'purple'
        ]);
        expect(f.store.batches.length).toBe(before + 1);
    });

    it('applies and removes a label across the selection', async () => {
        const f = bulkFixture();
        const { session, transport } = f.connect();
        await ask(session, transport, {
            command: 'set-bulk-label',
            workspace_ids: [W1, W2],
            label: 'review',
            apply: true
        });
        expect(f.store.state().workspaces.map((workspace) => workspace.labels)).toEqual([
            ['review'],
            ['review']
        ]);
        await ask(session, transport, {
            command: 'set-bulk-label',
            workspace_ids: [W1, W2],
            label: 'review',
            apply: false
        });
        expect(f.store.state().workspaces.map((workspace) => workspace.labels)).toEqual([[], []]);
    });

    it('creates a group holding the selection in one dispatch', async () => {
        const f = bulkFixture();
        const before = f.store.batches.length;
        const { session, transport } = f.connect();
        const reply = await ask(session, transport, {
            command: 'create-group-for-workspaces',
            name: 'Review',
            color: 'purple',
            workspace_ids: [W2, W1]
        });
        expect(reply['ok']).toBe(true);
        const groups = f.store.state().groups;
        expect(groups).toHaveLength(1);
        expect(groups[0]?.name).toBe('Review');
        expect(groups[0]?.color).toBe('purple');
        // Membership order is the order the caller captured from the sidebar walk.
        expect(groups[0]?.childOrder).toEqual([W2, W1]);
        expect(reply['group_id']).toBe(groups[0]?.id);
        // One dispatch: the header and its members must not arrive as two sidebar jumps.
        expect(f.store.batches.length).toBe(before + 1);
    });

    it('refuses a nameless or empty group selection', async () => {
        const f = bulkFixture();
        const { session, transport } = f.connect();
        expect(
            (await ask(session, transport, {
                command: 'create-group-for-workspaces',
                name: '  ',
                workspace_ids: [W1]
            }))['ok']
        ).toBe(false);
        expect(
            (await ask(session, transport, {
                command: 'create-group-for-workspaces',
                name: 'Review',
                workspace_ids: []
            }))['ok']
        ).toBe(false);
    });

    it('refuses an unknown workspace, an unknown colour and an empty label', async () => {
        const f = bulkFixture();
        const { session, transport } = f.connect();
        const unknownWorkspace = await ask(session, transport, {
            command: 'set-bulk-color',
            workspace_ids: [W1, 'nope'],
            color: 'blue'
        });
        expect(unknownWorkspace).toEqual({ ok: false, error: "no workspace matches 'nope'" });
        const unknownColor = await ask(session, transport, {
            command: 'set-bulk-color',
            workspace_ids: [W1],
            color: 'chartreuse'
        });
        expect(unknownColor['ok']).toBe(false);
        const emptyLabel = await ask(session, transport, {
            command: 'set-bulk-label',
            workspace_ids: [W1],
            label: '   ',
            apply: true
        });
        expect(emptyLabel['ok']).toBe(false);
    });
});
