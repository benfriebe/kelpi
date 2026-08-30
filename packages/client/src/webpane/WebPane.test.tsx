/**
 * The web pane's chrome: the verbs its controls send, and the geometry it reports.
 *
 * These two halves are the whole component. The chrome must speak the same vocabulary as the
 * CLI (a URL submit IS `web-navigate`), and the page-area rect must be reported on the events
 * that move it — appearing, moving, switching tab, disappearing — because that rect is the only
 * thing telling the Electron shell where to put a real browser view.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { registerOverlay, type OverlayHandle, type OverlayRect } from '../chrome/modal-presence';
import type { CommandReply } from '../connection';
import { FOCUS_RING_WIDTH } from '../grid/FocusRing';
import { insetHoleForFocusRing, WebPane, type WebPaneTab } from './WebPane';
import type { WebPaneCommands } from './commands';
import type { GeometryRect, GeometryReport } from './geometry';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const TAB1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const TAB2 = 'EEEEEEEE-0000-4000-8000-000000000002';

interface Recorded {
    readonly verb: string;
    readonly args: readonly unknown[];
}

function fakeCommands(): { commands: WebPaneCommands; sent: Recorded[] } {
    const sent: Recorded[] = [];
    const record =
        (verb: string) =>
        (...args: unknown[]): Promise<CommandReply> => {
            sent.push({ verb, args });
            return Promise.resolve({ ok: true });
        };
    return {
        sent,
        commands: {
            navigate: record('navigate'),
            back: record('back'),
            forward: record('forward'),
            reload: record('reload'),
            newTab: record('newTab'),
            selectTab: record('selectTab'),
            closeTab: record('closeTab'),
            toggleDevTools: record('toggleDevTools'),
            // WEB-043's keyboard handoff fires on the unfocused→focused transition, so any test
            // that focuses a pane goes through it.
            focusView: record('focusView')
        } as unknown as WebPaneCommands
    };
}

const TABS: readonly WebPaneTab[] = [
    { id: TAB1, url: 'https://example.com/', title: 'Example' },
    { id: TAB2, url: 'https://second.test/', title: 'Second' }
];

/** jsdom has no layout, so the component's measurement is injected. */
function fixedRect(rect: GeometryRect): (element: HTMLElement) => GeometryRect {
    return () => rect;
}

const RECT: GeometryRect = { x: 12, y: 40, w: 900, h: 500 };

/**
 * §N27a — the rect the client REPORTS for a measured hole.
 *
 * The page hole permanently reserves the focus ring's gutter on left, right and bottom, so this
 * is what the shell is told **whether or not the pane is focused**. Focus decides what is
 * painted in that gutter (the ring, or the pane background); it never moves a pixel of geometry.
 *
 * Written out by hand rather than by calling `insetHoleForFocusRing`, so a test that expects a
 * ringed rect cannot be satisfied by the function agreeing with itself.
 */
function withRingGutter(rect: GeometryRect): GeometryRect {
    return {
        x: rect.x + FOCUS_RING_WIDTH,
        y: rect.y,
        w: rect.w - FOCUS_RING_WIDTH * 2,
        h: rect.h - FOCUS_RING_WIDTH
    };
}

const RINGED = withRingGutter(RECT);

afterEach(() => {
    cleanup();
});

