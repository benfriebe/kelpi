import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ZERO_SYSTEM_STATS } from '@nex/protocol';

import {
    StatusFooter,
    footerGitStats,
    type ChromePane,
    type FooterAssociation,
    type StatusBarItem,
    type SystemStatsView
} from './index';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
/** 2026-01-02 09:05:00 local — a fixed clock so the footer is deterministic. */
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

const SUMMARY = { running: 2, waiting: 1, inactive: 0 };

describe('agent buckets (§9.3)', () => {
    it('renders running / waiting / inactive with their counts', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('count-running').textContent).toContain('2');
        expect(screen.getByTestId('count-waiting').textContent).toContain('1');
        expect(screen.getByTestId('count-inactive').textContent).toContain('0');
    });

    it('a zero count is inert; a non-zero count is a button', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('count-inactive').tagName).toBe('SPAN');
        expect(screen.getByTestId('count-running').tagName).toBe('BUTTON');
    });

    it('opens the bucket popover and jumps to a pane', () => {
        const onSelectPane = vi.fn();
        const items: readonly StatusBarItem[] = [
            {
                paneID: P1,
                workspaceID: W1,
                workspaceName: 'alpha',
                workspaceColor: 'blue',
                paneTitle: 'claude',
                status: 'running',
                agentStartedAt: NOW - 249_000
            }
        ];
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                bucketItems={(bucket) => (bucket === 'running' ? items : [])}
                onSelectPane={onSelectPane}
            />
        );

        fireEvent.click(screen.getByTestId('count-running'));
        const popover = screen.getByTestId('bucket-popover');
        expect(within(popover).getByText('Running agents')).toBeDefined();
        // Running rows carry a live elapsed label; 249s → "4m 9s".
        expect(within(popover).getByText('4m 9s')).toBeDefined();

        fireEvent.click(within(popover).getByTestId('bucket-row'));
        expect(onSelectPane).toHaveBeenCalledWith(W1, P1);
        expect(screen.queryByTestId('bucket-popover')).toBeNull();
    });

    it('an empty bucket list says "None."', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} bucketItems={() => []} />);
        fireEvent.click(screen.getByTestId('count-waiting'));
        expect(within(screen.getByTestId('bucket-popover')).getByText('None.')).toBeDefined();
    });
});

describe('focused-pane context (§9.1)', () => {
    it('abbreviates the home directory and shows the branch', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                homeDirectory="/Users/test"
                focusedPane={pane({ gitBranch: 'main' })}
            />
        );
        expect(screen.getByTestId('footer-cwd').textContent).toBe('~/code/nex');
        expect(screen.getByTestId('footer-branch').textContent).toContain('main');
    });

    it('shows the agent kind + elapsed while running, and background units', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane({
                    status: 'running',
                    agentSessionID: 'session',
                    agentKind: 'codex',
                    agentStartedAt: NOW - 9_000,
                    backgroundTaskCount: 2
                })}
            />
        );
        expect(screen.getByTestId('footer-agent').textContent).toBe('codex 9s · 2 running');
    });

    it('shows "awaiting input" while waiting and nothing while idle', () => {
        const view = render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane({ status: 'waitingForInput', agentSessionID: 'session' })}
            />
        );
        expect(screen.getByTestId('footer-agent').textContent).toBe('awaiting input');

        view.rerender(
            <StatusFooter summary={SUMMARY} now={NOW} focusedPane={pane({ agentSessionID: 'session' })} />
        );
        expect(screen.queryByTestId('footer-agent')).toBeNull();
    });

    it('renders nothing on the left with no focused pane', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.queryByTestId('footer-cwd')).toBeNull();
    });

    /** §AGNT-063 / §APP-072: the Swift falls back to the literal "claude", not "agent". */
    it('labels a running agent of unknown kind "claude"', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane({
                    status: 'running',
                    agentSessionID: 'session',
                    agentKind: null,
                    agentStartedAt: NOW - 4_000
                })}
            />
        );
        expect(screen.getByTestId('footer-agent').textContent).toBe('claude 4s');
    });
});

// ── §APP-071 / §GIT-092: `doc N +A -B` ──────────────────────────────────────────────

const DIRTY = { kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 } as const;
const CLEAN = { kind: 'clean', changedFiles: 0, additions: 0, deletions: 0 } as const;

function association(worktreePath: string, status: FooterAssociation['status']): FooterAssociation {
    return { worktreePath, status };
}

