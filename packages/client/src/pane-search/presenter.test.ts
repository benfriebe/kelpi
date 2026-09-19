/**
 * The presenter host: what it refuses, what it charges for, and the two latches the grid and the
 * Settings row both read.
 *
 * Every refusal is asserted BY MESSAGE and then re-read from the recorded calls, so a check cannot
 * pass on a call that was refused and ran anyway - the scenario rule, applied where it is cheapest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PANE_SEARCH_LIMITS } from './contract';
import {
    clearPaneSearchBoxes,
    paneSearchDeclaration,
    paneSearchDeclarationCount,
    retainPaneSearchBox,
    setPaneSearchBox
} from './box';
import { projectPaneSearch, type PaneSearchSession } from './projection';
import {
    PANE_SEARCH_UI_METHODS,
    clearPaneSearchPainted,
    clearPaneSearchPresenterFailure,
    createPaneSearchPresenterHost,
    notePaneSearchPainted,
    notePaneSearchPresenterFailure,
    paneSearchPaintedGeneration,
    paneSearchPresenterFailure,
    resetPaneSearchPresenterFailures,
    subscribePaneSearchPainted,
    subscribePaneSearchPresenters,
    type PaneSearchPresenterSnapshot
} from './presenter';

afterEach(() => {
    resetPaneSearchPresenterFailures();
    clearPaneSearchBoxes();
});

const SESSION: PaneSearchSession = {
    paneID: 'pane-1',
    kind: 'shell',
    needle: 'anchor',
    caseSensitive: false,
    total: 9,
    selected: 1,
    match: { line: 10, col: 2, length: 6, linesFromBottom: 4 }
};

interface Harness {
    readonly host: ReturnType<typeof createPaneSearchPresenterHost>;
    readonly ran: string[];
    readonly failures: string[];
    readonly frames: PaneSearchPresenterSnapshot[];
    setSession(next: PaneSearchSession | null): void;
    setVisible(next: boolean): void;
}

function harness(options: { session?: PaneSearchSession | null; visible?: boolean } = {}): Harness {
    let session: PaneSearchSession | null = options.session === undefined ? SESSION : options.session;
    let visible = options.visible ?? true;
    const ran: string[] = [];
    const failures: string[] = [];
    const frames: PaneSearchPresenterSnapshot[] = [];
    const known = new Set(['pane-1', 'pane-2']);
    const host = createPaneSearchPresenterHost({
        placement: 'pane.search',
        formFactor: () => 'desktop',
        visible: () => visible,
        // A fresh projection per read, as the grid hands one per render.
        projection: () =>
            projectPaneSearch({
                formFactor: 'desktop',
                visible,
                session,
                rect: { x: 40, y: 8, width: 266, height: 35 }
            }),
        actions: {
            setNeedle: (paneID, needle) => ran.push(`needle:${paneID}:${needle}`),
            setCaseSensitive: (paneID, on) => ran.push(`case:${paneID}:${String(on)}`),
            step: (paneID, direction) => ran.push(`step:${paneID}:${direction}`),
            close: (paneID) => ran.push(`close:${paneID}`),
            declareBox: (paneID, size) =>
                ran.push(`box:${paneID}:${size === null ? 'null' : `${String(size.width)}x${String(size.height)}`}`),
            knows: (paneID) => known.has(paneID)
        },
        fail: (detail) => failures.push(detail)
    });
    // One subscriber, because the host only publishes while somebody is listening.
    host.subscribe((value) => frames.push(value));
    return {
        host,
        ran,
        failures,
        frames,
        setSession(next) {
            session = next;
            host.refresh();
        },
        setVisible(next) {
            visible = next;
            host.refresh();
        }
    };
}

const refusal = (run: () => void): string => {
    try {
        run();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return 'resolved';
};

describe('the pane search presenter host', () => {
    it('publishes the frame the projection built', () => {
        const h = harness();
        const frame = h.host.getPaneSearch();
        expect(frame.placement).toBe('pane.search');
        expect(frame.visible).toBe(true);
        expect(frame.paneID).toBe('pane-1');
        expect(frame.needle).toBe('anchor');
        expect(frame.total).toBe(9);
        expect(frame.box).toEqual({ x: 40, y: 8, width: 266, height: 35 });
        expect(Object.isFrozen(frame)).toBe(true);
    });

    it('answers exactly the eight declared methods and nothing else', () => {
        const h = harness();
        expect([...PANE_SEARCH_UI_METHODS]).toEqual([
            'ui.getPaneSearch',
            'ui.reportPresenterReady',
            'ui.setSearchNeedle',
            'ui.setSearchCaseSensitive',
            'ui.searchNext',
            'ui.searchPrevious',
            'ui.closeSearch',
            'ui.setSearchBoxSize'
        ]);
        expect(refusal(() => h.host.call('ui.openSearch', { paneID: 'pane-1' }))).toBe(
            'Unknown pane search method.'
        );
        // Another placement's verb is refused by the same table, not by luck.
        expect(refusal(() => h.host.call('ui.setPaneChromeHeight', { paneID: 'pane-1', pixels: 48 }))).toBe(
            'Unknown pane search method.'
        );
        expect(h.ran).toEqual([]);
    });

    it('drives the daemon\'s needle, the case flag, both steps and the close', () => {
        const h = harness();
        h.host.getPaneSearch();
        h.host.call('ui.setSearchNeedle', { paneID: 'pane-1', text: 'marker' });
        h.host.call('ui.setSearchCaseSensitive', { paneID: 'pane-1', on: true });
        h.host.call('ui.searchNext', { paneID: 'pane-1' });
        h.host.call('ui.searchPrevious', { paneID: 'pane-1' });
        h.host.call('ui.closeSearch', { paneID: 'pane-1' });
        expect(h.ran).toEqual([
            'needle:pane-1:marker',
            'case:pane-1:true',
            'step:pane-1:next',
            'step:pane-1:prev',
            'close:pane-1'
        ]);
    });

    it('refuses an argument set that is not exactly the declared one', () => {
        const h = harness();
        h.host.getPaneSearch();
        expect(refusal(() => h.host.call('ui.searchNext', {}))).toBe('Invalid pane search arguments.');
        expect(refusal(() => h.host.call('ui.searchNext', { paneID: 'pane-1', extra: 1 }))).toBe(
            'Invalid pane search arguments.'
        );
        expect(refusal(() => h.host.call('ui.setSearchNeedle', { paneID: 'pane-1' }))).toBe(
            'Invalid pane search arguments.'
        );
        expect(h.ran).toEqual([]);
    });

    /**
     * The stale-id rule, which #244 recorded as a requirement: an id a presenter sends must never
     * resolve against an older frame to a different target.
     */
    it('refuses a pane the current frame does not name, and re-reading proves nothing ran', () => {
        const h = harness();
        h.host.getPaneSearch();
        const other = refusal(() => h.host.call('ui.setSearchNeedle', { paneID: 'pane-2', text: 'x' }));
        const forged = refusal(() => h.host.call('ui.searchNext', { paneID: 'not-a-pane' }));
        const wrongType = refusal(() => h.host.call('ui.closeSearch', { paneID: 7 }));
        expect(other).toBe('That pane is not the one being searched.');
        expect(forged).toBe('That pane is not the one being searched.');
        expect(wrongType).toBe('That pane is not the one being searched.');
        expect(h.ran).toEqual([]);
    });

    it('refuses every call while no search is open, which is what stops a presenter opening one', () => {
        const h = harness({ session: null });
        h.host.getPaneSearch();
        for (const call of [
            () => h.host.call('ui.setSearchNeedle', { paneID: 'pane-1', text: 'x' }),
            () => h.host.call('ui.searchNext', { paneID: 'pane-1' }),
            () => h.host.call('ui.closeSearch', { paneID: 'pane-1' }),
            () => h.host.call('ui.setSearchBoxSize', { paneID: 'pane-1', size: { width: 200, height: 30 } })
        ]) {
            expect(refusal(call)).toBe('No search is open for this presenter.');
        }
        expect(h.ran).toEqual([]);
    });

    it('refuses every call while the host is not painting', () => {
        const h = harness();
        h.host.getPaneSearch();
        h.setVisible(false);
        h.host.getPaneSearch();
        expect(refusal(() => h.host.call('ui.searchNext', { paneID: 'pane-1' }))).toBe(
            'No search is open for this presenter.'
        );
        expect(h.ran).toEqual([]);
    });

    it('holds a needle to one line and to the cap', () => {
        const h = harness();
        h.host.getPaneSearch();
        const message = `A needle is a single line of at most ${String(PANE_SEARCH_LIMITS.needleChars)} characters.`;
        expect(refusal(() => h.host.call('ui.setSearchNeedle', { paneID: 'pane-1', text: 'a\nb' }))).toBe(message);
        expect(
            refusal(() =>
                h.host.call('ui.setSearchNeedle', {
                    paneID: 'pane-1',
                    text: 'x'.repeat(PANE_SEARCH_LIMITS.needleChars + 1)
                })
            )
        ).toBe(message);
        expect(refusal(() => h.host.call('ui.setSearchNeedle', { paneID: 'pane-1', text: 12 }))).toBe(message);
        expect(h.ran).toEqual([]);
        // And the longest legal needle is accepted, so the cap is a cap rather than a wall.
        h.host.call('ui.setSearchNeedle', { paneID: 'pane-1', text: 'x'.repeat(PANE_SEARCH_LIMITS.needleChars) });
        expect(h.ran).toHaveLength(1);
    });

    it('takes a boolean for the case flag and nothing that merely looks like one', () => {
        const h = harness();
        h.host.getPaneSearch();
        expect(refusal(() => h.host.call('ui.setSearchCaseSensitive', { paneID: 'pane-1', on: 'true' }))).toBe(
            'Case sensitivity is true or false.'
        );
        expect(refusal(() => h.host.call('ui.setSearchCaseSensitive', { paneID: 'pane-1', on: 1 }))).toBe(
            'Case sensitivity is true or false.'
        );
        expect(h.ran).toEqual([]);
    });

    it('takes a box of two finite numbers and refuses everything else', () => {
        const h = harness();
        h.host.getPaneSearch();
        h.host.call('ui.setSearchBoxSize', { paneID: 'pane-1', size: { width: 9_999, height: 9_999 } });
        // The host stores what it was told; the CLAMP happens at read against the pane's own box.
        expect(h.ran).toEqual(['box:pane-1:9999x9999']);
        expect(refusal(() => h.host.call('ui.setSearchBoxSize', { paneID: 'pane-1', size: [1, 2] }))).toBe(
            'A pane search box is { width, height }, or null to withdraw.'
        );
        expect(
            refusal(() => h.host.call('ui.setSearchBoxSize', { paneID: 'pane-1', size: { width: Number.NaN, height: 3 } }))
        ).toBe('A pane search box is two finite numbers: width and height.');
        expect(h.ran).toHaveLength(1);
    });

    /**
     * A withdrawal is not a write. Refusing one for a pane the frame no longer names would leave a
     * presenter holding a declaration it could never undo, which is exactly the trap #244 found.
     */
    it('accepts a withdrawal for any pane the host still knows, carried or not', () => {
        const h = harness();
        h.host.getPaneSearch();
        h.host.call('ui.setSearchBoxSize', { paneID: 'pane-2', size: null });
        expect(h.ran).toEqual(['box:pane-2:null']);
        expect(refusal(() => h.host.call('ui.setSearchBoxSize', { paneID: 'gone', size: null }))).toBe(
            'That pane is not the one being searched.'
        );
        expect(h.ran).toHaveLength(1);
    });

    it('fails the placement when the call budget is exhausted, and says so once', () => {
        const h = harness();
        expect(() => {
            for (let i = 0; i <= PANE_SEARCH_LIMITS.presenterCalls + 1; i += 1) {
                h.host.call('ui.searchNext', { paneID: 'pane-1' });
            }
        }).toThrow(/call budget/);
        expect(h.failures.some((detail) => /call budget/.test(detail))).toBe(true);
    });

    it('is inert after disposal', () => {
        const h = harness();
        h.host.dispose();
        expect(refusal(() => h.host.call('ui.searchNext', { paneID: 'pane-1' }))).toBe(
            'Pane search is unavailable after disposal.'
        );
        expect(() => h.host.getPaneSearch()).toThrow(/after disposal/);
    });

    /**
     * Only a frame that OPENS a session is waited for. A needle delta and a moved total are not,
     * because a shell rewrites its buffer whenever it likes and a working presenter must not be
     * failed for being busy.
     */
    it('asks for an acknowledgement when a session opens and not when the needle moves', async () => {
        const awaited: boolean[] = [];
        let session: PaneSearchSession | null = null;
        const host = createPaneSearchPresenterHost({
            placement: 'pane.search',
            formFactor: () => 'desktop',
            visible: () => true,
            projection: () =>
                projectPaneSearch({ formFactor: 'desktop', visible: true, session, rect: null }),
            actions: {
                setNeedle: () => {},
                setCaseSensitive: () => {},
                step: () => {},
                close: () => {},
                declareBox: () => {},
                knows: () => true
            },
            fail: () => {},
            onFrame: (awaits) => awaited.push(awaits)
        });
        host.subscribe(() => {});
        expect(awaited).toEqual([false]);
        session = SESSION;
        host.refresh();
        await Promise.resolve();
        expect(awaited.at(-1)).toBe(true);
        session = { ...SESSION, needle: 'anchors', total: 3, selected: null };
        host.refresh();
        await Promise.resolve();
        expect(awaited.at(-1)).toBe(false);
        host.dispose();
    });
});

