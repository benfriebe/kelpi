import { describe, expect, it, vi } from 'vitest';

import { testPane } from '../grid/testing';

import { paneChromeModel, type PaneChromeCommandInput, type PaneChromeModel } from './model';
import { createPaneChromeSurface, type PaneChromeActions } from './surface';

const NOW = 1_000_000;

function harness(
    options: {
        readonly type?: 'shell' | 'markdown' | 'diff';
        readonly commands?: readonly PaneChromeCommandInput[];
        readonly items?: PaneChromeModel['descriptor']['items'];
    } = {}
) {
    const actions = {
        onFocusPane: vi.fn(),
        onClosePane: vi.fn(),
        onRenamePane: vi.fn(),
        onSplitPane: vi.fn(),
        onToggleZoom: vi.fn(),
        onToggleMarkdownEdit: vi.fn(),
        onRefreshDiff: vi.fn(),
        onCopyDocument: vi.fn(),
        onNewWebPane: vi.fn(),
        onRunHeaderItem: vi.fn(),
        onPaneContextMenu: vi.fn()
    } satisfies PaneChromeActions;
    let model = paneChromeModel({
        pane: testPane('p1', {
            type: options.type ?? 'shell',
            ...(options.type === 'markdown' ? { filePath: '/repo/NOTES.md' } : {})
        }),
        focused: false,
        nowSeconds: NOW,
        paneWidth: 900,
        canCopyDocument: true,
        ...(options.commands === undefined ? {} : { commands: options.commands }),
        ...(options.items === undefined ? {} : { items: options.items })
    });
    const surface = createPaneChromeSurface({
        actions: () => actions,
        model: (paneID) => (paneID === 'p1' ? model : null)
    });
    return {
        actions,
        surface,
        /** Replace the model the surface re-resolves against, as a re-render would. */
        publish(next: PaneChromeModel): void {
            model = next;
        }
    };
}

