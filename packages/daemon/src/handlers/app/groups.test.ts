import { describe, expect, it } from 'vitest';

import type { DaemonState, WorkspaceGroup } from '../../store/index.js';
import { harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const W3 = id('aaaaaaaa', 3);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const G1 = id('cccccccc', 1);
const G2 = id('cccccccc', 2);

/** Three workspaces, all members of G1 in w1,w2,w3 order. */
function grouped() {
    const h = harness({ initial: seeded(3) });
    h.dispatch(
        { type: 'create-group', id: G1, name: 'team', now: NOW },
        { type: 'move-workspace-to-group', id: W1, groupID: G1 },
        { type: 'move-workspace-to-group', id: W2, groupID: G1 },
        { type: 'move-workspace-to-group', id: W3, groupID: G1 }
    );
    return h;
}

describe('group-list', () => {
    it('returns [] with exit-0 semantics when there are no groups', () => {
        const h = harness({ initial: seeded(1) });
        expect(h.reply({ command: 'group-list' })).toEqual({ ok: true, groups: [] });
    });

    it('follows sidebar order, omits a null color, and lists members in child order', () => {
        const h = grouped();
        h.dispatch({ type: 'create-group', id: G2, name: 'other', now: NOW, color: 'purple' });
        expect(h.reply({ command: 'group-list' })).toEqual({
            ok: true,
            groups: [
                {
                    id: G1,
                    name: 'team',
                    workspaces: [
                        { id: W1, name: 'w1' },
                        { id: W2, name: 'w2' },
                        { id: W3, name: 'w3' }
                    ]
                },
                { id: G2, name: 'other', color: 'purple', workspaces: [] }
            ]
        });
    });

    it('dedupes a duplicated order entry and appends a group missing from the order', () => {
        const h = grouped();
        const state = h.state();
        const team = state.groups[0] as WorkspaceGroup;
        const broken: DaemonState = {
            ...state,
            groups: [...state.groups, { ...team, id: G2, name: 'orphan', childOrder: [] }],
            topLevelOrder: [...state.topLevelOrder, ...state.topLevelOrder]
        };
        const h2 = harness({ initial: broken });
        const names = (h2.reply({ command: 'group-list' })['groups'] as { name: string }[]).map(
            (entry) => entry.name
        );
        expect(names).toEqual(['team', 'orphan']);
    });

    it('skips dangling member ids', () => {
        const h = grouped();
        const state = h.state();
        const broken: DaemonState = {
            ...state,
            groups: state.groups.map((group) => ({
                ...group,
                childOrder: [...group.childOrder, id('9999aaaa', 1)]
            }))
        };
        const h2 = harness({ initial: broken });
        expect((h2.reply({ command: 'group-list' })['groups'] as { workspaces: [] }[])[0]?.workspaces).toHaveLength(3);
    });
});

describe('group-create / rename / delete', () => {
    it('creates a trimmed, colored group and records the sidebar scroll target', () => {
        const h = harness({ initial: seeded(1), ids: [G1] });
        expect(h.send({ command: 'group-create', name: '  team  ', color: 'blue' })).toEqual([]);
        expect(h.state().groups[0]).toMatchObject({ id: G1, name: 'team', color: 'blue', icon: null });
        expect(h.scrolled).toEqual([{ kind: 'group', id: G1 }]);
        expect(h.persists.length).toBe(1);
    });

    it('no-ops on a whitespace-only name', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'group-create', name: '   ' });
        expect(h.state().groups).toHaveLength(0);
    });

    it('renames by name or id and no-ops on an unresolvable token', () => {
        const h = grouped();
        h.send({ command: 'group-rename', name: 'team', new_name: 'squad' });
        expect(h.state().groups[0]?.name).toBe('squad');
        h.send({ command: 'group-rename', name: 'ghost', new_name: 'x' });
        expect(h.state().groups[0]?.name).toBe('squad');
    });

    it('promotes children to top level without --cascade, keeping their panes alive', () => {
        const h = grouped();
        h.send({ command: 'group-delete', name: 'team' });
        expect(h.state().groups).toHaveLength(0);
        expect(h.state().workspaces).toHaveLength(3);
        expect(h.killed).toEqual([]);
    });

    it('deletes members and kills their panes with --cascade', () => {
        const h = grouped();
        h.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW });
        h.send({ command: 'group-delete', name: 'team', cascade: true });
        expect(h.state().workspaces).toHaveLength(0);
        expect(h.killed).toEqual(expect.arrayContaining([P1, P2]));
        expect(h.killed).toHaveLength(4);
    });
});

