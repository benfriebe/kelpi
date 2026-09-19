/**
 * The slot's four window-level rules, which nothing else in this module can assert.
 *
 * The HOST itself is driven end to end by `features/search-lab.test.ts`, which runs the shipped
 * example against it. What is here is the relay grant (a keyboard surface's whole hazard is which
 * chords leave it), the painted gate (the native bar stays until the presenter says it has drawn),
 * the withdrawal that has to live in an unmount cleanup rather than in a render branch, and the
 * fallback's focus rule - which is a property of the NATIVE bar and is therefore asserted on the
 * native bar.
 */

import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';

import { clientKeyBindings } from '../chrome/keys';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { PaneSearchOverlay } from '../grid/PaneSearchOverlay';

import {
    clearPaneSearchBoxes,
    paneSearchDeclarationCount,
    setPaneSearchBox,
    usePaneSearchBoxScope
} from './box';
import {
    clearPaneSearchPainted,
    notePaneSearchPainted,
    resetPaneSearchPresenterFailures
} from './presenter';
import {
    PANE_SEARCH_NEXT_CHORD,
    PANE_SEARCH_PREVIOUS_CHORD,
    PaneSearchPresenterSlot,
    paneSearchPresenterChords,
    usePaneSearchPainted,
    usePaneSearchSelection
} from './presenter-slot';
import { projectPaneSearch } from './projection';

afterEach(() => {
    cleanup();
    clearPaneSearchBoxes();
    resetPaneSearchPresenterFailures();
});

describe('the relay grant', () => {
    /**
     * A search presenter owns a text input, so what leaves its frame is the whole safety question:
     * a chord that is relayed can act on the window behind the bar, and one that is not stays in
     * the sandbox and reaches nobody. Four, and only four.
     */
    it('is Escape, the toggle-search chord and the two stepping chords', () => {
        expect(paneSearchPresenterChords(DEFAULT_KEYBINDINGS)).toEqual([
            '0/Escape',
            // Shift-Cmd-G, Cmd-F, Cmd-G - sorted, which is what makes the list comparable.
            PANE_SEARCH_PREVIOUS_CHORD,
            '8/KeyF',
            PANE_SEARCH_NEXT_CHORD
        ]);
    });

    it('follows a rebound toggle-search chord and never grows past those four', () => {
        const rebound = paneSearchPresenterChords(clientKeyBindings(['super+shift+f=toggle_search']));
        expect(rebound).toContain('12/KeyF');
        expect(rebound).toHaveLength(5);
        // Not `close_pane`, not the palette, not Recover Interface: a find bar is a control in the
        // corner of one pane, not a modal that has taken the window.
        expect(rebound).not.toContain('8/KeyW');
        expect(rebound).not.toContain('8/KeyP');
    });
});

describe('the painted gate', () => {
    function Probe(props: { readonly generation: string }): ReactElement {
        return <span data-testid="painted">{String(usePaneSearchPainted(props.generation))}</span>;
    }

    /**
     * The native bar stands down on the presenter's own readiness report and not on the selection,
     * which is #244's rule said for this surface: a ⌘F during a plugin's boot must never open a
     * search with no bar in it.
     */
    it('is false until THIS generation reports it has painted, and false again for the next one', () => {
        clearPaneSearchPainted();
        const view = render(<Probe generation="view:1:a" />);
        expect(view.getByTestId('painted').textContent).toBe('false');
        act(() => notePaneSearchPainted('view:1:a'));
        expect(view.getByTestId('painted').textContent).toBe('true');
        // A reload moves the generation: the previous report says nothing about the new instance.
        view.rerender(<Probe generation="view:2:b" />);
        expect(view.getByTestId('painted').textContent).toBe('false');
        act(() => notePaneSearchPainted('view:2:b'));
        expect(view.getByTestId('painted').textContent).toBe('true');
        act(() => clearPaneSearchPainted());
        expect(view.getByTestId('painted').textContent).toBe('false');
    });
});

