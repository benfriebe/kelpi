/**
 * The chrome polish the first burn-down left open: WEB-018's hover-reveal close + gradient mask,
 * WEB-032's dimmed nav buttons and stop glyph, WEB-033/WEB-034's loading strip, WEB-039's
 * pending-count badge, WEB-040's private-mode glyph, WEB-043's focus handoff and WEB-002's
 * blank-URL focus rule — plus §L77, which is the *absence* of a gesture and therefore needs its
 * own guard.
 *
 * All of it is client-side and therefore assertable here — the *page* half of a web pane needs a
 * real browser (the audit drives it), but every rule below is DOM the client owns.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection';
import { WebPane, type WebPaneTab } from './WebPane';
import type { WebPaneCommands } from './commands';
import { navStateKey, useBlankWebPaneURLFocus, type BlankURLTarget } from './hooks';
import { parseNavStateMessage, type WebBatchSession } from './state';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const TAB1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const TAB2 = 'EEEEEEEE-0000-4000-8000-000000000002';
const TAB3 = 'EEEEEEEE-0000-4000-8000-000000000003';

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
            stop: record('stop'),
            focusView: record('focusView'),
            newTab: record('newTab'),
            selectTab: record('selectTab'),
            closeTab: record('closeTab'),
            reorderTabs: record('reorderTabs'),
            toggleDevTools: record('toggleDevTools'),
            batchToggle: record('batchToggle')
        } as unknown as WebPaneCommands
    };
}

const TABS: readonly WebPaneTab[] = [
    { id: TAB1, url: 'https://example.com/', title: 'Example' },
    { id: TAB2, url: 'https://second.test/', title: 'Second' },
    { id: TAB3, url: 'https://third.test/', title: 'Third' }
];

/** jsdom has no layout: give each pill the box the strip would have measured. */
function layOutStrip(width = 100): void {
    let left = 0;
    for (const tab of TABS) {
        const element = screen.queryByTestId(`web-tab-${tab.id}`);
        if (element === null) continue;
        const box = { left, right: left + width, top: 0, bottom: 24, width, height: 24, x: left, y: 0 };
        element.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
        left += width;
    }
}

/**
 * A pointer press with real coordinates.
 *
 * `fireEvent.pointerDown` cannot be used: jsdom has no `PointerEvent`, so testing-library
 * synthesises one that drops every `MouseEvent` field — `clientX` arrives `undefined` and the
 * drag has nothing to measure. Dispatching a real `MouseEvent` under the pointer event's NAME
 * is what a browser (and CDP's `Input.dispatchMouseEvent`, which the audit uses) actually
 * delivers.
 */
function pressAt(element: HTMLElement, clientX: number): void {
    fireEvent(element, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX }));
}

function pointerDragTab(tabID: string, fromX: number, toX: number): void {
    pressAt(screen.getByTestId(`web-tab-${tabID}`), fromX);
    act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: toX }));
        window.dispatchEvent(new MouseEvent('pointerup', { clientX: toX }));
    });
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

// ── L77 ─────────────────────────────────────────────────────────────────────────────

/**
 * §L77 — the strip has NO drag gesture, because the shipped app's has none.
 *
 * `WebPaneChrome.swift:311-377` gives a pill one gesture, `.onTapGesture(perform: onSelect)`, and
 * `WorkspaceFeature.swift:1050-1062`'s `webPaneTabReorder` action has no call site anywhere in
 * the app — no view, no menu, no socket command reaches it (`grep -rn webPaneTabReorder Nex/`
 * returns the case and its declaration, nothing else). So the port's pointer-drag was invented
 * here, and it is gone along with `reorder.ts`, the ghosted pill and the `grabbing` cursor.
 *
 * The daemon's `web-tab-reorder` command and its not-a-permutation guard are untouched: a client
 * can still move tabs on the wire, the strip simply is not one of the ways.
 */
describe('the tab strip has no drag gesture (L77)', () => {
    it('a pointer drag across the strip sends nothing and moves nothing', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        layOutStrip();

        pointerDragTab(TAB1, 50, 250);

        expect(sent).toEqual([]);
        const order = Array.from(
            screen.getByTestId(`web-tabs-${PANE}`).querySelectorAll('[data-testid^="web-tab-"]')
        )
            .map((element) => element.getAttribute('data-testid'))
            .filter((id): id is string => id !== null && !id.includes('select') && !id.includes('close'));
        expect(order).toEqual([`web-tab-${TAB1}`, `web-tab-${TAB2}`, `web-tab-${TAB3}`]);
    });

    it('and no pill ever reports a drag state, a ghost opacity or a grabbing cursor', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        layOutStrip();
        pressAt(screen.getByTestId(`web-tab-${TAB1}`), 50);
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: 250 }));
        });
        const pill = screen.getByTestId(`web-tab-${TAB1}`);
        expect(pill.getAttribute('data-dragging')).toBeNull();
        expect(pill.style.opacity).toBe('');
        expect(pill.style.cursor).toBe('');
        act(() => {
            window.dispatchEvent(new MouseEvent('pointerup', { clientX: 250 }));
        });
    });
});

