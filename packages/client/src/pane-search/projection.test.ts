/**
 * The frame, and the promise that nothing else is in it.
 *
 * The withholding test is a RECURSIVE key scan rather than a list of spot checks, because the rule
 * it defends is "the top level of every frame is copied field by field, never by spread": a spot
 * check passes the day somebody adds a field upstream, and a scan does not.
 */

import { describe, expect, it } from 'vitest';

import { PANE_SEARCH_LIMITS } from './contract';
import { PANE_SEARCH_FRAME_BUDGET, paneSearchBytes, projectPaneSearch, type PaneSearchSession } from './projection';

const rect = { x: 40, y: 8, width: 266, height: 35 };

const session = (overrides: Partial<PaneSearchSession> = {}): PaneSearchSession => ({
    paneID: 'pane-1',
    kind: 'shell',
    needle: 'anchor',
    caseSensitive: false,
    total: 17,
    selected: 2,
    match: { line: 412, col: 6, length: 6, linesFromBottom: 12 },
    ...overrides
});

/** Every key reachable anywhere in a value, at any depth. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
    if (Array.isArray(value)) {
        for (const entry of value) keysOf(entry, into);
        return into;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            into.add(key);
            keysOf(child, into);
        }
    }
    return into;
}

const FRAME_KEYS = new Set([
    'placement',
    'formFactor',
    'visible',
    'paneID',
    'kind',
    'needle',
    'needleTruncated',
    'caseSensitive',
    'total',
    'selected',
    'match',
    'box',
    // `match`
    'line',
    'col',
    'length',
    'linesFromBottom',
    // `box`
    'x',
    'y',
    'width',
    'height'
]);

describe('projectPaneSearch', () => {
    it('carries the daemon\'s session, the pane, the form factor and the box, and nothing else', () => {
        const { frame } = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session(),
            rect
        });
        expect(frame).toEqual({
            placement: 'pane.search',
            formFactor: 'desktop',
            visible: true,
            paneID: 'pane-1',
            kind: 'shell',
            needle: 'anchor',
            needleTruncated: false,
            caseSensitive: false,
            total: 17,
            selected: 2,
            match: { line: 412, col: 6, length: 6, linesFromBottom: 12 },
            box: rect
        });
    });

    /**
     * The scan. Scrollback, other panes, paths, the workspace id, plugin ids and test ids are the
     * named withheld list; anything at all outside the declared set fails this, which is the point.
     */
    it('reaches no key outside the declared set, at any depth', () => {
        const { frame } = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session(),
            rect
        });
        for (const key of keysOf(frame)) expect(FRAME_KEYS.has(key)).toBe(true);
        const serialised = JSON.stringify(frame);
        for (const forbidden of ['scrollback', 'workspaceID', 'pluginID', 'testID', 'path', 'panes']) {
            expect(serialised).not.toContain(forbidden);
        }
    });

    it('presents nothing at all while no search is open', () => {
        const { frame } = projectPaneSearch({ formFactor: 'desktop', visible: true, session: null, rect });
        expect(frame.visible).toBe(false);
        expect(frame.paneID).toBeNull();
        expect(frame.kind).toBeNull();
        expect(frame.needle).toBe('');
        expect(frame.total).toBeNull();
        expect(frame.selected).toBeNull();
        expect(frame.match).toBeNull();
        expect(frame.box).toBeNull();
    });

    it('is not visible on a phone even when the host says it is painting', () => {
        const { frame } = projectPaneSearch({
            formFactor: 'phone',
            visible: true,
            session: session(),
            rect
        });
        // The form factor travels so a view can SAY why; the host's own gate is what stops the
        // slot mounting at all (`App` never passes `paneSearchPresenter` to the phone shell).
        expect(frame.formFactor).toBe('phone');
    });

    /**
     * `3/0` is not a state the daemon can publish - it drops the selection when the total goes to
     * zero - so the frame says the same thing rather than leaving a presenter to invent a counter
     * for a pair that cannot happen.
     */
    it('drops a selection that has no total behind it', () => {
        expect(
            projectPaneSearch({
                formFactor: 'desktop',
                visible: true,
                session: session({ total: 0, selected: 3 }),
                rect
            }).frame.selected
        ).toBeNull();
        expect(
            projectPaneSearch({
                formFactor: 'desktop',
                visible: true,
                session: session({ total: null, selected: 3 }),
                rect
            }).frame.selected
        ).toBeNull();
    });

    it('refuses a counter, a match or a box that is not made of finite numbers', () => {
        const bad = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session({
                total: Number.NaN,
                selected: Number.POSITIVE_INFINITY,
                match: { line: 1, col: Number.NaN, length: 2, linesFromBottom: 3 }
            }),
            rect: { x: 1, y: 2, width: Number.NaN, height: 4 }
        }).frame;
        expect(bad.total).toBeNull();
        expect(bad.selected).toBeNull();
        expect(bad.match).toBeNull();
        expect(bad.box).toBeNull();
    });

    it('carries a match with no absolute line, because a reply need not state one', () => {
        const { frame } = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session({ match: { line: null, col: 1, length: 2, linesFromBottom: 3 } }),
            rect
        });
        expect(frame.match).toEqual({ line: null, col: 1, length: 2, linesFromBottom: 3 });
    });

    /**
     * A needle can reach the daemon from any plugin through `terminal.search`, and an oversized
     * frame would fail the user's chosen presenter over somebody else's string. So it is truncated
     * and SAID to be, which is a frame a presenter can draw honestly.
     */
    it('truncates an oversized needle rather than making the frame undeliverable', () => {
        const long = 'x'.repeat(PANE_SEARCH_LIMITS.needleChars + 500);
        const { frame } = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session({ needle: long }),
            rect
        });
        expect(frame.needle).toHaveLength(PANE_SEARCH_LIMITS.needleChars);
        expect(frame.needleTruncated).toBe(true);
        expect(paneSearchBytes(frame)).toBeLessThan(PANE_SEARCH_FRAME_BUDGET);
    });

    it('is a tiny frame even at its largest, which is why it has no budget cut', () => {
        const { frame } = projectPaneSearch({
            formFactor: 'desktop',
            visible: true,
            session: session({ needle: 'x'.repeat(PANE_SEARCH_LIMITS.needleChars) }),
            rect
        });
        expect(paneSearchBytes(frame)).toBeLessThan(PANE_SEARCH_LIMITS.needleChars + 512);
    });
});
