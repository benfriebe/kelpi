/**
 * The modal-presence registry (UI-FIDELITY H1).
 *
 * What it has to get right is not "is there a boolean somewhere": it is that a surface the
 * ASSEMBLY cannot see — a dialog the shell opened, a prompt inside the inspector, a portal menu
 * — is counted for exactly as long as it is painted, and that the count returns to zero
 * afterwards. A count that leaks would park a web pane's page forever; a count that drops early
 * would slice the dialog it was protecting.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRef, useState, type ReactElement } from 'react';

import {
    measureOverlayRect,
    modalPresenceCount,
    overlayCovers,
    overlayPresenceCount,
    registerModal,
    registerOverlay,
    useAnyModalOpen,
    useModalPresence,
    useOverlayPresence,
    useOverlayRects,
    type OverlayRect
} from './index';

afterEach(cleanup);

function Modal({ active = true }: { readonly active?: boolean }): ReactElement {
    useModalPresence(active);
    return <div data-testid="modal" />;
}

/** The assembly's read, published as an attribute so a test can watch it change. */
function Watcher({ children }: { readonly children?: ReactElement | null }): ReactElement {
    const open = useAnyModalOpen();
    return (
        <div data-testid="watcher" data-modal-open={open ? 'true' : 'false'}>
            {children}
        </div>
    );
}

describe('registerModal', () => {
    it('counts up and back down', () => {
        expect(modalPresenceCount()).toBe(0);
        const release = registerModal();
        expect(modalPresenceCount()).toBe(1);
        release();
        expect(modalPresenceCount()).toBe(0);
    });

    it('is idempotent per registration, so a double release cannot go negative', () => {
        const first = registerModal();
        const second = registerModal();
        expect(modalPresenceCount()).toBe(2);
        first();
        first();
        first();
        expect(modalPresenceCount()).toBe(1);
        second();
        expect(modalPresenceCount()).toBe(0);
    });
});