describe('chrome commands', () => {
    it('submitting the URL bar navigates with the raw text (the daemon normalizes)', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);

        const input = screen.getByTestId(`web-url-${PANE}`);
        expect((input as HTMLInputElement).value).toBe('https://example.com/');
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'example.org' } });
        fireEvent.submit(input);

        expect(sent).toEqual([{ verb: 'navigate', args: [PANE, 'example.org'] }]);
    });

    it('parks an incoming URL while the user is mid-edit, and applies it on blur (§16.2)', () => {
        const { commands } = fakeCommands();
        const view = render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;

        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'half-typed-add' } });
        // The page redirects under the draft: the field must NOT jump.
        const moved: readonly WebPaneTab[] = [{ id: TAB1, url: 'https://example.com/moved', title: 'Moved' }];
        view.rerender(<WebPane paneID={PANE} tabs={moved} activeTabID={TAB1} commands={commands} />);
        expect(input.value).toBe('half-typed-add');

        // Abandoning the edit adopts what the page actually did.
        fireEvent.blur(input);
        expect(input.value).toBe('https://example.com/moved');
    });

    it('follows the live URL while the bar is merely focused, not edited', () => {
        const { commands } = fakeCommands();
        const view = render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        fireEvent.focus(input);
        const moved: readonly WebPaneTab[] = [{ id: TAB1, url: 'https://example.com/next', title: 'Next' }];
        view.rerender(<WebPane paneID={PANE} tabs={moved} activeTabID={TAB1} commands={commands} />);
        expect(input.value).toBe('https://example.com/next');
    });

    it('does not submit an empty field', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={[]} activeTabID={null} commands={commands} />);
        fireEvent.submit(screen.getByTestId(`web-url-${PANE}`));
        expect(sent).toEqual([]);
    });

    it('wires back / forward / reload / new tab', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        fireEvent.click(screen.getByTestId(`web-back-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-forward-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-reload-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-new-tab-${PANE}`));
        expect(sent.map((entry) => entry.verb)).toEqual(['back', 'forward', 'reload', 'newTab']);
    });

    /**
     * §M34 — the reload tooltip has always promised "⌥-click bypasses the cache", and
     * `commands.reload(paneID, hard?)` has always supported it; the handler took no event, so
     * the advertised gesture did nothing at all.
     */
    it('reloads hard on an ⌥-click and soft on a plain one (M34)', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        const reload = screen.getByTestId(`web-reload-${PANE}`);
        expect(reload.getAttribute('title')).toContain('⌥-click bypasses the cache');

        fireEvent.click(reload);
        expect(sent.at(-1)).toEqual({ verb: 'reload', args: [PANE, false] });
        fireEvent.click(reload, { altKey: true });
        expect(sent.at(-1)).toEqual({ verb: 'reload', args: [PANE, true] });
    });

    /**
     * §M31 — `WebPaneChrome.swift:61-75` is one `VStack { navAndURLBar; tabStrip }` on one
     * `headerBackground`, with a SINGLE `Divider()` overlaid at the bottom of the whole block.
     * The port drew a rule under the nav row too, so every multi-tab pane got a seam between
     * the URL bar and the tab strip that the shipped app never has.
     */
    it('draws one divider, under the whole chrome block, never between the rows (M31)', () => {
        const { commands } = fakeCommands();
        const view = render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);

        const block = screen.getByTestId(`web-chrome-${PANE}`);
        const strip = screen.getByTestId(`web-tabs-${PANE}`);
        const nav = strip.previousElementSibling as HTMLElement;

        expect(block.style.borderBottom).not.toBe('');
        expect(nav.style.borderBottom).toBe('');
        expect(strip.style.borderBottom).toBe('');
        // Both rows share the block's one unbroken fill.
        expect(nav.style.background).toBe(strip.style.background);

        // …and a single-tab pane still gets the block's rule, because it is the block's.
        view.rerender(
            <WebPane paneID={PANE} tabs={[TABS[0] as WebPaneTab]} activeTabID={TAB1} commands={commands} />
        );
        expect(screen.getByTestId(`web-chrome-${PANE}`).style.borderBottom).not.toBe('');
    });

    it('offers dev tools only where they can actually open', () => {
        const { commands, sent } = fakeCommands();
        const view = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} embedded={false} />
        );
        expect(screen.getByTestId(`web-devtools-${PANE}`)).toHaveProperty('disabled', true);

        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={fixedRect(RECT)}
            />
        );
        fireEvent.click(screen.getByTestId(`web-devtools-${PANE}`));
        expect(sent).toEqual([{ verb: 'toggleDevTools', args: [PANE, TAB1] }]);
    });
});

