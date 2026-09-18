import { cleanup, render } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { overlayCovers, overlayPresenceCount, measureOverlayRect } from '../chrome/modal-presence';

import {
    clearPaneChromeHeights,
    paneChromeBand,
    paneChromeDeclaration,
    paneChromeDeclarationCount,
    setPaneChromeHeight,
    usePaneChromeHeights,
    usePaneChromeParking
} from './height';

afterEach(() => {
    cleanup();
    clearPaneChromeHeights();
});

describe('the pane chrome height store', () => {
    it('is empty until something declares, which nothing does in this phase', () => {
        expect(paneChromeDeclarationCount()).toBe(0);
        expect(paneChromeDeclaration('p1')).toBeNull();
        expect(paneChromeBand(new Map(), 'p1', 800)).toBe(24);
        expect(paneChromeBand(new Map(), 'p1', 800, 32)).toBe(32);
    });

    it('stores a declaration raw and clamps it only at read', () => {
        setPaneChromeHeight('p1', 400);
        // Raw, because the ceiling is a fraction of a pane height the store cannot see.
        expect(paneChromeDeclaration('p1')).toBe(400);
        expect(paneChromeBand(new Map([['p1', 400]]), 'p1', 800)).toBe(96);
        expect(paneChromeBand(new Map([['p1', 400]]), 'p1', 240)).toBe(60);
    });

    it('refuses a value that is not a height, and rounds one that is', () => {
        setPaneChromeHeight('p1', Number.NaN);
        setPaneChromeHeight('p2', -1);
        setPaneChromeHeight('p3', Number.POSITIVE_INFINITY);
        expect(paneChromeDeclarationCount()).toBe(0);
        setPaneChromeHeight('p4', 47.6);
        expect(paneChromeDeclaration('p4')).toBe(48);
    });

    it('withdraws on null and drops everything on a fallback', () => {
        setPaneChromeHeight('p1', 60);
        setPaneChromeHeight('p2', 60);
        setPaneChromeHeight('p1', null);
        expect(paneChromeDeclaration('p1')).toBeNull();
        expect(paneChromeDeclarationCount()).toBe(1);
        clearPaneChromeHeights();
        expect(paneChromeDeclarationCount()).toBe(0);
    });

    it('publishes a stable snapshot, so an unrelated render does not re-measure every terminal', () => {
        let seen: ReadonlyMap<string, number>[] = [];
        function Probe(): ReactElement {
            const heights = usePaneChromeHeights();
            seen.push(heights);
            return <span data-testid="probe">{String(heights.size)}</span>;
        }
        const view = render(<Probe />);
        view.rerender(<Probe />);
        expect(seen.length).toBeGreaterThan(1);
        expect(seen.every((entry) => entry === seen[0])).toBe(true);
        seen = [];
    });
});

function Band({ kind, height }: { readonly kind: 'web' | 'shell'; readonly height: number }): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    usePaneChromeParking(ref, kind, height);
    return <div ref={ref} data-testid="band" style={{ height }} />;
}

describe('parking a declared band over a web pane (ratified decision 5)', () => {
    it('registers nothing at the native band, on any pane kind', () => {
        render(<Band kind="web" height={24} />);
        expect(overlayPresenceCount()).toBe(0);
        cleanup();
        render(<Band kind="shell" height={96} />);
        expect(overlayPresenceCount()).toBe(0);
    });

    it('enrols a taller band over a web pane, and releases it when the band goes back', () => {
        const view = render(<Band kind="web" height={96} />);
        expect(overlayPresenceCount()).toBe(1);
        view.rerender(<Band kind="web" height={24} />);
        expect(overlayPresenceCount()).toBe(0);
    });

    it('releases on unmount, so a closed pane cannot park a page forever', () => {
        render(<Band kind="web" height={96} />);
        expect(overlayPresenceCount()).toBe(1);
        cleanup();
        expect(overlayPresenceCount()).toBe(0);
    });

    /**
     * The geometry half of the decision, asserted as arithmetic because jsdom has no layout.
     *
     * A band and the page hole under it are ADJACENT, not overlapping: the hole starts where the
     * band ends. So once the shell has moved the native view down, `overlayCovers` reports no
     * cover and the page comes back live - and the registration only bites in the frames between
     * the band growing and the view following it, which is exactly the window a user would
     * otherwise watch new chrome get sliced in.
     */
    it('covers the hole only while the two actually overlap', () => {
        const band = { x: 100, y: 200, w: 500, h: 96 };
        const holeBelow = { x: 100, y: 296, w: 500, h: 400 };
        const holeNotYetMoved = { x: 100, y: 224, w: 500, h: 472 };
        expect(overlayCovers(holeBelow, [band])).toBe(false);
        expect(overlayCovers(holeNotYetMoved, [band])).toBe(true);
        // And an unmeasurable registration covers everything, which is the safe default the
        // whole `modal-presence` precision rests on.
        expect(overlayCovers(holeBelow, [{ x: 0, y: 0, w: 0, h: 0 }])).toBe(true);
        expect(measureOverlayRect(null)).toBeNull();
    });
});
