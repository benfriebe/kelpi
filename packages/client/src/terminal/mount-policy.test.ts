import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MOUNT_LIMIT,
    EMPTY_MOUNT_STATE,
    createMountPolicy,
    planMounts,
    visiblePaneIDs
} from './mount-policy';

function ids(count: number, prefix = 'p'): string[] {
    return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

describe('mount policy — candidates', () => {
    it('mounts the active workspace layout order', () => {
        expect(visiblePaneIDs({ paneOrder: ['a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
    });

    it('mounts nothing for a background workspace', () => {
        expect(visiblePaneIDs({ paneOrder: ['a', 'b'], workspaceActive: false })).toEqual([]);
    });

    it('mounts only the zoomed pane while zoom is on', () => {
        expect(visiblePaneIDs({ paneOrder: ['a', 'b', 'c'], zoomedPaneID: 'b' })).toEqual(['b']);
    });

    it('ignores a zoom id that is not in the layout', () => {
        expect(visiblePaneIDs({ paneOrder: ['a', 'b'], zoomedPaneID: 'gone' })).toEqual(['a', 'b']);
    });
});

describe('mount policy — cap and LRU', () => {
    it('mounts every visible pane below the cap, in layout order', () => {
        const decision = planMounts(EMPTY_MOUNT_STATE, { desired: ['a', 'b', 'c'], limit: 4 });

        expect(decision.mounted).toEqual(['a', 'b', 'c']);
        expect(decision.mount).toEqual(['a', 'b', 'c']);
        expect(decision.evict).toEqual([]);
    });

    it('caps at the limit, keeping layout order for a first sighting', () => {
        const decision = planMounts(EMPTY_MOUNT_STATE, { desired: ids(20), limit: 3 });

        expect(decision.mounted).toEqual(['p1', 'p2', 'p3']);
    });

    it('defaults the cap and dedupes the request', () => {
        const decision = planMounts(EMPTY_MOUNT_STATE, { desired: [...ids(30), 'p1'] });

        expect(decision.mounted).toHaveLength(DEFAULT_MOUNT_LIMIT);
        expect(new Set(decision.mounted).size).toBe(DEFAULT_MOUNT_LIMIT);
    });

    it('focusing an unmounted pane evicts the least recently used one', () => {
        const desired = ids(4);
        const first = planMounts(EMPTY_MOUNT_STATE, { desired, focusedPaneID: 'p1', limit: 2 });
        expect(first.mounted).toEqual(['p1', 'p2']);

        const second = planMounts(first.state, { desired, focusedPaneID: 'p4', limit: 2 });

        // p1 was focused most recently before p4, so p2 (never used) is the eviction.
        expect(second.mounted).toEqual(['p1', 'p4']);
        expect(second.mount).toEqual(['p4']);
        expect(second.evict).toEqual(['p2']);
    });

    it('keeps a mounted pane mounted while it stays visible', () => {
        const desired = ids(3);
        const first = planMounts(EMPTY_MOUNT_STATE, { desired, focusedPaneID: 'p1', limit: 3 });
        const second = planMounts(first.state, { desired, focusedPaneID: 'p2', limit: 3 });

        expect(second.mounted).toEqual(['p1', 'p2', 'p3']);
        expect(second.mount).toEqual([]);
        expect(second.evict).toEqual([]);
    });

    it('evicts everything when the workspace goes to the background, and re-mounts on return', () => {
        const desired = ids(2);
        const mounted = planMounts(EMPTY_MOUNT_STATE, { desired, focusedPaneID: 'p1' });
        const hidden = planMounts(mounted.state, { desired: [] });

        expect(hidden.mounted).toEqual([]);
        expect(hidden.evict).toEqual(['p1', 'p2']);

        // Coming back re-mounts, which re-attaches the stream and replays the daemon snapshot.
        const back = planMounts(hidden.state, { desired, focusedPaneID: 'p1' });
        expect(back.mounted).toEqual(['p1', 'p2']);
        expect(back.mount).toEqual(['p1', 'p2']);
    });

    it('a newly split pane is treated as used and displaces an idle one', () => {
        const first = planMounts(EMPTY_MOUNT_STATE, { desired: ['a', 'b'], focusedPaneID: 'a', limit: 2 });
        const second = planMounts(first.state, { desired: ['a', 'b', 'fresh'], focusedPaneID: 'a', limit: 2 });

        expect(second.mounted).toEqual(['a', 'fresh']);
        expect(second.evict).toEqual(['b']);
    });

    it('bounds the LRU history', () => {
        let state = EMPTY_MOUNT_STATE;
        for (let generation = 0; generation < 20; generation += 1) {
            state = planMounts(state, { desired: ids(2, `g${generation}-`), limit: 2 }).state;
        }

        expect(state.used.size).toBeLessThanOrEqual(2 * 4 + 2);
    });
});

describe('createMountPolicy', () => {
    it('threads state between calls and honours a default limit', () => {
        const policy = createMountPolicy({ limit: 2 });

        expect(policy.plan({ desired: ['a', 'b', 'c'] }).mounted).toEqual(['a', 'b']);
        expect(policy.mounted).toEqual(['a', 'b']);

        const second = policy.plan({ desired: ['a', 'b', 'c'], focusedPaneID: 'c' });
        expect(second.mounted).toEqual(['a', 'c']);
        expect(second.evict).toEqual(['b']);

        policy.reset();
        expect(policy.mounted).toEqual([]);
    });
});