describe('tab strip', () => {
    it('renders the store’s tabs, marks the active one, and drives select/close', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB2} commands={commands} />);

        const strip = screen.getByTestId(`web-tabs-${PANE}`);
        expect(strip.textContent).toContain('Example');
        expect(strip.textContent).toContain('Second');
        expect(screen.getByTestId(`web-tab-${TAB2}`).getAttribute('data-active')).toBe('true');
        expect(screen.getByTestId(`web-tab-${TAB1}`).getAttribute('data-active')).toBe('false');

        fireEvent.click(screen.getByTestId(`web-tab-select-${TAB1}`));
        fireEvent.click(screen.getByTestId(`web-tab-close-${TAB2}`));
        expect(sent).toEqual([
            { verb: 'selectTab', args: [PANE, TAB1] },
            { verb: 'closeTab', args: [PANE, TAB2] }
        ]);
    });

    it('hides the strip for a single tab (§16.4) and shows the empty state with none', () => {
        const { commands } = fakeCommands();
        const view = render(
            <WebPane paneID={PANE} tabs={[TABS[0] as WebPaneTab]} activeTabID={TAB1} commands={commands} />
        );
        expect(screen.queryByTestId(`web-tabs-${PANE}`)).toBeNull();

        view.rerender(<WebPane paneID={PANE} tabs={[]} activeTabID={null} commands={commands} />);
        expect(screen.getByTestId(`web-empty-${PANE}`).textContent).toContain('New web pane');
    });

    /**
     * §M33 — `WebPaneView.swift:226-239` is a bare centred stack: a 32 pt tertiary globe over
     * "New web pane" over "Type a URL above and press Return". The port had lost the glyph
     * entirely and wrapped the two strings in a bordered card, which turned the quietest screen
     * in the app into a floating panel.
     */
    it('shows the empty state as a bare stack under a 32 px globe (M33)', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={[]} activeTabID={null} commands={commands} />);

        const empty = screen.getByTestId(`web-empty-${PANE}`);
        const globe = empty.querySelector('[data-icon="globe"]');
        expect(globe).not.toBeNull();
        expect(globe?.getAttribute('width')).toBe('32');
        expect(empty.textContent).toContain('New web pane');
        expect(empty.textContent).toContain('Type a URL above and press Return');

        // No card: no border and no surface fill of its own.
        expect((empty as HTMLElement).style.border).toBe('');
        expect((empty as HTMLElement).style.background).toBe('');
        expect(empty.className).not.toContain('rounded');
    });

    it('falls back to tabs[0] when activeTabID is stale (§17.2)', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID="gone" commands={commands} />);
        expect(screen.getByTestId(`web-tab-${TAB1}`).getAttribute('data-active')).toBe('true');
    });
});

describe('the page area', () => {
    it('shows an "open in the app" card in a browser, and nothing when embedded', () => {
        const { commands } = fakeCommands();
        const view = render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        expect(screen.getByTestId(`web-external-${PANE}`).textContent).toContain('Open in the Kelpi app');

        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={fixedRect(RECT)}
            />
        );
        // The native view covers this box exactly; anything drawn here would flash under it.
        expect(screen.queryByTestId(`web-external-${PANE}`)).toBeNull();
        expect(screen.getByTestId(`web-page-${PANE}`)).toBeTruthy();
    });
});

