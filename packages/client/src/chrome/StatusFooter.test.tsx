import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { ZERO_SYSTEM_STATS } from '@kelpi/protocol';

import {
    StatusFooter,
    clockLabel,
    fitStatGauges,
    footerGitStats,
    statGaugeWidth,
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
        workingDirectory: '/Users/test/code/kelpi',
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
        expect(screen.getByTestId('footer-cwd').textContent).toBe('~/code/kelpi');
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

/** An association as the DAEMON now ships it: literal root plus its symlink-resolved twin. */
function canonicalAssociation(
    worktreePath: string,
    worktreePathReal: string,
    status: FooterAssociation['status']
): FooterAssociation {
    return { worktreePath, worktreePathReal, status };
}

describe('working-tree diff stats', () => {
    it('matches the pane cwd to the LONGEST worktree prefix', () => {
        const stats = footerGitStats(
            [
                association('/Users/test/code', DIRTY),
                association('/Users/test/code/kelpi', {
                    kind: 'dirty',
                    changedFiles: 1,
                    additions: 2,
                    deletions: 3
                }),
                association('/Users/test/other', DIRTY)
            ],
            '/Users/test/code/kelpi/packages'
        );
        expect(stats).toEqual({ changedFiles: 1, additions: 2, deletions: 3 });
    });

    it('is null outside every tracked worktree, and for a clean one', () => {
        expect(footerGitStats([association('/Users/test/code/kelpi', DIRTY)], '/tmp/elsewhere')).toBeNull();
        expect(footerGitStats([association('/Users/test/code/kelpi', CLEAN)], '/Users/test/code/kelpi')).toBeNull();
        // A sibling directory whose name merely starts the same way is NOT inside it.
        expect(
            footerGitStats([association('/Users/test/code/kelpi', DIRTY)], '/Users/test/code/kelpi-other')
        ).toBeNull();
    });

    it('renders `doc N` with green additions, red deletions and a spoken label', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane()}
                associations={[association('/Users/test/code/kelpi', DIRTY)]}
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
                associations={[association('/Users/test/code/kelpi', DIRTY)]}
            />
        );
        expect(screen.queryByTestId('footer-git-stats')).toBeNull();
    });
});

// ── §APP-071 / §GIT-092, audit ledger N5: symlinked ancestors ───────────────────────
//
// The defect that made this item's four green tests worthless: the association's root is git's
// PHYSICAL path (`rev-parse --show-toplevel` → `/private/var/…`) and the pane's cwd is the
// LOGICAL one its shell reported (`/var/…`). Every repo under a symlinked ancestor — all of
// `/tmp` and `/var` on macOS, a symlinked `$HOME` — failed the prefix test and the segment drew
// nothing at all. The fixture below is a REAL symlink on disk rather than two hand-typed
// strings, because two hand-typed strings are precisely what shipped last time.

describe('a repository under a symlinked ancestor (N5)', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-footer-n5-')));
    fs.mkdirSync(path.join(base, 'tree', 'repo', 'packages'), { recursive: true });
    fs.symlinkSync(path.join(base, 'tree'), path.join(base, 'link'), 'dir');

    /** What the shell reports / the pane was spawned with. */
    const logicalCwd = path.join(base, 'link', 'repo');
    /** What `git rev-parse --show-toplevel` answers, and what the association stores. */
    const physicalRoot = fs.realpathSync(logicalCwd);

    afterAll(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    it('is genuinely the same directory reached by two different strings', () => {
        expect(physicalRoot).not.toBe(logicalCwd);
        expect(fs.realpathSync(logicalCwd)).toBe(physicalRoot);
    });

    // BEFORE: only the literal strings existed on the wire, and this is what the footer did.
    it('MISSES when only the literal paths are available — the shipped defect', () => {
        expect(footerGitStats([association(physicalRoot, DIRTY)], logicalCwd)).toBeNull();
    });

    // AFTER: the daemon ships the symlink-resolved twin of both sides and they meet.
    it('MATCHES once the daemon supplies the canonical form of both sides', () => {
        expect(
            footerGitStats(
                [canonicalAssociation(physicalRoot, physicalRoot, DIRTY)],
                logicalCwd,
                fs.realpathSync(logicalCwd)
            )
        ).toEqual({ changedFiles: 3, additions: 27, deletions: 12 });
    });

    it('matches a pane DEEPER inside the symlinked tree too', () => {
        const nested = path.join(logicalCwd, 'packages');
        expect(
            footerGitStats(
                [canonicalAssociation(physicalRoot, physicalRoot, DIRTY)],
                nested,
                fs.realpathSync(nested)
            )
        ).toEqual({ changedFiles: 3, additions: 27, deletions: 12 });
    });

    it('renders the segment end to end for the symlinked pane', () => {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane({
                    workingDirectory: logicalCwd,
                    workingDirectoryReal: physicalRoot
                })}
                associations={[canonicalAssociation(physicalRoot, physicalRoot, DIRTY)]}
            />
        );
        expect(screen.getByTestId('footer-git-stats').textContent).toBe('3+27-12');
        // …and the DISPLAYED cwd is still the logical one the user typed.
        expect(screen.getByTestId('footer-cwd').textContent).toContain('repo');
    });

    it('a sibling of the repo inside the same symlinked tree still shows nothing', () => {
        const sibling = path.join(base, 'link', 'repo-other');
        fs.mkdirSync(path.join(base, 'tree', 'repo-other'), { recursive: true });
        expect(
            footerGitStats(
                [canonicalAssociation(physicalRoot, physicalRoot, DIRTY)],
                sibling,
                fs.realpathSync(sibling)
            )
        ).toBeNull();
    });
});

