import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PaneHeader,
    TITLE_SHRINK,
    agentBadge,
    homeAbbreviated,
    paneDisplayTitle,
    splitHeaderTitle
} from './PaneHeader';
import { firePointer, testPane } from './testing';
import type { PaneModel } from './types';

const NOW = 1_000_000;

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('paneDisplayTitle', () => {
    it('spells the title per pane type (shell-ui.md §4.2 item 3)', () => {
        const cases: { pane: PaneModel; expected: string }[] = [
            { pane: testPane('a', { type: 'scratchpad' }), expected: 'Scratchpad' },
            {
                pane: testPane('a', { type: 'markdown', filePath: '/repo/docs/NOTES.md' }),
                expected: 'NOTES.md'
            },
            {
                pane: testPane('a', { type: 'diff', filePath: '/repo/src/main.ts' }),
                expected: 'diff: main.ts'
            },
            {
                pane: testPane('a', { type: 'diff', filePath: null, workingDirectory: '/repo/src' }),
                expected: 'diff: src'
            },
            {
                pane: testPane('a', { type: 'shell', workingDirectory: '/Users/ben/code/nex' }),
                expected: '~/code/nex'
            },
            {
                pane: testPane('a', { type: 'shell', title: 'vim README.md' }),
                expected: 'vim README.md'
            }
        ];
        for (const { pane, expected } of cases) {
            expect(paneDisplayTitle(pane, '/Users/ben')).toBe(expected);
        }
    });

    it('abbreviates the home directory only at a path boundary', () => {
        expect(homeAbbreviated('/Users/ben', '/Users/ben')).toBe('~');
        expect(homeAbbreviated('/Users/ben/x', '/Users/ben/')).toBe('~/x');
        expect(homeAbbreviated('/Users/benjamin/x', '/Users/ben')).toBe('/Users/benjamin/x');
        expect(homeAbbreviated('/etc', '')).toBe('/etc');
    });
});

describe('splitHeaderTitle (§4.2 middle truncation)', () => {
    it('keeps the last path segment out of the ellipsizing half', () => {
        // run-B m9: `text-overflow: ellipsis` only cuts the tail, so a long temp path showed
        // `/var/folders/5x/k7q6qbys3p35wb8dcn0dl…` — every character of it uninformative.
        expect(splitHeaderTitle('/var/folders/5x/k7q6qbys3p35wb8dcn0dlfmh0000gn/T/nexaudit/home')).toEqual({
            head: '/var/folders/5x/k7q6qbys3p35wb8dcn0dlfmh0000gn/T/nexaudit',
            tail: '/home'
        });
        expect(splitHeaderTitle('~/code/nex')).toEqual({ head: '~/code', tail: '/nex' });
    });

    it('leaves titles with nothing to protect alone', () => {
        expect(splitHeaderTitle('Scratchpad')).toEqual({ head: 'Scratchpad', tail: '' });
        expect(splitHeaderTitle('/home')).toEqual({ head: '/home', tail: '' });
        expect(splitHeaderTitle('/repo/')).toEqual({ head: '/repo/', tail: '' });
    });

    it('refuses a tail that would eat the whole header', () => {
        const monster = `/repo/${'x'.repeat(80)}`;
        expect(splitHeaderTitle(monster)).toEqual({ head: monster, tail: '' });
    });
});