describe('the window latches', () => {
    it('reports one failing generation, and Retry clears it', () => {
        const seen = vi.fn();
        const stop = subscribePaneSearchPresenters(seen);
        notePaneSearchPresenterFailure('view:1:a', 'crashed on purpose');
        expect(paneSearchPresenterFailure()).toEqual({ generation: 'view:1:a', detail: 'crashed on purpose' });
        // A second report for the SAME generation does not republish: one broken presenter, one row.
        notePaneSearchPresenterFailure('view:1:a', 'and again');
        expect(paneSearchPresenterFailure()?.detail).toBe('crashed on purpose');
        clearPaneSearchPresenterFailure();
        expect(paneSearchPresenterFailure()).toBeNull();
        expect(seen).toHaveBeenCalled();
        stop();
    });

    it('tracks which generation has painted, so the native bar knows when to stand down', () => {
        const seen = vi.fn();
        const stop = subscribePaneSearchPainted(seen);
        expect(paneSearchPaintedGeneration()).toBeNull();
        notePaneSearchPainted('view:1:a');
        expect(paneSearchPaintedGeneration()).toBe('view:1:a');
        // A reload moves the generation, so the previous painted report means nothing for it.
        notePaneSearchPainted('view:2:b');
        expect(paneSearchPaintedGeneration()).toBe('view:2:b');
        clearPaneSearchPainted();
        expect(paneSearchPaintedGeneration()).toBeNull();
        stop();
    });
});