describe('canonical-path matching rules', () => {
    const LOGICAL = '/var/folders/ab/T/audit/repo';
    const PHYSICAL = '/private/var/folders/ab/T/audit/repo';

    it('falls back to the literal comparison when neither side has a canonical form', () => {
        // An older daemon, or a path realpath could not resolve at all: the pre-N5 behaviour
        // is preserved rather than replaced, so nothing that used to work stops working.
        expect(footerGitStats([association('/Users/test/code/kelpi', DIRTY)], '/Users/test/code/kelpi/x')).toEqual({
            changedFiles: 3,
            additions: 27,
            deletions: 12
        });
    });

    it('matches when only ONE side resolved', () => {
        // Association canonical, pane not (its directory was deleted mid-session): the literal
        // root still matches the literal cwd, so the segment survives.
        expect(
            footerGitStats([canonicalAssociation(LOGICAL, PHYSICAL, DIRTY)], `${LOGICAL}/src`)
        ).toEqual({ changedFiles: 3, additions: 27, deletions: 12 });
    });

    it('ranks nested worktrees by their CANONICAL depth, not by whichever string is longer', () => {
        // The repo's canonical root is LONGER than the nested worktree's logical path, so a
        // naive `.length` race between mixed forms would hand the pane the parent repo's stats.
        const stats = footerGitStats(
            [
                canonicalAssociation(LOGICAL, PHYSICAL, DIRTY),
                canonicalAssociation(`${LOGICAL}/wt`, `${PHYSICAL}/wt`, {
                    kind: 'dirty',
                    changedFiles: 1,
                    additions: 2,
                    deletions: 3
                })
            ],
            `${LOGICAL}/wt/src`,
            `${PHYSICAL}/wt/src`
        );
        expect(stats).toEqual({ changedFiles: 1, additions: 2, deletions: 3 });
    });

    it('treats a trailing slash as the same root', () => {
        expect(
            footerGitStats([canonicalAssociation(`${LOGICAL}/`, `${PHYSICAL}/`, DIRTY)], `${LOGICAL}/src`)
        ).toEqual({ changedFiles: 3, additions: 27, deletions: 12 });
        expect(
            footerGitStats([canonicalAssociation(LOGICAL, PHYSICAL, DIRTY)], `${LOGICAL}/`, `${PHYSICAL}/`)
        ).toEqual({ changedFiles: 3, additions: 27, deletions: 12 });
    });

    it('keeps the prefix boundary: `/repo` never matches `/repo2`', () => {
        expect(
            footerGitStats([canonicalAssociation(LOGICAL, PHYSICAL, DIRTY)], `${LOGICAL}2/src`, `${PHYSICAL}2/src`)
        ).toBeNull();
        expect(
            footerGitStats([canonicalAssociation(`${LOGICAL}/`, `${PHYSICAL}/`, DIRTY)], `${LOGICAL}2`)
        ).toBeNull();
    });

    it('stays case-sensitive — `/Repo` and `/repo` are two repositories', () => {
        expect(
            footerGitStats([canonicalAssociation('/srv/Repo', '/srv/Repo', DIRTY)], '/srv/repo/src')
        ).toBeNull();
    });

    it('is null for a pane with no cwd at all, canonical or otherwise', () => {
        expect(footerGitStats([canonicalAssociation(LOGICAL, PHYSICAL, DIRTY)], '')).toBeNull();
        expect(footerGitStats([canonicalAssociation(LOGICAL, PHYSICAL, DIRTY)], '', '')).toBeNull();
    });

    it('ignores an association with no usable root', () => {
        expect(footerGitStats([canonicalAssociation('', '', DIRTY)], LOGICAL, PHYSICAL)).toBeNull();
    });
});