// ── WEB-018 ─────────────────────────────────────────────────────────────────────────

describe('tab pills (WEB-018)', () => {
    it('reveals the close button on hover and on the active pill, and never otherwise', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);

        expect(screen.queryByTestId(`web-tab-close-${TAB1}`)).not.toBeNull(); // active
        expect(screen.queryByTestId(`web-tab-close-${TAB2}`)).toBeNull(); // idle

        fireEvent.pointerEnter(screen.getByTestId(`web-tab-${TAB2}`));
        expect(screen.queryByTestId(`web-tab-close-${TAB2}`)).not.toBeNull();
        fireEvent.pointerLeave(screen.getByTestId(`web-tab-${TAB2}`));
        expect(screen.queryByTestId(`web-tab-close-${TAB2}`)).toBeNull();
    });

    it('masks the label under the close button so the pill does not resize on hover', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        const idle = screen.getByTestId(`web-tab-select-${TAB2}`);
        expect(idle.style.getPropertyValue('mask-image')).toBe('');

        fireEvent.pointerEnter(screen.getByTestId(`web-tab-${TAB2}`));
        const hovered = screen.getByTestId(`web-tab-select-${TAB2}`);
        expect(hovered.style.getPropertyValue('mask-image')).toContain('linear-gradient');
        expect(hovered.style.getPropertyValue('mask-image')).toContain('transparent 100%');
    });

    it('the close ✕ closes the tab and never starts a drag', () => {
        const { commands, sent } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        layOutStrip();
        const close = screen.getByTestId(`web-tab-close-${TAB1}`);
        pressAt(close, 90);
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: 250 }));
            window.dispatchEvent(new MouseEvent('pointerup', { clientX: 250 }));
        });
        fireEvent.click(close);
        expect(sent).toEqual([{ verb: 'closeTab', args: [PANE, TAB1] }]);
    });
});

// ── WEB-032 / WEB-033 / WEB-034 ─────────────────────────────────────────────────────

describe('the loading strip and the nav buttons (WEB-032/033/034)', () => {
    it('dims back/forward from the host’s real history report, without hiding them', () => {
        const { commands } = fakeCommands();
        const view = render(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                canGoBack={false}
                canGoForward={false}
            />
        );
        expect(screen.getByTestId(`web-back-${PANE}`)).toHaveProperty('disabled', true);
        expect(screen.getByTestId(`web-forward-${PANE}`)).toHaveProperty('disabled', true);

        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                canGoBack={true}
                canGoForward={false}
            />
        );
        expect(screen.getByTestId(`web-back-${PANE}`)).toHaveProperty('disabled', false);
        // Still in the row — a control that vanishes reflows the chrome (§16.1).
        expect(screen.getByTestId(`web-forward-${PANE}`)).not.toBeNull();
    });

    it('swaps the reload glyph for a stop while loading, and the click stops the load', () => {
        const { commands, sent } = fakeCommands();
        render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} loading={true} />
        );
        const button = screen.getByTestId(`web-reload-${PANE}`);
        expect(button.getAttribute('aria-label')).toContain('Stop');
        expect(button.querySelector('[data-icon="close"]')).not.toBeNull();
        fireEvent.click(button);
        expect(sent).toEqual([{ verb: 'stop', args: [PANE, TAB1] }]);
    });

    it('runs the strip while loading and plays WEB-033’s completion choreography', () => {
        vi.useFakeTimers();
        const { commands } = fakeCommands();
        const timings = { fadeAfterMs: 300, resetAfterMs: 150 };
        const view = render(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                loading={true}
                progressTimings={timings}
            />
        );
        const strip = (): HTMLElement | null => screen.queryByTestId(`web-progress-${PANE}`);
        expect(strip()?.getAttribute('data-phase')).toBe('loading');
        expect(screen.getByTestId(`web-progress-bar-${PANE}`).className).toContain('nex-web-progress');

        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                loading={false}
                progressTimings={timings}
            />
        );
        // Pinned to full width first — completion has to be visible before it fades.
        expect(strip()?.getAttribute('data-phase')).toBe('complete');
        expect(screen.getByTestId(`web-progress-bar-${PANE}`).style.width).toBe('100%');

        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(strip()?.getAttribute('data-phase')).toBe('fading');
        expect(strip()?.style.opacity).toBe('0');

        act(() => {
            vi.advanceTimersByTime(150);
        });
        expect(strip()).toBeNull();
    });

    it('WEB-034: switching tabs snaps the strip to the new tab’s state', () => {
        vi.useFakeTimers();
        const { commands } = fakeCommands();
        const view = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} loading={true} />
        );
        expect(screen.getByTestId(`web-progress-${PANE}`).getAttribute('data-phase')).toBe('loading');

        // Tab 2 is idle: no fade-out of tab 1's bar, no frozen bar — it is simply gone.
        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB2} commands={commands} loading={false} />
        );
        expect(screen.queryByTestId(`web-progress-${PANE}`)).toBeNull();

        // …and back into the still-loading tab shows its strip at once.
        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} loading={true} />
        );
        expect(screen.getByTestId(`web-progress-${PANE}`).getAttribute('data-phase')).toBe('loading');
    });

    it('draws no strip at all for an idle pane', () => {
        const { commands } = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        expect(screen.queryByTestId(`web-progress-${PANE}`)).toBeNull();
    });
});

