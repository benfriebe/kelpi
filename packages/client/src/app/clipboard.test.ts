/**
 * The `copy` / `paste` action decisions (#81).
 *
 * The properties worth pinning are the two `false` returns, because `false` is the dispatcher's
 * fall-through and it is what keeps ⌘C and ⌘V working everywhere that is NOT a terminal pane.
 * A test that only proved "a selection reaches the clipboard" would let a regression swallow the
 * chord in a markdown pane and never notice.
 */

import { describe, expect, it, vi } from 'vitest';

import { copySelection, pasteIntoFocusedPane } from './clipboard';

interface Recorded {
    readonly written: string[];
    readonly errors: string[];
}

function copyHarness(options: {
    focused?: string | null;
    selection?: string | null;
    writeText?: ((text: string) => Promise<void>) | null;
}): { run: () => boolean; log: Recorded } {
    const written: string[] = [];
    const errors: string[] = [];
    const writeText =
        options.writeText === undefined
            ? (text: string): Promise<void> => {
                  written.push(text);
                  return Promise.resolve();
              }
            : options.writeText;
    return {
        log: { written, errors },
        run: () =>
            copySelection({
                focusedPaneID: () => options.focused ?? null,
                selectionFor: () => options.selection ?? null,
                writeText,
                onError: (detail) => errors.push(detail)
            })
    };
}

describe('copySelection', () => {
    it('writes the focused pane s live selection to the clipboard and consumes the chord', () => {
        const h = copyHarness({ focused: 'pane-1', selection: 'total 48' });
        expect(h.run()).toBe(true);
        expect(h.log.written).toEqual(['total 48']);
        expect(h.log.errors).toEqual([]);
    });

    it('declines when the focused pane has no terminal renderer, so the Edit menu keeps ⌘C', () => {
        // `selectionFor` returning null is the pane-type test: markdown, diff, web, scratchpad,
        // and a terminal whose engine has not opened yet.
        const h = copyHarness({ focused: 'pane-markdown', selection: null });
        expect(h.run()).toBe(false);
        expect(h.log.written).toEqual([]);
    });

    it('declines when nothing is focused at all', () => {
        const h = copyHarness({ focused: null, selection: 'ignored' });
        expect(h.run()).toBe(false);
        expect(h.log.written).toEqual([]);
    });

    /**
     * The one #81 proposed as a `0x03` fall-through. It is a plain decline instead: mouse
     * reporting clears the selection on every press, so an agent pane sees this case constantly
     * and a ⌘C that interrupted the agent would be a worse bug than the one being fixed.
     */
    it('declines on an EMPTY selection, and sends no interrupt', () => {
        const h = copyHarness({ focused: 'pane-1', selection: '' });
        expect(h.run()).toBe(false);
        expect(h.log.written).toEqual([]);
        expect(h.log.errors).toEqual([]);
    });

    it('consumes and reports when there is a selection but no clipboard to write it to', () => {
        const h = copyHarness({ focused: 'pane-1', selection: 'total 48', writeText: null });
        expect(h.run()).toBe(true);
        expect(h.log.errors).toEqual(['this browser exposes no clipboard']);
    });

    it('reports a refused write rather than failing silently', async () => {
        const h = copyHarness({
            focused: 'pane-1',
            selection: 'total 48',
            writeText: () => Promise.reject(new Error('NotAllowedError'))
        });
        expect(h.run()).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(h.log.errors).toEqual(['NotAllowedError']);
    });
});

describe('pasteIntoFocusedPane', () => {
    it('delivers into the FOCUSED pane, not into whatever holds the DOM caret', () => {
        const deliver = vi.fn(() => Promise.resolve());
        const consumed = pasteIntoFocusedPane({
            focusedPaneID: () => 'pane-2',
            isTerminalPane: () => true,
            deliver
        });
        expect(consumed).toBe(true);
        expect(deliver).toHaveBeenCalledWith('pane-2');
    });

    it('declines for a pane with no terminal renderer, so a markdown editor still pastes', () => {
        const deliver = vi.fn(() => Promise.resolve());
        expect(
            pasteIntoFocusedPane({
                focusedPaneID: () => 'pane-markdown',
                isTerminalPane: () => false,
                deliver
            })
        ).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
    });

    it('declines when nothing is focused', () => {
        const deliver = vi.fn(() => Promise.resolve());
        expect(
            pasteIntoFocusedPane({ focusedPaneID: () => null, isTerminalPane: () => true, deliver })
        ).toBe(false);
        expect(deliver).not.toHaveBeenCalled();
    });
});
