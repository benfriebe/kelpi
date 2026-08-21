import { describe, expect, it } from 'vitest';

import { GitCommandError, type GitService, type WorktreeAddRequest } from '../../git/index.js';
import { stubGitService } from '../../git/testing.js';
import { createStore, emptyDaemonState, makeWorkspaceState, type DaemonState } from '../../store/index.js';
import { flush, harness, HOME, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const W3 = id('aaaaaaaa', 3);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const G1 = id('cccccccc', 1);

function stubGit(overrides: Partial<GitService> = {}): GitService {
    return stubGitService(overrides);
}

// ---------------------------------------------------------------------------
// workspace-list
// ---------------------------------------------------------------------------

describe('workspace-list', () => {
    it('emits the documented entry schema with the optional fields elided', () => {
        const h = harness({ initial: seeded(1) });
        const reply = h.reply({ command: 'workspace-list' });
        expect(reply['ok']).toBe(true);
        const entries = reply['workspaces'] as Record<string, unknown>[];
        expect(entries).toHaveLength(1);
        expect(entries[0]).toEqual({
            id: W1,
            name: 'w1',
            color: 'blue',
            pane_count: 1,
            is_active: true,
            created_at: '2025-08-18T06:53:20Z',
            last_accessed_at: '2025-08-18T06:53:20Z',
            labels: [],
            last_activity_at: '2025-08-18T06:53:20Z'
        });
    });

    it('walks the sidebar order and includes members of a COLLAPSED group', () => {
        const h = harness({ initial: seeded(3) });
        h.dispatch(
            { type: 'create-group', id: G1, name: 'grp', now: NOW },
            { type: 'move-workspace-to-group', id: W2, groupID: G1 },
            { type: 'set-group-collapsed', id: G1, collapsed: true }
        );
        const reply = h.reply({ command: 'workspace-list' });
        const names = (reply['workspaces'] as { name: string }[]).map((entry) => entry.name);
        // w2 moved into the (collapsed) group, whose header sits after w1/w3 at top level.
        expect(names).toEqual(['w1', 'w3', 'w2']);
    });

    it('appends a workspace unreachable through the top-level order instead of hiding it', () => {
        const base = seeded(2);
        const broken: DaemonState = {
            ...base,
            topLevelOrder: base.topLevelOrder.filter(
                (entry) => !(entry.kind === 'workspace' && entry.id === W1)
            )
        };
        const h = harness({ initial: broken });
        const names = (h.reply({ command: 'workspace-list' })['workspaces'] as { name: string }[]).map(
            (entry) => entry.name
        );
        expect(names).toEqual(['w2', 'w1']);
    });

    it('dedupes a corrupted order that lists the same workspace twice', () => {
        const base = seeded(1);
        const duped: DaemonState = {
            ...base,
            topLevelOrder: [...base.topLevelOrder, ...base.topLevelOrder]
        };
        const h = harness({ initial: duped });
        expect(h.reply({ command: 'workspace-list' })['workspaces']).toHaveLength(1);
    });

    it('carries group_id + group_name together, labels always, and the first session id', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch(
            { type: 'create-group', id: G1, name: 'grp', now: NOW },
            { type: 'move-workspace-to-group', id: W1, groupID: G1 },
            { type: 'workspace-labels', id: W1, op: 'add', values: ['wip'] },
            {
                type: 'pane-agent-event',
                paneID: P1,
                event: { type: 'sessionStarted', sessionID: 'sess-1', agent: 'codex' },
                now: NOW
            }
        );
        const entry = (h.reply({ command: 'workspace-list' })['workspaces'] as Record<string, unknown>[])[0];
        expect(entry).toMatchObject({
            group_id: G1,
            group_name: 'grp',
            labels: ['wip'],
            agent_session_id: 'sess-1'
        });
    });

    it('omits last_activity_at for a workspace with no panes', () => {
        const store = createStore(emptyDaemonState(HOME));
        store.dispatch({
            type: 'replace-state',
            state: {
                ...emptyDaemonState(HOME),
                workspaces: [
                    makeWorkspaceState({ id: W1, name: 'empty', slug: 'empty', color: 'red', createdAt: 1 })
                ],
                topLevelOrder: [{ kind: 'workspace', id: W1 }]
            }
        });
        const h = harness({ initial: store.getState() });
        const entry = (h.reply({ command: 'workspace-list' })['workspaces'] as Record<string, unknown>[])[0];
        expect(entry).not.toHaveProperty('last_activity_at');
        expect(entry).toMatchObject({ pane_count: 0, labels: [] });
    });

    it('errors on an unknown group filter but returns an empty list for an empty group', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'create-group', id: G1, name: 'grp', now: NOW });

        expect(h.reply({ command: 'workspace-list', group: 'nope' })).toEqual({
            ok: false,
            error: "no group matches 'nope'"
        });
        expect(h.reply({ command: 'workspace-list', group: 'grp' })).toEqual({
            ok: true,
            workspaces: []
        });
    });

    it('scopes to the group members, preserving order', () => {
        const h = harness({ initial: seeded(3) });
        h.dispatch(
            { type: 'create-group', id: G1, name: 'grp', now: NOW },
            { type: 'move-workspace-to-group', id: W3, groupID: G1 },
            { type: 'move-workspace-to-group', id: W1, groupID: G1 }
        );
        const names = (
            h.reply({ command: 'workspace-list', group: G1 })['workspaces'] as { name: string }[]
        ).map((entry) => entry.name);
        expect(names).toEqual(['w3', 'w1']);
    });
});

