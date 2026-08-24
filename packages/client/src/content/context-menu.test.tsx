/**
 * H10, client half — the preview's menu APPENDS to WebKit's rather than replacing it.
 *
 * `MarkdownPaneView.swift:457-494` inserts "Copy as Markdown" / "Copy as Rich Text" / a
 * separator at indices 0-2 of the menu WebKit built, so Copy (and Look Up, Speech, Services)
 * all survive a right-click in a preview. The port's host menu carried exactly two items, and a
 * diff pane — where the frame deliberately leaves the browser's menu alone — got nothing at all,
 * because an Electron renderer has no default menu (`shell/src/context-menu.ts` is the other
 * half of this fix, and has its own tests).
 *
 * What is asserted here: the frame reports the selection with its right-click, the host menu
 * carries Copy under its own two commands and writes THAT text, and a click with nothing
 * selected keeps the row away instead of offering a Copy that would do nothing.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_BRIDGE_SOURCE, CONTENT_HOST_SOURCE, contentBridgeScript, parseBridgeMessage } from './bridge';
import { ContentFrame } from './ContentFrame';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const DOCUMENT = '<!DOCTYPE html>\n<html><head></head><body><h1>Doc</h1></body></html>\n';

/** `act`, because a bridge message drives React state from outside React's own event system. */
function fromFrame(message: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent('message', { data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, ...message } })
        );
    });
}

afterEach(cleanup);

describe('the preview’s copy menu', () => {
    it('appends Copy under its own two commands, and copies the selection', () => {
        const writeClipboard = vi.fn();
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource={'# Doc\n'}
                writeClipboard={writeClipboard}
            />
        );

        fromFrame({ kind: 'context-menu', x: 12, y: 8, selection: 'a selected phrase' });

        const menu = screen.getByTestId(`content-copy-menu-${PANE}`);
        const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
        // The Swift order: the two nex commands first, WebKit's Copy under the separator.
        expect(rows).toEqual(['Copy as Markdown', 'Copy as Rich Text', 'Copy']);
        expect(screen.getByTestId(`content-copy-separator-${PANE}`)).not.toBeNull();

        fireEvent.click(screen.getByTestId(`content-copy-selection-${PANE}`));
        expect(writeClipboard).toHaveBeenCalledWith('a selected phrase');
        expect(screen.queryByTestId(`content-copy-menu-${PANE}`)).toBeNull();
    });

    it('leaves the Copy row out when nothing is selected', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} copySource={'# Doc\n'} />);

        fromFrame({ kind: 'context-menu', x: 12, y: 8, selection: '   ' });

        expect(screen.queryByTestId(`content-copy-selection-${PANE}`)).toBeNull();
        expect(screen.queryByTestId(`content-copy-separator-${PANE}`)).toBeNull();
    });

    it('keeps a stale selection out of the header button’s menu', () => {
        const view = render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource={'# Doc\n'}
                copyToken={0}
            />
        );
        fromFrame({ kind: 'context-menu', x: 12, y: 8, selection: 'earlier' });
        expect(screen.getByTestId(`content-copy-selection-${PANE}`)).not.toBeNull();
        fireEvent.click(screen.getByTestId(`content-copy-scrim-${PANE}`));

        // §TERM-103's route is a button press, not a click into the document.
        view.rerender(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource={'# Doc\n'}
                copyToken={1}
            />
        );
        expect(screen.getByTestId(`content-copy-menu-${PANE}`)).not.toBeNull();
        expect(screen.queryByTestId(`content-copy-selection-${PANE}`)).toBeNull();
    });

    it('parses a right-click with no selection field as no selection', () => {
        expect(
            parseBridgeMessage(
                { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, kind: 'context-menu', x: 1, y: 2 },
                PANE
            )
        ).toEqual({ kind: 'context-menu', x: 1, y: 2, selection: '' });
    });

    it('sends the document’s selection with the right-click, and only when the host has a menu', async () => {
        const posted: Record<string, unknown>[] = [];
        const collect = (event: MessageEvent): void => {
            const data = event.data as Record<string, unknown> | null;
            if (data !== null && data['source'] === CONTENT_BRIDGE_SOURCE) posted.push(data);
        };
        window.addEventListener('message', collect);
        document.body.innerHTML = '<div id="content"><p id="para">selected text</p></div>';
        delete (window as unknown as Record<string, unknown>)['__nexContentBridge'];
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the injected script IS the test
        new Function(contentBridgeScript(PANE))();

        const rightClick = (): MouseEvent => {
            const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            document.getElementById('para')?.dispatchEvent(event);
            return event;
        };

        // A diff pane never enables the host menu: the browser's own is left intact, which is
        // what the shell's native handler now answers.
        const untouched = rightClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(untouched.defaultPrevented).toBe(false);
        expect(posted.some((message) => message['kind'] === 'context-menu')).toBe(false);

        window.dispatchEvent(
            new MessageEvent('message', {
                data: { source: CONTENT_HOST_SOURCE, kind: 'copy-menu', enabled: true }
            })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        const range = document.createRange();
        range.selectNodeContents(document.getElementById('para') as HTMLElement);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);

        const claimed = rightClick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(claimed.defaultPrevented).toBe(true);
        const message = posted.filter((entry) => entry['kind'] === 'context-menu').at(-1);
        expect(message?.['selection']).toBe('selected text');

        window.removeEventListener('message', collect);
    });
});
