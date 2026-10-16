/**
 * The `copy` / `paste` action decisions (#81).
 *
 * The properties worth pinning are the two `false` returns, because `false` is the dispatcher's
 * fall-through and it is what keeps ⌘C and ⌘V working everywhere that is NOT a terminal pane.
 * A test that only proved "a selection reaches the clipboard" would let a regression swallow the
 * chord in a markdown pane and never notice.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    BROWSER_CLIPBOARD_FILE_NOTICE,
    NOTHING_TO_PASTE_NOTICE,
    copySelection,
    deferredClipboardWriter,
    pasteIntoFocusedPane,
    PasteSupersededError,
    PasteTargetChangedError,
    readClipboardForPaste,
    readClipboardTextOnFocus,
    warnPasteTypedNothing,
    type PasteFocusView
} from './clipboard';
import type { DroppedFilesResolution } from './dropped-files';

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

describe('readClipboardForPaste (#382, section 12.2)', () => {
    const png = new Blob(['png'], { type: 'image/png' });
    /** A clipboard whose `read()` answers these items' types (or throws, given an Error). */
    const board = (text: string, items: readonly (readonly string[])[] | Error = []) => ({
        readText: vi.fn(async () => text),
        read: vi.fn(async () => {
            if (items instanceof Error) throw items;
            return items.map((types) => ({ types, getType: async () => png }));
        })
    });
    const shell = (answer: Partial<DroppedFilesResolution> = {}) =>
        vi.fn(async (): Promise<DroppedFilesResolution> => ({ paths: [], unresolved: 0, error: null, ...answer }));
    const read = (clipboard: unknown, readFiles: (() => Promise<DroppedFilesResolution>) | null) =>
        readClipboardForPaste({ clipboard: clipboard as Clipboard, readFiles });

    it('takes text first and asks the shell nothing', async () => {
        const files = shell({ paths: ['/tmp/x'] });
        await expect(read(board('hello', [['image/png']]), files)).resolves.toEqual({ kind: 'text', text: 'hello' });
        expect(files).not.toHaveBeenCalled();
    });

    it('takes a PNG next, before any file on the pasteboard', async () => {
        const files = shell({ paths: ['/tmp/x'] });
        await expect(read(board('', [['image/png']]), files)).resolves.toEqual({ kind: 'image', image: png });
        expect(files).not.toHaveBeenCalled();
    });

    it('types the copied files as a drop of them would, for CleanShot’s Copy (one item, no types the page can read)', async () => {
        const files = shell({ paths: ['/Users/me/Library/Application Support/CleanShot/media/Shot 1.png'] });
        await expect(read(board('', [[]]), files)).resolves.toEqual({
            kind: 'paths',
            text: '/Users/me/Library/Application\\ Support/CleanShot/media/Shot\\ 1.png',
            notice: null
        });
    });

    it('still asks the shell when read() throws, and says what it left out in a paste’s words', async () => {
        const files = shell({ paths: ['/tmp/a', '/tmp/b\nc'], unresolved: 1 });
        await expect(read(board('', new Error('NotAllowedError')), files)).resolves.toEqual({
            kind: 'paths',
            text: '/tmp/a',
            notice: '2 copied items had no path that can be typed and were left out'
        });
        // A page that could not read the clipboard cannot call it empty: the shell's reason stands.
        await expect(read(board('', new Error('NotAllowedError')), shell({ error: 'update Kelpi' }))).resolves.toEqual({
            kind: 'nothing',
            notice: 'update Kelpi'
        });
    });

    it('says the clipboard is empty when nothing is anywhere, never staying silent', async () => {
        await expect(read(board(''), shell())).resolves.toEqual({ kind: 'nothing', notice: NOTHING_TO_PASTE_NOTICE });
        // The shell's reason only explains something there was to read.
        await expect(read(board(''), shell({ error: 'too old' }))).resolves.toEqual({ kind: 'nothing', notice: NOTHING_TO_PASTE_NOTICE });
        await expect(read(board('', [[]]), shell({ error: 'too old' }))).resolves.toEqual({ kind: 'nothing', notice: 'too old' });
    });

    it('tells a browser why a copied file has no path, and an empty clipboard that it is empty', async () => {
        await expect(read(board('', [[]]), null)).resolves.toEqual({ kind: 'nothing', notice: BROWSER_CLIPBOARD_FILE_NOTICE });
        await expect(read(board(''), null)).resolves.toEqual({ kind: 'nothing', notice: NOTHING_TO_PASTE_NOTICE });
    });

    it('throws for no clipboard API, or a refused readText, for the caller to report', async () => {
        await expect(read(undefined, null)).rejects.toThrow('this browser exposes no clipboard');
        const refused = { readText: vi.fn(async () => { throw new Error('Document is not focused.'); }) };
        await expect(read(refused, shell())).rejects.toThrow('Document is not focused.');
    });
});