// ---------------------------------------------------------------------------
// workspace-create
// ---------------------------------------------------------------------------

describe('workspace-create (top level)', () => {
    it('acks the pre-minted id BEFORE the workspace exists, then creates and spawns it', () => {
        const h = harness({ ids: [W1, P1] });
        const reply = h.reply({ command: 'workspace-create', name: 'dev', path: '/code/dev' });
        expect(reply).toEqual({ ok: true, workspace_id: W1, workspace_name: 'dev' });
        // Reply-before-effect: nothing existed when the ack went out.
        expect(h.replies[0]?.states[0]?.workspaces).toHaveLength(0);

        const workspace = h.state().workspaces[0];
        expect(workspace?.id).toBe(W1);
        expect(workspace?.panes[0]?.workingDirectory).toBe('/code/dev');
        expect(h.spawned).toEqual([
            { paneID: P1, workspaceID: W1, cwd: '/code/dev', profileName: null }
        ]);
        expect(h.scrolled).toEqual([{ kind: 'workspace', id: W1 }]);
        expect(h.persists.length).toBeGreaterThan(0);
    });

    it('defaults the name to "Workspace" and normalizes the profile assignment', () => {
        const h = harness({ ids: [W1, P1] });
        const reply = h.reply({ command: 'workspace-create', profile: 'default' });
        expect(reply['workspace_name']).toBe('Workspace');
        expect(h.state().workspaces[0]?.profileName).toBeNull();

        const h2 = harness({ ids: [W2, P2] });
        h2.reply({ command: 'workspace-create', profile: ' work ' });
        expect(h2.state().workspaces[0]?.profileName).toBe('work');
    });

    it('reveals the new workspace to every attached client', () => {
        // run-B L3: the port's active workspace is per client, so the reducer marking the new
        // workspace last-active only moved what `nex workspace list` calls ACTIVE — a
        // `nex workspace create` from a terminal left every open window on the old workspace
        // indefinitely, and the agent's next `nex pane create` landed somewhere invisible.
        // A create is broadcast as a reveal, which clients already act on (ws/sync.ts).
        const h = harness({ ids: [W1, P1] });
        h.reply({ command: 'workspace-create', name: 'dev' });
        expect(h.broadcasts).toContainEqual({ type: 'reveal-pane', workspaceID: W1, paneID: P1 });
    });

    it('keeps an unrecognized color out of the reply path and picks a random one', () => {
        const h = harness({ ids: [W1, P1], random: () => 0 });
        h.reply({ command: 'workspace-create', color: 'chartreuse' });
        expect(h.state().workspaces[0]?.color).toBe('red');
    });
});