describe('clock and sparkline', () => {
    /*
     * §M23: was `toBe('09:05')`. The footer now renders the OS format the shipped app renders
     * (`.dateTime.hour().minute()`), so the assertion is the same instant read through the same
     * formatter the component uses — locale-tolerant, and still exact about which minute.
     */
    it('renders the hour+minute clock in the viewer’s locale', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('footer-clock').textContent).toBe(clockLabel(new Date(NOW)));
        expect(screen.getByTestId('footer-clock').textContent).toMatch(/\b0?9[:.]05\b/);
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
        ).toContain('--kelpi-fg-secondary');
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

/**
 * §N6 — the left cluster must CLIP, never spill over the system stats.
 *
 * jsdom has no layout engine, so nothing here can measure an overlap; what it can pin down is
 * the pair of rules that make one impossible, and which were both absent when the defect was
 * found in `run-L/52-footer-git-stats.png` (`⑂ main 🗎 2 +5 -5` painted on top of the CPU
 * chip). The measurement itself belongs to the audit's `footer-git-stats` step, which compares
 * this cluster's bounding rect — and every segment inside it — against the system-stat block's
 * at a deliberately narrow window width.
 */
describe('the left cluster clips instead of overflowing (N6)', () => {
    function renderCrowded(): void {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                homeDirectory="/Users/test"
                focusedPane={pane({
                    workingDirectory: '/Users/test/code/kelpi/packages/client/src/chrome/deeply/nested',
                    gitBranch: 'feature/a-branch-name-long-enough-to-crowd-the-row',
                    status: 'running',
                    agentSessionID: 'session',
                    agentKind: 'claude',
                    agentStartedAt: NOW - 9_000
                })}
                associations={[
                    {
                        worktreePath: '/Users/test/code/kelpi',
                        status: { kind: 'dirty', changedFiles: 2, additions: 5, deletions: 5 }
                    }
                ]}
                systemStats={statsView({ enabled: ['cpu', 'memory', 'load'] })}
            />
        );
    }

    it('hides its own overflow, so nothing can be painted over the right cluster', () => {
        renderCrowded();
        const left = screen.getByTestId('footer-left');
        expect(left.className).toContain('overflow-hidden');
        // …while still being the flexible half of the row: it has to be able to shrink at all.
        expect(left.className).toContain('min-w-0');
        // `flex-auto`, not `flex-1` — the same grow and the same shrink, but a CONTENT basis
        // instead of `0%` (§N7). With a zero basis this cluster asks the row for nothing, and an
        // over-subscribed row hands it exactly that: the 0 px-wide left cluster photographed in
        // run-M/56-footer-git-stats.png, with the path, the branch and the stats all clipped out
        // of existence. `flex-1` must NOT come back.
        expect(left.className).toContain('flex-auto');
        expect(left.className).not.toContain('flex-1');
    });

    it('gives the path the largest shrink factor, so it truncates first', () => {
        renderCrowded();
        const cwd = screen.getByTestId('footer-cwd');
        const branch = screen.getByTestId('footer-branch');
        expect(cwd.className).toContain('truncate');
        expect(cwd.className).toContain('min-w-0');
        expect(Number(cwd.style.flexShrink)).toBeGreaterThan(Number(branch.style.flexShrink));
        expect(Number(branch.style.flexShrink)).toBeGreaterThan(0);
    });

    it('lets the branch NAME truncate rather than holding the chip at its full width', () => {
        renderCrowded();
        const branch = screen.getByTestId('footer-branch');
        expect(branch.className).toContain('min-w-0');
        const name = Array.from(branch.querySelectorAll('span')).find((node) =>
            node.textContent?.includes('feature/')
        );
        expect(name?.className).toContain('truncate');
        // The chip still reads as one label, glyph included (§APP-070).
        expect(branch.textContent).toContain('feature/a-branch-name-long-enough-to-crowd-the-row');
    });

    it('keeps the two fixed segments whole — they are the ones worth reading at any width', () => {
        renderCrowded();
        expect(screen.getByTestId('footer-git-stats').className).toContain('shrink-0');
        expect(screen.getByTestId('footer-agent').className).toContain('shrink-0');
        // …and they still say exactly what they said before the layout change (§APP-071).
        expect(screen.getByTestId('footer-git-stats').getAttribute('aria-label')).toBe(
            '2 files changed, 5 added, 5 removed'
        );
    });
});

