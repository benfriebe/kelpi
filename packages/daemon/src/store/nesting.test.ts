/**
 * Nested workspaces (app-state-core.md §2.9): a parent's `childOrder`, one level deep, and
 * every reducer that has to keep children attached to (or promoted out of) their parent.
 */

import { groupSidebarID, workspaceSidebarID } from '@kelpi/core/codec';
import { describe, expect, it } from 'vitest';
import {
    groupByID,
    groupIDForWorkspace,
    nestingRefusal,
    parentIDForWorkspace,
    sidebarWorkspaceOrder,
    visibleWorkspaceOrder,
    workspaceByID
} from './derived.js';
import { applyDomainEvents } from './events.js';
import { repairNesting } from './snapshot.js';
import { harness, id, NOW, topLevelWorkspaceIDs, W1, W2 } from './testing.js';
import type { DaemonState, DomainAction } from './types.js';

const W3 = id('bbbbbbbb', 3);
const W4 = id('bbbbbbbb', 4);
const G1 = id('cccccccc', 1);

function create(workspaceID: string, name: string, extra: Partial<DomainAction> = {}): DomainAction {
    return {
        type: 'create-workspace',
        id: workspaceID,
        paneID: `${workspaceID}-pane`,
        name,
        color: 'blue',
        now: NOW,
        ...extra
    } as DomainAction;
}

/** W1 (parent) with W2 and W3 nested under it; W4 at top level. */
function family(): ReturnType<typeof harness> {
    const h = harness();
    h.dispatch(
        create(W1, 'orchestrator'),
        create(W2, 'worker-a', { parentID: W1 }),
        create(W3, 'worker-b', { parentID: W1 }),
        create(W4, 'other')
    );
    return h;
}

function childrenOf(state: DaemonState, workspaceID: string): readonly string[] {
    return workspaceByID(state, workspaceID)?.childOrder ?? [];
}

describe('creating a nested workspace', () => {
    it('lands under its parent and nowhere else', () => {
        const h = family();
        expect(childrenOf(h.state(), W1)).toEqual([W2, W3]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W4]);
        expect(parentIDForWorkspace(h.state(), W2)).toBe(W1);
        expect(parentIDForWorkspace(h.state(), W1)).toBeNull();
        expect(h.state().lastActiveWorkspaceID).toBe(W4);
    });

    it('wins over a group and follows the parent into its group, opening it', () => {
        const h = harness();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            create(W1, 'orchestrator', { groupID: G1 }),
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'set-workspace-children-collapsed', id: W1, collapsed: true },
            create(W2, 'worker', { parentID: W1, groupID: G1 })
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W2]);
        expect(groupByID(h.state(), G1)?.isCollapsed).toBe(false);
        expect(workspaceByID(h.state(), W1)?.childrenCollapsed).toBe(false);
        expect(groupIDForWorkspace(h.state(), W2)).toBe(G1);
    });

    it('falls back to normal placement when the parent is missing or nested itself', () => {
        const h = family();
        h.dispatch(
            create(id('bbbbbbbb', 7), 'stale', { parentID: id('bbbbbbbb', 99) }),
            create(id('bbbbbbbb', 8), 'grandchild', { parentID: W2 })
        );
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W4, id('bbbbbbbb', 7), id('bbbbbbbb', 8)]);
        expect(childrenOf(h.state(), W2)).toEqual([]);
    });

    it('places near the active sibling under near-selection', () => {
        const h = family();
        h.dispatch(
            { type: 'set-active-workspace', id: W2, now: NOW },
            create(id('bbbbbbbb', 5), 'worker-c', { parentID: W1, placement: 'near-selection' })
        );
        expect(childrenOf(h.state(), W1)).toEqual([W2, id('bbbbbbbb', 5), W3]);
    });
});

describe('creating near a nested selection', () => {
    it('lands in the group right after the active child\'s parent', () => {
        const h = harness();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            create(W1, 'orchestrator', { groupID: G1 }),
            create(W4, 'tail', { groupID: G1 }),
            create(W2, 'worker', { parentID: W1 }),
            create(W3, 'new', { groupID: G1, placement: 'near-selection' })
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1, W3, W4]);
    });
});

