/**
 * The status footer's density pack — `../kelpi-docs/SPACING-REVIEW.md` S31.
 *
 * One row, one number, and the arithmetic behind it: `AgentStatusDetailPopover` is
 * `.padding(12).frame(width: 252)` (`StatusBarView.swift:367-368`), i.e. a **228 pt content
 * box** with the `NSPopover`'s chrome outside that frame. This panel is a `border-box` div with
 * a 1 px border, so the bare Swift number spent 13 px a side and left a 226 px row — measured,
 * on every bucket row. §L49 had already made this argument for the stat popover and shipped it
 * at `w-[222px]` (220 + the edge); the two popovers simply disagreed about how to count.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusFooter, type StatusBarItem } from './index';
import { BUCKET_POPOVER_WIDTH_PX } from './StatusFooter';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const NOW = new Date(2026, 0, 2, 9, 5, 0).getTime();

function items(): readonly StatusBarItem[] {
    return [
        {
            paneID: P1,
            workspaceID: W1,
            workspaceName: 'alpha',
            workspaceColor: 'blue' as const,
            paneTitle: 'claude',
            status: 'running' as const,
            agentStartedAt: NOW - 249_000
        }
    ];
}

function renderFooter(): void {
    render(
        <StatusFooter
            summary={{ running: 2, waiting: 1, inactive: 3 }}
            now={NOW}
            bucketItems={items}
            onSelectPane={vi.fn()}
        />
    );
}

describe('S31 — the bucket popover carries its own border', () => {
    it('is 254 wide, so the CONTENT box is the shipped 228', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-running'));
        const panel = screen.getByTestId('bucket-popover');
        expect(panel.className).toContain('w-[254px]');
        expect(panel.className).not.toContain('w-[252px]');
        // 254 − 2 × (12 padding + 1 border) = 228, the `.frame(width: 252)` minus `.padding(12)`.
        expect(panel.className).toContain('p-3');
        expect(BUCKET_POPOVER_WIDTH_PX - 2 * (12 + 1)).toBe(228);
    });

    it('anchors from the same number it paints, or the beak would miss its chip', () => {
        // The placement math and the class are one metric: §M20 centres the panel on the chip
        // using this constant, so a panel that paints 254 and anchors 252 is off by a pixel.
        expect(BUCKET_POPOVER_WIDTH_PX).toBe(254);
    });
});
