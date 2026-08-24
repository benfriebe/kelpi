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

    /**
     * §L48 — `PaneHeaderView.swift:496-502` scopes a diff on `target.isEmpty`, not on nil, so an
     * empty STRING falls back to the repo's directory name. `pane.filePath ?? workingDirectory`
     * keeps `''` and titled such a pane `diff: `.
     */
    it('treats an EMPTY diff scope as unscoped, like the Swift (§L48)', () => {
        const empty = testPane('a', { type: 'diff', filePath: '', workingDirectory: '/repo/src' });
        expect(paneDisplayTitle(empty, '/Users/ben')).toBe('diff: src');
        // A real scope, and the null case, are untouched.
        expect(paneDisplayTitle(testPane('a', { type: 'diff', filePath: '/repo/src/main.ts' }), '')).toBe(
            'diff: main.ts'
        );
        expect(
            paneDisplayTitle(
                testPane('a', { type: 'diff', filePath: null, workingDirectory: '/repo/src' }),
                ''
            )
        ).toBe('diff: src');
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

    /**
     * §M19 — a last segment longer than the budget is CLAMPED, never abandoned.
     *
     * The first version handed the whole string back as the head, which fell straight through to
     * plain tail-ellipsis in exactly the case middle truncation exists for: the informative end
     * of the path was the part thrown away. `.truncationMode(.middle)` keeps both ends, so the
     * tail becomes the last `tailMax` characters and the head is everything before them.
     */
    it('clamps a tail that would eat the whole header, keeping its END', () => {
        const monster = `/repo/${'x'.repeat(80)}`;
        const clamped = splitHeaderTitle(monster);
        expect(clamped.tail).toBe('x'.repeat(24));
        expect(clamped.head).toBe(`/repo/${'x'.repeat(56)}`);
        // The two spans are adjacent, so a header wide enough still reads as one whole string.
        expect(clamped.head + clamped.tail).toBe(monster);
    });

    it('keeps the informative end of a long last segment (the M19 case)', () => {
        const title = '~/code/some-really-long-directory-name';
        const split = splitHeaderTitle(title);
        // The old fallback returned the whole title as the head and '' as the tail, so CSS
        // ellipsis cut `…-name` off. The name is what the user is trying to read.
        expect(split.tail).not.toBe('');
        expect(title.endsWith(split.tail)).toBe(true);
        expect(split.tail.endsWith('directory-name')).toBe(true);
        expect(split.head + split.tail).toBe(title);
    });

    it('honours a custom budget on the clamped branch too', () => {
        const split = splitHeaderTitle('/a/bbbbbbbbbb', 4);
        expect(split).toEqual({ head: '/a/bbbbbb', tail: 'bbbb' });
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

        // §H3: a shell pane earns NO per-type button, not even with a live agent attached.
        // `PaneHeaderView.swift:177-272` has no `.shell` branch and the shipped app has no
        // restart control at all; a one-click restart of a running agent next to Close is a
        // mis-click waiting to happen.
        renderHeader(testPane('a', { agentSessionID: 's', status: 'running' }));
        expect(screen.queryByTestId('pane-restart-a')).toBeNull();
    });

    /**
     * §TERM-103: the Swift keeps "Copy as Markdown / Copy as Rich Text" on the pane HEADER,
     * markdown-only. The menu itself is the content frame's (see `ContentFrame.copyToken`);
     * the header's job is the button, and it is absent in edit mode — there is no rendered
     * document to copy while the editor is up.
     */
    it('offers the markdown copy button in preview mode only', () => {
        const onCopyDocument = vi.fn();
        renderHeader(testPane('a', { type: 'markdown', isEditing: false }), { onCopyDocument });
        const button = screen.getByTestId('pane-copy-a');
        // L26: `.help("Copy whole file")` (`PaneHeaderView.swift:193`), verbatim — tooltip and
        // accessible name alike.
        expect(button.getAttribute('aria-label')).toBe('Copy whole file');
        expect(button.getAttribute('title')).toBe('Copy whole file');
        act(() => button.click());
        expect(onCopyDocument).toHaveBeenCalledExactlyOnceWith('a');
        cleanup();

        renderHeader(testPane('a', { type: 'markdown', isEditing: true }), { onCopyDocument });
        expect(screen.queryByTestId('pane-copy-a')).toBeNull();
        cleanup();

        renderHeader(testPane('a', { type: 'shell' }), { onCopyDocument });
        expect(screen.queryByTestId('pane-copy-a')).toBeNull();
        cleanup();

        renderHeader(testPane('a', { type: 'diff' }), { onCopyDocument });
        expect(screen.queryByTestId('pane-copy-a')).toBeNull();
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

    /**
     * §H8 — the Swift hangs `.onTapGesture(count: 2) { onToggleZoom }` off the header HStack and
     * fills that HStack with SwiftUI `Button`s, each of which consumes its own taps: a
     * double-click on Split Right there is two splits and nothing else. `dblclick` is a separate
     * native event from `click`, so stopping `click` alone left it bubbling to the header — two
     * splits AND a zoom toggle, or on Close, a close plus a zoom of whatever was left.
     */
    it('never toggles zoom from a double-click on a header control', () => {
        const onToggleZoom = vi.fn();
        const onSplitPane = vi.fn();
        renderHeader(testPane('a', { label: 'worker' }), {
            onToggleZoom,
            onSplitPane,
            zoomed: true,
            zoomAvailable: true
        });

        // A real double-click is click, click, dblclick — so the button's own action fires
        // twice (that part is the user's own fault) and the dblclick must go nowhere.
        const splitRight = screen.getByTestId('pane-split-right-a');
        fireEvent.click(splitRight);
        fireEvent.click(splitRight);
        fireEvent.doubleClick(splitRight);
        expect(onSplitPane).toHaveBeenCalledTimes(2);
        expect(onToggleZoom).not.toHaveBeenCalled();

        fireEvent.doubleClick(screen.getByTestId('pane-close-a'));
        expect(onToggleZoom).not.toHaveBeenCalled();

        // The ZOOM badge is a button too (Swift: `Button` at `PaneHeaderView.swift:101`), so a
        // double-click on it is two badge presses, never two presses plus the header gesture.
        const zoomBadge = screen.getByTestId('pane-zoom-badge-a');
        fireEvent.click(zoomBadge);
        fireEvent.click(zoomBadge);
        fireEvent.doubleClick(zoomBadge);
        expect(onToggleZoom).toHaveBeenCalledTimes(2);
        expect(onToggleZoom.mock.calls.every((call) => call[0] === 'a')).toBe(true);

        // …and the header still zooms when the double-click lands on the header itself.
        onToggleZoom.mockClear();
        fireEvent.doubleClick(screen.getByTestId('pane-header-a'));
        expect(onToggleZoom).toHaveBeenCalledExactlyOnceWith('a');
    });

    /**
     * §M30 — the field is opened by the CONTEXT menu's "Rename…" (a bumped `renameToken`), which
     * is the only gesture the Swift has (`PaneHeaderView.swift:354-356`); the header's own pencil
     * is gone. The commit/abandon behaviour below is byte-for-byte the assertion set the
     * button-driven version carried — only the way in changed.
     */
    it('renames inline: Enter commits the trimmed draft, Escape abandons it', () => {
        const onRenamePane = vi.fn();
        const pane = testPane('a', { label: 'old' });
        // The token is a counter read on CHANGE (so an agent tick cannot re-open the field), so
        // the menu's ask is a bump from the mounted value rather than a non-zero initial one.
        const view = render(
            <PaneHeader pane={pane} focused={false} nowSeconds={NOW} renameToken={0} onRenamePane={onRenamePane} />
        );
        view.rerender(
            <PaneHeader pane={pane} focused={false} nowSeconds={NOW} renameToken={1} onRenamePane={onRenamePane} />
        );
        const input = screen.getByTestId('pane-rename-input-a') as HTMLInputElement;
        expect(input.value).toBe('old');
        fireEvent.change(input, { target: { value: '  new  ' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRenamePane).toHaveBeenCalledExactlyOnceWith('a', 'new');
        expect(screen.queryByTestId('pane-rename-input-a')).toBeNull();

        // A second ask re-opens it — which is what the token being a COUNTER is for.
        view.rerender(
            <PaneHeader pane={pane} focused={false} nowSeconds={NOW} renameToken={2} onRenamePane={onRenamePane} />
        );
        fireEvent.change(screen.getByTestId('pane-rename-input-a'), { target: { value: 'nope' } });
        fireEvent.keyDown(screen.getByTestId('pane-rename-input-a'), { key: 'Escape' });
        expect(onRenamePane).toHaveBeenCalledTimes(1);
    });

    /**
     * §M30 — no rename pencil in the header. Swift's `:222-272` tail is split-right, split-down,
     * globe, close; rename is a context-menu item there and the port's extra button sat next to
     * the markdown edit-toggle's near-identical pencil.
     */
    it('offers no rename button on any pane type', () => {
        const view = renderHeader(testPane('a'), { onRenamePane: vi.fn() });
        for (const type of ['shell', 'markdown', 'diff', 'scratchpad', 'web'] as const) {
            view.rerender(<PaneHeader pane={testPane('a', { type })} focused={false} nowSeconds={NOW} />);
            expect(screen.queryByTestId('pane-rename-a')).toBeNull();
        }
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
        for (const testID of ['pane-split-right-a', 'pane-split-down-a', 'pane-close-a']) {
            expect(screen.getByTestId(testID).className).toContain('shrink-0');
        }

        // M11: the title no longer GROWS. `flex-1` made it absorb every pixel of slack, which is
        // what pushed ZOOM and SYNC out of the left cluster; the spacer owns the slack now, and
        // its zero basis keeps it out of the negative-space share-out above.
        expect(title.className).not.toContain('flex-1');
        expect(screen.getByTestId('pane-spacer-a').className).toContain('flex-1');
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

/**
 * §M11 — ZOOM and SYNC belong to the LEFT cluster, hugging the path.
 *
 * `PaneHeaderView.swift` orders the row glyph → label → path → ZOOM → SYNC → `Spacer()` (`:157`)
 * → agent → branch → buttons, so the free space opens up AFTER the two fixed-word badges. The
 * port's `flex-1` title took that space instead, which moved both badges over to the right
 * cluster. jsdom has no layout, so what is assertable here is the DOM order and the flex
 * contract that produces the split; the pixels are the audit's `pane-header-details` shots.
 */
describe('the header spacer (M11)', () => {
    function order(): string[] {
        return [...screen.getByTestId('pane-header-a').children]
            .map((node) => node.getAttribute('data-testid') ?? '')
            .filter((id) => id !== '');
    }

    it('sits after the ZOOM and SYNC badges and before the agent badge', () => {
        render(
            <PaneHeader
                pane={testPane('a', {
                    label: 'worker',
                    gitBranch: 'main',
                    agentSessionID: 's',
                    status: 'running',
                    agentStartedAt: null
                })}
                focused
                zoomed
                zoomAvailable
                syncActive
                nowSeconds={NOW}
            />
        );
        const ids = order();
        expect(ids).toEqual([
            'pane-status-dot-a',
            'pane-label-a',
            'pane-title-a',
            'pane-zoom-badge-a',
            'pane-sync-badge-a',
            'pane-spacer-a',
            'pane-agent-badge-a',
            'pane-branch-a',
            'pane-split-right-a',
            'pane-split-down-a',
            'pane-new-web-a',
            'pane-close-a'
        ]);
    });

    it('and steps aside for the inline rename field, which owns the slack itself', () => {
        const pane = testPane('a');
        const view = render(<PaneHeader pane={pane} focused nowSeconds={NOW} renameToken={0} />);
        expect(screen.getByTestId('pane-spacer-a')).toBeTruthy();
        view.rerender(<PaneHeader pane={pane} focused nowSeconds={NOW} renameToken={1} />);
        expect(screen.queryByTestId('pane-spacer-a')).toBeNull();
        expect(screen.getByTestId('pane-rename-input-a').className).toContain('flex-1');
    });

    /**
     * The spacer is deliberately NOT `pane-header-spacer-…`, and this is the guard.
     *
     * The audit harness counts panes and extracts pane ids with `[data-testid^="pane-header-"]`
     * in eleven places (`scripts/ui-audit/audit.mjs:530,533`), so a second element under that
     * prefix reads as a second pane in every one of them — a scoped run caught exactly that,
     * with `fresh-boot` reporting `panes=2` beside `daemon agrees: one pane`. Only the header
     * root may carry the prefix.
     */
    it('keeps the audit harness’s `pane-header-` prefix unique to the header root', () => {
        render(
            <PaneHeader
                pane={testPane('a', { label: 'worker', gitBranch: 'main', agentSessionID: 's', status: 'running' })}
                focused
                zoomed
                zoomAvailable
                syncActive
                nowSeconds={NOW}
            />
        );
        const root = screen.getByTestId('pane-header-a');
        const claimants = [...document.querySelectorAll('[data-testid^="pane-header-"]')];
        expect(claimants).toEqual([root]);
    });
});

/**
 * §M14 / §M15 — the badges are three tones and two weights, not one recipe.
 *
 * `PaneHeaderView.swift`: label / ZOOM / SYNC fill at 12% (`:91`, `:112`, `:137`), SYNC OFF and
 * the branch chip at 10% (`:153`, `:174`), the agent badge at 14% (`:329`, `:336`); every one is
 * `cornerRadius: 3`. The fixed-word badges carry `.medium` (`:106`, `:131`, `:147`) and SYNC OFF
 * is deliberately 9 pt against its peers' 10.
 */
describe('badge fills, radius and weight (M14/M15)', () => {
    function renderAll() {
        return render(
            <PaneHeader
                pane={testPane('a', {
                    label: 'worker',
                    gitBranch: 'main',
                    agentSessionID: 's',
                    status: 'running',
                    agentStartedAt: null
                })}
                focused
                zoomed
                zoomAvailable
                syncActive
                nowSeconds={NOW}
            />
        );
    }

    it('gives each badge the Swift’s own fill percentage', () => {
        renderAll();
        const fill = (testID: string): string => screen.getByTestId(testID).style.background;
        expect(fill('pane-label-a')).toContain(' 12%');
        expect(fill('pane-zoom-badge-a')).toContain(' 12%');
        expect(fill('pane-sync-badge-a')).toContain(' 12%');
        expect(fill('pane-agent-badge-a')).toContain(' 14%');
        expect(fill('pane-branch-a')).toContain(' 10%');
    });

    it('and SYNC OFF, which only exists on an excluded pane', () => {
        render(<PaneHeader pane={testPane('a')} focused nowSeconds={NOW} syncActive syncExcluded />);
        const badge = screen.getByTestId('pane-sync-off-badge-a');
        expect(badge.style.background).toContain(' 10%');
        expect(badge.className).toContain('text-[9px]');
        expect(badge.className).toContain('font-medium');
    });

    it('rounds every badge to 3, not 4', () => {
        renderAll();
        for (const testID of [
            'pane-label-a',
            'pane-zoom-badge-a',
            'pane-sync-badge-a',
            'pane-agent-badge-a',
            'pane-branch-a'
        ]) {
            expect(screen.getByTestId(testID).style.borderRadius).toBe('3px');
        }
    });

    it('weights the fixed-word badges medium and leaves the user-data ones alone', () => {
        renderAll();
        expect(screen.getByTestId('pane-zoom-badge-a').className).toContain('font-medium');
        expect(screen.getByTestId('pane-sync-badge-a').className).toContain('font-medium');
        for (const testID of ['pane-label-a', 'pane-agent-badge-a', 'pane-branch-a']) {
            const badge = screen.getByTestId(testID);
            expect(badge.className).not.toContain('font-medium');
            // …and they keep the common 10 pt: only SYNC OFF steps down.
            expect(badge.className).toContain('text-[10px]');
        }
    });

    /**
     * §M13 — the label chip is `Color.accentColor` (`PaneHeaderView.swift:88,91`), the macOS
     * SYSTEM accent, and the shipped app ships no `AccentColor.colorset`. The port reads its own
     * `--nex-system-accent` name so a "Sidebar highlight" override cannot recolour the pane grid
     * the way it does the sidebar. The value it falls back to today is still `--nex-accent` — the
     * standing divergence is recorded in `tokens.ts`.
     */
    it('paints the label chip from the system-accent token, not the chrome accent', () => {
        renderAll();
        const chip = screen.getByTestId('pane-label-a');
        expect(chip.style.color).toContain('--nex-system-accent');
        expect(chip.style.background).toContain('--nex-system-accent');
    });
});

/** §M17 — `HStack(spacing: 4)` (`PaneHeaderView.swift:52`), not the port's 6 px. */
describe('header item spacing (M17)', () => {
    it('sets the row gap to 4 px and keeps the 8 px horizontal padding', () => {
        render(<PaneHeader pane={testPane('a')} focused nowSeconds={NOW} />);
        const header = screen.getByTestId('pane-header-a');
        expect(header.className).toContain('gap-1');
        expect(header.className).not.toContain('gap-1.5');
        expect(header.className).toContain('px-2');
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
