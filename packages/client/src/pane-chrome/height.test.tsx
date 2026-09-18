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
    usePaneChromeParking,
    usePaneChromeScope,
    usePaneChromeWithdrawal
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

    /**
     * Three inputs, three answers, and the same answers `contract.ts` clamps to. The pair used to
     * disagree: a negative number was refused here while the clamp documented it as 0, so whether
     * -40 meant "nothing" or "keep what you had" depended on which of the two you read.
     */
    it('refuses a non-height, floors a negative one at zero, and rounds a fractional one', () => {
        setPaneChromeHeight('p4', 60);
        // Non-finite is not a height: there is nothing to clamp it to, so the band stands.
        setPaneChromeHeight('p4', Number.NaN);
        expect(paneChromeDeclaration('p4')).toBe(60);
        setPaneChromeHeight('p4', Number.POSITIVE_INFINITY);
        expect(paneChromeDeclaration('p4')).toBe(60);
        setPaneChromeHeight('p4', Number.NEGATIVE_INFINITY);
        expect(paneChromeDeclaration('p4')).toBe(60);
        // A negative band is no band, which is a legal band and what the clamp already said.
        setPaneChromeHeight('p4', -40);
        expect(paneChromeDeclaration('p4')).toBe(0);
        expect(paneChromeBand(new Map([['p4', 0]]), 'p4', 800)).toBe(0);
        setPaneChromeHeight('p4', 47.6);
        expect(paneChromeDeclaration('p4')).toBe(48);
        // A refused value on a pane that never declared leaves the store empty, not at 0.
        setPaneChromeHeight('p5', Number.NaN);
        expect(paneChromeDeclaration('p5')).toBeNull();
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

    /**
     * A declaration outliving its pane is not a leaked map entry, it is a resize: the daemon can
     * hand a new pane the id a closed one had, and a workspace switched away from and back applies
     * the stale band on the first frame, before a presenter could re-declare.
     */
    it('withdraws a pane band when that pane`s chrome unmounts', () => {
        function Pane({ id }: { readonly id: string }): ReactElement {
            usePaneChromeWithdrawal(id);
            return <span data-testid={`pane-${id}`} />;
        }
        const view = render(<Pane id="p1" />);
        setPaneChromeHeight('p1', 96);
        expect(paneChromeDeclaration('p1')).toBe(96);
        view.rerender(<span />);
        expect(paneChromeDeclaration('p1')).toBeNull();
        expect(paneChromeDeclarationCount()).toBe(0);
    });

    it('hands every band back when the grid changes the workspace it is showing', () => {
        function Grid({ workspace }: { readonly workspace: string | undefined }): ReactElement {
            usePaneChromeScope(workspace);
            return <span data-testid="grid" />;
        }
        const view = render(<Grid workspace="ws-1" />);
        setPaneChromeHeight('p1', 96);
        setPaneChromeHeight('p2', 48);
        expect(paneChromeDeclarationCount()).toBe(2);
        view.rerender(<Grid workspace="ws-2" />);
        expect(paneChromeDeclarationCount()).toBe(0);
        // And when the grid itself goes (a disconnect banner, a remote workspace selected).
        setPaneChromeHeight('p3', 96);
        view.unmount();
        expect(paneChromeDeclarationCount()).toBe(0);
        // A host with no such notion opts out and the store is left alone.
        const opted = render(<Grid workspace={undefined} />);
        setPaneChromeHeight('p4', 96);
        opted.rerender(<Grid workspace={undefined} />);
        expect(paneChromeDeclaration('p4')).toBe(96);
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

function Band({
    kind,
    height,
    visible = true
}: {
    readonly kind: 'web' | 'shell';
    readonly height: number;
    readonly visible?: boolean;
}): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    usePaneChromeParking(ref, kind, height, visible);
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

    /**
     * The zoomed case. `PaneGrid` keeps a hidden pane mounted at its last rect, so the invisible
     * band is a real box to the registry, and `overlayCovers` reads boxes rather than elements:
     * the zoomed-out pane's band lies inside the zoomed pane's page hole and would park it.
     */
    it('registers nothing for a hidden pane, so a zoomed-out band cannot park the zoomed page', () => {
        const view = render(<Band kind="web" height={96} visible={false} />);
        expect(overlayPresenceCount()).toBe(0);
        // Zooming back out makes it visible again, and only then does it enrol.
        view.rerender(<Band kind="web" height={96} visible />);
        expect(overlayPresenceCount()).toBe(1);
        view.rerender(<Band kind="web" height={96} visible={false} />);
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
