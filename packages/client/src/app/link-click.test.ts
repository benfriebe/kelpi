import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    LINK_CLICK_SLOP_PX,
    LINK_MENU_DELAY_MS,
    createLinkClickTracker,
    linkCaption,
    type LinkClickInput,
    type LinkProbeAnswer
} from './link-click';

const URL = 'https://example.com/docs';

function click(overrides: Partial<LinkClickInput> = {}): LinkClickInput {
    return {
        paneID: 'pane-1',
        cell: { row: 3, col: 7 },
        clientX: 100,
        clientY: 50,
        button: 0,
        detail: 1,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...overrides
    };
}

function harness(answer: LinkProbeAnswer | null = { opened: 'external', url: URL }) {
    let resolveProbe: ((value: LinkProbeAnswer | null) => void) | null = null;
    const probe = vi.fn(
        () =>
            new Promise<LinkProbeAnswer | null>((resolve) => {
                resolveProbe = resolve;
            })
    );
    const open = vi.fn();
    const tracker = createLinkClickTracker({ probe, open });
    const answerProbe = async (value: LinkProbeAnswer | null = answer): Promise<void> => {
        resolveProbe?.(value);
        await Promise.resolve();
        await Promise.resolve();
    };
    return { tracker, probe, open, answerProbe };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a plain click on a terminal link (#326)', () => {
    it('probes the clicked cell AT the click, and opens the menu once the double-click window is over', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        expect(h.tracker.click(click())).toBe(true);
        // Asked now, so a TUI that redraws in answer to the click cannot change the answer.
        expect(h.probe).toHaveBeenCalledWith('pane-1', 3, 7);
        await h.answerProbe();
        expect(h.open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS);
        expect(h.open).toHaveBeenCalledWith({ paneID: 'pane-1', url: URL, x: 100, y: 50 });
    });

    it('opens the menu when a slow probe answers after the window', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.click(click());
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.open).not.toHaveBeenCalled();
        await h.answerProbe();
        expect(h.open).toHaveBeenCalledTimes(1);
    });

    it('waits out macOS\'s default double-click interval', () => {
        expect(LINK_MENU_DELAY_MS).toBeGreaterThanOrEqual(500);
    });

    it('opens nothing for anything the daemon does not call an external link', async () => {
        for (const answer of [
            { opened: 'none' },
            { opened: 'none', url: undefined },
            { opened: 'markdown' },
            { opened: 'missing' },
            null
        ]) {
            const h = harness(answer);
            h.tracker.pointerDown(100, 50);
            h.tracker.click(click());
            await h.answerProbe();
            vi.advanceTimersByTime(LINK_MENU_DELAY_MS);
            expect(h.open).not.toHaveBeenCalled();
        }
    });

    it('never offers a menu for a double-click, which selects the word instead', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.click(click({ detail: 1 }));
        await h.answerProbe();
        // The second press lands inside the window (late, at 450 ms): the first click's menu is
        // cancelled...
        vi.advanceTimersByTime(450);
        h.tracker.pointerDown(100, 50);
        // ...and the second click (detail 2) is not a link click at all.
        expect(h.tracker.click(click({ detail: 2 }))).toBe(false);
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.probe).toHaveBeenCalledTimes(1);
        expect(h.open).not.toHaveBeenCalled();
    });

    it('lets a right-click cancel a pending menu', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.click(click());
        h.tracker.pointerDown(100, 50, 2);
        await h.answerProbe();
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.open).not.toHaveBeenCalled();
    });

    it('ignores a click with no recorded press (a synthesized tap)', () => {
        const h = harness();
        expect(h.tracker.click(click())).toBe(false);
        expect(h.probe).not.toHaveBeenCalled();
    });

    it('ignores a drag that travelled and came back to where it started', () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.pointerMove(160, 50);
        h.tracker.pointerMove(101, 50);
        expect(h.tracker.click(click({ clientX: 101 }))).toBe(false);
        expect(h.probe).not.toHaveBeenCalled();
    });

    it('ignores the end of a drag, however short the selection', () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        expect(h.tracker.click(click({ clientX: 100 + LINK_CLICK_SLOP_PX + 1 }))).toBe(false);
        h.tracker.pointerDown(100, 50);
        expect(h.tracker.click(click({ clientY: 50 - LINK_CLICK_SLOP_PX - 1 }))).toBe(false);
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.probe).not.toHaveBeenCalled();
    });

    it('tolerates a jitter within the slop', () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        expect(h.tracker.click(click({ clientX: 102, clientY: 52 }))).toBe(true);
    });

    it('leaves modified and non-primary clicks to their own gestures', () => {
        const h = harness();
        for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) {
            h.tracker.pointerDown(100, 50);
            expect(h.tracker.click(click({ [modifier]: true }))).toBe(false);
        }
        h.tracker.pointerDown(100, 50);
        expect(h.tracker.click(click({ button: 1 }))).toBe(false);
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.probe).not.toHaveBeenCalled();
    });

    it('drops a probe answer that arrives after the user moved on', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.click(click());
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS);
        expect(h.probe).toHaveBeenCalledTimes(1);
        // A key, a scroll or a new press while the daemon is answering.
        h.tracker.cancel();
        await h.answerProbe();
        expect(h.open).not.toHaveBeenCalled();
    });

    it('cancels a pending menu on a key during the window, even with the answer in', async () => {
        const h = harness();
        h.tracker.pointerDown(100, 50);
        h.tracker.click(click());
        await h.answerProbe();
        h.tracker.cancel();
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS * 2);
        expect(h.open).not.toHaveBeenCalled();
    });

    it('swallows a failed probe rather than raising anything', async () => {
        const probe = vi.fn(() => Promise.reject(new Error('socket closed')));
        const open = vi.fn();
        const tracker = createLinkClickTracker({ probe, open });
        tracker.pointerDown(100, 50);
        tracker.click(click());
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(LINK_MENU_DELAY_MS);
        expect(open).not.toHaveBeenCalled();
    });
});

describe('linkCaption', () => {
    it('drops the scheme', () => {
        expect(linkCaption('https://example.com/a')).toBe('example.com/a');
        expect(linkCaption('http://example.com')).toBe('example.com');
    });

    it('elides the middle of a long URL to the limit', () => {
        const long = 'https://example.com/' + 'segment/'.repeat(20) + 'end?q=1';
        const caption = linkCaption(long, 30);
        expect(caption).toHaveLength(30);
        expect(caption.startsWith('example.com/')).toBe(true);
        expect(caption.endsWith('end?q=1')).toBe(true);
        expect(caption).toContain('…');
    });
});
