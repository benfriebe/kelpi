/**
 * The pane → tab → view bookkeeping (web-pane.md §1, §5, §6 + HOST_PROTOCOL §3.1).
 *
 * The rules worth a test are the ones a naive implementation gets wrong:
 *   - `pane-open` is replayed on every host registration, so it must **reconcile** rather than
 *     rebuild (a reconnect must not reload every live page);
 *   - closing the active tab activates its LEFT neighbour;
 *   - the active tab always falls back to `tabs[0]` (§17.2);
 *   - flipping `isPrivate` destroys and rebuilds, because the partition is sealed into a view.
 */

import { describe, expect, it } from 'vitest';

import { createTabRegistry, type CreateTabInput, type DestroyReason } from './registry.js';

interface FakeView {
    readonly id: string;
    readonly url: string;
    readonly isPrivate: boolean;
    visible: boolean;
    destroyed: DestroyReason | null;
}

function harness() {
    const created: FakeView[] = [];
    const destroyed: { view: FakeView; reason: DestroyReason }[] = [];
    const registry = createTabRegistry<FakeView>({
        create(input: CreateTabInput) {
            const view: FakeView = {
                id: input.tabID,
                url: input.url,
                isPrivate: input.isPrivate,
                visible: false,
                destroyed: null
            };
            created.push(view);
            return view;
        },
        destroy(view, reason) {
            view.destroyed = reason;
            destroyed.push({ view, reason });
        },
        show(view, visible) {
            view.visible = visible;
        }
    });
    return { registry, created, destroyed };
}

const pane = (tabs: string[], activeTabID: string | null, isPrivate = false) => ({
    paneID: 'P1',
    isPrivate,
    activeTabID,
    tabs: tabs.map((id) => ({ id, url: `https://${id}/` }))
});

describe('openPane', () => {
    it('builds one view per tab and shows only the active one', () => {
        const { registry, created } = harness();
        registry.openPane(pane(['t1', 't2'], 't2'));
        expect(created.map((view) => view.id)).toEqual(['t1', 't2']);
        expect(created.map((view) => view.visible)).toEqual([false, true]);
        expect(registry.activeTabID('P1')).toBe('t2');
    });

    it('is idempotent: a replay keeps the live views and adds only what is new', () => {
        const { registry, created, destroyed } = harness();
        registry.openPane(pane(['t1'], 't1'));
        const first = created[0];
        registry.openPane(pane(['t1', 't2'], 't1'));
        expect(destroyed).toHaveLength(0);
        expect(registry.view('P1', 't1')).toBe(first);
        expect(created).toHaveLength(2);
    });

    it('drops views the daemon no longer knows about', () => {
        const { registry, destroyed } = harness();
        registry.openPane(pane(['t1', 't2'], 't1'));
        registry.openPane(pane(['t1'], 't1'));
        expect(destroyed.map((entry) => [entry.view.id, entry.reason])).toEqual([['t2', 'reconcile']]);
    });

    it('rebuilds the whole pane when the private flag changed (the partition is sealed in)', () => {
        const { registry, created, destroyed } = harness();
        registry.openPane(pane(['t1'], 't1'));
        registry.openPane(pane(['t1'], 't1', true));
        expect(destroyed.map((entry) => entry.reason)).toEqual(['private-flip']);
        expect(created).toHaveLength(2);
        expect(created[1]?.isPrivate).toBe(true);
    });
});