describe('working-tree diff stats', () => {
    it('matches the pane cwd to the LONGEST worktree prefix', () => {
        const stats = footerGitStats(
            [
                association('/Users/test/code', DIRTY),
                association('/Users/test/code/nex', {
                    kind: 'dirty',
                    changedFiles: 1,
                    additions: 2,
                    deletions: 3
                }),
                association('/Users/test/other', DIRTY)
            ],
            '/Users/test/code/nex/packages'
        );
        expect(stats).toEqual({ changedFiles: 1, additions: 2, deletions: 3 });
    });

    it('is null outside every tracked worktree, and for a clean one', () => {
        expect(footerGitStats([association('/Users/test/code/nex', DIRTY)], '/tmp/elsewhere')).toBeNull();
        expect(footerGitStats([association('/Users/test/code/nex', CLEAN)], '/Users/test/code/nex')).toBeNull();
        // A sibling directory whose name merely starts the same way is NOT inside it.
        expect(
            footerGitStats([association('/Users/test/code/nex', DIRTY)], '/Users/test/code/nex-other')
        ).toBeNull();
    });

    it('renders `doc N` with green additions, red deletions and a spoken label', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane()}
                associations={[association('/Users/test/code/nex', DIRTY)]}
            />
        );
        const segment = screen.getByTestId('footer-git-stats');
        expect(segment.textContent).toBe('3+27-12');
        expect(segment.getAttribute('aria-label')).toBe('3 files changed, 27 added, 12 removed');
        const spans = [...segment.querySelectorAll('span')];
        const additions = spans.find((span) => span.textContent === '+27');
        const deletions = spans.find((span) => span.textContent === '-12');
        expect(additions?.style.color).toBe('rgb(95, 190, 137)');
        expect(deletions?.style.color).toBe('rgb(224, 101, 92)');
    });

    it('shows no stats segment when the pane is not inside a tracked worktree', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane({ workingDirectory: '/tmp/scratch' })}
                associations={[association('/Users/test/code/nex', DIRTY)]}
            />
        );
        expect(screen.queryByTestId('footer-git-stats')).toBeNull();
    });
});

describe('clock and sparkline', () => {
    it('renders a zero-padded HH:MM clock', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('footer-clock').textContent).toBe('09:05');
    });

    /**
     * With neither a stats broadcast nor a sample series there is nothing to draw, and the
     * footer draws nothing — no slot, no chip. The empty-slot placeholder existed to stop the
     * counts jumping when a sampler eventually landed; now that one has (APP-078), the honest
     * rendering for "nobody has told us what the machine is doing" is an absence.
     */
    it('renders no sparkline slot at all when nothing has supplied data', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.queryByTestId('sparkline-placeholder')).toBeNull();
        expect(screen.queryByTestId('sparkline')).toBeNull();
        expect(screen.queryByTestId('system-stats')).toBeNull();
    });

    it('holds the slot but paints nothing while a supplied series is too short to draw', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} sparklineSamples={[1]} />);
        const placeholder = screen.getByTestId('sparkline-placeholder');
        // It PAINTS nothing: the audit photographed the old 6 %-white fill as an empty chip
        // sitting in the footer (run-B m2).
        expect((placeholder as HTMLElement).style.background).toBe('transparent');
    });

    it('plots a supplied series auto-scaled to its own maximum', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} sparklineSamples={[1, 4, 2, 8]} />);
        const svg = screen.getByTestId('sparkline');
        expect(svg.querySelector('polyline')?.getAttribute('points')).toBe(
            '0.00,9.25 9.33,5.50 18.67,8.00 28.00,0.50'
        );
    });
});

// ── system-stat gauges (APP-080…APP-083) ────────────────────────────────────────────

/**
 * The footer's right cluster. These assertions are about the rules a gauge row has to obey
 * rather than its pixels: the canonical order, the fixed slot that stops the clock shuffling
 * sideways, the two sparkline scales, and the hover popover.
 */
function statsView(patch: Partial<SystemStatsView> = {}): SystemStatsView {
    return {
        stats: {
            ...ZERO_SYSTEM_STATS,
            cpuPercent: 42,
            memUsedBytes: 4 * 1024 ** 3,
            memTotalBytes: 16 * 1024 ** 3,
            loadAverage1m: 1.25,
            netDownBytesPerSec: 1_200_000,
            netUpBytesPerSec: 88_000
        },
        history: { cpu: [10, 40, 42], memory: [25, 25, 25], load: [1, 1.2, 1.25], network: [0, 500, 1_288_000] },
        intervalMs: 2000,
        showSystemStats: true,
        enabled: ['cpu', 'memory', 'load'],
        showGraphs: false,
        graphStyle: 'line',
        graphColor: '',
        graphWidth: 28,
        ...patch
    };
}

