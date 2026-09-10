/**
 * The `copy` / `paste` action decisions (#81).
 *
 * The properties worth pinning are the two `false` returns, because `false` is the dispatcher's
 * fall-through and it is what keeps ⌘C and ⌘V working everywhere that is NOT a terminal pane.
 * A test that only proved "a selection reaches the clipboard" would let a regression swallow the
 * chord in a markdown pane and never notice.
 */

import { describe, expect, it, vi } from 'vitest';

import { copySelection, deferredClipboardWriter, pasteIntoFocusedPane } from './clipboard';

const deferred = <T,>() => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
const readBlob = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob);
});
class DeferredClipboardItem {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
    getType(type: string): Promise<Blob> { return this.data[type]!; }
}

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
    it('starts the clipboard write during copy and resolves a delayed live selection from the original pane', async () => {
        const selected = deferred<string>(), written: string[] = [], onError = vi.fn(), writeText = vi.fn();
        let focused = 'first-pane', gesture = true;
        const clipboard = { write: vi.fn(async (items: ClipboardItem[]) => {
            expect(gesture).toBe(true);
            const blob = await items[0]!.getType('text/plain');
            expect(blob.type).toBe('text/plain'); written.push(await readBlob(blob));
        }) };
        const selectionFor = vi.fn(() => selected.promise);
        const writePendingText = deferredClipboardWriter(clipboard, DeferredClipboardItem as unknown as typeof ClipboardItem);
        expect(copySelection({ focusedPaneID: () => focused, selectionFor, writeText, writePendingText, onError })).toBe(true);
        expect(clipboard.write).toHaveBeenCalledOnce(); expect(written).toEqual([]);
        gesture = false; focused = 'different-pane'; selected.resolve('Live selected text 🌊');
        await vi.waitFor(() => expect(written).toEqual(['Live selected text 🌊']));
        expect(selectionFor).toHaveBeenCalledExactlyOnceWith('first-pane');
        expect(writeText).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    });

    it('rejects an empty promised representation quietly, preserving the existing clipboard', async () => {
        const selected = deferred<string>(), onError = vi.fn(), writeText = vi.fn();
        let clipboardText = 'previous clipboard';
        const clipboard = { write: vi.fn(async (items: ClipboardItem[]) => { clipboardText = await readBlob(await items[0]!.getType('text/plain')); }) };
        const writePendingText = deferredClipboardWriter(clipboard, DeferredClipboardItem as unknown as typeof ClipboardItem);
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: () => selected.promise, writeText, writePendingText, onError });
        selected.resolve('');
        await clipboard.write.mock.results[0]!.value.catch(() => {});
        await Promise.resolve(); await Promise.resolve();
        expect(clipboardText).toBe('previous clipboard'); expect(onError).not.toHaveBeenCalled(); expect(writeText).not.toHaveBeenCalled();
    });

    it('reports rejected deferred writes once without retrying or writing cached text', async () => {
        const selected = deferred<string>(), onError = vi.fn(), writeText = vi.fn();
        const clipboard = { write: vi.fn(() => Promise.reject(new Error('Document is not focused.'))) };
        const writePendingText = deferredClipboardWriter(clipboard, DeferredClipboardItem as unknown as typeof ClipboardItem);
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: () => selected.promise, writeText, writePendingText, onError });
        selected.resolve('current highlight');
        await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith('Document is not focused.'));
        expect(clipboard.write).toHaveBeenCalledOnce(); expect(writeText).not.toHaveBeenCalled();
    });

    it('handles an immediate permission failure followed by empty or failed selection without unhandled rejections', async () => {
        for (const empty of [true, false]) {
            const selected = deferred<string>(), onError = vi.fn(), writeText = vi.fn();
            const clipboard = { write: vi.fn(() => Promise.reject(new Error('NotAllowedError'))) };
            const writePendingText = deferredClipboardWriter(clipboard, DeferredClipboardItem as unknown as typeof ClipboardItem);
            copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: () => selected.promise, writeText, writePendingText, onError });
            await Promise.resolve();
            if (empty) selected.resolve(''); else selected.reject(new Error('Renderer was disposed.'));
            for (let index = 0; index < 8; index++) await Promise.resolve();
            if (empty) expect(onError).not.toHaveBeenCalled();
            else expect(onError).toHaveBeenCalledExactlyOnceWith('Renderer was disposed.');
            expect(writeText).not.toHaveBeenCalled();
        }
    });

    it('reports a synchronous deferred-item construction error', async () => {
        const onError = vi.fn();
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: async () => 'text', writeText: vi.fn(),
            writePendingText: () => { throw new Error('Clipboard representation is unsupported.'); }, onError });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith('Clipboard representation is unsupported.'));
    });

    it('uses writeText when promised clipboard items are unavailable and leaves native copies synchronous', async () => {
        const clipboard = { write: vi.fn() }, onError = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined);
        expect(deferredClipboardWriter(undefined, DeferredClipboardItem as unknown as typeof ClipboardItem)).toBeUndefined();
        expect(deferredClipboardWriter({} as Clipboard, DeferredClipboardItem as unknown as typeof ClipboardItem)).toBeUndefined();
        const writePendingText = deferredClipboardWriter(clipboard, null as unknown as typeof ClipboardItem);
        expect(writePendingText).toBeUndefined();
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: async () => 'fallback text', writeText, writePendingText, onError });
        expect(writeText).not.toHaveBeenCalled(); await Promise.resolve(); expect(writeText).toHaveBeenCalledExactlyOnceWith('fallback text');
        const deferredWrite = vi.fn();
        copySelection({ focusedPaneID: () => 'native-pane', selectionFor: () => 'native text', writeText, writePendingText: deferredWrite, onError });
        expect(writeText).toHaveBeenLastCalledWith('native text'); expect(deferredWrite).not.toHaveBeenCalled();
        expect(clipboard.write).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    });

    it('reads an isolated renderer at copy time and never copies a cleared selection', async () => {
        let selected = 'old highlight';
        const writeText = vi.fn().mockResolvedValue(undefined), onError = vi.fn();
        const selectionFor = vi.fn(async () => selected);
        selected = '';
        expect(copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor, writeText, onError })).toBe(true);
        await Promise.resolve();
        expect(writeText).not.toHaveBeenCalled();
        selected = 'current highlight';
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor, writeText, onError });
        await Promise.resolve();
        expect(writeText).toHaveBeenCalledWith('current highlight');
        expect(selectionFor).toHaveBeenCalledTimes(2);
        expect(onError).not.toHaveBeenCalled();
    });

    it('reports disposed renderer selection requests without writing stale text', async () => {
        const writeText = vi.fn(), onError = vi.fn();
        copySelection({ focusedPaneID: () => 'plugin-pane', selectionFor: () => Promise.reject(new Error('renderer disposed')), writeText, onError });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('renderer disposed'));
        expect(writeText).not.toHaveBeenCalled();
    });
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