describe('the selection, with no workbench at all', () => {
    function Probe(): ReactElement {
        const selection = usePaneSearchSelection(true);
        return <span data-testid="bundled">{String(selection.bundled)}</span>;
    }

    /**
     * The recovery floor cannot depend on the layout being up. A standalone render, a window that
     * has not built its workbench yet and a phone all have to mean "the native bar draws", never a
     * crash.
     */
    it('is bundled, because no provider means the native bar draws', () => {
        const view = render(<Probe />);
        expect(view.getByTestId('bundled').textContent).toBe('true');
    });
});

describe('the withdrawal paths', () => {
    const projection = projectPaneSearch({
        formFactor: 'desktop',
        visible: false,
        session: null,
        rect: null
    });
    const actions = {
        setNeedle: () => {},
        setCaseSensitive: () => {},
        step: () => {},
        close: () => {},
        declareBox: () => {},
        knows: () => true
    };

    /**
     * The lesson #244 recorded in as many words: the withdrawal goes in an UNMOUNT cleanup, never
     * in a render branch. The slot is rendered only while a presenter is selected, so the moment the
     * user picks the bundled bar, disables the plugin or uninstalls it, this component unmounts and
     * never re-renders with a bundled selection to notice it in - a branch would simply never run.
     */
    it('drops every declared box when the slot unmounts', async () => {
        const view = render(
            <PaneSearchPresenterSlot
                selection={{ bundled: true, viewID: '', pluginID: null, runtime: null, generation: ':' }}
                visible
                formFactor="desktop"
                projection={projection}
                rect={null}
                paneID={null}
                actions={actions}
                chords={[]}
                onReleaseCaret={() => {}}
            />
        );
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        expect(paneSearchDeclarationCount()).toBe(1);
        view.unmount();
        // A microtask, because StrictMode's rehearsal remount must not drop the box of the mount
        // that replaced it.
        await Promise.resolve();
        await Promise.resolve();
        expect(paneSearchDeclarationCount()).toBe(0);
    });

    function Scope(props: { readonly workspaceID: string | undefined }): ReactElement {
        usePaneSearchBoxScope(props.workspaceID);
        return <span />;
    }

    it('drops every declared box when the grid changes what it is showing', () => {
        const view = render(<Scope workspaceID="ws-1" />);
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        view.rerender(<Scope workspaceID="ws-2" />);
        expect(paneSearchDeclarationCount()).toBe(0);
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        view.unmount();
        expect(paneSearchDeclarationCount()).toBe(0);
    });

    it('leaves the store alone for a host that has no notion of a workspace', () => {
        const view = render(<Scope workspaceID={undefined} />);
        setPaneSearchBox('pane-1', { width: 300, height: 40 });
        view.unmount();
        expect(paneSearchDeclarationCount()).toBe(1);
    });
});

/**
 * The fallback's focus rule, asserted on the surface it is a rule about.
 *
 * A failed presenter returns the NATIVE bar with the daemon's needle intact and its input focused,
 * and that costs nothing to arrange because the state was never the presenter's: the needle is
 * workspace state, and `PaneSearchOverlay` seeds its draft from whatever it is handed and focuses
 * itself on mount. So the thing to prove is that a fresh mount does both - which is exactly what a
 * fallback is.
 */
describe('the fallback focus rule', () => {
    it('comes back seeded from the daemon\'s needle, focused, with the caret at the end', () => {
        const view = render(
            <PaneSearchOverlay
                paneID="pane-1"
                needle="anchor"
                total={17}
                selected={2}
                onNeedleChange={() => {}}
                onNext={() => {}}
                onPrevious={() => {}}
                onClose={() => {}}
            />
        );
        const field = view.getByTestId('pane-search-input-pane-1') as HTMLInputElement;
        expect(field.value).toBe('anchor');
        expect(document.activeElement).toBe(field);
        expect(field.selectionStart).toBe('anchor'.length);
        // And the daemon's counter is what it draws, not a count of its own.
        expect(view.getByTestId('pane-search-count-pane-1').textContent).toBe('3/17');
    });
});