describe('workspace-create (group)', () => {
    it('creates the group when missing and echoes the trimmed group name', () => {
        // The workspace id is minted FIRST (§6.2c step 2), the group only if it is missing.
        const h = harness({ ids: [W1, G1, P1] });
        const reply = h.reply({ command: 'workspace-create', name: 'dev', group: '  team  ' });
        expect(reply).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'dev',
            group: 'team'
        });
        const group = h.state().groups[0];
        expect(group?.id).toBe(G1);
        expect(group?.name).toBe('team');
        expect(group?.childOrder).toEqual([W1]);
        expect(h.scrolled).toEqual([{ kind: 'workspace', id: W1 }]);
    });

    it('reuses an existing group', () => {
        const h = harness({ initial: seeded(1), ids: [W2, P2] });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.reply({ command: 'workspace-create', name: 'dev', group: 'team' });
        expect(h.state().groups).toHaveLength(1);
        expect(h.state().groups[0]?.childOrder).toEqual([W2]);
    });

    it('rejects an ambiguous group name before mutating anything', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch(
            { type: 'create-group', id: G1, name: 'team', now: NOW },
            { type: 'create-group', id: id('cccccccc', 2), name: 'team', now: NOW }
        );
        const before = h.state();
        expect(h.reply({ command: 'workspace-create', name: 'dev', group: 'team' })).toEqual({
            ok: false,
            error: 'group name is ambiguous: team (use the id or rename an existing group)'
        });
        expect(h.state()).toBe(before);
    });
});

describe('workspace-create (worktree)', () => {
    const worktreeRequest = {
        command: 'workspace-create',
        name: 'feature-x',
        worktree: 'feature x',
        repo: '/code/nex'
    };

    it('adds the worktree, seeds the workspace from it, and replies late', async () => {
        const requests: WorktreeAddRequest[] = [];
        const h = harness({
            ids: [id('bbbbbbbb', 9), W1, P1, id('eeeeeeee', 1)],
            worktreeBasePath: '~/wt/<repo>',
            git: stubGit({
                worktreeAdd: async (request) => {
                    requests.push(request);
                }
            })
        });
        expect(h.send(worktreeRequest)).toEqual([]); // nothing yet: the git work is async
        await flush();

        expect(requests).toEqual([
            {
                repoPath: '/code/nex',
                worktreePath: `${HOME}/wt/nex/feature-x`,
                branchName: 'feature-x',
                updateMain: false
            }
        ]);
        expect(h.replies[0]?.payloads[0]).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'feature-x',
            worktree_path: `${HOME}/wt/nex/feature-x`,
            branch: 'feature-x'
        });

        const workspace = h.state().workspaces[0];
        expect(workspace?.panes[0]?.workingDirectory).toBe(`${HOME}/wt/nex/feature-x`);
        expect(h.state().repos).toEqual([
            expect.objectContaining({ path: '/code/nex', name: 'nex', isAutoDiscovered: false })
        ]);
        expect(workspace?.repoAssociations).toEqual([
            expect.objectContaining({
                worktreePath: `${HOME}/wt/nex/feature-x`,
                branchName: 'feature-x',
                isAutoDetected: false
            })
        ]);
    });

    it('sanitizes an explicit branch and falls back to the worktree name', async () => {
        const requests: WorktreeAddRequest[] = [];
        const h = harness({
            git: stubGit({
                worktreeAdd: async (request) => {
                    requests.push(request);
                }
            })
        });
        h.send({ ...worktreeRequest, branch: 'feature/My Thing!!', update_main: true });
        await flush();
        expect(requests[0]?.branchName).toBe('feature/My-Thing');
        expect(requests[0]?.updateMain).toBe(true);
    });

    it('reuses a registered repo by standardized path instead of minting a second one', async () => {
        const base = seeded(1);
        const withRepo: DaemonState = {
            ...base,
            repos: [
                {
                    id: id('9999aaaa', 1),
                    path: '/code/nex',
                    name: 'nex',
                    remoteURL: null,
                    lastAccessedAt: 1,
                    isAutoDiscovered: true
                }
            ]
        };
        const h = harness({ initial: withRepo, git: stubGit() });
        h.send({ ...worktreeRequest, repo: '/code/other/../nex/' });
        await flush();
        expect(h.state().repos).toHaveLength(1);
        expect(h.state().workspaces[1]?.repoAssociations[0]?.repoID).toBe(id('9999aaaa', 1));
    });

    it('mines the LAST fatal: line out of git stderr on failure and creates nothing', async () => {
        const h = harness({
            git: stubGit({
                worktreeAdd: async () => {
                    throw new GitCommandError({
                        command: 'git worktree add',
                        exitCode: 128,
                        stderr: "Preparing worktree (new branch 'x')\nfatal: '/wt/x' already exists",
                        cwd: '/code/nex'
                    });
                }
            })
        });
        h.send(worktreeRequest);
        await flush();
        expect(h.replies[0]?.payloads[0]).toEqual({
            ok: false,
            error: "fatal: '/wt/x' already exists"
        });
        expect(h.state().workspaces).toHaveLength(0);
        expect(h.state().repos).toHaveLength(0);
    });

    it('rejects an unknown group and NEVER creates one', async () => {
        const h = harness({ git: stubGit() });
        expect(h.reply({ ...worktreeRequest, group: 'nope' })).toEqual({
            ok: false,
            error: 'unknown group: nope — --worktree only supports existing groups; create it first (`nex group create`) or omit --group'
        });
        await flush();
        expect(h.state().groups).toHaveLength(0);
    });

    it('rejects an ambiguous group with the shared ambiguity message', () => {
        const h = harness({ git: stubGit() });
        h.dispatch(
            { type: 'create-group', id: G1, name: 'team', now: NOW },
            { type: 'create-group', id: id('cccccccc', 2), name: 'team', now: NOW }
        );
        expect(h.reply({ ...worktreeRequest, group: 'team' })).toEqual({
            ok: false,
            error: 'group name is ambiguous: team (use the id or rename an existing group)'
        });
    });

    it('echoes the resolved group on success', async () => {
        const h = harness({ git: stubGit() });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.send({ ...worktreeRequest, group: 'team' });
        await flush();
        expect(h.replies[0]?.payloads[0]).toMatchObject({ ok: true, group: 'team' });
    });

    it('requires a source repo', () => {
        const h = harness({ git: stubGit() });
        expect(h.reply({ command: 'workspace-create', worktree: 'x' })).toEqual({
            ok: false,
            error: '--worktree requires a source repo (pass --repo <path>)'
        });
    });

    it('falls back to --path as the source repo', async () => {
        const requests: WorktreeAddRequest[] = [];
        const h = harness({
            git: stubGit({
                worktreeAdd: async (request) => {
                    requests.push(request);
                }
            })
        });
        h.send({ command: 'workspace-create', worktree: 'x', path: '/code/nex' });
        await flush();
        expect(requests[0]?.repoPath).toBe('/code/nex');
    });

    it('rejects worktree and branch names that sanitize away', () => {
        const h = harness({ git: stubGit() });
        expect(h.reply({ command: 'workspace-create', worktree: '///', repo: '/r' })).toEqual({
            ok: false,
            error: `"///" isn't a usable worktree name`
        });
        expect(
            h.reply({ command: 'workspace-create', worktree: 'ok', branch: '!!!', repo: '/r' })
        ).toEqual({ ok: false, error: `"!!!" isn't a usable branch name` });
    });
});

