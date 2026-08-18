import { resolvePaneTarget, resolveWorkspaceLenient, workspaceContainingPane as resolveWorkspaceContainingPane } from '@nex/core/resolve';
import { describe, expect, it } from 'vitest';
import {
    buildPaneIndex,
    findPaneAnywhere,
    layoutPaneOrder,
    nextRandomColor,
    paneAnywhere,
    resolveStateOf,
    visiblePane,
    workspaceByID,
    workspaceContainingPane,
    workspaceContainingVisiblePane
} from './derived.js';
import { harness, id, NOW, seededState, W1 } from './testing.js';
import type { WorkspaceState } from './types.js';

const P0 = id('dddddddd', 100);
const PA = id('eeeeeeee', 1);

describe('pane lookup', () => {
    it('indexes both lanes and reports lane + position', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: id('eeeeeeee', 2),
                filePath: '/docs/a.md',
                reusePaneID: P0,
                now: NOW
            }
        );
        const index = buildPaneIndex(h.state());
        expect(index.get(P0)).toMatchObject({ workspaceID: W1, lane: 'parked', index: 0 });
        expect(index.get(PA)).toMatchObject({ workspaceID: W1, lane: 'visible' });
        expect(findPaneAnywhere(h.state(), 'ghost')).toBeNull();

        const workspace = workspaceByID(h.state(), W1) as WorkspaceState;
        expect(visiblePane(workspace, P0)).toBeNull();
        expect(paneAnywhere(workspace, P0)?.id).toBe(P0);
        expect(workspaceContainingPane(h.state(), P0)?.id).toBe(W1);
        expect(workspaceContainingVisiblePane(h.state(), P0)).toBeNull();
        expect(layoutPaneOrder(workspace)).toEqual([id('eeeeeeee', 2), PA]);
    });
});

describe('resolveStateOf', () => {
    it('feeds the @nex/core resolvers, flagging parked panes as unaddressable', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'split-pane',
                workspaceID: W1,
                paneID: PA,
                direction: 'horizontal',
                now: NOW,
                label: 'worker'
            },
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: id('eeeeeeee', 2),
                filePath: '/docs/a.md',
                reusePaneID: P0,
                now: NOW
            }
        );
        const projection = resolveStateOf(h.state());

        expect(resolvePaneTarget(projection, { paneID: PA, target: 'worker' })).toEqual({
            ok: true,
            paneID: PA,
            workspace: { id: W1, name: 'dev', slug: workspaceByID(h.state(), W1)?.slug }
        });
        // Parked panes stay out of user-command resolution but remain routable for lifecycle.
        expect(resolvePaneTarget(projection, { target: P0 })).toMatchObject({ ok: false });
        expect(resolveWorkspaceContainingPane(projection, P0)?.id).toBe(W1);
        expect(resolveWorkspaceLenient(projection, 'dev')?.id).toBe(W1);
    });
});

describe('nextRandomColor', () => {
    it('never repeats the trailing workspace colour', () => {
        const h = harness(seededState());
        for (let index = 0; index < 20; index += 1) {
            const color = nextRandomColor(h.state(), () => index / 20);
            expect(color).not.toBe(workspaceByID(h.state(), W1)?.color);
        }
    });
});