describe('system-stat gauges', () => {
    it('renders the enabled metrics in canonical order with compact values', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ enabled: ['load', 'cpu'] })} />);
        const row = screen.getByTestId('system-stats');
        const rendered = within(row)
            .getAllByRole('button')
            .map((node) => node.getAttribute('data-testid'));
        expect(rendered).toEqual(['stat-gauge-cpu', 'stat-gauge-load']);
        expect(screen.getByTestId('stat-gauge-cpu').dataset['value']).toBe('42%');
        expect(screen.getByTestId('stat-gauge-load').dataset['value']).toBe('1.25');
    });

    // APP-081: the icon+value cluster sits in a fixed per-kind slot, so the value's right edge
    // — and the clock after it — never moves as 9% becomes 100%.
    it('gives each kind its fixed-width slot', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ enabled: ['cpu', 'network'] })} />);
        const slot = (kind: string): string =>
            (screen.getByTestId(`stat-gauge-${kind}`).firstElementChild as HTMLElement).style.width;
        expect(slot('cpu')).toBe('44px');
        expect(slot('network')).toBe('60px');
    });

    // SET-042: the master toggle removes the row entirely, it does not merely blank the values.
    it('renders no gauges at all when the master toggle is off', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ showSystemStats: false })} />);
        expect(screen.queryByTestId('system-stats')).toBeNull();
        expect(screen.getByTestId('count-running')).toBeDefined();
    });

    it('draws inline sparklines only when mini graphs are on', () => {
        const view = render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView()} />);
        expect(screen.queryByTestId('stat-sparkline-cpu')).toBeNull();
        view.rerender(
            <StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ showGraphs: true })} />
        );
        expect(screen.getByTestId('stat-sparkline-cpu').getAttribute('data-samples')).toBe('3');
    });

    // APP-082: a percentage metric is pinned to 0…100 so a 10–42 % trace reads as low, while a
    // rate metric auto-scales so its shape is legible at all.
    it('scales a percentage metric to 100 and a rate metric to its own window max', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                systemStats={statsView({ showGraphs: true, enabled: ['cpu', 'network'] })}
            />
        );
        const cpu = screen.getByTestId('stat-sparkline-cpu').querySelector('polyline');
        const network = screen.getByTestId('stat-sparkline-network').querySelector('polyline');
        // cpu 10/40/42 against a fixed 100 stays in the lower third of an 11px box.
        expect(cpu?.getAttribute('points')).toBe('0.00,9.50 14.00,6.50 28.00,6.30');
        // network 0/500/1288000 against its own max touches both the floor and the ceiling.
        expect(network?.getAttribute('points')).toBe('0.00,10.50 14.00,10.50 28.00,0.50');
    });

    it('draws the stacked-dots style as dots rather than a line', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                systemStats={statsView({ showGraphs: true, graphStyle: 'dots' })}
            />
        );
        const svg = screen.getByTestId('stat-sparkline-cpu');
        expect(svg.querySelector('polyline')).toBeNull();
        expect(svg.querySelectorAll('circle').length).toBeGreaterThan(0);
    });

    // APP-083: the hover popover — name, breakdown, big graph, now/min/max/avg, footnote.
    it('opens a detail popover on hover with the breakdown and the window summary', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ enabled: ['memory'] })} />);
        expect(screen.queryByTestId('stat-popover-memory')).toBeNull();
        fireEvent.mouseEnter(screen.getByTestId('stat-gauge-memory'));
        const popover = screen.getByTestId('stat-popover-memory');
        expect(within(popover).getByTestId('stat-detail-memory').textContent).toBe('4.0G / 16.0G');
        expect(popover.textContent).toContain('Memory');
        expect(popover.textContent).toContain('now');
        expect(popover.textContent).toContain('avg');
        // The footnote is derived from the daemon's cadence, so it cannot go stale.
        expect(popover.textContent).toContain('last 3 samples · ~6s');
        fireEvent.mouseLeave(screen.getByTestId('stat-gauge-memory'));
        expect(screen.queryByTestId('stat-popover-memory')).toBeNull();
    });

    // The Swift gauge is mouse-only; a keyboard user could never reach the detail. Same
    // content, one more way in.
    it('opens the same popover on keyboard focus', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} systemStats={statsView({ enabled: ['cpu'] })} />);
        fireEvent.focus(screen.getByTestId('stat-gauge-cpu'));
        expect(screen.getByTestId('stat-popover-cpu')).toBeDefined();
    });

    it('uses the custom graph colour, falling back to the chrome tone when it is blank', () => {
        const view = render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                systemStats={statsView({ showGraphs: true, graphColor: '#ff8800', enabled: ['cpu'] })}
            />
        );
        expect(
            screen.getByTestId('stat-sparkline-cpu').querySelector('polyline')?.getAttribute('stroke')
        ).toBe('#ff8800');
        view.rerender(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                systemStats={statsView({ showGraphs: true, graphColor: '', enabled: ['cpu'] })}
            />
        );
        // The adaptive default is the footer's own secondary token, so a reset follows the
        // palette instead of freezing whatever hex an imported theme happened to carry.
        expect(
            screen.getByTestId('stat-sparkline-cpu').querySelector('polyline')?.getAttribute('stroke')
        ).toContain('--nex-fg-secondary');
    });

    it('honours the configured graph width', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                systemStats={statsView({ showGraphs: true, graphWidth: 60, enabled: ['cpu'] })}
            />
        );
        expect(screen.getByTestId('stat-sparkline-cpu').getAttribute('width')).toBe('60');
    });
});