describe('agentBadge', () => {
    const table: { name: string; pane: PaneModel; expected: ReturnType<typeof agentBadge> }[] = [
        {
            name: 'idle shell with a session shows nothing',
            pane: testPane('a', { agentSessionID: 's', status: 'idle' }),
            expected: null
        },
        {
            name: 'running without a session shows nothing',
            pane: testPane('a', { status: 'running' }),
            expected: null
        },
        {
            name: 'running defaults the kind to claude',
            pane: testPane('a', { agentSessionID: 's', status: 'running' }),
            expected: { text: 'claude', tone: 'running' }
        },
        {
            name: 'running with a start time ticks the elapsed clock',
            pane: testPane('a', {
                agentSessionID: 's',
                status: 'running',
                agentStartedAt: (NOW - 249) * 1000
            }),
            expected: { text: 'claude · 4m 9s', tone: 'running' }
        },
        {
            name: 'codex labels itself',
            pane: testPane('a', {
                agentSessionID: 's',
                status: 'running',
                agentKind: 'codex',
                agentStartedAt: (NOW - 9) * 1000
            }),
            expected: { text: 'codex · 9s', tone: 'running' }
        },
        {
            name: 'background work appends the running count',
            pane: testPane('a', {
                agentSessionID: 's',
                status: 'running',
                agentStartedAt: (NOW - 3661) * 1000,
                backgroundTaskCount: 2
            }),
            expected: { text: 'claude · 1h 1m · 2 running', tone: 'running' }
        },
        {
            name: 'waiting is its own tone',
            pane: testPane('a', { agentSessionID: 's', status: 'waitingForInput' }),
            expected: { text: 'awaiting input', tone: 'waiting' }
        },
        {
            name: 'non-shell panes never carry an agent badge',
            pane: testPane('a', { type: 'markdown', agentSessionID: 's', status: 'running' }),
            expected: null
        }
    ];

    for (const { name, pane, expected } of table) {
        it(name, () => {
            expect(agentBadge(pane, NOW)).toEqual(expected);
        });
    }
});

