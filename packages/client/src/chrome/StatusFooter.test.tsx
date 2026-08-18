import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusFooter, type ChromePane, type StatusBarItem } from './index';

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
});

describe('clock and sparkline', () => {
    it('renders a zero-padded HH:MM clock', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('footer-clock').textContent).toBe('09:05');
    });

    it('keeps the sparkline slot as a placeholder until there are two samples', () => {
        const view = render(<StatusFooter summary={SUMMARY} now={NOW} />);
        expect(screen.getByTestId('sparkline-placeholder')).toBeDefined();

        view.rerender(<StatusFooter summary={SUMMARY} now={NOW} sparklineSamples={[1, 4, 2, 8]} />);
        const svg = screen.getByTestId('sparkline');
        expect(svg.querySelector('polyline')?.getAttribute('points')).toBe(
            '0.00,9.63 9.33,5.50 18.67,8.25 28.00,0.00'
        );
    });
});