describe('useModalPresence / useAnyModalOpen', () => {
    it('a mounted modal makes the assembly read true, and unmounting hands it back', () => {
        function Host(): ReactElement {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" data-testid="toggle" onClick={() => setOpen((v) => !v)}>
                        toggle
                    </button>
                    <Watcher>{open ? <Modal /> : null}</Watcher>
                </>
            );
        }
        render(<Host />);
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');

        fireEvent.click(screen.getByTestId('toggle'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('true');
        expect(modalPresenceCount()).toBe(1);

        fireEvent.click(screen.getByTestId('toggle'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('`active: false` registers nothing — the ToastStack case, mounted but painting nothing', () => {
        render(
            <Watcher>
                <Modal active={false} />
            </Watcher>
        );
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('two modals at once keep the read true until BOTH are gone', () => {
        function Host(): ReactElement {
            const [count, setCount] = useState(2);
            return (
                <>
                    <button type="button" data-testid="drop" onClick={() => setCount((v) => v - 1)}>
                        drop
                    </button>
                    <Watcher>
                        <>
                            {count > 0 ? <Modal /> : null}
                            {count > 1 ? <Modal /> : null}
                        </>
                    </Watcher>
                </>
            );
        }
        render(<Host />);
        expect(modalPresenceCount()).toBe(2);
        fireEvent.click(screen.getByTestId('drop'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('true');
        fireEvent.click(screen.getByTestId('drop'));
        expect(screen.getByTestId('watcher').dataset['modalOpen']).toBe('false');
        expect(modalPresenceCount()).toBe(0);
    });

    it('unmounting the whole tree releases what it held', () => {
        const view = render(
            <Watcher>
                <Modal />
            </Watcher>
        );
        expect(modalPresenceCount()).toBe(1);
        view.unmount();
        expect(modalPresenceCount()).toBe(0);
    });
});

// ── §N26: the finer half — surfaces that register WHERE they are ────────────────────

/** A box a test can hand to `overlayCovers` without a DOM. */
const rect = (x: number, y: number, w: number, h: number): OverlayRect => ({ x, y, w, h });

describe('overlayCovers (§N26)', () => {
    const hole = rect(400, 100, 500, 700);

    it('is false with nothing registered — an app with no popups parks no pages', () => {
        expect(overlayCovers(hole, [])).toBe(false);
    });

    it('is false for a surface beside the hole: a menu inside the sidebar parks nothing', () => {
        expect(overlayCovers(hole, [rect(100, 130, 190, 160)])).toBe(false);
    });

    it('is true for one that overlaps, however slightly', () => {
        expect(overlayCovers(hole, [rect(210, 130, 191, 160)])).toBe(true);
    });

    it('touching edges do not overlap — a popover flush against the pane is still outside it', () => {
        expect(overlayCovers(hole, [rect(200, 130, 200, 160)])).toBe(false);
    });

    it('an UNMEASURED overlay covers everything — H1 is the fallback, not a narrower guess', () => {
        // The whole safety argument: a zero-area registration means "position unknown", and an
        // unknown position must park exactly as the blunt count did. jsdom is this case.
        expect(overlayCovers(hole, [rect(0, 0, 0, 0)])).toBe(true);
    });

    it('an unlaid-out HOLE is covered too, for the same reason', () => {
        expect(overlayCovers(rect(0, 0, 0, 0), [rect(100, 130, 190, 160)])).toBe(true);
        expect(overlayCovers(null, [rect(100, 130, 190, 160)])).toBe(true);
    });

    it('one overlapping surface out of several is enough', () => {
        expect(overlayCovers(hole, [rect(0, 0, 100, 50), rect(410, 120, 40, 40), rect(0, 900, 10, 10)])).toBe(true);
    });
});

describe('registerOverlay', () => {
    it('publishes a rect, updates it in place, and releases idempotently', () => {
        expect(overlayPresenceCount()).toBe(0);
        const handle = registerOverlay(rect(10, 10, 20, 20));
        expect(overlayPresenceCount()).toBe(1);
        handle.update(rect(30, 30, 40, 40));
        expect(overlayPresenceCount()).toBe(1);
        handle.release();
        handle.release();
        expect(overlayPresenceCount()).toBe(0);
    });

    it('registers unmeasured when handed nothing — the widest answer, not the narrowest', () => {
        const handle = registerOverlay();
        // Read through the same lens the pane uses.
        let seen: readonly OverlayRect[] = [];
        function Probe(): ReactElement {
            seen = useOverlayRects();
            return <div />;
        }
        render(<Probe />);
        expect(seen).toHaveLength(1);
        expect(overlayCovers(rect(400, 100, 500, 700), seen)).toBe(true);
        handle.release();
    });

    it('an update after release does nothing (a late ResizeObserver callback)', () => {
        const handle = registerOverlay(rect(1, 1, 1, 1));
        handle.release();
        handle.update(rect(2, 2, 2, 2));
        expect(overlayPresenceCount()).toBe(0);
    });
});

describe('measureOverlayRect', () => {
    it('is null for nothing to measure', () => {
        expect(measureOverlayRect(null)).toBeNull();
    });

    it('takes the UNION of the panel and its children, so an open submenu counts', () => {
        // The submenu is an absolutely-positioned child hanging off the panel's side: the
        // panel's own box stops at 190px and a pane under the submenu alone would otherwise
        // stay live — N26 again, one level down.
        const panel = document.createElement('div');
        const submenu = document.createElement('div');
        panel.append(submenu);
        panel.getBoundingClientRect = () =>
            ({ left: 100, top: 100, right: 290, bottom: 260, width: 190, height: 160 }) as DOMRect;
        submenu.getBoundingClientRect = () =>
            ({ left: 290, top: 140, right: 470, bottom: 340, width: 180, height: 200 }) as DOMRect;
        expect(measureOverlayRect(panel)).toEqual({ x: 100, y: 100, w: 370, h: 240 });
    });

    it('ignores zero-area children (a collapsed row cannot shrink or widen the surface)', () => {
        const panel = document.createElement('div');
        const empty = document.createElement('div');
        panel.append(empty);
        panel.getBoundingClientRect = () =>
            ({ left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }) as DOMRect;
        empty.getBoundingClientRect = () =>
            ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
        expect(measureOverlayRect(panel)).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    });

    it('is null when nothing has been laid out — the caller then registers "unknown"', () => {
        const panel = document.createElement('div');
        panel.getBoundingClientRect = () =>
            ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
        expect(measureOverlayRect(panel)).toBeNull();
    });
});

describe('useOverlayPresence', () => {
    function Surface({
        open,
        box
    }: {
        readonly open: boolean;
        readonly box?: OverlayRect | undefined;
    }): ReactElement {
        const ref = useRef<HTMLDivElement | null>(null);
        useOverlayPresence(ref, open);
        return (
            <div
                ref={(node) => {
                    ref.current = node;
                    if (node !== null && box !== undefined) {
                        node.getBoundingClientRect = () =>
                            ({
                                left: box.x,
                                top: box.y,
                                right: box.x + box.w,
                                bottom: box.y + box.h,
                                width: box.w,
                                height: box.h
                            }) as DOMRect;
                    }
                }}
                data-testid="surface"
            />
        );
    }

    function Host({
        open,
        box
    }: {
        readonly open: boolean;
        readonly box?: OverlayRect | undefined;
    }): ReactElement {
        const rects = useOverlayRects();
        return (
            <div data-testid="host" data-count={String(rects.length)} data-covered={String(overlayCovers(rect(400, 100, 500, 700), rects))}>
                <Surface open={open} box={box} />
            </div>
        );
    }

    it('registers while active and releases when it closes', () => {
        const view = render(<Host open={false} />);
        expect(screen.getByTestId('host').dataset['count']).toBe('0');

        view.rerender(<Host open />);
        expect(screen.getByTestId('host').dataset['count']).toBe('1');

        view.rerender(<Host open={false} />);
        expect(screen.getByTestId('host').dataset['count']).toBe('0');
        expect(overlayPresenceCount()).toBe(0);
    });

    it('a measured surface beside the pane leaves it alone; one over it does not', () => {
        const view = render(<Host open box={rect(100, 130, 190, 160)} />);
        expect(screen.getByTestId('host').dataset['covered']).toBe('false');

        view.rerender(<Host open box={rect(410, 130, 190, 160)} />);
        expect(screen.getByTestId('host').dataset['covered']).toBe('true');
    });

    it('unmounting mid-flight releases the registration (no page parked forever)', () => {
        const view = render(<Host open box={rect(410, 130, 190, 160)} />);
        expect(overlayPresenceCount()).toBe(1);
        view.unmount();
        expect(overlayPresenceCount()).toBe(0);
    });
});