describe('sidebar order', () => {
    it('walks children after their parent and hides them while collapsed', () => {
        const h = family();
        expect(visibleWorkspaceOrder(h.state())).toEqual([W1, W2, W3, W4]);
        h.dispatch({ type: 'set-workspace-children-collapsed', id: W1, collapsed: true });
        expect(visibleWorkspaceOrder(h.state())).toEqual([W1, W4]);
        expect(sidebarWorkspaceOrder(h.state())).toEqual([W1, W2, W3, W4]);
    });

    it('expands a collapsed parent (and its group) when a child is activated', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W1] },
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'set-workspace-children-collapsed', id: W1, collapsed: true },
            { type: 'set-active-workspace', id: W3, now: NOW }
        );
        expect(workspaceByID(h.state(), W1)?.childrenCollapsed).toBe(false);
        expect(groupByID(h.state(), G1)?.isCollapsed).toBe(false);
    });
});

describe('nest-workspaces', () => {
    it('nests at the post-remove index and reorders within the parent', () => {
        const h = family();
        h.dispatch({ type: 'nest-workspaces', ids: [W4], parentID: W1, index: 1 });
        expect(childrenOf(h.state(), W1)).toEqual([W2, W4, W3]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1]);
        h.dispatch({ type: 'nest-workspaces', ids: [W3], parentID: W1, index: 0 });
        expect(childrenOf(h.state(), W1)).toEqual([W3, W2, W4]);
    });

    it('moves a child from one parent to another, and pulls a workspace out of a group', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W4] },
            { type: 'nest-workspaces', ids: [W4, W2], parentID: W1 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([]);
        expect(childrenOf(h.state(), W1)).toEqual([W3, W4, W2]);
    });

    it('expands a collapsed parent it nests into', () => {
        const h = family();
        h.dispatch(
            { type: 'set-workspace-children-collapsed', id: W1, collapsed: true },
            { type: 'nest-workspaces', ids: [W4], parentID: W1 }
        );
        expect(workspaceByID(h.state(), W1)?.childrenCollapsed).toBe(false);
    });

    it('opens the parent\'s collapsed group so the nested rows are visible', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W1] },
            { type: 'set-group-collapsed', id: G1, collapsed: true },
            { type: 'nest-workspaces', ids: [W4], parentID: W1 }
        );
        expect(groupByID(h.state(), G1)?.isCollapsed).toBe(false);
        expect(visibleWorkspaceOrder(h.state())).toContain(W4);
    });

    it('refuses anything deeper than one level, and says why', () => {
        const h = family();
        const before = h.state();
        h.dispatch(
            { type: 'nest-workspaces', ids: [W4], parentID: W2 },
            { type: 'nest-workspaces', ids: [W1], parentID: W4 },
            { type: 'nest-workspaces', ids: [W4, W1], parentID: W1 },
            { type: 'nest-workspaces', ids: [W4], parentID: id('bbbbbbbb', 99) }
        );
        expect(h.state()).toBe(before);
        expect(nestingRefusal(before, [W4], W2)).toMatch(/nested itself/);
        expect(nestingRefusal(before, [W1], W4)).toMatch(/has nested workspaces/);
        expect(nestingRefusal(before, [W1], W1)).toMatch(/under itself/);
        expect(nestingRefusal(before, [W4], id('bbbbbbbb', 99))).toMatch(/no workspace matches/);
        expect(nestingRefusal(before, [W4], W1)).toBeNull();
    });
});

describe('un-nesting', () => {
    it('move-workspace(s)-to-group detaches a child from its parent', () => {
        const h = family();
        h.dispatch(
            { type: 'move-workspace-to-group', id: W2, groupID: null, index: 0 },
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspaces-to-group', ids: [W3], groupID: G1 }
        );
        expect(childrenOf(h.state(), W1)).toEqual([]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W2, W1, W4]);
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W3]);
    });

    it('a parent moved into a group takes its children with it', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspace-to-group', id: W1, groupID: G1 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W2, W3]);
        expect(groupIDForWorkspace(h.state(), W3)).toBe(G1);
    });

    it('create-group with a nested workspace as a member un-nests it', () => {
        const h = family();
        h.dispatch({ type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W3] });
        expect(childrenOf(h.state(), W1)).toEqual([W2]);
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W3]);
    });
});