describe('#264: a clipboard read refused for want of focus', () => {
    const notFocused = (): Error => Object.assign(new Error('Document is not focused.'), { name: 'NotAllowedError' });

    /** A page whose focus the test drives, with a manual clock. */
    function fakeView(focused = false) {
        const listeners = new Set<() => void>();
        let timer: (() => void) | null = null;
        const view: PasteFocusView = {
            hasFocus: () => focused,
            addEventListener: (_type, fn) => { listeners.add(fn); },
            removeEventListener: (_type, fn) => { listeners.delete(fn); },
            setTimeout: (fn) => { timer = fn; return 1; },
            clearTimeout: () => { timer = null; }
        };
        return {
            view,
            focus: () => { focused = true; for (const fn of [...listeners]) fn(); },
            expire: () => timer?.(),
            listening: () => listeners.size > 0,
            listeners: () => listeners.size
        };
    }

    it('waits for the window to be focused and reads again, once', async () => {
        const page = fakeView(false);
        const read = vi.fn().mockRejectedValueOnce(notFocused()).mockResolvedValueOnce('pasted');
        const result = readClipboardTextOnFocus(read, page.view);
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        page.focus();
        await expect(result).resolves.toEqual({ text: 'pasted', retried: true });
        expect(read).toHaveBeenCalledTimes(2);
        expect(page.listening()).toBe(false);
    });

    it('gives up after the wait, with the original refusal and no listener left behind', async () => {
        const page = fakeView(false);
        const refusal = notFocused();
        const result = readClipboardTextOnFocus(vi.fn().mockRejectedValue(refusal), page.view);
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        page.expire();
        await expect(result).rejects.toBe(refusal);
        expect(page.listening()).toBe(false);
    });

    it('retries at once when the focus came back before the refusal did', async () => {
        // The activation race the other way round: the read started unfocused and its rejection
        // arrived after the window had been focused, so there is no focus event left to wait for.
        const page = fakeView(false);
        const refusal = deferred<string>();
        const read = vi.fn().mockReturnValueOnce(refusal.promise).mockResolvedValueOnce('pasted');
        const result = readClipboardTextOnFocus(read, page.view);
        page.focus();
        refusal.reject(notFocused());
        await expect(result).resolves.toEqual({ text: 'pasted', retried: true });
        expect(read).toHaveBeenCalledTimes(2);
        expect(page.listening()).toBe(false);
    });

    it('does not wait when the page already has focus (the refusal is not about focus)', async () => {
        const page = fakeView(true);
        const read = vi.fn().mockRejectedValue(notFocused());
        await expect(readClipboardTextOnFocus(read, page.view)).rejects.toThrow('Document is not focused.');
        expect(read).toHaveBeenCalledTimes(1);
        expect(page.listening()).toBe(false);
    });

    it('does not wait for any other failure', async () => {
        const page = fakeView(false);
        const read = vi.fn().mockRejectedValue(new Error('no clipboard'));
        await expect(readClipboardTextOnFocus(read, page.view)).rejects.toThrow('no clipboard');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('reads once and says so when nothing was refused', async () => {
        await expect(readClipboardTextOnFocus(() => Promise.resolve('x'), fakeView(true).view)).resolves.toEqual({
            text: 'x',
            retried: false
        });
    });

    it('two pastes refused while the window comes back paste once, the later one', async () => {
        // The person pressed ⌘V again because the first "did nothing": one focus must not
        // answer both, or the text lands twice.
        const page = fakeView(false);
        const first = vi.fn().mockRejectedValueOnce(notFocused()).mockResolvedValue('first');
        const second = vi.fn().mockRejectedValueOnce(notFocused()).mockResolvedValue('second');
        const one = readClipboardTextOnFocus(first, page.view);
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        const two = readClipboardTextOnFocus(second, page.view);
        await expect(one).rejects.toBeInstanceOf(PasteSupersededError);
        await vi.waitFor(() => expect(page.listeners()).toBe(1));
        page.focus();
        await expect(two).resolves.toEqual({ text: 'second', retried: true });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        expect(page.listening()).toBe(false);
    });

    it('a second refusal after the focus is the answer, not a loop', async () => {
        const page = fakeView(false);
        const read = vi.fn().mockRejectedValue(notFocused());
        const result = readClipboardTextOnFocus(read, page.view);
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        page.focus();
        await expect(result).rejects.toThrow('Document is not focused.');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('reads through the wait for focus when given one, and pastes into a pane that is still the target', async () => {
        const page = fakeView(false);
        const clipboard = { readText: vi.fn().mockRejectedValueOnce(notFocused()).mockResolvedValueOnce('pasted') };
        const found = readClipboardForPaste({ clipboard: clipboard as unknown as Clipboard, readFiles: null, focus: { view: page.view, stillTarget: () => true } });
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        page.focus();
        await expect(found).resolves.toEqual({ kind: 'text', text: 'pasted' });
    });

    it('types nothing after the wait when the person has moved to another pane meanwhile', async () => {
        const page = fakeView(false);
        const clipboard = { readText: vi.fn().mockRejectedValueOnce(notFocused()).mockResolvedValueOnce('pasted') };
        const stillTarget = vi.fn(() => false);
        const found = readClipboardForPaste({ clipboard: clipboard as unknown as Clipboard, readFiles: null, focus: { view: page.view, stillTarget } });
        await vi.waitFor(() => expect(page.listening()).toBe(true));
        page.focus();
        await expect(found).rejects.toBeInstanceOf(PasteTargetChangedError);
        // Asked only after a wait: a read that was never refused pastes as #382 does.
        const once = vi.fn(() => false);
        await expect(
            readClipboardForPaste({ clipboard: { readText: async () => 'x' } as unknown as Clipboard, readFiles: null, focus: { view: fakeView(true).view, stillTarget: once } })
        ).resolves.toEqual({ kind: 'text', text: 'x' });
        expect(once).not.toHaveBeenCalled();
    });
});

describe('#264: a paste that typed nothing is said out loud', () => {
    it('warns with the reason and the detail, never the text', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            warnPasteTypedNothing('the clipboard has no text and no PNG', { types: ['text/uri-list'] });
            expect(warn).toHaveBeenCalledTimes(1);
            const line = String(warn.mock.calls[0]?.[0]);
            // The shell copies exactly this prefix into shell.log (`main.ts` ▸ console-message).
            expect(line.startsWith('[paste] nothing typed: the clipboard has no text and no PNG ')).toBe(true);
            expect(line).toContain('"types":["text/uri-list"]');
            expect(line).toContain('"hasFocus"');
        } finally {
            warn.mockRestore();
        }
    });
});