describe('tabs', () => {
    it('activates the left neighbour when the active tab closes', () => {
        const { registry } = harness();
        registry.openPane(pane(['t1', 't2', 't3'], 't2'));
        expect(registry.closeTab('P1', 't2')).toBe(true);
        expect(registry.activeTabID('P1')).toBe('t1');
    });

    it('falls back to tabs[0] when the active id is stale', () => {
        const { registry } = harness();
        registry.openPane(pane(['t1', 't2'], 'gone'));
        expect(registry.activeTabID('P1')).toBe('t1');
        expect(registry.activeView('P1')?.id).toBe('t1');
    });

    it('refuses a duplicate tab id rather than building a second view for it', () => {
        const { registry, created } = harness();
        registry.openPane(pane(['t1'], 't1'));
        expect(registry.openTab('P1', 't1', 'https://x/', true)).toBe(false);
        expect(created).toHaveLength(1);
    });

    it('opens a background tab without stealing visibility', () => {
        const { registry } = harness();
        registry.openPane(pane(['t1'], 't1'));
        expect(registry.openTab('P1', 't2', 'https://x/', false)).toBe(true);
        expect(registry.activeTabID('P1')).toBe('t1');
        expect(registry.view('P1', 't2')?.visible).toBe(false);
    });

    /**
     * Issue #76. This used to assert the opposite - `destroyed` empty - on the reading that a
     * tab whose renderer died has nothing left to take down. It has: the `WebContentsView` is
     * still parented, still in the embed controller's books, and still covering the pane. The
     * destroy hook is what unhooks it (`beforeDestroy` -> `embed.releaseView`), so it has to run.
     *
     * That single call is also issue #72's requirement of this path, which is why #72's separate
     * `forget` hook is not here: a dead renderer left embedded in the window is a rectangle of
     * nothing that swallows every click, and the destroy hook is the notice the party holding it
     * gets. One path off the screen, not two.
     */
    it('takes down the view of a tab whose renderer died', () => {
        const { registry, destroyed } = harness();
        registry.openPane(pane(['t1', 't2'], 't2'));
        expect(registry.forgetTab('P1', 't2')).toBe(true);
        expect(destroyed).toEqual([{ view: expect.objectContaining({ id: 't2' }), reason: 'renderer-gone' }]);
        expect(registry.activeTabID('P1')).toBe('t1');
        expect(registry.view('P1', 't2')).toBeNull();
    });

    /** #72: and it says NOTHING for a tab it never had, so the sweep cannot fire on a miss. */
    it('says nothing about a tab it did not have', () => {
        const { registry, destroyed } = harness();
        registry.openPane(pane(['t1'], 't1'));
        expect(registry.forgetTab('P1', 'nope')).toBe(false);
        expect(registry.forgetTab('nope', 't1')).toBe(false);
        expect(destroyed).toEqual([]);
    });

    /**
     * The rebuild half of #76, and the reason the daemon needs no new host verb: a pane whose
     * only tab died is announced again with the SAME tab id, and `openPane`'s reconcile builds
     * a view for any tab in the spec it does not hold.
     */
    it('rebuilds a dead sole tab from a re-announced pane-open', () => {
        const { registry, created, destroyed } = harness();
        registry.openPane(pane(['t1'], 't1'));
        expect(registry.forgetTab('P1', 't1')).toBe(true);
        expect(registry.pane('P1')?.tabs).toHaveLength(0);

        registry.openPane(pane(['t1'], 't1'));
        expect(created).toHaveLength(2);
        expect(destroyed).toHaveLength(1);
        expect(registry.activeTabID('P1')).toBe('t1');
        // A fresh view, at the URL the daemon still holds, and visible because it is active.
        const rebuilt = created[1];
        expect(rebuilt?.destroyed).toBeNull();
        expect(rebuilt?.url).toBe('https://t1/');
        expect(rebuilt?.visible).toBe(true);
    });

    it('reports misses instead of throwing', () => {
        const { registry } = harness();
        expect(registry.closeTab('nope', 't1')).toBe(false);
        expect(registry.selectTab('nope', 't1')).toBe(false);
        expect(registry.view('nope', 't1')).toBeNull();
        expect(registry.activeView('nope')).toBeNull();
        expect(registry.pane('nope')).toBeNull();
    });
});

describe('teardown', () => {
    it('closePane destroys every view of the pane', () => {
        const { registry, destroyed } = harness();
        registry.openPane(pane(['t1', 't2'], 't1'));
        expect(registry.closePane('P1')).toBe(true);
        expect(destroyed.map((entry) => entry.reason)).toEqual(['pane-close', 'pane-close']);
        expect(registry.paneIDs()).toEqual([]);
    });

    it('dispose clears everything', () => {
        const { registry, destroyed } = harness();
        registry.openPane(pane(['t1'], 't1'));
        registry.dispose();
        expect(destroyed.map((entry) => entry.reason)).toEqual(['dispose']);
        expect(registry.paneIDs()).toEqual([]);
    });
});

describe('locate', () => {
    it('reverse-maps a view to its pane and tab (view-driven events know only the view)', () => {
        const { registry } = harness();
        registry.openPane(pane(['t1', 't2'], 't1'));
        const found = registry.locate((view) => view.id === 't2');
        expect(found?.paneID).toBe('P1');
        expect(found?.tabID).toBe('t2');
        expect(registry.locate(() => false)).toBeNull();
    });
});
