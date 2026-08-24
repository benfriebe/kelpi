/**
 * The LOW-POLISH status-bar / title-bar items — `docs/UI-FIDELITY.md` L49…L56.
 *
 * One suite per surface, as the campaign allows for metric-only rows: every block names the Swift
 * line the port had drifted from and asserts the number, tone or structure THAT line specifies.
 * Nothing here re-tests the behaviour `StatusFooter.test.tsx` already owns (the buckets, the
 * gauge budget, the clock) — only the presentation those suites never measured.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ZERO_SYSTEM_STATS } from '@nex/protocol';

import { FOOTER_DIFF_TONES } from './StatusFooter';
import {
    StatusFooter,
    TopBar,
    type ChromePane,
    type FooterAssociation,
    type StatusBarItem,
    type SystemStatsView
} from './index';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const NOW = new Date(2026, 0, 2, 9, 5, 0).getTime();

function pane(overrides: Partial<ChromePane> = {}): ChromePane {
    return {
        id: P1,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code/nex',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0,
        ...overrides
    };
}

const SUMMARY = { running: 1, waiting: 0, inactive: 0 };

const DIRTY: FooterAssociation = {
    worktreePath: '/Users/test/code/nex',
    status: { kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 }
};

function statsView(patch: Partial<SystemStatsView> = {}): SystemStatsView {
    return {
        stats: { ...ZERO_SYSTEM_STATS, cpuPercent: 42, memUsedBytes: 4 * 1024 ** 3, memTotalBytes: 16 * 1024 ** 3 },
        history: { cpu: [10, 40, 42], memory: [25, 25, 25] },
        intervalMs: 2000,
        showSystemStats: true,
        enabled: ['cpu', 'memory'],
        showGraphs: false,
        graphStyle: 'line',
        graphColor: '',
        graphWidth: 28,
        ...patch
    };
}

/** L49 — `SystemStatGauge.swift:129-162`, `StatDetailPopover`. */
describe('the gauge hover popover (L49)', () => {
    function openPopover(): HTMLElement {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView()} />);
        fireEvent.mouseEnter(screen.getByTestId('stat-gauge-cpu'));
        return screen.getByTestId('stat-popover-cpu');
    }

    it('titles at 13 px semibold, not the popover’s own 11', () => {
        const title = within(openPopover()).getByText('CPU');
        expect(title.className).toContain('text-[13px]');
        expect(title.className).toContain('font-semibold');
    });

    it('draws the breakdown in the UI face with TABULAR digits, not a monospace face', () => {
        const detail = within(openPopover()).getByTestId('stat-detail-cpu');
        // `.font(.system(size: 12)).monospacedDigit()` — 12 pt system, figures only.
        expect(detail.className).toContain('text-[12px]');
        expect(detail.className).toContain('tabular-nums');
        expect(detail.className).not.toContain('font-mono');
    });

    it('gives the history graph its 196×52 frame inside a 6 px box with no inset', () => {
        const graph = within(openPopover()).getByTestId('stat-graph-cpu');
        expect(graph.getAttribute('width')).toBe('196');
        expect(graph.getAttribute('height')).toBe('52');
        const box = graph.parentElement as HTMLElement;
        expect(box.className).toContain('rounded-md'); // 6 px, not `rounded`'s 4
        expect(box.style.padding).toBe('');
        // `.strokeBorder` paints INSIDE the frame; a CSS border would eat 2 px of the 196.
        expect(box.style.boxShadow).toContain('inset');
        expect(box.style.border).toBe('');
    });
});

/** L50 — `StatusBarView.swift:56, 181-208`: one 14 px right-hand stack, ≥28 px between clusters. */
describe('footer spacing (L50)', () => {
    it('is one 14 px stack from the gauges through the clock', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView()} />);
        expect(screen.getByTestId('footer-right').className).toContain('gap-3.5');
        expect(screen.getByTestId('footer-keep').className).toContain('gap-3.5');
        expect(screen.getByTestId('system-stats').className).toContain('gap-3.5');
        expect(screen.getByTestId('footer-right').className).not.toContain('gap-3 ');
    });

    it('holds the two clusters 10 + 8 + 10 apart, the shipped Spacer(minLength: 8) floor', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView()} />);
        expect(screen.getByTestId('status-footer').className).toContain('gap-2.5');
        const spacer = screen.getByTestId('footer-cluster-gap');
        expect(spacer.className).toContain('w-2');
        expect(spacer.className).toContain('shrink-0');
    });
});