describe('group-reorder', () => {
    it('rewrites the child order from an explicit list', () => {
        const h = grouped();
        expect(h.reply({ command: 'group-reorder', name: 'team', order: [W3, W1, W2] })).toEqual({
            ok: true,
            group_id: G1,
            group_name: 'team',
            order: [W3, W1, W2]
        });
        expect(h.state().groups[0]?.childOrder).toEqual([W3, W1, W2]);
    });

    it('resolves member names as well as UUIDs and tails the omitted members', () => {
        const h = grouped();
        expect(h.reply({ command: 'group-reorder', name: 'team', order: ['w3'] })['order']).toEqual([
            W3,
            W1,
            W2
        ]);
    });

    it('rejects a non-member token and a duplicate without writing anything', () => {
        const h = grouped();
        const before = h.state().groups[0]?.childOrder;
        expect(h.reply({ command: 'group-reorder', name: 'team', order: ['ghost'] })).toEqual({
            ok: false,
            error: "'ghost' is not a workspace in group 'team'"
        });
        expect(h.reply({ command: 'group-reorder', name: 'team', order: [W1, W1] })).toEqual({
            ok: false,
            error: `workspace '${W1}' listed more than once`
        });
        expect(h.state().groups[0]?.childOrder).toEqual(before);
    });

    it('errors on an unknown group and on an empty order', () => {
        const h = grouped();
        expect(h.reply({ command: 'group-reorder', name: 'ghost', order: [W1] })).toEqual({
            ok: false,
            error: "no group matches 'ghost'"
        });
        expect(h.reply({ command: 'group-reorder', name: 'team', order: [] })).toEqual({
            ok: false,
            error: 'no order or sort key given'
        });
    });

    it('keeps dangling stored ids at the tail but out of the reply', () => {
        const h = grouped();
        const state = h.state();
        const ghost = id('9999aaaa', 1);
        const broken: DaemonState = {
            ...state,
            groups: state.groups.map((group) => ({
                ...group,
                childOrder: [ghost, ...group.childOrder]
            }))
        };
        const h2 = harness({ initial: broken });
        expect(h2.reply({ command: 'group-reorder', name: 'team', order: [W2] })['order']).toEqual([
            W2,
            W1,
            W3
        ]);
        expect(h2.state().groups[0]?.childOrder).toEqual([W2, W1, W3, ghost]);
    });
});

describe('group-sort', () => {
    it('sorts by name, case-insensitively, and reverses the key comparison with --desc', () => {
        const h = grouped();
        h.dispatch(
            { type: 'rename-workspace', id: W1, name: 'Beta' },
            { type: 'rename-workspace', id: W2, name: 'alpha' },
            { type: 'rename-workspace', id: W3, name: 'Gamma' }
        );
        expect(h.reply({ command: 'group-sort', name: 'team', by: 'name' })['order']).toEqual([
            W2,
            W1,
            W3
        ]);
        expect(
            h.reply({ command: 'group-sort', name: 'team', by: 'NAME', descending: true })['order']
        ).toEqual([W3, W1, W2]);
    });

    it('sorts by last activity across the workspace panes', () => {
        const h = grouped();
        h.dispatch(
            { type: 'pane-directory-changed', paneID: P1, directory: '/a', now: NOW + 3000 },
            { type: 'pane-directory-changed', paneID: id('dddddddd', 3), directory: '/c', now: NOW + 2000 }
        );
        expect(
            h.reply({ command: 'group-sort', name: 'team', by: 'last-activity', descending: true })[
                'order'
            ]
        ).toEqual([W1, W3, W2]);
    });

    it('sorts by last accessed, accepting the last-modified alias', () => {
        const h = grouped();
        h.dispatch(
            { type: 'set-active-workspace', id: W2, now: NOW + 5000 },
            { type: 'set-active-workspace', id: W1, now: NOW + 9000 }
        );
        expect(h.reply({ command: 'group-sort', name: 'team', by: 'last_modified' })['order']).toEqual([
            W3,
            W2,
            W1
        ]);
    });

    it('is stable: ties keep their prior relative order in both directions', () => {
        const h = grouped();
        // All three share the same createdAt/lastAccessedAt, so every key ties.
        expect(h.reply({ command: 'group-sort', name: 'team', by: 'last-accessed' })['order']).toEqual([
            W1,
            W2,
            W3
        ]);
        expect(
            h.reply({ command: 'group-sort', name: 'team', by: 'last-accessed', descending: true })[
                'order'
            ]
        ).toEqual([W1, W2, W3]);
    });

    it('rejects an unknown sort key with the usage hint', () => {
        const h = grouped();
        expect(h.reply({ command: 'group-sort', name: 'team', by: 'colour' })).toEqual({
            ok: false,
            error: "unknown sort key 'colour' (use name|last-activity|last-accessed)"
        });
    });
});
