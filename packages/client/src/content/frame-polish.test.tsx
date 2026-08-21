/**
 * The host half of the preview's find bar and copy menu (content-panes.md §3.13, §3.14).
 *
 * The frame is cross-origin in production, so every exchange here is a `postMessage` — which
 * is exactly what these tests drive: a message "from the frame" opens the bar, and the bar's
 * own gestures are asserted by what the host posts BACK. That boundary is the contract; the
 * marks themselves are `find.test.ts`'s job.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_BRIDGE_SOURCE, CONTENT_HOST_SOURCE } from './bridge';
import { ContentFrame, findCountLabel } from './ContentFrame';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const DOCUMENT = '<!DOCTYPE html>\n<html>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n';

/**
 * What the frame would post; jsdom cannot run the sandboxed script for us. Wrapped in `act`
 * because a bridge message drives React state (the count, the menu) from outside React's own
 * event system, so the commit would otherwise land after the assertion.
 */
function fromFrame(message: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent('message', { data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, ...message } })
        );
    });
}

/** Captures what the host posts INTO the frame (the iframe has no real contentWindow here). */
function captureToFrame(): Record<string, unknown>[] {
    const posted: Record<string, unknown>[] = [];
    const iframe = screen.getByTestId(`content-iframe-${PANE}`) as HTMLIFrameElement;
    Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: {
            postMessage: (message: Record<string, unknown>) => {
                posted.push(message);
            }
        }
    });
    return posted;
}

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    cleanup();
});

describe('findCountLabel', () => {
    it('never shows a stale selection against zero matches (§3.13)', () => {
        expect(findCountLabel(0, -1)).toBe('0/0');
        expect(findCountLabel(0, 2)).toBe('0/0');
        expect(findCountLabel(12, 2)).toBe('3/12');
        expect(findCountLabel(12, -1)).toBe('0/12');
    });
});

describe('find bar', () => {
    it('opens on ⌘F inside the preview and searches without a debounce', async () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} />);
        const posted = captureToFrame();

        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        fromFrame({ kind: 'find-open' });
        const input = await screen.findByTestId(`content-find-input-${PANE}`);

        fireEvent.change(input, { target: { value: 'alp' } });
        const search = posted.filter((message) => message['kind'] === 'find' && message['op'] === 'search');
        expect(search.at(-1)).toMatchObject({ source: CONTENT_HOST_SOURCE, op: 'search', needle: 'alp' });
    });

    it('opens when the app bumps the find token (the ⌘F binding)', async () => {
        const view = render(
            <ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} findToken={0} />
        );
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();

        view.rerender(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} findToken={1} />);
        expect(await screen.findByTestId(`content-find-${PANE}`)).toBeTruthy();
    });

    it('shows the match count the frame reports and steps through matches', async () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} />);
        const posted = captureToFrame();
        fromFrame({ kind: 'find-open' });
        await screen.findByTestId(`content-find-${PANE}`);

        fromFrame({ kind: 'find-result', total: 12, current: 2 });
        expect(screen.getByTestId(`content-find-count-${PANE}`).textContent).toBe('3/12');

        fireEvent.click(screen.getByTestId(`content-find-next-${PANE}`));
        fireEvent.click(screen.getByTestId(`content-find-prev-${PANE}`));
        const ops = posted.filter((message) => message['kind'] === 'find').map((message) => message['op']);
        expect(ops).toContain('next');
        expect(ops).toContain('prev');
    });

    it('closing clears the marks in the document', async () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} />);
        const posted = captureToFrame();
        fromFrame({ kind: 'find-open' });
        await screen.findByTestId(`content-find-${PANE}`);
        fireEvent.change(screen.getByTestId(`content-find-input-${PANE}`), { target: { value: 'x' } });

        fireEvent.click(screen.getByTestId(`content-find-close-${PANE}`));

        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        expect(posted.filter((message) => message['op'] === 'clear')).toHaveLength(1);
    });

    it('re-applies the stored needle after the document reloads (§3.13)', async () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} />);
        const posted = captureToFrame();
        fromFrame({ kind: 'find-open' });
        await screen.findByTestId(`content-find-${PANE}`);
        fireEvent.change(screen.getByTestId(`content-find-input-${PANE}`), { target: { value: 'doc' } });
        posted.length = 0;

        // The watcher saw a write: the frame reloads and says `ready` with no marks left.
        fromFrame({ kind: 'ready' });

        expect(posted.filter((message) => message['kind'] === 'find' && message['needle'] === 'doc')).toHaveLength(
            1
        );
    });
});

