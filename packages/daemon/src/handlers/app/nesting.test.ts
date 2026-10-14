/**
 * Nested workspaces over the wire (app-state-core.md §2.9): `workspace-create` with `parent` /
 * `parent_pane_id`, `workspace-nest`, `workspace-delete` with `cascade`, `workspace-list`'s
 * `parent_id` / `parent_name` and `parent` filter, and the group cascade's teardown.
 */

import { describe, expect, it } from 'vitest';

import { stubGitService } from '../../git/testing.js';
import { workspaceByID, type DaemonState } from '../../store/index.js';
import { flush, harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const W3 = id('aaaaaaaa', 3);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const P3 = id('dddddddd', 3);
const G1 = id('cccccccc', 1);
const NEW = id('bbbbbbbb', 1);
const NEW_PANE = id('bbbbbbbb', 2);

function childrenOf(state: DaemonState, workspaceID: string): readonly string[] {
    return workspaceByID(state, workspaceID)?.childOrder ?? [];
}

/** w1 with w2 and w3 nested under it. */
function family(): ReturnType<typeof harness> {
    const h = harness({ initial: seeded(3) });
    h.dispatch({ type: 'nest-workspaces', ids: [W2, W3], parentID: W1 });
    return h;
}

describe('workspace-create with a parent', () => {
    it('nests under a parent named by name or id, and echoes it', () => {
        const h = harness({ initial: seeded(1), ids: [NEW, NEW_PANE] });
        expect(h.reply({ command: 'workspace-create', name: 'worker', parent: 'w1' })).toEqual({
            ok: true,
            workspace_id: NEW,
            workspace_name: 'worker',
            muted: false,
            parent_id: W1,
            parent_name: 'w1'
        });
        expect(childrenOf(h.state(), W1)).toEqual([NEW]);
        expect(h.state().topLevelOrder.map((entry) => entry.id)).toEqual([W1]);
    });

    it('nests under the workspace holding parent_pane_id (`--nested`)', () => {
        const h = harness({ initial: seeded(2), ids: [NEW, NEW_PANE] });
        const reply = h.reply({ command: 'workspace-create', name: 'worker', parent_pane_id: P2.toLowerCase() });
        expect(reply).toMatchObject({ ok: true, parent_id: W2, parent_name: 'w2' });
        expect(childrenOf(h.state(), W2)).toEqual([NEW]);
    });

    it('refuses before creating anything: unknown, both, with a group, or a nested parent', () => {
        const h = family();
        const before = h.state().workspaces.length;
        expect(h.reply({ command: 'workspace-create', parent: 'ghost' })).toEqual({
            ok: false,
            error: 'parent workspace not found: ghost'
        });
        expect(h.reply({ command: 'workspace-create', parent_pane_id: id('eeeeeeee', 1) })['error']).toMatch(
            /no pane matches/
        );
        expect(h.reply({ command: 'workspace-create', parent: 'w1', parent_pane_id: P1 })['error']).toMatch(
            /not both/
        );
        expect(h.reply({ command: 'workspace-create', parent: 'w1', group: 'team' })['error']).toMatch(
            /follows its parent's group/
        );
        expect(h.reply({ command: 'workspace-create', parent: 'w2' })['error']).toMatch(/nest one level deep/);
        expect(h.state().workspaces).toHaveLength(before);
        expect(h.state().groups).toHaveLength(0);
    });

    it('follows a grouped parent into its group without making a group of its own', () => {
        const h = harness({ initial: seeded(1), ids: [NEW, NEW_PANE] });
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW, initialWorkspaceIDs: [W1] });
        h.reply({ command: 'workspace-create', name: 'worker', parent: W1 });
        expect(h.state().groups).toHaveLength(1);
        expect(h.state().groups[0]?.childOrder).toEqual([W1]);
        expect(childrenOf(h.state(), W1)).toEqual([NEW]);
    });
});

describe('an empty parent (§2.9: never read as "no parent")', () => {
    it('is refused by create, list and nest, and creates nothing', () => {
        const h = family();
        const before = h.state().workspaces.length;
        for (const parent of ['', '   ']) {
            expect(h.reply({ command: 'workspace-create', name: 'stray', parent })).toEqual({
                ok: false,
                error: 'parent must name a workspace (got an empty value)'
            });
            expect(h.reply({ command: 'workspace-list', parent })).toEqual({
                ok: false,
                error: 'parent must name a workspace (got an empty value)'
            });
            expect(h.reply({ command: 'workspace-nest', name: 'w2', parent })).toEqual({
                ok: false,
                error: 'parent must name a workspace (got an empty value)'
            });
        }
        expect(h.reply({ command: 'workspace-create', name: 'stray', parent_pane_id: ' ' })).toMatchObject({ ok: false });
        expect(h.state().workspaces).toHaveLength(before);
    });
});