/** L51 / L52 / L53 / L54 — the left cluster. */
describe('the focused-pane cluster', () => {
    function renderRepoPane(bucket?: 'light' | 'dark'): void {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                {...(bucket === undefined ? {} : { bucket })}
                homeDirectory="/Users/test"
                focusedPane={pane({
                    gitBranch: 'main',
                    status: 'running',
                    agentSessionID: 'session-1',
                    agentKind: 'claude',
                    agentStartedAt: NOW - 9000
                })}
                associations={[DIRTY]}
            />
        );
    }

    it('L51: the branch chip is a 3 px gap around a 9 pt glyph', () => {
        renderRepoPane();
        const branch = screen.getByTestId('footer-branch');
        expect(branch.className).toContain('gap-[3px]');
        expect(branch.querySelector('svg')?.getAttribute('width')).toBe('9');
    });

    it('L52: the +A / -B tones follow the appearance instead of being pinned to the dark hexes', () => {
        renderRepoPane('light');
        const light = within(screen.getByTestId('footer-git-stats'));
        expect((light.getByText('+27') as HTMLElement).style.color).toBe(rgb(FOOTER_DIFF_TONES.light.add));
        expect((light.getByText('-12') as HTMLElement).style.color).toBe(rgb(FOOTER_DIFF_TONES.light.del));
        cleanup();
        renderRepoPane('dark');
        const dark = within(screen.getByTestId('footer-git-stats'));
        // The dark column is unchanged: it is the inspector's pair, and the audit reads it.
        expect((dark.getByText('+27') as HTMLElement).style.color).toBe(rgb('#5FBE89'));
        expect((dark.getByText('-12') as HTMLElement).style.color).toBe(rgb('#E0655C'));
        expect(FOOTER_DIFF_TONES.light.add).not.toBe(FOOTER_DIFF_TONES.dark.add);
    });

    it('L53: the path gives way from the HEAD, so the leaf survives a squeeze', () => {
        renderRepoPane();
        const cwd = screen.getByTestId('footer-cwd');
        // The box still truncates (and still shrinks first) — only the ellipsis moved.
        expect(cwd.className).toContain('truncate');
        expect(cwd.className).toContain('min-w-0');
        expect(cwd.style.direction).toBe('rtl');
        expect(cwd.style.textAlign).toBe('left');
        // …with the path itself still laid out left-to-right, or a leading `~` migrates.
        expect(cwd.querySelector('bdi')?.textContent).toBe('~/code/nex');
        expect(cwd.textContent).toBe('~/code/nex');
    });

    it('L54: both elapsed labels carry tabular figures', () => {
        renderRepoPane();
        const agent = screen.getByTestId('footer-agent');
        expect(agent.textContent).toBe('claude 9s');
        const elapsed = [...agent.querySelectorAll('span')].find((node) => node.textContent?.includes('9s'));
        expect(elapsed?.className).toContain('tabular-nums');
    });
});

/** L54 / L56 — the bucket popover's rows. */
describe('bucket popover rows', () => {
    const LONG = 'claude · refactor the parser and the printer';
    const items: readonly StatusBarItem[] = [
        {
            paneID: P1,
            workspaceID: W1,
            workspaceName: 'alpha',
            workspaceColor: 'blue',
            paneTitle: LONG,
            status: 'running',
            agentStartedAt: NOW - 249_000
        }
    ];

    function openRunning(): HTMLElement {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                bucketItems={(bucket) => (bucket === 'running' ? items : [])}
            />
        );
        fireEvent.click(screen.getByTestId('count-running'));
        return screen.getByTestId('bucket-row');
    }

    it('L56: the title is not cut at 24 characters — the WIDTH decides', () => {
        const title = within(openRunning()).getByTestId('bucket-row-title');
        expect(title.textContent).toBe(LONG);
        expect(title.textContent).not.toContain('…');
        expect(title.className).toContain('truncate');
        expect(title.style.direction).toBe('rtl');
    });

    it('L56: and it can never abut the elapsed — Spacer(minLength: 10)', () => {
        const row = openRunning();
        const spacer = [...row.querySelectorAll('span')].find((node) =>
            node.className.includes('min-w-[10px]')
        );
        expect(spacer).toBeDefined();
        expect(spacer?.className).toContain('flex-1');
    });

    it('L54: the row’s elapsed is tabular too', () => {
        const elapsed = within(openRunning()).getByText('4m 9s');
        expect(elapsed.className).toContain('tabular-nums');
    });
});

/** L55 — `WindowTitleBar.swift:67, 76-80, 98-100`: the `·` is a member of the 7 pt stack. */
describe('title-bar identity spacing (L55)', () => {
    it('gives the separator 7 px on both sides by making it its own span', () => {
        render(
            <TopBar
                workspaceName="alpha"
                workspaceColor="blue"
                panes={[pane(), pane({ id: 'p2' })]}
                connection="connected"
            />
        );
        const identity = screen.getByTestId('top-bar-identity');
        expect(identity.className).toContain('gap-[7px]');
        const spans = [...identity.querySelectorAll('span')].map((node) => node.textContent);
        expect(spans).toContain('·');
        expect(spans).toContain('2 panes');
        // The old single span was `· 2 panes`, whose inner gap was a literal space.
        expect(spans).not.toContain('· 2 panes');
    });
});

/** jsdom normalises inline hex to `rgb(r, g, b)`. */
function rgb(hex: string): string {
    const value = hex.replace('#', '');
    const channel = (index: number): number => Number.parseInt(value.slice(index, index + 2), 16);
    return `rgb(${String(channel(0))}, ${String(channel(2))}, ${String(channel(4))})`;
}