describe('PaneHeader rendering', () => {
    function renderHeader(pane: PaneModel, props: Partial<Parameters<typeof PaneHeader>[0]> = {}) {
        return render(<PaneHeader pane={pane} focused={false} nowSeconds={NOW} {...props} />);
    }

    it('shows the status dot for shell panes and a glyph for the rest', () => {
        renderHeader(testPane('a', { status: 'running' }));
        expect(screen.getByTestId('pane-status-dot-a').getAttribute('data-status')).toBe('running');
        cleanup();
        renderHeader(testPane('b', { type: 'web' }));
        expect(screen.queryByTestId('pane-status-dot-b')).toBeNull();
        expect(screen.getByTestId('pane-title-b').textContent).toBe('/tmp');
    });

    it('renders the agent, label, branch, zoom and sync badges', () => {
        renderHeader(
            testPane('a', {
                label: 'worker',
                gitBranch: 'feat/grid',
                agentSessionID: 's',
                status: 'running',
                agentStartedAt: (NOW - 65) * 1000
            }),
            { zoomed: true, zoomAvailable: true, syncActive: true }
        );
        expect(screen.getByTestId('pane-label-a').textContent).toBe('worker');
        expect(screen.getByTestId('pane-branch-a').textContent).toBe('feat/grid');
        expect(screen.getByTestId('pane-agent-badge-a').textContent).toBe('claude · 1m 5s');
        expect(screen.getByTestId('pane-zoom-badge-a')).toBeTruthy();
        expect(screen.getByTestId('pane-sync-badge-a')).toBeTruthy();
    });

    it('shows SYNC OFF for an excluded pane and hides ZOOM in a single-pane workspace', () => {
        renderHeader(testPane('a'), { zoomed: true, zoomAvailable: false, syncActive: true, syncExcluded: true });
        expect(screen.queryByTestId('pane-zoom-badge-a')).toBeNull();
        expect(screen.queryByTestId('pane-sync-badge-a')).toBeNull();
        expect(screen.getByTestId('pane-sync-off-badge-a')).toBeTruthy();
    });

    it('offers the buttons each pane type earns', () => {
        renderHeader(testPane('a', { type: 'markdown', isEditing: false }));
        expect(screen.getByTestId('pane-edit-toggle-a').getAttribute('aria-label')).toBe('Edit (⌘E)');
        expect(screen.queryByTestId('pane-refresh-a')).toBeNull();
        expect(screen.queryByTestId('pane-restart-a')).toBeNull();
        cleanup();

        renderHeader(testPane('a', { type: 'markdown', isEditing: true }));
        expect(screen.getByTestId('pane-edit-toggle-a').getAttribute('aria-label')).toBe('Preview (⌘E)');
        cleanup();

        renderHeader(testPane('a', { type: 'diff' }));
        expect(screen.getByTestId('pane-refresh-a')).toBeTruthy();
        cleanup();

        renderHeader(testPane('a', { agentSessionID: 's' }));
        expect(screen.getByTestId('pane-restart-a')).toBeTruthy();
    });

    it('routes every button to its callback', () => {
        const spies = {
            onClosePane: vi.fn(),
            onSplitPane: vi.fn(),
            onToggleZoom: vi.fn(),
            onRefreshDiff: vi.fn(),
            onRestartAgent: vi.fn(),
            onNewWebPane: vi.fn()
        };
        renderHeader(testPane('a', { type: 'diff', agentSessionID: 's' }), spies);
        act(() => screen.getByTestId('pane-close-a').click());
        act(() => screen.getByTestId('pane-split-right-a').click());
        act(() => screen.getByTestId('pane-split-down-a').click());
        act(() => screen.getByTestId('pane-refresh-a').click());
        act(() => screen.getByTestId('pane-new-web-a').click());
        expect(spies.onClosePane).toHaveBeenCalledExactlyOnceWith('a');
        expect(spies.onSplitPane).toHaveBeenNthCalledWith(1, 'a', 'horizontal');
        expect(spies.onSplitPane).toHaveBeenNthCalledWith(2, 'a', 'vertical');
        expect(spies.onRefreshDiff).toHaveBeenCalledExactlyOnceWith('a');
        expect(spies.onNewWebPane).toHaveBeenCalledExactlyOnceWith('a', 'horizontal');

        fireEvent.doubleClick(screen.getByTestId('pane-header-a'));
        expect(spies.onToggleZoom).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('renames inline: Enter commits the trimmed draft, Escape abandons it', () => {
        const onRenamePane = vi.fn();
        renderHeader(testPane('a', { label: 'old' }), { onRenamePane });
        act(() => screen.getByTestId('pane-rename-a').click());
        const input = screen.getByTestId('pane-rename-input-a') as HTMLInputElement;
        expect(input.value).toBe('old');
        fireEvent.change(input, { target: { value: '  new  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRenamePane).toHaveBeenCalledExactlyOnceWith('a', 'new');
        expect(screen.queryByTestId('pane-rename-input-a')).toBeNull();

        act(() => screen.getByTestId('pane-rename-a').click());
        fireEvent.change(screen.getByTestId('pane-rename-input-a'), { target: { value: 'nope' } });
        fireEvent.keyDown(screen.getByTestId('pane-rename-input-a'), { key: 'Escape' });
        expect(onRenamePane).toHaveBeenCalledTimes(1);
    });

    it('starts a pane-move drag from a header press but not from a button press', () => {
        const onHeaderPointerDown = vi.fn();
        const onFocusPane = vi.fn();
        renderHeader(testPane('a'), { onHeaderPointerDown, onFocusPane });
        act(() => firePointer(screen.getByTestId('pane-header-a'), 'pointerdown', { clientX: 5, clientY: 5 }));
        expect(onHeaderPointerDown).toHaveBeenCalledTimes(1);
        expect(onFocusPane).toHaveBeenCalledExactlyOnceWith('a');

        act(() => firePointer(screen.getByTestId('pane-close-a'), 'pointerdown', { clientX: 5, clientY: 5 }));
        expect(onHeaderPointerDown).toHaveBeenCalledTimes(1);
    });

    it('raises the context menu without the browser default', () => {
        const onPaneContextMenu = vi.fn();
        renderHeader(testPane('a'), { onPaneContextMenu });
        fireEvent.contextMenu(screen.getByTestId('pane-header-a'));
        expect(onPaneContextMenu).toHaveBeenCalledTimes(1);
        expect(onPaneContextMenu.mock.calls[0]?.[0]).toBe('a');
    });

    it('ticks the elapsed clock without remounting the header', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW * 1000);
        const pane = testPane('a', { agentSessionID: 's', status: 'running', agentStartedAt: (NOW - 5) * 1000 });
        render(<PaneHeader pane={pane} focused />);
        const badge = screen.getByTestId('pane-agent-badge-a');
        expect(badge.textContent).toBe('claude · 5s');
        act(() => vi.advanceTimersByTime(3000));
        expect(screen.getByTestId('pane-agent-badge-a')).toBe(badge);
        expect(badge.textContent).toBe('claude · 8s');
    });
});

describe('truncation priority as the header narrows (TERM-102/104)', () => {
    /**
     * jsdom has no layout, so what is assertable HERE is the contract that produces the order —
     * the shrink weights and the min-widths. The pixels are proved by the visual audit's
     * `pane-header-truncation` step, which narrows a real pane and measures the boxes.
     */
    it('weights the path far above the badges, and pins the buttons at zero', () => {
        const pane = testPane('a', {
            label: 'a-very-long-pane-label-that-would-push-the-buttons-off',
            gitBranch: 'feature/some-extremely-long-branch-name',
            agentSessionID: 's',
            status: 'running',
            agentStartedAt: null,
            workingDirectory: '/Users/ben/code/nex/packages/client/src/grid'
        });
        render(<PaneHeader pane={pane} focused nowSeconds={NOW} />);

        const title = screen.getByTestId('pane-title-a');
        expect(title.style.flexShrink).toBe(String(TITLE_SHRINK));
        expect(title.className).toContain('min-w-0');

        // User-data badges give ground second: they may shrink, and they truncate when they do.
        for (const testID of ['pane-label-a', 'pane-branch-a', 'pane-agent-badge-a']) {
            const badge = screen.getByTestId(testID);
            expect(badge.className).toContain('shrink');
            expect(badge.className).not.toContain('shrink-0');
            expect(badge.style.minWidth).toBe('0');
            expect(badge.querySelector('span')?.className).toContain('truncate');
        }

        // The controls never shrink — a header that drops its ✕ before its path is backwards.
        for (const testID of ['pane-rename-a', 'pane-split-right-a', 'pane-split-down-a', 'pane-close-a']) {
            expect(screen.getByTestId(testID).className).toContain('shrink-0');
        }
    });

    it('keeps the fixed-word badges unshrinkable — there is nothing in them to truncate', () => {
        render(
            <PaneHeader
                pane={testPane('a')}
                focused
                zoomed
                zoomAvailable
                syncActive
                nowSeconds={NOW}
            />
        );
        expect(screen.getByTestId('pane-zoom-badge-a').className).toContain('shrink-0');
        expect(screen.getByTestId('pane-sync-badge-a').className).toContain('shrink-0');
    });
});

describe('the agent badge transition (TERM-104)', () => {
    it('swaps text and tone across the status transitions, and disappears when idle', () => {
        const running = testPane('a', {
            agentSessionID: 's',
            status: 'running',
            agentStartedAt: (NOW - 12) * 1000
        });
        const view = render(<PaneHeader pane={running} focused nowSeconds={NOW} />);
        const badge = screen.getByTestId('pane-agent-badge-a');
        expect(badge.textContent).toBe('claude · 12s');

        view.rerender(
            <PaneHeader pane={{ ...running, status: 'waitingForInput' }} focused nowSeconds={NOW} />
        );
        // Same node, new content: the badge TRANSITIONS rather than remounting, which is what
        // keeps the swap from flashing an empty gap between the two states.
        expect(screen.getByTestId('pane-agent-badge-a')).toBe(badge);
        expect(badge.textContent).toBe('awaiting input');

        view.rerender(<PaneHeader pane={{ ...running, status: 'idle' }} focused nowSeconds={NOW} />);
        expect(screen.queryByTestId('pane-agent-badge-a')).toBeNull();
    });

    it('animates the status dot rather than cutting between colours', () => {
        render(<PaneHeader pane={testPane('a', { status: 'running' })} focused nowSeconds={NOW} />);
        const dot = screen.getByTestId('pane-status-dot-a');
        expect(dot.className).toContain('transition-colors');
        expect(dot.className).toContain('duration-300');
        expect(dot.getAttribute('data-status')).toBe('running');
    });
});