/**
 * §N7 — the RIGHT cluster yields, and it yields in a fixed order.
 *
 * The defect N6's fix made legible: the right cluster was `shrink-0` around ~840 px of gauges,
 * counts and clock, so an over-subscribed row could not balance at all — the left cluster was
 * starved to 0 px AND the right one still ran 485 px past the footer's own box, sideways under
 * the inspector (docs/audit/run-M/56-footer-git-stats.png).
 *
 * jsdom cannot measure any of that; what it can pin is the set of rules that make it impossible,
 * every one of which was absent before:
 *   1. the right cluster shrinks at all, and shrinks harder than the left one, so a resize is
 *      contained even in the frame before the next measurement;
 *   2. the gauge row is `shrink-0` and NOT clipped — it is dropped a reading at a time by
 *      `fitStatGauges` instead, because CSS cannot make a flex container yield below its
 *      children's min-content and because every gauge owns a hover popover that a clip would eat;
 *   3. the counts and the clock are `shrink-0` and grouped, so they are never crushed and the
 *      budget can measure exactly what it must leave room for;
 *   4. the row itself still has no `overflow-hidden` — the bucket popover is positioned outside
 *      its box, so nothing over this row may clip.
 * The measurement is the audit's `footer-git-stats` step, which reads every one of these boxes
 * against the footer's own at 1280 / 1060 / 880 px.
 */
describe('the right cluster shrinks in priority order (N7)', () => {
    function renderRight(patch: Partial<SystemStatsView> = {}): void {
        render(
            <StatusFooter
                summary={SUMMARY}
                now={NOW}
                focusedPane={pane()}
                systemStats={statsView({
                    enabled: ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace'],
                    ...patch
                })}
            />
        );
    }

    it('is no longer shrink-0, and gives way 1000× faster than the left cluster', () => {
        renderRight();
        const right = screen.getByTestId('footer-right');
        const left = screen.getByTestId('footer-left');
        expect(right.className).not.toContain('shrink-0');
        expect(Number(right.style.flexShrink)).toBe(1000);
        // The left cluster's shrink factor is the CSS default of 1 (via `flex-auto`), so the
        // right one is three orders of magnitude more willing to give up width.
        expect(left.style.flexShrink).toBe('');
        expect(Number(right.style.flexShrink)).toBeGreaterThan(1);
    });

    it('never zeroes its own minimum — counts and clock are what it refuses to shrink below', () => {
        renderRight();
        const right = screen.getByTestId('footer-right');
        // `min-w-0` here would let flexbox crush the counts; the automatic min-content size IS
        // the contract, so it must stay.
        expect(right.className).not.toContain('min-w-0');
        for (const bucket of ['running', 'waiting', 'inactive']) {
            const count = screen.getByTestId(`count-${bucket}`);
            expect(count.className).toContain('shrink-0');
            expect(count.className).toContain('whitespace-nowrap');
        }
        expect(screen.getByTestId('footer-clock').className).toContain('shrink-0');
    });

    it('renders a gauge whole or not at all — the squeeze removes readings, not digits', () => {
        renderRight();
        const stats = screen.getByTestId('system-stats');
        // NOT clipped and NOT compressible: every gauge owns a hover popover drawn ABOVE the
        // footer, so an `overflow-hidden` here would cut the popovers off at the window edge —
        // which is why the segment is dropped by measurement instead (see `fitStatGauges`).
        expect(stats.className).toContain('shrink-0');
        expect(stats.className).not.toContain('overflow-hidden');
        // …and each reading keeps its fixed slot (§APP-081's fixed per-kind slot).
        const slot = screen.getByTestId('stat-gauge-cpu').firstElementChild as HTMLElement;
        expect(slot.style.width).toBe('44px');
    });

    it('groups the segments it keeps, so the budget can measure exactly what it must leave', () => {
        renderRight();
        const keep = screen.getByTestId('footer-keep');
        expect(keep.className).toContain('shrink-0');
        for (const bucket of ['running', 'waiting', 'inactive']) {
            expect(keep.contains(screen.getByTestId(`count-${bucket}`))).toBe(true);
        }
        expect(keep.contains(screen.getByTestId('footer-clock'))).toBe(true);
        // The gauges are deliberately OUTSIDE it: they are the part that goes.
        expect(keep.contains(screen.getByTestId('system-stats'))).toBe(false);
    });

    it('renders every gauge while no measurement has been taken (jsdom, first paint)', () => {
        // `useFooterGaugeBudget` returns null without a ResizeObserver, and null means "all of
        // them" — the behaviour the row had before the budget existed.
        renderRight();
        expect(
            within(screen.getByTestId('system-stats'))
                .getAllByRole('button')
                .map((node) => node.getAttribute('data-testid'))
        ).toEqual([
            'stat-gauge-cpu',
            'stat-gauge-memory',
            'stat-gauge-load',
            'stat-gauge-network',
            'stat-gauge-diskIO',
            'stat-gauge-diskSpace'
        ]);
    });

    it('leaves the row itself unclipped, so the bucket popover can still escape it', () => {
        renderRight();
        const row = screen.getByTestId('status-footer');
        expect(row.className).not.toContain('overflow-hidden');
        expect(row.className).toContain('relative');
        fireEvent.click(screen.getByTestId('count-running'));
        const popover = screen.getByTestId('bucket-popover');
        // Anchored to the row, drawn ABOVE it — the thing `overflow-hidden` on the row would eat.
        expect(popover.className).toContain('absolute');
        expect(popover.className).toContain('bottom-7');
        expect(row.contains(popover)).toBe(true);
    });

    it('keeps the standalone sparkline slot on the same terms as the gauge row', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} sparklineSamples={[1, 4, 2, 8]} />);
        const slot = screen.getByTestId('sparkline').parentElement as HTMLElement;
        expect(slot.className).toContain('shrink-0');
        expect(slot.className).not.toContain('overflow-hidden');
    });
});