describe('an async create whose parent goes away while git runs (§2.9)', () => {
    const REPO = '/code/kelpi';

    /** w1 (the parent) and w2, with git held open until `release` is called. */
    function gated() {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = harness({
            initial: seeded(2),
            worktreeBasePath: '~/wt/<repo>',
            git: stubGitService({
                worktreeAdd: async () => gate,
                resolveRepoRoot: async (directory) => {
                    await gate;
                    return directory.startsWith(REPO) ? { worktreeRoot: REPO, parentRepoRoot: REPO } : null;
                },
                getCurrentBranch: async () => 'main'
            })
        });
        /** Lets git finish, then returns the create's own reply (the first one sent). */
        const finish = async (): Promise<Record<string, unknown> | undefined> => {
            release();
            for (let tick = 0; tick < 5; tick += 1) await flush();
            return h.replies.find((captured) => captured.command === 'workspace-create')?.payloads[0];
        };
        return { h, finish };
    }

    it('completes a worktree create at the top level and says the parent was lost', async () => {
        const { h, finish } = gated();
        h.send({ command: 'workspace-create', name: 'worker', parent: 'w1', worktree: 'worker', repo: REPO });
        h.send({ command: 'workspace-delete', name: 'w1' });
        const reply = await finish();
        expect(reply).toMatchObject({
            ok: true,
            parent_lost: true,
            parent_lost_reason: "parent 'w1' was deleted while the workspace was being created"
        });
        expect(reply).not.toHaveProperty('parent_id');
        const created = h.state().workspaces.find((workspace) => workspace.name === 'worker');
        expect(h.state().topLevelOrder.map((entry) => entry.id)).toContain(created?.id);
    });

    it('fails a repo create whole, leaving no workspace, when the parent was nested meanwhile', async () => {
        const { h, finish } = gated();
        h.send({ command: 'workspace-create', name: 'worker', parent: 'w1', repo: REPO });
        h.send({ command: 'workspace-nest', name: 'w1', parent: 'w2' });
        expect(await finish()).toEqual({
            ok: false,
            error: "parent 'w1' changed while the workspace was being created: 'w1' is nested itself; workspaces nest one level deep"
        });
        expect(h.state().workspaces.map((workspace) => workspace.name).sort()).toEqual(['w1', 'w2']);
    });

    it('still nests when the parent is untouched', async () => {
        const { h, finish } = gated();
        h.send({ command: 'workspace-create', name: 'worker', parent: 'w1', repo: REPO });
        const reply = await finish();
        expect(reply).toMatchObject({ ok: true, parent_id: W1, parent_name: 'w1' });
        expect(reply).not.toHaveProperty('parent_lost');
    });
});

describe('workspace-nest', () => {
    it('nests, reorders with --index, and replies with the position', () => {
        const h = harness({ initial: seeded(3) });
        expect(h.reply({ command: 'workspace-nest', name: 'w2', parent: 'w1' })).toEqual({
            ok: true,
            workspace_id: W2,
            workspace_name: 'w2',
            parent_id: W1,
            parent_name: 'w1',
            index: 0
        });
        expect(h.reply({ command: 'workspace-nest', name: 'w3', parent: 'w1', index: 0 })).toMatchObject({ index: 0 });
        expect(childrenOf(h.state(), W1)).toEqual([W3, W2]);
        expect(h.persists.length).toBeGreaterThan(0);
    });

    it('says why it refuses', () => {
        const h = family();
        expect(h.reply({ command: 'workspace-nest', name: 'w1', parent: 'w2' })['error']).toMatch(/nested itself/);
        expect(h.reply({ command: 'workspace-nest', name: 'w1', parent: 'w1' })['error']).toMatch(/under itself/);
        expect(h.reply({ command: 'workspace-nest', name: 'ghost', parent: 'w1' })).toEqual({
            ok: false,
            error: 'workspace not found: ghost'
        });
        expect(h.reply({ command: 'workspace-nest', name: 'w2', parent: 'ghost' })).toEqual({
            ok: false,
            error: 'parent workspace not found: ghost'
        });
    });

    it('is undone by workspace-move to the top level', () => {
        const h = family();
        h.send({ command: 'workspace-move', name: 'w2', index: 0 });
        expect(childrenOf(h.state(), W1)).toEqual([W3]);
        expect(h.state().topLevelOrder.map((entry) => entry.id)).toEqual([W2, W1]);
    });
});