// ── WEB-039 / WEB-040 ───────────────────────────────────────────────────────────────

describe('the scope and storage buttons (WEB-039/WEB-040)', () => {
    const session = (visible: boolean, items: number): WebBatchSession => ({
        visible,
        focused_id: null,
        last_target: null,
        submit: false,
        items: Array.from({ length: items }, (_unused, index) => ({
            id: `item-${String(index)}`,
            selector: `#e${String(index)}`,
            tag: 'div',
            text: '',
            url: '',
            comment: ''
        }))
    });

    it('badges the scope button with the batch’s pending count, and names it', () => {
        const { commands } = fakeCommands();
        const view = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} batch={session(false, 2)} />
        );
        expect(screen.getByTestId(`web-batch-toggle-${PANE}-badge`).textContent).toBe('2');
        expect(screen.getByTestId(`web-batch-toggle-${PANE}`).getAttribute('aria-label')).toContain(
            '2 items waiting'
        );

        /*
         * §M35 — a VISIBLE batch keeps its badge. `WebPaneView.swift:114` hands the chrome
         * `pendingItemCount: batchInspect?.items.count ?? 0` with no reference to the panel, and
         * `WebPaneChrome.swift:254-266` draws the capsule on `pendingItemCount > 0` alone, so
         * picking gives running toolbar feedback rather than a number that only appears once you
         * hide the rows. The tooltip still distinguishes the two states.
         */
        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} batch={session(true, 2)} />
        );
        expect(screen.getByTestId(`web-batch-toggle-${PANE}-badge`).textContent).toBe('2');
        expect(screen.getByTestId(`web-batch-toggle-${PANE}`).getAttribute('aria-label')).toBe(
            'Hide element pickup'
        );

        // An empty batch has nothing to count, so no capsule at all.
        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} batch={session(true, 0)} />
        );
        expect(screen.queryByTestId(`web-batch-toggle-${PANE}-badge`)).toBeNull();
    });

    it('swaps the storage glyph and its tooltip in private mode', () => {
        const { commands } = fakeCommands();
        const view = render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} />);
        const button = (): HTMLElement => screen.getByTestId(`web-storage-toggle-${PANE}`);
        expect(button().querySelector('[data-icon="lock-open"]')).not.toBeNull();
        expect(button().getAttribute('title')).toBe('Cookies and site data');

        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} isPrivate={true} />
        );
        expect(button().querySelector('[data-icon="lock"]')).not.toBeNull();
        expect(button().getAttribute('title')).toContain('Private mode');
    });
});

// ── WEB-043 ─────────────────────────────────────────────────────────────────────────

describe('focus handoff (WEB-043)', () => {
    it('hands the keyboard to the page when the pane gains focus', () => {
        const { commands, sent } = fakeCommands();
        const view = render(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={() => ({ x: 0, y: 0, w: 10, h: 10 })}
                focused={false}
            />
        );
        expect(sent.filter((entry) => entry.verb === 'focusView')).toEqual([]);

        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={() => ({ x: 0, y: 0, w: 10, h: 10 })}
                focused={true}
            />
        );
        expect(sent.filter((entry) => entry.verb === 'focusView')).toEqual([
            { verb: 'focusView', args: [PANE, TAB1] }
        ]);
    });

    it('never steals the caret out of the URL bar (the NSText exemption)', () => {
        const { commands, sent } = fakeCommands();
        const view = render(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={() => ({ x: 0, y: 0, w: 10, h: 10 })}
                focused={false}
            />
        );
        (screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement).focus();
        view.rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={commands}
                embedded={true}
                measure={() => ({ x: 0, y: 0, w: 10, h: 10 })}
                focused={true}
            />
        );
        expect(sent.filter((entry) => entry.verb === 'focusView')).toEqual([]);
    });

    it('does nothing in a plain browser, where there is no native view to focus', () => {
        const { commands, sent } = fakeCommands();
        const view = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} focused={false} />
        );
        view.rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands} focused={true} />
        );
        expect(sent).toEqual([]);
    });
});