// ---------------------------------------------------------------------------
// workspace-delete
// ---------------------------------------------------------------------------

describe('workspace-delete', () => {
    it('refuses to delete the last workspace', () => {
        const h = harness({ initial: seeded(1) });
        expect(h.reply({ command: 'workspace-delete', name: 'w1' })).toEqual({
            ok: false,
            error: 'refusing to delete the last workspace'
        });
        expect(h.state().workspaces).toHaveLength(1);
    });

    it('distinguishes an ambiguous name from a missing one', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch({ type: 'rename-workspace', id: W2, name: 'w1' });
        expect(h.reply({ command: 'workspace-delete', name: 'w1' })).toEqual({
            ok: false,
            error: 'workspace name is ambiguous: w1 (use the id)'
        });
        expect(h.reply({ command: 'workspace-delete', name: 'ghost' })).toEqual({
            ok: false,
            error: 'workspace not found: ghost'
        });
    });

    it('refuses while agents are running and reports the count', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P1,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        expect(h.reply({ command: 'workspace-delete', name: 'w1' })).toEqual({
            ok: false,
            error: 'workspace w1 has 1 running agent; pass --force to delete anyway',
            active_agents: 1
        });
        expect(h.state().workspaces).toHaveLength(2);
    });

    it('pluralizes the running-agent noun', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW },
            {
                type: 'pane-agent-event',
                paneID: P1,
                event: { type: 'agentStarted', agent: 'claude' },
                now: NOW
            },
            {
                type: 'pane-agent-event',
                paneID: P2,
                event: { type: 'agentStopped', backgroundTaskCount: 0 },
                now: NOW
            }
        );
        expect(h.reply({ command: 'workspace-delete', name: 'w1' })['error']).toBe(
            'workspace w1 has 2 running agents; pass --force to delete anyway'
        );
    });

    it('--force deletes anyway, killing every pane and reporting the shell cwd', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P1,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        const reply = h.reply({ command: 'workspace-delete', name: 'w1', force: true });
        expect(reply).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'w1',
            path: HOME
        });
        expect(h.killed).toEqual([P1]);
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W2]);
    });

    it('reports the FIRST SHELL pane cwd even when a content pane comes first', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch(
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: P2,
                filePath: '/docs/a.md',
                reusePaneID: P1,
                now: NOW
            },
            { type: 'pane-directory-changed', paneID: P1, directory: '/code/wt', now: NOW }
        );
        // P1 is parked now, so the only visible pane is the markdown one.
        const reply = h.reply({ command: 'workspace-delete', name: 'w1' });
        expect(reply['path']).toBe('/docs');
        expect(h.killed).toEqual(expect.arrayContaining([P1, P2]));
    });

    it('omits path for a workspace with no panes', () => {
        const base = seeded(1);
        const withEmpty: DaemonState = {
            ...base,
            workspaces: [
                ...base.workspaces,
                makeWorkspaceState({ id: W2, name: 'empty', slug: 'empty', color: 'red', createdAt: 1 })
            ],
            topLevelOrder: [...base.topLevelOrder, { kind: 'workspace', id: W2 }]
        };
        const h = harness({ initial: withEmpty });
        const reply = h.reply({ command: 'workspace-delete', name: 'empty' });
        expect(reply).toEqual({ ok: true, workspace_id: W2, workspace_name: 'empty' });
    });

    it('still deletes on the legacy fire-and-forget path but drops failures silently', () => {
        const h = harness({ initial: seeded(2) });
        const message = { command: 'workspace-delete' as const, name: 'w1', force: false };
        h.table.get('workspace-delete')?.(message, h.ctx, null);
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W2]);

        h.table.get('workspace-delete')?.({ ...message, name: 'ghost' }, h.ctx, null);
        expect(h.state().workspaces).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// workspace-move / workspace-profile (fire-and-forget)
