/**
 * The sandboxed viewport and its message bridge.
 *
 * Two things here are load-bearing rather than cosmetic: the sandbox token list (a note that
 * could script the app shell is the failure this design exists to prevent) and the `<base href>`
 * injection (without it every relative image in every note resolves against the client page and
 * 404s). Both are asserted on the rendered DOM, not on a helper's return value.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_BRIDGE_SOURCE, CONTENT_HOST_SOURCE } from './bridge';
import { ContentFrame } from './ContentFrame';
import { createScrollStore } from './scroll';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

const BARE_DOCUMENT =
    '<!DOCTYPE html>\n<html class="dark">\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n';

function frame(paneID = PANE): HTMLIFrameElement {
    return screen.getByTestId(`content-iframe-${paneID}`) as HTMLIFrameElement;
}

function srcdoc(paneID = PANE): string {
    return frame(paneID).getAttribute('srcdoc') ?? '';
}

/** A message as the frame would send it (jsdom cannot run the sandboxed script itself). */
function fromFrame(message: Record<string, unknown>, paneID = PANE): void {
    window.dispatchEvent(
        new MessageEvent('message', { data: { source: CONTENT_BRIDGE_SOURCE, paneID, ...message } })
    );
}

afterEach(() => {
    cleanup();
});

describe('sandboxing', () => {
    it('runs the document with scripts but never with the app’s origin', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);

        const sandbox = frame().getAttribute('sandbox');
        expect(sandbox).toBe('allow-scripts');
        expect(sandbox).not.toContain('allow-same-origin');
    });

    /**
     * run-B L1: the sandbox is precisely what breaks §3.8's transparent document. `allow-scripts`
     * alone gives the frame an opaque origin; Chromium isolates one into its own process; an
     * out-of-process frame composites over a WHITE base and never sees the pane container behind
     * it. The frame therefore paints the fill assembly resolved, and the pane container keeps
     * painting its own so the two agree at the edges.
     */
    it('paints the frame with the fill assembly resolved, not Chromium’s white base', () => {
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                documentBackground="#1A1B26"
                isDark
            />
        );

        expect(srcdoc()).toContain('html{background-color:#1A1B26;color-scheme:dark;}');
    });

    it('falls back to the theme default when assembly resolved nothing', () => {
        const view = render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);
        expect(srcdoc()).toContain('html{background-color:#0A0A0C;color-scheme:dark;}');

        view.rerender(
            <ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} isDark={false} />
        );
        expect(srcdoc()).toContain('html{background-color:#FFFFFF;color-scheme:light;}');
    });

    it('loads the daemon’s document through srcdoc with the copy-button script injected', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);

        const document = srcdoc();
        expect(document).toContain('<h1>Doc</h1>');
        expect(document).toContain('__nexContentBridge');
        expect(document).toContain('.code-copy-btn');
        // The script goes inside the document, before its end tag.
        expect(document.indexOf('__nexContentBridge')).toBeLessThan(document.lastIndexOf('</body>'));
    });
});

describe('relative assets', () => {
    it('injects the pane-assets base when the document has none', () => {
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                assetBase={`/pane-assets/${PANE}/`}
            />
        );

        const document = srcdoc();
        expect(document).toContain(`<base href="/pane-assets/${PANE}/">`);
        // …in the head, ahead of anything that could load a resource.
        expect(document.indexOf('<base')).toBeLessThan(document.indexOf('</head>'));
    });

    it('leaves the daemon’s own base tag alone', () => {
        const withBase = BARE_DOCUMENT.replace('<head>\n', `<head>\n<base href="/pane-assets/${PANE}/">\n`);
        render(
            <ContentFrame paneID={PANE} title="markdown preview" html={withBase} assetBase="/pane-assets/other/" />
        );

        const document = srcdoc();
        expect(document.match(/<base /g)).toHaveLength(1);
        expect(document).not.toContain('/pane-assets/other/');
    });
});

describe('the message bridge', () => {
    it('writes a copied code block to the clipboard', () => {
        const writeClipboard = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                writeClipboard={writeClipboard}
            />
        );

        fromFrame({ kind: 'copy', text: 'npm run build\n' });

        expect(writeClipboard).toHaveBeenCalledWith('npm run build\n');
    });

    it('ignores a message that claims another pane', () => {
        const writeClipboard = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                writeClipboard={writeClipboard}
            />
        );

        fromFrame({ kind: 'copy', text: 'x' }, 'DDDDDDDD-0000-4000-8000-000000000002');

        expect(writeClipboard).not.toHaveBeenCalled();
    });

    it('opens a link outside the pane, but only a safe scheme', () => {
        const openLink = vi.fn();
        render(
            <ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} openLink={openLink} />
        );

        fromFrame({ kind: 'link', href: 'https://example.com/docs' });
        expect(openLink).toHaveBeenCalledWith('https://example.com/docs');

        openLink.mockClear();
        fromFrame({ kind: 'link', href: 'javascript:alert(1)' });
        expect(openLink).not.toHaveBeenCalled();
    });

    it('reports a press inside the frame as a focus request', () => {
        const onFocusRequest = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                onFocusRequest={onFocusRequest}
            />
        );

        fromFrame({ kind: 'focus' });

        expect(onFocusRequest).toHaveBeenCalledWith(PANE);
    });

    it('forwards ⌘E from inside the preview, which the host’s key handler cannot see', () => {
        const onToggleEdit = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                onToggleEdit={onToggleEdit}
            />
        );

        fromFrame({ kind: 'toggle-edit' });

        expect(onToggleEdit).toHaveBeenCalledWith(PANE);
    });
});

describe('scroll preservation', () => {
    it('keeps the reported position in the shared store, keyed by pane', () => {
        const store = createScrollStore();
        render(
            <ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} scrollStore={store} />
        );

        fromFrame({ kind: 'scroll', top: 640, fraction: 0.4 });

        expect(store.get(PANE)).toEqual({ top: 640, fraction: 0.4 });
    });

    it('restores the stored fraction on a fresh mount and the pixels on a reload', () => {
        const store = createScrollStore();
        store.set(PANE, { top: 1200, fraction: 0.5 });
        const view = render(
            <ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} scrollStore={store} />
        );

        const target = frame().contentWindow;
        expect(target).not.toBeNull();
        const post = vi.spyOn(target as Window, 'postMessage');

        // Fresh mount: the new document's height is not the old one's, so the fraction wins.
        fromFrame({ kind: 'ready' });
        expect(post).toHaveBeenLastCalledWith(
            { source: CONTENT_HOST_SOURCE, kind: 'scroll-to', top: 0, fraction: 0.5 },
            '*'
        );

        // The reader scrolls, then the watcher pushes a new document into the same mount:
        // the same document at the same length, so the absolute offset is the truthful one.
        fromFrame({ kind: 'scroll', top: 900, fraction: 0.45 });
        view.rerender(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT.replace('Doc', 'Doc updated')}
                scrollStore={store}
            />
        );
        fromFrame({ kind: 'ready' });

        expect(post).toHaveBeenLastCalledWith(
            { source: CONTENT_HOST_SOURCE, kind: 'scroll-to', top: 900, fraction: 0 },
            '*'
        );
    });

    it('re-renders the document only when it changes', () => {
        const view = render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);
        const first = srcdoc();

        view.rerender(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);
        expect(srcdoc()).toBe(first);

        view.rerender(
            <ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT.replace('Doc', 'New')} />
        );
        expect(srcdoc()).not.toBe(first);
    });
});