// ── WEB-002 ─────────────────────────────────────────────────────────────────────────

function BlankHarness(props: { readonly onFocus: (paneID: string) => void }): ReactElement {
    const [targets, setTargets] = useState<readonly BlankURLTarget[]>([]);
    useBlankWebPaneURLFocus(targets, props.onFocus);
    return (
        <div>
            <button type="button" data-testid="add-blank" onClick={() => setTargets([{ paneID: PANE, activeTabID: TAB1, activeURL: '' }])}>
                blank pane
            </button>
            <button
                type="button"
                data-testid="add-loaded"
                onClick={() => setTargets([{ paneID: PANE, activeTabID: TAB1, activeURL: 'https://example.com/' }])}
            >
                loaded pane
            </button>
            <button
                type="button"
                data-testid="url-arrives"
                onClick={() => setTargets([{ paneID: PANE, activeTabID: TAB1, activeURL: 'https://example.com/' }])}
            >
                url arrives
            </button>
            <button
                type="button"
                data-testid="add-blank-tab"
                onClick={() =>
                    setTargets([{ paneID: PANE, activeTabID: TAB2, activeURL: '' }])
                }
            >
                blank tab
            </button>
        </div>
    );
}

describe('a blank web pane claims the URL bar (WEB-002)', () => {
    it('bumps for a pane that arrives blank, and not for one that arrives with a URL', () => {
        const focused: string[] = [];
        render(<BlankHarness onFocus={(paneID) => focused.push(paneID)} />);
        fireEvent.click(screen.getByTestId('add-blank'));
        expect(focused).toEqual([PANE]);

        cleanup();
        focused.length = 0;
        render(<BlankHarness onFocus={(paneID) => focused.push(paneID)} />);
        fireEvent.click(screen.getByTestId('add-loaded'));
        expect(focused).toEqual([]);
    });

    it('does not re-bump when the URL fills in under a blank pane', () => {
        const focused: string[] = [];
        render(<BlankHarness onFocus={(paneID) => focused.push(paneID)} />);
        fireEvent.click(screen.getByTestId('add-blank'));
        fireEvent.click(screen.getByTestId('url-arrives'));
        expect(focused).toEqual([PANE]);
    });

    it('bumps again for a blank NEW TAB in a pane it already knows', () => {
        const focused: string[] = [];
        render(<BlankHarness onFocus={(paneID) => focused.push(paneID)} />);
        fireEvent.click(screen.getByTestId('add-loaded'));
        fireEvent.click(screen.getByTestId('add-blank-tab'));
        expect(focused).toEqual([PANE]);
    });
});

// ── the nav-state broadcast ─────────────────────────────────────────────────────────

describe('the nav-state broadcast (WEB-032/033/034)', () => {
    it('parses a well-formed report, keyed by pane AND tab', () => {
        const parsed = parseNavStateMessage({
            type: 'web-nav-state',
            paneID: PANE,
            tabID: TAB1,
            loading: true,
            can_go_back: true,
            can_go_forward: false
        });
        expect(parsed).toEqual({
            paneID: PANE,
            tabID: TAB1,
            loading: true,
            canGoBack: true,
            canGoForward: false
        });
        // The per-tab key is what makes WEB-034's snap possible at all.
        expect(navStateKey(PANE, TAB1)).toBe(`${PANE}:${TAB1}`);
        expect(navStateKey(PANE, null)).toBe(`${PANE}:`);
    });

    it('ignores another message type, and a report naming no tab', () => {
        expect(parseNavStateMessage({ type: 'web-batch', paneID: PANE })).toBeNull();
        expect(parseNavStateMessage({ type: 'web-nav-state', paneID: PANE })).toBeNull();
        expect(parseNavStateMessage({ type: 'web-nav-state', tabID: TAB1 })).toBeNull();
        expect(parseNavStateMessage('nonsense')).toBeNull();
    });

    it('reads a missing flag as false rather than undefined', () => {
        expect(parseNavStateMessage({ type: 'web-nav-state', paneID: PANE, tabID: TAB1 })).toEqual({
            paneID: PANE,
            tabID: TAB1,
            loading: false,
            canGoBack: false,
            canGoForward: false
        });
    });
});