describe('the pane chrome surface', () => {
    it('routes every direct verb, once, with the pane it was given', () => {
        const h = harness();
        h.surface.focusPane('p1');
        h.surface.splitPane('p1', 'vertical');
        h.surface.toggleZoom('p1');
        h.surface.closePane('p1');
        expect(h.actions.onFocusPane).toHaveBeenCalledExactlyOnceWith('p1');
        expect(h.actions.onSplitPane).toHaveBeenCalledExactlyOnceWith('p1', 'vertical');
        expect(h.actions.onToggleZoom).toHaveBeenCalledExactlyOnceWith('p1');
        expect(h.actions.onClosePane).toHaveBeenCalledExactlyOnceWith('p1');
    });

    it('owns the rename trim, so the field it came from does not have to', () => {
        const h = harness();
        h.surface.renamePane('p1', '   api   ');
        expect(h.actions.onRenamePane).toHaveBeenCalledExactlyOnceWith('p1', 'api');
        // Empty still clears the label, as the inline field always has.
        h.surface.renamePane('p1', '   ');
        expect(h.actions.onRenamePane).toHaveBeenLastCalledWith('p1', '');
    });

    it('runs each host control through the verb the button used to call directly', () => {
        const h = harness({ type: 'markdown' });
        h.surface.runControl('p1', 'copy');
        h.surface.runControl('p1', 'edit');
        h.surface.runControl('p1', 'split-right');
        h.surface.runControl('p1', 'split-down');
        h.surface.runControl('p1', 'close');
        expect(h.actions.onCopyDocument).toHaveBeenCalledExactlyOnceWith('p1');
        expect(h.actions.onToggleMarkdownEdit).toHaveBeenCalledExactlyOnceWith('p1');
        expect(h.actions.onSplitPane).toHaveBeenNthCalledWith(1, 'p1', 'horizontal');
        expect(h.actions.onSplitPane).toHaveBeenNthCalledWith(2, 'p1', 'vertical');
        expect(h.actions.onClosePane).toHaveBeenCalledExactlyOnceWith('p1');

        const diff = harness({ type: 'diff' });
        diff.surface.runControl('p1', 'refresh');
        expect(diff.actions.onRefreshDiff).toHaveBeenCalledExactlyOnceWith('p1');
    });

    /**
     * The globe's two gestures, which used to be two closures: the button read `event.shiftKey`
     * and the `•••` row could not, so the same control did different things depending on which of
     * the two drew it. One call, one flag.
     */
    it('takes the globe`s alternate gesture as an option rather than a second closure', () => {
        const h = harness();
        h.surface.runControl('p1', 'new-web');
        expect(h.actions.onNewWebPane).toHaveBeenLastCalledWith('p1', 'horizontal');
        h.surface.runControl('p1', 'new-web', { alternate: true });
        expect(h.actions.onNewWebPane).toHaveBeenLastCalledWith('p1', 'vertical');
        h.surface.runControl('p1', 'new-web', { alternate: false });
        expect(h.actions.onNewWebPane).toHaveBeenLastCalledWith('p1', 'horizontal');
    });

    it('runs another plugin`s command from the private table, never from the descriptor', () => {
        const run = vi.fn();
        const h = harness({ commands: [{ id: 'sample.board.inspect', title: 'Inspect', run }] });
        h.surface.runControl('p1', 'sample.board.inspect');
        expect(run).toHaveBeenCalledExactlyOnceWith('p1');
    });

    it('refuses a control that is disabled, unknown, or belongs to another pane', () => {
        const run = vi.fn();
        const h = harness({
            commands: [{ id: 'sample.board.inspect', title: 'Inspect', enabled: false, run }]
        });
        h.surface.runControl('p1', 'sample.board.inspect');
        h.surface.runControl('p1', 'not-a-control');
        h.surface.runControl('p2', 'close');
        h.surface.focusPane('p2');
        h.surface.closePane('p2');
        expect(run).not.toHaveBeenCalled();
        expect(h.actions.onClosePane).not.toHaveBeenCalled();
        expect(h.actions.onFocusPane).not.toHaveBeenCalled();
    });

    /**
     * The re-resolve, which is the whole reason the surface takes an id.
     *
     * `settings/surface.ts` re-reads the catalog before every commit so a field that went away
     * cannot be written; a control is the same problem one surface over. The row a user clicks is
     * always at least one render old, and a plugin can disable its command between the two.
     */
    it('re-resolves against the latest model, so a stale row cannot run a withdrawn command', () => {
        const run = vi.fn();
        const h = harness({ commands: [{ id: 'sample.board.inspect', title: 'Inspect', run }] });
        h.publish(paneChromeModel({ pane: testPane('p1'), focused: false, nowSeconds: NOW, paneWidth: 900 }));
        h.surface.runControl('p1', 'sample.board.inspect');
        expect(run).not.toHaveBeenCalled();
        // The host controls the withdrawn pane's row still resolve, because they are still in it.
        h.surface.runControl('p1', 'close');
        expect(h.actions.onClosePane).toHaveBeenCalledExactlyOnceWith('p1');
    });

    it('activates another plugin`s item by its opaque ref, and refuses a disabled one', () => {
        const h = harness({
            items: [
                { id: 'sample.board.status', text: 'Ready', tooltip: null, badge: null, tone: 'default', enabled: true },
                { id: 'sample.board.off', text: 'Off', tooltip: null, badge: null, tone: 'default', enabled: false }
            ]
        });
        h.surface.runItem('p1', 'sample.board.status');
        h.surface.runItem('p1', 'sample.board.off');
        h.surface.runItem('p1', 'sample.board.missing');
        h.surface.runItem('p2', 'sample.board.status');
        expect(h.actions.onRunHeaderItem).toHaveBeenCalledExactlyOnceWith('p1', 'sample.board.status');
    });

    it('is inert where the host bound nothing, rather than throwing at a control', () => {
        const model = paneChromeModel({ pane: testPane('p1'), focused: false, nowSeconds: NOW });
        const surface = createPaneChromeSurface({
            actions: () => ({}),
            model: (paneID) => (paneID === 'p1' ? model : null)
        });
        expect(() => {
            surface.focusPane('p1');
            surface.closePane('p1');
            surface.runControl('p1', 'split-right');
            surface.runControl('p1', 'new-web', { alternate: true });
            surface.runItem('p1', 'anything');
        }).not.toThrow();
    });
});