// ---------------------------------------------------------------------------

describe('workspace-move and workspace-profile', () => {
    it('moves into an existing group and back to the top level, silently', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });

        expect(h.send({ command: 'workspace-move', name: 'w1', group: 'team' })).toEqual([]);
        expect(h.state().groups[0]?.childOrder).toEqual([W1]);

        h.send({ command: 'workspace-move', name: 'w1' });
        expect(h.state().groups[0]?.childOrder).toEqual([]);
    });

    it('honors --index inside the group', () => {
        const h = harness({ initial: seeded(3) });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.send({ command: 'workspace-move', name: 'w1', group: 'team' });
        h.send({ command: 'workspace-move', name: 'w2', group: 'team' });
        h.send({ command: 'workspace-move', name: 'w3', group: 'team', index: 1 });
        expect(h.state().groups[0]?.childOrder).toEqual([W1, W3, W2]);
    });

    /*
     * SET-012. The setting is applied at the VERB because the sidebar's drop is this verb (the
     * wire-field dictionary has no field to carry a per-gesture answer, and inventing one would
     * put the decoder out of conformance with wire-protocol.md §7), so both directions are
     * asserted here: on (the default) opens a collapsed target, off leaves it shut.
     */
    it('expands a collapsed target group by default (SET-012)', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.send({ command: 'workspace-move', name: 'w1', group: 'team' });
        expect(h.state().groups[0]?.childOrder).toEqual([W1]);
        expect(h.state().groups[0]?.isCollapsed).toBe(false);
    });

    it('leaves a collapsed target group collapsed when the setting is off (SET-012)', () => {
        const h = harness({ initial: seeded(1), expandGroupOnDrop: false });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.send({ command: 'workspace-move', name: 'w1', group: 'team' });
        expect(h.state().groups[0]?.childOrder).toEqual([W1]);
        expect(h.state().groups[0]?.isCollapsed).toBe(true);
    });

    it('reads the setting per command, so a Settings write lands on the next move (SET-012)', () => {
        let expand = false;
        const h = harness({ initial: seeded(2), expandGroupOnDrop: () => expand });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW });
        h.dispatch({ type: 'set-group-collapsed', id: G1, collapsed: true });
        h.send({ command: 'workspace-move', name: 'w1', group: 'team' });
        expect(h.state().groups[0]?.isCollapsed).toBe(true);
        // …the user flips the toggle: no table rebuild, no daemon restart.
        expand = true;
        h.send({ command: 'workspace-move', name: 'w2', group: 'team' });
        expect(h.state().groups[0]?.isCollapsed).toBe(false);
    });

    it('never creates a group and no-ops on an unresolvable name', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'workspace-move', name: 'w1', group: 'nope' });
        expect(h.state().groups).toHaveLength(0);
        h.send({ command: 'workspace-move', name: 'ghost' });
        expect(h.state().workspaces).toHaveLength(1);
    });

    it('assigns and clears the profile with "default"/empty normalization', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'workspace-profile', name: 'w1', profile: 'work' });
        expect(h.state().workspaces[0]?.profileName).toBe('work');
        h.send({ command: 'workspace-profile', name: 'w1' });
        expect(h.state().workspaces[0]?.profileName).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// workspace-label