describe('deleting', () => {
    it('promotes a deleted parent’s children into its top-level slot, in order', () => {
        const h = family();
        h.dispatch({ type: 'delete-workspace', id: W1 });
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W2, W3, W4]);
    });

    it('promotes into the parent’s group slot', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W4, W1] },
            { type: 'delete-workspace', id: W1 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W4, W2, W3]);
    });

    it('deleting parent and children together promotes nothing', () => {
        const h = family();
        h.dispatch({ type: 'delete-workspaces', ids: [W1, W2, W3] });
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W4]);
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W4]);
    });

    it('deleting a child drops it from its parent', () => {
        const h = family();
        h.dispatch({ type: 'delete-workspace', id: W2 });
        expect(childrenOf(h.state(), W1)).toEqual([W3]);
    });

    it('a cascading group delete takes members’ children too', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W1] },
            { type: 'delete-group', id: G1, cascade: true }
        );
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([W4]);
    });

    it('a promoting group delete keeps children under their parent', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W1] },
            { type: 'delete-group', id: G1, cascade: false }
        );
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W4, W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W2, W3]);
    });
});

describe('event replay', () => {
    it('a mirror converges through nesting, collapse and promotion', () => {
        const h = harness();
        let mirror = h.state();
        const steps: DomainAction[] = [
            create(W1, 'orchestrator'),
            create(W2, 'worker', { parentID: W1 }),
            create(W4, 'other'),
            { type: 'nest-workspaces', ids: [W4], parentID: W1, index: 0 },
            { type: 'set-workspace-children-collapsed', id: W1, collapsed: true },
            { type: 'delete-workspace', id: W1 }
        ];
        for (const step of steps) {
            const from = h.events.length;
            h.dispatch(step);
            mirror = applyDomainEvents(mirror, h.events.slice(from));
            expect(mirror.workspaces.map((w) => [w.id, w.childOrder, w.childrenCollapsed])).toEqual(
                h.state().workspaces.map((w) => [w.id, w.childOrder, w.childrenCollapsed])
            );
            expect(mirror.topLevelOrder).toEqual(h.state().topLevelOrder);
        }
    });
});

describe('repairNesting (boot)', () => {
    function stateWith(
        nesting: Record<string, readonly string[]>,
        topLevel: readonly string[]
    ): DaemonState {
        const h = harness();
        for (const workspaceID of [W1, W2, W3, W4]) h.dispatch(create(workspaceID, workspaceID));
        const state = h.state();
        return {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({
                ...workspace,
                childOrder: nesting[workspace.id] ?? []
            })),
            topLevelOrder: topLevel.map((workspaceID) => workspaceSidebarID(workspaceID))
        };
    }

    function repaired(state: DaemonState) {
        const result = repairNesting(state.workspaces, state.groups, state.topLevelOrder);
        return {
            children: Object.fromEntries(
                result.workspaces.filter((w) => w.childOrder.length > 0).map((w) => [w.id, w.childOrder])
            ),
            topLevel: result.topLevelOrder.map((entry) => entry.id)
        };
    }

    it('drops dangling, self and duplicate child ids, and the first claim wins', () => {
        const ghost = id('bbbbbbbb', 99);
        expect(repaired(stateWith({ [W1]: [W2, ghost, W1, W2], [W4]: [W2, W3] }, [W1, W4]))).toEqual({
            children: { [W1]: [W2], [W4]: [W3] },
            topLevel: [W1, W4]
        });
    });

    it('removes a nested workspace’s top-level and group entries', () => {
        const state = stateWith({ [W1]: [W2] }, [W1, W2, W4]);
        const withGroup: DaemonState = {
            ...state,
            groups: [
                {
                    id: G1,
                    name: 'Client',
                    color: null,
                    isCollapsed: false,
                    childOrder: [W3, W2],
                    createdAt: 0,
                    icon: null,
                    repoID: null,
                    createWorktree: false
                }
            ],
            topLevelOrder: [...state.topLevelOrder, groupSidebarID(G1)]
        };
        const result = repairNesting(withGroup.workspaces, withGroup.groups, withGroup.topLevelOrder);
        expect(result.topLevelOrder.map((entry) => entry.id)).toEqual([W1, W4, G1]);
        expect(result.groups[0]?.childOrder).toEqual([W3]);
    });

    it('places a workspace an older daemon left in no order at the top level', () => {
        // An older daemon drops the nesting columns, so its save leaves the children nowhere.
        expect(repaired(stateWith({}, [W1, W4]))).toEqual({ children: {}, topLevel: [W1, W4, W2, W3] });
    });

    it('flattens a second level and breaks cycles, placing released workspaces at the top level', () => {
        expect(repaired(stateWith({ [W1]: [W2], [W2]: [W3] }, [W1, W4]))).toEqual({
            children: { [W1]: [W2] },
            topLevel: [W1, W4, W3]
        });
        // A cycle keeps one valid level: the first link to lose its parent breaks it.
        expect(repaired(stateWith({ [W1]: [W2], [W2]: [W1] }, [W4]))).toEqual({
            children: { [W2]: [W1] },
            // W3 had no place in this fixture at all, so it is placed too.
            topLevel: [W4, W2, W3]
        });
    });
});