/**
 * §N7's arithmetic, on its own.
 *
 * The decision the footer cannot express in CSS: a flex container's min-content size counts its
 * children's min-content sizes whatever their `min-width`, so the gauge row's intrinsic width
 * propagates out through the right cluster and makes it unshrinkable below ~840 px — which is
 * how a `shrink-0` right cluster came to run 485 px past the footer's own box while starving the
 * left one to 0. The fix is to decide how many gauges fit and render only those; this is that
 * decision, held still.
 */
describe('fitStatGauges (N7)', () => {
    const width = (kind: string): number => statGaugeWidth(kind, { showGraph: false, graphWidth: 28 });
    const all = ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace'] as const;

    it('measures a gauge as its fixed slot, plus its sparkline when graphs are on', () => {
        expect(statGaugeWidth('cpu', { showGraph: false, graphWidth: 28 })).toBe(44);
        expect(statGaugeWidth('cpu', { showGraph: true, graphWidth: 28 })).toBe(44 + 3 + 28);
        expect(statGaugeWidth('network', { showGraph: false, graphWidth: 28 })).toBe(60);
        // An unknown kind measures 0 rather than throwing: it renders nothing either.
        expect(statGaugeWidth('nonsense', { showGraph: true, graphWidth: 28 })).toBe(0);
    });

    it('keeps every gauge when no measurement has been taken', () => {
        expect(fitStatGauges(all, Number.POSITIVE_INFINITY, width)).toEqual(all);
    });

    it('drops from the TAIL, so the canonical order is the priority order', () => {
        // cpu(44) + 14 + memory(44) = 102; the next gap+load would need 108 more.
        expect(fitStatGauges(all, 102, width)).toEqual(['cpu', 'memory']);
        expect(fitStatGauges(all, 101, width)).toEqual(['cpu']);
        expect(fitStatGauges(all, 44, width)).toEqual(['cpu']);
    });

    it('drops the whole row when even the first one does not fit — including a negative budget', () => {
        expect(fitStatGauges(all, 43, width)).toEqual([]);
        expect(fitStatGauges(all, 0, width)).toEqual([]);
        expect(fitStatGauges(all, -120, width)).toEqual([]);
    });

    it('charges the gap only BETWEEN gauges, never before the first', () => {
        const two = fitStatGauges(['cpu', 'memory'] as const, 102, width);
        expect(two).toEqual(['cpu', 'memory']);
        // The same budget minus one pixel loses the second one, which is where the gap lives.
        expect(fitStatGauges(['cpu', 'memory'] as const, 101, width)).toEqual(['cpu']);
    });

    it('counts the sparkline when graphs are on, so a graphed row drops sooner', () => {
        const graphed = (kind: string): number => statGaugeWidth(kind, { showGraph: true, graphWidth: 28 });
        expect(fitStatGauges(all, 102, graphed)).toEqual(['cpu']);
        expect(fitStatGauges(all, 74, graphed)).toEqual([]);
    });
});