// ---------------------------------------------------------------------------

describe('workspace-label', () => {
    it('sets, adds, removes and clears, replying with the post-mutation set', () => {
        const h = harness({ initial: seeded(1) });
        expect(
            h.reply({
                command: 'workspace-label',
                name: 'w1',
                label_op: 'set',
                label_values: ['b', 'a', 'b']
            })
        ).toEqual({ ok: true, workspace_id: W1, workspace_name: 'w1', labels: ['b', 'a'] });

        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'add', label_values: ['a', 'c'] })[
                'labels'
            ]
        ).toEqual(['b', 'a', 'c']);

        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'remove', label_values: ['b'] })[
                'labels'
            ]
        ).toEqual(['a', 'c']);

        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'clear', label_values: [] })[
                'labels'
            ]
        ).toEqual([]);
    });

    it('back-fills a gray preset for every introduced label without overwriting a chosen color', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'add-label-preset', name: 'a', color: { kind: 'named', color: 'purple' } });
        h.reply({ command: 'workspace-label', name: 'w1', label_op: 'set', label_values: ['a', 'z'] });
        expect(h.state().labelPresets).toEqual([
            { name: 'a', color: { kind: 'named', color: 'purple' }, textColor: null },
            { name: 'z', color: { kind: 'named', color: 'gray' }, textColor: null }
        ]);
    });

    it('normalizes values (trim + 64-char clamp) and drops empties', () => {
        const h = harness({ initial: seeded(1) });
        const long = 'x'.repeat(80);
        const labels = h.reply({
            command: 'workspace-label',
            name: 'w1',
            label_op: 'set',
            label_values: ['  wip \n', '   ', long]
        })['labels'] as string[];
        expect(labels).toEqual(['wip', 'x'.repeat(64)]);
    });

    it('refuses a set/add/remove whose values all normalize away', () => {
        const h = harness({ initial: seeded(1) });
        h.reply({ command: 'workspace-label', name: 'w1', label_op: 'add', label_values: ['keep'] });
        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'set', label_values: ['  '] })
        ).toEqual({
            ok: false,
            error: 'no label value to set (use --clear to remove all labels)'
        });
        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'add', label_values: [] })['error']
        ).toBe('no label value to add');
        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'remove', label_values: [''] })[
                'error'
            ]
        ).toBe('no label value to remove');
        // The guard must not have wiped anything.
        expect(h.state().workspaces[0]?.labels).toEqual(['keep']);
    });

    it('rejects an unknown workspace and an unknown operation', () => {
        const h = harness({ initial: seeded(1) });
        expect(
            h.reply({ command: 'workspace-label', name: 'ghost', label_op: 'set', label_values: ['a'] })
        ).toEqual({ ok: false, error: "no workspace matches 'ghost'" });
        expect(
            h.reply({ command: 'workspace-label', name: 'w1', label_op: 'toggle', label_values: ['a'] })
        ).toEqual({ ok: false, error: "unknown label operation 'toggle'" });
    });
});