describe('geometry reporting', () => {
    function mount(
        props: {
            visible?: boolean;
            embedded?: boolean;
            rect?: GeometryRect;
            tabs?: readonly WebPaneTab[];
            activeTabID?: string | null;
            focused?: boolean;
        } = {}
    ) {
        const { commands } = fakeCommands();
        const reports: GeometryReport[] = [];
        const hidden: string[] = [];
        const element = (
            <WebPane
                paneID={PANE}
                tabs={props.tabs ?? TABS}
                activeTabID={props.activeTabID ?? TAB1}
                commands={commands}
                embedded={props.embedded ?? true}
                visible={props.visible ?? true}
                focused={props.focused ?? false}
                measure={fixedRect(props.rect ?? RECT)}
                devicePixelRatio={2}
                onGeometry={(report) => reports.push(report)}
                onHidden={(paneID) => hidden.push(paneID)}
            />
        );
        const view = render(element);
        return { view, reports, hidden, commands };
    }

    it('reports the page-area rect on mount', () => {
        const h = mount();
        // §N27a: the ring gutter is reserved on mount, unfocused — it is not a focus effect.
        expect(h.reports).toEqual([
            { paneID: PANE, tabID: TAB1, rect: RINGED, visible: true, devicePixelRatio: 2 }
        ]);
    });

    describe('§N27 — the focus ring needs the three edges the hole shares with it', () => {
        /** Re-render the mounted pane with a different focus state and nothing else changed. */
        const refocus = (h: ReturnType<typeof mount>, focused: boolean): void => {
            act(() => {
                h.view.rerender(
                    <WebPane
                        paneID={PANE}
                        tabs={TABS}
                        activeTabID={TAB1}
                        commands={h.commands}
                        embedded={true}
                        visible={true}
                        focused={focused}
                        measure={fixedRect(RECT)}
                        devicePixelRatio={2}
                        onGeometry={(report) => h.reports.push(report)}
                        onHidden={(paneID) => h.hidden.push(paneID)}
                    />
                );
            });
        };

        it('insets a FOCUSED pane’s hole on left, right and bottom, never the top', () => {
            const h = mount({ focused: true });
            // The header already holds the top clear, so `y` must not move — shifting it down
            // would put a 2 px band of pane background between the chrome and the page.
            expect(h.reports.at(-1)?.rect).toEqual(RINGED);
        });

        /*
         * §N27a — the assertion this pair replaces read "leaves an UNFOCUSED pane's hole FLUSH,
         * so the cost is paid only where the ring is". That arithmetic was the regression: the
         * two rects differed, so every focus change resized a live native view by 4×2 px and the
         * page visibly reflowed under the owner's click. The gutter is reserved permanently now,
         * and the unfocused rect is the focused one.
         */
        it('insets an UNFOCUSED pane’s hole by exactly the same amount — the gutter is constant', () => {
            const h = mount({ focused: false });
            expect(h.reports.at(-1)?.rect).toEqual(RINGED);
        });

        it('reports a BYTE-IDENTICAL rect across a focus change — zero geometry moves (§N27a)', () => {
            const h = mount({ focused: false });
            const unfocused = h.reports.at(-1)?.rect;
            refocus(h, true);
            const focused = h.reports.at(-1)?.rect;
            refocus(h, false);
            const unfocusedAgain = h.reports.at(-1)?.rect;

            // Field by field, not merely "equal": this is the regression's own shape.
            expect(focused).toEqual(unfocused);
            expect(unfocusedAgain).toEqual(unfocused);
            expect(new Set(h.reports.map((report) => JSON.stringify(report.rect))).size).toBe(1);
            // …and the one rect they all share is the ringed one, so the ring still has its gutter.
            expect(unfocused).toEqual(RINGED);
        });

        it('never asks the shell to move the view on focus alone (no report differs)', () => {
            const h = mount({ focused: false });
            const before = h.reports.length;
            const last = h.reports.at(-1);
            refocus(h, true);
            /*
             * Re-publishing is fine and expected — the layout effect has no dep list, and the
             * host drops identical reports. Publishing a DIFFERENT report is the defect, so the
             * comparison is the whole object (tab, visibility and dpr as well as the rect): what
             * the shell acts on is the report, not the rect alone.
             */
            expect(h.reports.length).toBeGreaterThan(before);
            for (const report of h.reports.slice(before)) {
                expect(report).toEqual(last);
            }
        });

        it('shrinks the hole by exactly the ring width — the ring is 2 px of a 2 px strip', () => {
            const ringed = insetHoleForFocusRing(RECT);
            // Left/right/bottom each give up exactly `FOCUS_RING_WIDTH`; nothing else moves.
            expect(ringed.x - RECT.x).toBe(FOCUS_RING_WIDTH);
            expect(RECT.x + RECT.w - (ringed.x + ringed.w)).toBe(FOCUS_RING_WIDTH);
            expect(RECT.y + RECT.h - (ringed.y + ringed.h)).toBe(FOCUS_RING_WIDTH);
            expect(ringed.y).toBe(RECT.y);
        });

        it('refuses to inset a hole too small to give the strips up', () => {
            // A zero- or negative-sized native view is a worse defect than a clipped ring.
            const tiny: GeometryRect = { x: 0, y: 0, w: FOCUS_RING_WIDTH * 2, h: FOCUS_RING_WIDTH };
            expect(insetHoleForFocusRing(tiny)).toEqual(tiny);
            const thin: GeometryRect = { x: 0, y: 0, w: 3, h: 100 };
            expect(insetHoleForFocusRing(thin).w).toBe(3);
        });

        /*
         * The gutter composes with the surfaces that already shrink the hole — the batch pickup
         * panel and the find bar are SIBLING ROWS, not overlays (that is the whole reason
         * `BatchPanel` is a row), so they change the measured hole and the single inset is
         * applied downstream of the measurement. There is nothing focus-dependent left for them
         * to interact with; a shorter hole simply gets the same constant gutter.
         */
        it('applies the same gutter to a hole a sibling row has already shrunk', () => {
            const withPanel: GeometryRect = { x: RECT.x, y: RECT.y, w: RECT.w, h: RECT.h - 120 };
            expect(insetHoleForFocusRing(withPanel)).toEqual(withRingGutter(withPanel));
        });

        /*
         * §N27a — was "is the identity when the pane is not focused, whatever the rect". There is
         * no focus argument left to be the identity for: the only identity is a zero-width ring.
         */
        it('is the identity only for a zero-width ring — never for a focus state', () => {
            expect(insetHoleForFocusRing(RECT, 0)).toBe(RECT);
            expect(insetHoleForFocusRing(RECT, -1)).toBe(RECT);
            // The function cannot see focus at all, which is what makes the constancy structural
            // rather than a convention two call sites have to keep.
            expect(insetHoleForFocusRing.length).toBe(1);
        });
    });

    it('re-reports when the pane moves', () => {
        const h = mount();
        const moved: GeometryRect = { x: 12, y: 40, w: 500, h: 500 };
        act(() => {
            h.view.rerender(
                <WebPane
                    paneID={PANE}
                    tabs={TABS}
                    activeTabID={TAB1}
                    commands={h.commands}
                    embedded={true}
                    visible={true}
                    measure={fixedRect(moved)}
                    devicePixelRatio={2}
                    onGeometry={(report) => h.reports.push(report)}
                    onHidden={(paneID) => h.hidden.push(paneID)}
                />
            );
        });
        expect(h.reports.at(-1)?.rect).toEqual(withRingGutter(moved));
    });

    it('reports the active tab so a switch re-targets the view', () => {
        const h = mount();
        act(() => {
            h.view.rerender(
                <WebPane
                    paneID={PANE}
                    tabs={TABS}
                    activeTabID={TAB2}
                    commands={h.commands}
                    embedded={true}
                    visible={true}
                    measure={fixedRect(RECT)}
                    devicePixelRatio={2}
                    onGeometry={(report) => h.reports.push(report)}
                    onHidden={(paneID) => h.hidden.push(paneID)}
                />
            );
        });
        expect(h.reports.at(-1)?.tabID).toBe(TAB2);
    });

    it('asks for the view back when the pane is hidden, and on unmount', () => {
        const h = mount({ visible: false });
        // Hidden panes report nothing but must take the view back.
        expect(h.reports).toEqual([]);
        expect(h.hidden).toEqual([PANE]);

        const shown = mount();
        expect(shown.reports).toHaveLength(1);
        act(() => {
            shown.view.unmount();
        });
        expect(shown.hidden).toEqual([PANE]);
    });

    it('never reports from a plain browser client (there is nothing to place)', () => {
        const h = mount({ embedded: false });
        expect(h.reports).toEqual([]);
        expect(h.hidden).toEqual([]);
    });

    /**
     * §N26 — a menu or popover drawn over the page area.
     *
     * The page is a native `WebContentsView` composited above this document, so a floating DOM
     * surface over it is simply not visible. H1 answered that for modals with a whole-window
     * park; this is the per-pane half: a surface registers WHERE it is
     * (`chrome/modal-presence.ts`) and this pane parks only when that box is over ITS hole.
     */
    describe('a floating surface over the page area (§N26)', () => {
        /**
         * Registering is a store write outside React, so it goes through `act` — and every
         * handle is tracked, because one leaked registration would silently park the pane in
         * every test after it.
         */
        const open = (rect: OverlayRect | null): OverlayHandle => {
            let handle!: OverlayHandle;
            act(() => {
                handle = registerOverlay(rect);
            });
            live.push(handle);
            return handle;
        };
        const close = (handle: OverlayHandle): void => {
            act(() => {
                handle.release();
            });
        };
        const live: OverlayHandle[] = [];
        afterEach(() => {
            for (const handle of live.splice(0)) handle.release();
        });

        /** The hide re-publishes on each render while it holds; the reporter upstream dedupes. */
        const hiddenOnce = (hidden: readonly string[]): readonly string[] => [...new Set(hidden)];

        it('parks the view — the page reports itself hidden while the surface is up', () => {
            const h = mount();
            expect(h.reports).toHaveLength(1);
            open({ x: 100, y: 100, w: 200, h: 200 });
            expect(hiddenOnce(h.hidden)).toEqual([PANE]);
            const hole = screen.getByTestId(`web-page-${PANE}`);
            expect(hole.dataset['visible']).toBe('false');
            expect(hole.dataset['overlayCovered']).toBe('true');
        });

        it('hands it straight back when the surface closes, at the same rect (no flash, §N24)', () => {
            const h = mount();
            const overlay = open({ x: 100, y: 100, w: 200, h: 200 });
            expect(hiddenOnce(h.hidden)).toEqual([PANE]);
            close(overlay);
            expect(screen.getByTestId(`web-page-${PANE}`).dataset['visible']).toBe('true');
            // §N27a: the restored rect carries the ring gutter, and it is the SAME rect the pane
            // was parked from — a park/restore round-trip cannot be where the constancy is lost.
            expect(h.reports.at(-1)).toEqual({
                paneID: PANE,
                tabID: TAB1,
                rect: RINGED,
                visible: true,
                devicePixelRatio: 2
            });
            expect(h.reports.at(-1)?.rect).toEqual(h.reports[0]?.rect);
        });

        /**
         * §N26 × §N27a — park a FOCUSED pane, restore it, and the bounds must be the ones it had
         * before. The previous rule made this the sharpest trap in the codebase: the restore had
         * to recompute the placement from the pane's focus state, so a focus change while the
         * surface was up silently invalidated the pre-park number. With a constant gutter the
         * question disappears — there is only ever one rect for a given hole.
         */
        it('round-trips a FOCUSED pane through park/restore at the identical rect', () => {
            const h = mount({ focused: true });
            const parked = h.reports.at(-1)?.rect;
            const overlay = open({ x: 100, y: 100, w: 200, h: 200 });
            expect(hiddenOnce(h.hidden)).toEqual([PANE]);
            close(overlay);
            expect(h.reports.at(-1)?.rect).toEqual(parked);
            expect(h.reports.at(-1)?.rect).toEqual(RINGED);
        });

        it('a surface BESIDE the pane leaves it placed — the whole point of the rect', () => {
            // RECT is x 12…912, y 40…540; this box is past its right edge — a menu in a sidebar
            // beside a web pane, or a popover over the OTHER pane of a split.
            const h = mount();
            open({ x: 950, y: 100, w: 200, h: 200 });
            expect(h.hidden).toEqual([]);
            expect(screen.getByTestId(`web-page-${PANE}`).dataset['visible']).toBe('true');
        });

        it('an UNMEASURED surface parks it, exactly as the blunt H1 count did', () => {
            const h = mount();
            open(null);
            expect(hiddenOnce(h.hidden)).toEqual([PANE]);
        });

        it('is answered by a browser client too, even though it places nothing', () => {
            // `data-visible` is one truth about the document, not a property of the transport.
            mount({ embedded: false });
            open({ x: 100, y: 100, w: 200, h: 200 });
            expect(screen.getByTestId(`web-page-${PANE}`).dataset['visible']).toBe('false');
        });
    });
});
