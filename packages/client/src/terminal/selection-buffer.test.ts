import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachSelectionBuffer, lastSelection, recordSelection, resetSelectionBufferForTests } from './selection-buffer';

afterEach(() => resetSelectionBufferForTests());

/** Another Kelpi window: a second page on the same origin, which is all a channel can tell. */
function otherWindow() {
    const channel = new BroadcastChannel('kelpi-selection-buffer');
    const heard: unknown[] = [];
    channel.onmessage = (event: MessageEvent) => heard.push(event.data);
    return { send: (text: string) => channel.postMessage(text), heard, close: () => channel.close() };
}

describe('the selection buffer', () => {
    it('holds the newest non-empty selection, and nothing until there is one', () => {
        expect(lastSelection()).toBeNull();
        recordSelection('first');
        recordSelection('');
        expect(lastSelection()).toBe('first');
        recordSelection('second');
        expect(lastSelection()).toBe('second');
    });

    it("shares selections with the other Kelpi windows while a terminal is mounted", async () => {
        const detach = attachSelectionBuffer();
        const other = otherWindow();
        try {
            recordSelection('from this window');
            await vi.waitFor(() => expect(other.heard).toEqual(['from this window']));
            other.send('from the other window');
            await vi.waitFor(() => expect(lastSelection()).toBe('from the other window'));
        } finally {
            other.close();
            detach();
        }
    });

    it('stops listening once the last pane detaches, and keeps what it had', async () => {
        const first = attachSelectionBuffer();
        const second = attachSelectionBuffer();
        recordSelection('kept');
        first();
        first(); // a second call from the same pane is not a second detach
        const other = otherWindow();
        try {
            other.send('still heard');
            await vi.waitFor(() => expect(lastSelection()).toBe('still heard'));
            second();
            other.send('not heard');
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(lastSelection()).toBe('still heard');
        } finally {
            other.close();
        }
    });
});
