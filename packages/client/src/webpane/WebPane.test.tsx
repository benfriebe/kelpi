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

import type { CommandReply } from '../connection';
import { WebPane, type WebPaneTab } from './WebPane';
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
            toggleDevTools: record('toggleDevTools')
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
        expect(screen.getByTestId(`web-external-${PANE}`).textContent).toContain('Open in the Nex app');

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
        expect(h.reports).toEqual([
            { paneID: PANE, tabID: TAB1, rect: RECT, visible: true, devicePixelRatio: 2 }
        ]);
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
        expect(h.reports.at(-1)?.rect).toEqual(moved);
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
});