describe('the declared box store', () => {
    it('stores a declaration raw and clamps it only at read', () => {
        setPaneSearchBox('pane-1', { width: 900, height: 400 });
        expect(paneSearchDeclaration('pane-1')).toEqual({ width: 900, height: 400 });
    });

    it('refuses a non-size, floors a negative one and rounds a fractional one', () => {
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        setPaneSearchBox('pane-1', { width: Number.NaN, height: 40 });
        // The previous box stands: NaN is not a size, and treating it as a hand-back would make one
        // arithmetic slip look like a deliberate withdrawal.
        expect(paneSearchDeclaration('pane-1')).toEqual({ width: 300, height: 40 });
        setPaneSearchBox('pane-1', { width: -40, height: -1 });
        expect(paneSearchDeclaration('pane-1')).toEqual({ width: 0, height: 0 });
        setPaneSearchBox('pane-1', { width: 300.6, height: 40.4 });
        expect(paneSearchDeclaration('pane-1')).toEqual({ width: 301, height: 40 });
    });

    it('withdraws on null, on a retain that names another pane, and on the whole-store clear', () => {
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        setPaneSearchBox('pane-1', null);
        expect(paneSearchDeclaration('pane-1')).toBeNull();

        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        setPaneSearchBox('pane-2', { width: 200, height: 30 });
        expect(paneSearchDeclarationCount()).toBe(2);
        // The search moved to pane-2: everything else is stale by definition.
        retainPaneSearchBox('pane-2');
        expect(paneSearchDeclaration('pane-1')).toBeNull();
        expect(paneSearchDeclaration('pane-2')).toEqual({ width: 200, height: 30 });
        // And the search closed.
        retainPaneSearchBox(null);
        expect(paneSearchDeclarationCount()).toBe(0);

        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        clearPaneSearchBoxes();
        expect(paneSearchDeclarationCount()).toBe(0);
    });
});
