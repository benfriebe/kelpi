/**
 * §TERM-090 — "any split, pane-open, layout cycle or layout select silently un-zooms first".
 *
 * This suite exists because the checklist item and the port disagreed on paper, and the
 * disagreement was in the item. `WorkspaceFeature.swift:712-716` — the lines TERM-090 cites for
 * the markdown branch — are inside `openMarkdownFile`'s **`reusePaneID`** arm (`nex md --here`),
 * where the saved layout is restored as part of parking the source pane. The `else` arm below
 * it (`:726-745`, the ordinary open) sets `state.layout`, `state.panes`, `setFocus` and
 * `currentLayoutIndex` and never touches `savedLayout`, so an ordinary markdown open in the
 * shipped app leaves a zoomed workspace zoomed. `store/reducers/panes.ts:414` preserves exactly
 * that, with the quirk named in a comment.
 *
 * So the rule the port implements — and the rule these tests pin — is:
 *
 *   un-zooms:  split, split-at-path, diff open, scratchpad, web open, layout cycle,
 *              layout select, and markdown open **with `--here`**
 *   does not:  markdown open without `--here`
 *
 * Every case is asserted the same way: zoom, act, then read `zoomedPaneID`/`savedLayout` and
 * check the layout the workspace came back with is the pre-zoom one — because "un-zoomed" is
 * three fields moving together, and a reducer that cleared only the flag would leave the
 * workspace showing one pane with nothing to restore.
 */

import { describe, expect, it } from 'vitest';

import { harness, id, seededState, NOW, W1 } from './testing.js';
import type { DomainAction } from './types.js';

const PANE_A = id('dddddddd', 100);
const PANE_B = id('dddddddd', 101);

/** A workspace with two panes, zoomed on the second, plus the layout it was zoomed from. */
function zoomedPair(): { h: ReturnType<typeof harness>; before: unknown } {
    const h = harness(seededState(W1, PANE_A));
    h.dispatch({ type: 'split-pane', workspaceID: W1, paneID: PANE_B, direction: 'horizontal', now: NOW });
    const before = h.state().workspaces[0]?.layout;
    h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
    const zoomed = h.state().workspaces[0];
    expect(zoomed?.zoomedPaneID).toBe(PANE_B);
    expect(zoomed?.savedLayout).not.toBeNull();
    return { h, before };
}

function expectUnzoomed(h: ReturnType<typeof harness>, before: unknown): void {
    const workspace = h.state().workspaces[0];
    expect(workspace?.zoomedPaneID).toBeNull();
    expect(workspace?.savedLayout).toBeNull();
    // The pre-zoom tree is back underneath whatever the new pane added to it: every pane that
    // was visible before the zoom is visible again.
    expect(JSON.stringify(workspace?.layout)).toContain(PANE_A);
    expect(JSON.stringify(before)).toContain(PANE_A);
}

const UNZOOMING: readonly (readonly [string, DomainAction])[] = [
    [
        'a split',
        { type: 'split-pane', workspaceID: W1, paneID: id('dddddddd', 200), direction: 'vertical', now: NOW }
    ],
    [
        'a split at a path',
        { type: 'split-pane-at-path', workspaceID: W1, paneID: id('dddddddd', 201), path: '/tmp', now: NOW }
    ],
    [
        'a diff pane',
        { type: 'open-diff-pane', workspaceID: W1, paneID: id('dddddddd', 202), repoPath: '/repo', now: NOW }
    ],
    [
        'a scratchpad',
        { type: 'create-scratchpad', workspaceID: W1, paneID: id('dddddddd', 203), now: NOW }
    ],
    [
        'a web pane',
        {
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: id('dddddddd', 204),
            tabID: id('eeeeeeee', 1),
            url: 'https://example.com',
            now: NOW
        }
    ],
    ['a layout cycle', { type: 'cycle-layout', workspaceID: W1 }],
    ['a layout select', { type: 'select-layout', workspaceID: W1, kind: 'tiled' }]
];

describe('§TERM-090 — opening anything un-zooms first', () => {
    for (const [name, action] of UNZOOMING) {
        it(`${name} silently un-zooms`, () => {
            const { h, before } = zoomedPair();
            h.dispatch(action);
            expectUnzoomed(h, before);
        });
    }

    it('a markdown open WITH --here un-zooms (the arm Swift :712-716 is in)', () => {
        const { h, before } = zoomedPair();
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: id('dddddddd', 205),
            filePath: '/tmp/notes.md',
            now: NOW,
            reusePaneID: PANE_B
        });
        expectUnzoomed(h, before);
    });

    /**
     * The preserved quirk. Not a port defect: the Swift `else` arm has no `savedLayout` restore,
     * so a checklist that reads TERM-090 as covering the ordinary markdown open is reading the
     * `--here` arm's lines and attributing them to its neighbour.
     */
    it('an ordinary markdown open leaves a zoomed workspace zoomed (Swift parity)', () => {
        const { h } = zoomedPair();
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: id('dddddddd', 206),
            filePath: '/tmp/notes.md',
            now: NOW
        });
        const workspace = h.state().workspaces[0];
        expect(workspace?.zoomedPaneID).toBe(PANE_B);
        expect(workspace?.savedLayout).not.toBeNull();
    });

    /**
     * The three §5.1 names into `restoreZoomIfNeeded`'s "deliberately NOT" list, kept honest —
     * a later wave that "fixed" the markdown quirk by moving the call into a shared helper would
     * break these instead, which is the point.
     */
    it('a plain create-pane does NOT un-zoom (it is not a structural open)', () => {
        const { h } = zoomedPair();
        h.dispatch({ type: 'create-pane', workspaceID: W1, paneID: id('dddddddd', 207), now: NOW });
        expect(h.state().workspaces[0]?.zoomedPaneID).toBe(PANE_B);
    });

    it('toggle-zoom itself restores, because it IS the toggle', () => {
        const { h, before } = zoomedPair();
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expectUnzoomed(h, before);
    });
});