describe('a family moved together (§2.9)', () => {
    it('stays a family when a parent and its children move into a group together', () => {
        const h = family();
        h.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspaces-to-group', ids: [W1, W2, W3], groupID: G1 }
        );
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W2, W3]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W4]);
    });

    it('stays a family when a group is created around a parent and one of its children', () => {
        const h = family();
        h.dispatch({ type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W2, W1] });
        expect(groupByID(h.state(), G1)?.childOrder).toEqual([W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W2, W3]);
    });

    it('still detaches a child moved without its parent', () => {
        const h = family();
        h.dispatch({ type: 'move-workspaces-to-group', ids: [W2, W4], groupID: null, index: 0 });
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W2, W4, W1]);
        expect(childrenOf(h.state(), W1)).toEqual([W3]);
    });

    it('places an id listed twice once', () => {
        const h = family();
        h.dispatch({ type: 'move-workspaces-to-group', ids: [W2, W2], groupID: null });
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W4, W2]);
    });
});

describe('hardening against cycles (§2.9)', () => {
    it('never nests a new workspace under itself, or under a parent that is nested', () => {
        const h = family();
        const W5 = id('bbbbbbbb', 5);
        const W6 = id('bbbbbbbb', 6);
        h.dispatch(create(W5, 'self', { parentID: W5 }), create(W6, 'too-deep', { parentID: W2 }));
        expect(childrenOf(h.state(), W5)).toEqual([]);
        expect(childrenOf(h.state(), W2)).toEqual([]);
        expect(topLevelWorkspaceIDs(h.state())).toEqual([W1, W4, W5, W6]);
    });

    it('anchors a near-selection create without recursing through a corrupt cycle', () => {
        const h = family();
        // A corrupt state no reducer produces: W1 and W2 each list the other, and W4 lists itself.
        const state = h.state();
        const corrupt: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace) =>
                workspace.id === W2
                    ? { ...workspace, childOrder: [W1] }
                    : workspace.id === W4
                      ? { ...workspace, childOrder: [W4] }
                      : workspace
            ),
            lastActiveWorkspaceID: W1
        };
        expect(parentIDForWorkspace(corrupt, W4)).toBeNull();
        const next = harness(corrupt);
        expect(() => {
            next.dispatch(create(id('bbbbbbbb', 7), 'new', { placement: 'near-selection' }));
        }).not.toThrow();
        next.dispatch({ type: 'set-active-workspace', id: W4, now: NOW });
        expect(() => {
            next.dispatch(create(id('bbbbbbbb', 8), 'newer', { placement: 'near-selection' }));
        }).not.toThrow();
    });
});

describe('nesting that changes nothing (§2.9)', () => {
    it('returns the same state and emits nothing', () => {
        const h = family();
        const before = h.state();
        const emitted = h.events.length;
        h.dispatch(
            { type: 'nest-workspaces', ids: [W2], parentID: W1, index: 0 },
            { type: 'nest-workspaces', ids: [W3], parentID: W1 }
        );
        expect(h.state()).toBe(before);
        expect(h.events.length).toBe(emitted);
    });

    it('re-orders within the parent without announcing a top-level order change', () => {
        const h = family();
        const emitted = h.events.length;
        h.dispatch({ type: 'nest-workspaces', ids: [W3], parentID: W1, index: 0 });
        expect(childrenOf(h.state(), W1)).toEqual([W3, W2]);
        const kinds = h.events.slice(emitted).map((event) => event.kind);
        expect(kinds).toContain('workspace-upserted');
        expect(kinds).not.toContain('order-changed');
    });

    it('drops dead ids from a workspace that becomes nested', () => {
        const h = family();
        const state = h.state();
        const withDead: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace) =>
                workspace.id === W4 ? { ...workspace, childOrder: ['gone'] } : workspace
            )
        };
        const next = harness(withDead);
        next.dispatch({ type: 'nest-workspaces', ids: [W4], parentID: W1 });
        expect(childrenOf(next.state(), W1)).toEqual([W2, W3, W4]);
        expect(childrenOf(next.state(), W4)).toEqual([]);
    });
});