describe('copy commands', () => {
    it('shows no copy affordance for a document whose load failed (§3.14)', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource={null} />);
        expect(screen.queryByTestId(`content-copy-${PANE}`)).toBeNull();
        // A right-click cannot conjure the menu either.
        fromFrame({ kind: 'context-menu', x: 10, y: 10 });
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();
    });

    it('tells the frame whether to suppress the native context menu', () => {
        const view = render(
            <ContentFrame paneID={PANE} title="diff" html={DOCUMENT} />
        );
        const posted = captureToFrame();

        // No copy source (a diff pane): the browser's own menu must stay.
        fromFrame({ kind: 'ready' });
        expect(posted.filter((message) => message['kind'] === 'copy-menu').at(-1)).toMatchObject({
            enabled: false
        });

        view.rerender(
            <ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource="# Doc\n" />
        );
        expect(posted.filter((message) => message['kind'] === 'copy-menu').at(-1)).toMatchObject({
            enabled: true
        });
    });

    it('copies the source with front matter stripped', () => {
        const writeClipboard = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource={'---\ntitle: Doc\n---\n# Doc\n'}
                writeClipboard={writeClipboard}
            />
        );

        fireEvent.click(screen.getByTestId(`content-copy-${PANE}`));
        fireEvent.click(screen.getByTestId(`content-copy-markdown-${PANE}`));

        expect(writeClipboard).toHaveBeenCalledWith('# Doc\n');
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();
    });

    /**
     * §TERM-103: the pane HEADER's copy button, which is where the Swift puts this menu. It
     * cannot pass coordinates (it is not in this component's box), so the menu pins to the
     * top-right corner the in-frame chip occupies — and a second bump re-opens it.
     */
    it('opens the menu from the header’s copy button, pinned top-right', () => {
        const view = render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource="# Doc\n"
                copyToken={0}
            />
        );
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();

        view.rerender(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource="# Doc\n"
                copyToken={1}
            />
        );
        const menu = screen.getByTestId(`content-copy-menu-${PANE}`);
        expect(menu.style.right).toBe('14px');
        expect(menu.style.top).toBe('8px');
        expect(menu.style.left).toBe('');
        // Both items are the same ones the chip opens.
        expect(screen.getByTestId(`content-copy-markdown-${PANE}`)).toBeTruthy();
        expect(screen.getByTestId(`content-copy-rich-${PANE}`)).toBeTruthy();

        fireEvent.click(screen.getByTestId(`content-copy-scrim-${PANE}`));
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();

        // Asking again re-opens it (the token is a counter, not a flag).
        view.rerender(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource="# Doc\n"
                copyToken={2}
            />
        );
        expect(screen.getByTestId(`content-copy-menu-${PANE}`)).toBeTruthy();
    });

    it('ignores the header’s copy button for a document whose load failed', () => {
        const view = render(
            <ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource={null} copyToken={0} />
        );
        view.rerender(
            <ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource={null} copyToken={1} />
        );
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();
    });

    it('opens the same menu from the preview’s right-click', () => {
        render(
            <ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource="# Doc\n" />
        );
        fromFrame({ kind: 'context-menu', x: 42, y: 24 });
        const menu = screen.getByTestId(`content-copy-menu-${PANE}`);
        expect(menu.style.left).toBe('42px');
        expect(menu.style.top).toBe('24px');
    });

    it('asks the frame for the rendered DOM and writes both flavors', () => {
        const writeRichClipboard = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource="# Doc\n"
                writeRichClipboard={writeRichClipboard}
            />
        );
        const posted = captureToFrame();

        fireEvent.click(screen.getByTestId(`content-copy-${PANE}`));
        fireEvent.click(screen.getByTestId(`content-copy-rich-${PANE}`));

        const request = posted.find((message) => message['kind'] === 'collect-rich-text');
        expect(request).toBeTruthy();
        const token = request?.['token'] as string;

        // A stale reply (an older request, a reloaded document) must not write anything.
        fromFrame({ kind: 'rich-text', token: 'stale', html: '<p>old</p>', text: 'old' });
        expect(writeRichClipboard).not.toHaveBeenCalled();

        fromFrame({ kind: 'rich-text', token, html: '<h1>Doc</h1>', text: 'Doc' });
        expect(writeRichClipboard).toHaveBeenCalledWith({ html: '<h1>Doc</h1>', text: 'Doc' });
    });
});