/**
 * §N7 residue — the budget is re-measured when the LEFT cluster's content changes, not only
 * when the row resizes. Focusing a repo pane swaps `~` for a long path plus the branch and
 * stats chips without the row ever changing size; run-O attempt 1 showed the gauges keeping
 * the budget they took beside an almost-empty cluster, squeezing the path to 0 px at every
 * width. Real geometry is stubbed per node so the measurement actually runs under jsdom.
 */
describe('the budget re-measures when the left cluster content changes (§N7 residue)', () => {
    const ROW_WIDTH = 780;
    const KEEP_WIDTH = 175;
    let wanted = 30;
    let rectSpy: ReturnType<typeof vi.spyOn> | null = null;
    const originalScrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');

    const install = (): void => {
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe(): void {}
                unobserve(): void {}
                disconnect(): void {}
            }
        );
        rectSpy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                const id = this.getAttribute('data-testid');
                const width = id === 'status-footer' ? ROW_WIDTH : id === 'footer-keep' ? KEEP_WIDTH : 0;
                return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 24, toJSON: () => ({}) } as DOMRect;
            });
        // On the CHILD, not the container: the cluster's children shrink, so the container
        // never overflows — the truncated path span is what still reports its full content.
        Object.defineProperty(Element.prototype, 'scrollWidth', {
            configurable: true,
            get(this: Element) {
                return this.getAttribute('data-testid') === 'footer-cwd' ? wanted : 0;
            }
        });
    };
    const restore = (): void => {
        vi.unstubAllGlobals();
        rectSpy?.mockRestore();
        rectSpy = null;
        if (originalScrollWidth !== undefined) {
            Object.defineProperty(Element.prototype, 'scrollWidth', originalScrollWidth);
        }
    };

    it('yields tail gauges to the reserve once a repo pane fills the cluster', () => {
        install();
        try {
            wanted = 30; // the home pane's `~`: the cluster wants almost nothing
            const home = '/Users/test';
            const view = render(
                <StatusFooter
                    summary={SUMMARY}
                    now={NOW}
                    homeDirectory={home}
                    focusedPane={pane({ workingDirectory: home })}
                    systemStats={statsView({
                        enabled: ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace']
                    })}
                />
            );
            const rendered = (): string[] =>
                within(screen.getByTestId('system-stats'))
                    .getAllByRole('button')
                    .map((node) => node.getAttribute('data-testid') ?? '');
            // Beside `~` the reserve is capped at what the cluster WANTS, so all six fit.
            expect(rendered()).toHaveLength(6);

            // Focus a repo pane: long path + branch + stats — the row itself never resizes.
            wanted = 320;
            const repo = '/private/var/folders/zz/audit/worktrees/repo';
            view.rerender(
                <StatusFooter
                    summary={SUMMARY}
                    now={NOW}
                    homeDirectory={home}
                    focusedPane={pane({ workingDirectory: repo, gitBranch: 'main' })}
                    associations={[association(repo, DIRTY)]}
                    systemStats={statsView({
                        enabled: ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace']
                    })}
                />
            );
            const after = rendered();
            // The reserve (220) now binds: the tail gauge yields to the path instead of the
            // path being starved to 0 px. What survives is a canonical-order PREFIX.
            expect(after.length).toBeLessThan(6);
            expect(after.length).toBeGreaterThan(0);
            expect(after).not.toContain('stat-gauge-diskSpace');
            expect(after[0]).toBe('stat-gauge-cpu');
        } finally {
            restore();
        }
    });
});