describe('workspace-delete of a parent', () => {
    it('promotes the nested workspaces by default and kills only the parent’s panes', () => {
        const h = family();
        expect(h.reply({ command: 'workspace-delete', name: 'w1' })).not.toHaveProperty('deleted_children');
        expect(h.killed).toEqual([P1]);
        expect(h.state().topLevelOrder.map((entry) => entry.id)).toEqual([W2, W3]);
    });

    it('with cascade deletes them too, tears down their panes and lists them', () => {
        const h = harness({ initial: seeded(4) });
        h.dispatch({ type: 'nest-workspaces', ids: [W2, W3], parentID: W1 });
        expect(h.reply({ command: 'workspace-delete', name: 'w1', cascade: true })).toMatchObject({
            ok: true,
            workspace_id: W1,
            deleted_children: [W2, W3],
            deleted_child_names: ['w2', 'w3']
        });
        expect(h.killed.sort()).toEqual([P1, P2, P3].sort());
        expect(h.state().workspaces.map((workspace) => workspace.name)).toEqual(['w4']);
        expect(h.syncGroups.map((entry) => entry.workspaceID)).toEqual(expect.arrayContaining([W1, W2, W3]));
    });

    it('counts the cascade against the last-workspace guard and sums agents across it', () => {
        const h = family();
        expect(h.reply({ command: 'workspace-delete', name: 'w1', cascade: true })).toEqual({
            ok: false,
            error: 'refusing to delete the last workspace'
        });
        const g = harness({ initial: seeded(4) });
        g.dispatch(
            { type: 'nest-workspaces', ids: [W2], parentID: W1 },
            { type: 'pane-agent-event', paneID: P2, event: { type: 'agentStarted', agent: 'claude' }, now: NOW }
        );
        expect(g.reply({ command: 'workspace-delete', name: 'w1', cascade: true })).toMatchObject({
            ok: false,
            error: 'workspace w1 and its nested workspace have 1 running agent; pass --force to delete anyway',
            active_agents: 1
        });
        // Without the cascade the child's agent is not in the way: it is promoted, not deleted.
        expect(g.reply({ command: 'workspace-delete', name: 'w1' })).toMatchObject({ ok: true });
    });
});

describe('workspace-list and nesting', () => {
    it('lists each workspace’s nested ones right after it, with parent_id and parent_name', () => {
        const h = harness({ initial: seeded(3) });
        h.dispatch({ type: 'nest-workspaces', ids: [W1], parentID: W3 });
        const entries = h.reply({ command: 'workspace-list' })['workspaces'] as Record<string, unknown>[];
        expect(entries.map((entry) => entry['name'])).toEqual(['w2', 'w3', 'w1']);
        expect(entries[2]).toMatchObject({ parent_id: W3, parent_name: 'w3' });
        expect(entries[1]).not.toHaveProperty('parent_id');
    });

    it('filters to one parent’s nested workspaces, and errors on an unknown parent', () => {
        const h = family();
        const reply = h.reply({ command: 'workspace-list', parent: 'w1' });
        const listed = reply['workspaces'] as Record<string, unknown>[];
        expect(listed.map((entry) => entry['name'])).toEqual(['w2', 'w3']);
        // Echoed, so a caller can tell this from an older daemon's unfiltered reply.
        expect(reply).toMatchObject({ parent_id: W1, parent_name: 'w1' });
        expect(h.reply({ command: 'workspace-list' })).not.toHaveProperty('parent_id');
        expect(h.reply({ command: 'workspace-list', parent: 'w2' })['workspaces']).toEqual([]);
        expect(h.reply({ command: 'workspace-list', parent: 'ghost' })).toEqual({
            ok: false,
            error: 'workspace not found: ghost'
        });
    });

    it('lists a grouped parent’s nested workspaces with the group, reporting its group', () => {
        const h = family();
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW, initialWorkspaceIDs: [W1] });
        const listed = h.reply({ command: 'workspace-list', group: 'team' })['workspaces'] as Record<string, unknown>[];
        expect(listed.map((entry) => [entry['name'], entry['group_name']])).toEqual([
            ['w1', 'team'],
            ['w2', 'team'],
            ['w3', 'team']
        ]);
    });
});

describe('group-list', () => {
    it('lists each member’s nested workspaces right after it, as group-delete --cascade takes them', () => {
        const h = family();
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW, initialWorkspaceIDs: [W1] });
        const groups = h.reply({ command: 'group-list' })['groups'] as Record<string, unknown>[];
        expect(groups[0]?.['workspaces']).toEqual([
            { id: W1, name: 'w1' },
            { id: W2, name: 'w2', parent_id: W1, parent_name: 'w1' },
            { id: W3, name: 'w3', parent_id: W1, parent_name: 'w1' }
        ]);
    });
});

describe('group-delete --cascade', () => {
    it('tears down the panes of members’ nested workspaces too', () => {
        const h = family();
        h.dispatch({ type: 'create-group', id: G1, name: 'team', now: NOW, initialWorkspaceIDs: [W1] });
        h.dispatch({ type: 'create-workspace', id: NEW, paneID: NEW_PANE, name: 'keep', now: NOW });
        h.send({ command: 'group-delete', name: 'team', cascade: true });
        expect(h.killed.sort()).toEqual([P1, P2, P3].sort());
        expect(h.state().workspaces.map((workspace) => workspace.name)).toEqual(['keep']);
    });
});
