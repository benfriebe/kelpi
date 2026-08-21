// @vitest-environment jsdom
/**
 * §WEB-139 / §WEB-143 — the page script's TRANSIENTS, held with fake timers.
 *
 * These are the two items 00-INDEX gap #8 names: a 320 ms badge pulse, panel-origin focus's
 * smooth-scroll-to-centre plus its 400 ms re-anchor, and the picker's suspension while the
 * comment popover is open. The visual audit drives the same script against a real Chromium and
 * reads what it can (the ring, the placement, the comment sync) — but an animation that has
 * finished by the time a screenshot lands is not something a screenshot can prove.
 *
 * So they are proven here instead. The injected sources are `Function.prototype.toString()` of
 * real functions in `./scripts.ts`, which means they can simply be EVALUATED — in jsdom, with
 * `vi.useFakeTimers()` holding the clock still between the pulse's start and its end, and with
 * `Element.prototype.scrollIntoView` and `getBoundingClientRect` stubbed (jsdom implements
 * neither meaningfully). What is asserted is exactly what the page does, at the millisecond the
 * spec names — not that the file contains a `320`.
 *
 * The one thing this cannot show is the *appearance* of the transition: jsdom computes no
 * animation. It holds the state machine either side of the timer, which is what the two items
 * describe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchMarkerScript, buildInspectArm, inspectorScript } from './scripts.js';

interface PageWindow {
    __nexPost?: (channel: string, body: unknown) => void;
    __nexBatchSetMarkers?: (items: readonly unknown[]) => boolean;
    __nexBatchHighlight?: (id: string, scrollIntoView: boolean) => boolean;
    __nexBatchUnfocus?: () => boolean;
    __nexBatchHasOpenPopover?: boolean;
    __nexInspectorEnable?: (nonce: string, sticky: boolean) => boolean;
    __nexInspectorArmed?: () => boolean;
    __nexBatchMarkersInstalled?: boolean;
    __nexInspectorInstalled?: boolean;
    __nexBridgeInstalled?: boolean;
}

const page = (): PageWindow => window as unknown as PageWindow;

/** Posts the page made, in order — the `nexInspect` / `nexBatchMarker` channels. */
let posted: { channel: string; body: Record<string, unknown> }[] = [];

/** The rect `#target` reports; moved between assertions to prove a re-anchor happened. */
let targetRect = { left: 100, top: 200, width: 40, height: 20 };

function install(): void {
    document.body.innerHTML = '<button id="target">Go</button><div id="other">Elsewhere</div>';
    const target = document.querySelector('#target') as HTMLElement;
    target.getBoundingClientRect = (): DOMRect =>
        ({
            ...targetRect,
            x: targetRect.left,
            y: targetRect.top,
            right: targetRect.left + targetRect.width,
            bottom: targetRect.top + targetRect.height,
            toJSON: () => ({})
        }) as DOMRect;
    page().__nexPost = (channel, body) => {
        posted.push({ channel, body: body as Record<string, unknown> });
    };
    // The scripts are IIFE source strings; evaluating one IS installing it in this window.
    // eslint-disable-next-line no-eval
    (0, eval)(batchMarkerScript());
    (0, eval)(inspectorScript());
}

function badge(): HTMLElement {
    const found = document.querySelector('[data-nex-batch-marker]');
    if (found === null) throw new Error('no badge rendered');
    return found as HTMLElement;
}

function popover(): HTMLElement | null {
    return document.querySelector('[data-nex-batch-popover]');
}

beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    targetRect = { left: 100, top: 200, width: 40, height: 20 };
    Element.prototype.scrollIntoView = vi.fn();
    // A fresh window per test is not available here, so the install guards are reset instead.
    page().__nexBatchMarkersInstalled = false;
    page().__nexInspectorInstalled = false;
    page().__nexBatchHasOpenPopover = false;
    install();
    page().__nexBatchSetMarkers?.([{ id: 'i1', selector: '#target', label: '1', comment: '' }]);
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('WEB-139: the focus transients', () => {
    it('pulses the badge to 1.6× and settles it back after exactly 320 ms', () => {
        page().__nexBatchHighlight?.('i1', false);
        expect(badge().style.transform).toBe('scale(1.6)');

        // Still enlarged one tick before the deadline…
        vi.advanceTimersByTime(319);
        expect(badge().style.transform).toBe('scale(1.6)');

        // …and back at rest on it.
        vi.advanceTimersByTime(1);
        expect(badge().style.transform).toBe('scale(1)');
    });

    it('scrolls a PANEL-origin focus to centre, and re-anchors 400 ms later', () => {
        page().__nexBatchHighlight?.('i1', true);

        const target = document.querySelector('#target') as HTMLElement;
        expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
        // Anchored to where the element is RIGHT NOW (badge sits 6 px outside its top-left).
        expect(badge().style.top).toBe('194px');

        // The smooth scroll moves the element under the badge; nothing repositions it until…
        targetRect = { ...targetRect, top: 40 };
        vi.advanceTimersByTime(399);
        expect(badge().style.top).toBe('194px');

        // …the 400 ms re-anchor, which is the whole reason the timer exists.
        vi.advanceTimersByTime(1);
        expect(badge().style.top).toBe('34px');
    });

    it('does not scroll a PAGE-origin focus — the element is already under the cursor', () => {
        page().__nexBatchHighlight?.('i1', false);
        const target = document.querySelector('#target') as HTMLElement;
        expect(target.scrollIntoView).not.toHaveBeenCalled();

        // And with no scroll there is no re-anchor timer either: a moved rect stays stale until
        // the next real scroll/resize event, exactly as the un-scrolled path intends.
        targetRect = { ...targetRect, top: 40 };
        vi.advanceTimersByTime(1_000);
        expect(badge().style.top).toBe('194px');
    });

    it('hides the badge and the ring for an element that has gone off-screen', () => {
        page().__nexBatchHighlight?.('i1', false);
        expect(badge().style.display).toBe('flex');

        targetRect = { left: -500, top: -500, width: 40, height: 20 };
        // A scroll is the event the page listens for; the reposition is synchronous.
        window.dispatchEvent(new Event('scroll'));
        expect(badge().style.display).toBe('none');
    });
});

describe('WEB-143: the picker suspends while the popover is open', () => {
    beforeEach(() => {
        // Arm the picker exactly the way the daemon does, then open a popover on the item.
        (0, eval)(buildInspectArm('NONCE', true));
        expect(page().__nexInspectorArmed?.()).toBe(true);
        page().__nexBatchHighlight?.('i1', false);
        expect(page().__nexBatchHasOpenPopover).toBe(true);
        expect(popover()).not.toBeNull();
    });

    it('hides the hover outline instead of drawing one', () => {
        const other = document.querySelector('#other') as HTMLElement;
        other.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

        const overlay = document.querySelector('[data-nex-inspector-overlay]') as HTMLElement | null;
        // Either no overlay was ever created, or the one that exists is hidden — both are "no
        // outline is drawn"; what must never happen is a visible box tracking the cursor.
        expect(overlay === null || overlay.style.display === 'none').toBe(true);
    });

    it('takes no pick from a click, and does not preventDefault it', () => {
        const other = document.querySelector('#other') as HTMLElement;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        other.dispatchEvent(event);

        expect(posted.filter((entry) => entry.channel === 'nexInspect')).toHaveLength(0);
        // The page keeps its own click: the popover's buttons are ordinary DOM.
        expect(event.defaultPrevented).toBe(false);
        // And the picker is still armed — suspended, not disarmed.
        expect(page().__nexInspectorArmed?.()).toBe(true);
    });

    it('gives Escape to the popover: the batch is not cancelled', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // A cancel would have posted `{cancelled:true}` on the inspect channel.
        expect(posted.filter((entry) => entry.channel === 'nexInspect')).toHaveLength(0);
        expect(page().__nexInspectorArmed?.()).toBe(true);
    });

    it('resumes the picker once the popover is dismissed', () => {
        page().__nexBatchUnfocus?.();
        expect(page().__nexBatchHasOpenPopover).toBe(false);

        const other = document.querySelector('#other') as HTMLElement;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        other.dispatchEvent(event);

        const picks = posted.filter((entry) => entry.channel === 'nexInspect');
        expect(picks).toHaveLength(1);
        expect(picks[0]?.body['selector']).toBe('#other');
        expect(event.defaultPrevented).toBe(true);
    });
});
