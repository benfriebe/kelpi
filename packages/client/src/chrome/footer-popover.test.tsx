/**
 * The status footer's agent-count popover: dismissal (H15), anchoring (M20), hover (H11).
 *
 * `StatusBarView.swift:272-283` presents it as `.popover(isPresented:arrowEdge: .top)` attached
 * to the `StatusCountItem` that was clicked — an `NSPopover`, so it rises out of THAT chip and
 * closes on any outside click or on Escape. The port pinned one shared node at `bottom-7 right-3`
 * that could only be closed by re-clicking the same count or picking a row, and
 * `grep -n addEventListener StatusFooter.tsx` returned nothing at all: the panel stayed parked
 * over the pane grid while the user typed.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusFooter, bucketPopoverPlacement, type StatusBarItem } from './index';
import { BUCKET_POPOVER_WIDTH_PX } from './StatusFooter';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const NOW = new Date(2026, 0, 2, 9, 5, 0).getTime();
const SUMMARY = { running: 2, waiting: 1, inactive: 3 };

function items(count = 1): readonly StatusBarItem[] {
    return Array.from({ length: count }, (_unused, index) => ({
        paneID: `${P1}${String(index)}`,
        workspaceID: W1,
        workspaceName: 'alpha',
        workspaceColor: 'blue' as const,
        paneTitle: 'claude',
        status: 'running' as const,
        agentStartedAt: NOW - 249_000
    }));
}

function renderFooter(onSelectPane = vi.fn()): void {
    render(
        <StatusFooter
            summary={SUMMARY}
            now={NOW}
            bucketItems={() => items()}
            onSelectPane={onSelectPane}
        />
    );
}

describe('dismissal (§H15)', () => {
    it('closes on a mousedown anywhere outside it', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-running'));
        expect(screen.getByTestId('bucket-popover')).toBeTruthy();

        fireEvent.mouseDown(screen.getByTestId('footer-left'));
        expect(screen.queryByTestId('bucket-popover')).toBeNull();
    });

    it('closes on Escape', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-waiting'));
        expect(screen.getByTestId('bucket-popover')).toBeTruthy();

        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(screen.queryByTestId('bucket-popover')).toBeNull();
    });

    it('stays open for a mousedown INSIDE it, so a row can still be clicked', () => {
        const onSelectPane = vi.fn();
        renderFooter(onSelectPane);
        fireEvent.click(screen.getByTestId('count-running'));
        const row = screen.getByTestId('bucket-row');

        fireEvent.mouseDown(row);
        expect(screen.getByTestId('bucket-popover')).toBeTruthy();
        fireEvent.click(row);
        expect(onSelectPane).toHaveBeenCalledWith(W1, `${P1}0`);
        expect(screen.queryByTestId('bucket-popover')).toBeNull();
    });

    it('the chip that opened it still closes it — the dismiss must not race its own toggle', () => {
        renderFooter();
        const chip = screen.getByTestId('count-running');
        fireEvent.click(chip);
        expect(screen.getByTestId('bucket-popover')).toBeTruthy();

        // A real click is mousedown → mouseup → click. The mousedown lands on the anchor, which
        // the keep-list excludes, so only the toggle acts and the panel closes exactly once.
        fireEvent.mouseDown(chip);
        fireEvent.click(chip);
        expect(screen.queryByTestId('bucket-popover')).toBeNull();
    });

    it('switching buckets from another chip keeps a panel open, on the new bucket', () => {
        renderFooter();
        fireEvent.mouseDown(screen.getByTestId('count-running'));
        fireEvent.click(screen.getByTestId('count-running'));
        expect(screen.getByTestId('bucket-popover').getAttribute('aria-label')).toBe('Running agents');

        fireEvent.mouseDown(screen.getByTestId('count-inactive'));
        fireEvent.click(screen.getByTestId('count-inactive'));
        expect(screen.getByTestId('bucket-popover').getAttribute('aria-label')).toBe('Inactive agents');
    });

    it('nothing is listening while it is closed', () => {
        renderFooter();
        // No panel: an Escape here must not be consumed on the footer's behalf.
        const behind = vi.fn();
        window.addEventListener('keydown', behind);
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(behind).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', behind);
    });
});

describe('anchoring (§M20)', () => {
    const row = { left: 0, width: 1440 };

    it('centres the panel on the chip that opened it', () => {
        const placement = bucketPopoverPlacement({ left: 700, width: 60 }, row);
        expect(placement).not.toBeNull();
        /*
         * Chip centre 730 − half the panel = 603. The panel is 254 rather than the Swift's flat
         * 252 because it is a `border-box` div: SPACING-REVIEW S31 added the two 1 px edges so
         * the CONTENT box is the shipped 228, the way §L49 already settled the stat popover.
         */
        expect(placement?.left).toBe(603);
        // …and the arrow points back at the centre: 730 − 603 − half the 8 px beak.
        expect(placement?.arrowLeft).toBe(123);
    });

    it('clamps to the row rather than hanging off the trailing edge', () => {
        const placement = bucketPopoverPlacement({ left: 1400, width: 30 }, row);
        expect(placement?.left).toBe(1440 - BUCKET_POPOVER_WIDTH_PX - 8);
        // …and the arrow follows the chip inside the clamped panel rather than staying centred:
        // chip centre 1415, panel at 1178, minus half the 8 px beak (S31: 254, not 252).
        expect(placement?.arrowLeft).toBe(233);
        expect(placement?.arrowLeft).toBeLessThanOrEqual(BUCKET_POPOVER_WIDTH_PX - 16);
    });

    it('clamps to the leading edge too', () => {
        const placement = bucketPopoverPlacement({ left: 2, width: 20 }, row);
        expect(placement?.left).toBe(8);
        expect(placement?.arrowLeft).toBe(16);
    });

    it('measures relative to the ROW, not the window — the footer now spans it (§H2)', () => {
        const placement = bucketPopoverPlacement({ left: 900, width: 60 }, { left: 220, width: 1000 });
        // Chip centre 930, row-relative 710, minus half the 254 px panel (S31).
        expect(placement?.left).toBe(583);
    });

    it('returns null when there is nothing to measure, so the caller keeps its old placement', () => {
        expect(bucketPopoverPlacement({ left: 0, width: 0 }, { left: 0, width: 0 })).toBeNull();
        expect(bucketPopoverPlacement({ left: 0, width: 10 }, { left: 0, width: 260 })).toBeNull();
    });

    it('anchors to the chip once there IS a measurement, arrow and all', () => {
        /*
         * jsdom has no layout, so the wiring from "the chip's rect" to "the panel's left" can
         * only be exercised by supplying the rects. Everything else is real: the layout effect,
         * the state, and the style the component renders from it.
         */
        const boxes: Record<string, { left: number; width: number }> = {
            'status-footer': { left: 0, width: 1440 },
            'count-running': { left: 1000, width: 60 }
        };
        const original = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
            const box = boxes[this.dataset['testid'] ?? ''];
            if (box === undefined) return original.call(this);
            return {
                x: box.left,
                y: 0,
                left: box.left,
                right: box.left + box.width,
                top: 0,
                bottom: 24,
                width: box.width,
                height: 24,
                toJSON: () => ({})
            } as DOMRect;
        };
        try {
            renderFooter();
            fireEvent.click(screen.getByTestId('count-running'));
            const popover = screen.getByTestId('bucket-popover');
            expect(popover.dataset['anchored']).toBe('true');
            expect(popover.className).not.toContain('right-3');
            // Chip centre 1030 − half the 254 px panel (S31) = 903.
            expect(popover.style.left).toBe('903px');
            expect(screen.getByTestId('bucket-popover-arrow').style.left).toBe('123px');
        } finally {
            HTMLElement.prototype.getBoundingClientRect = original;
        }
    });

    it('falls back to the trailing placement in a layout-less document', () => {
        // jsdom has no layout: every rect is zero, so the measurement is refused and the panel
        // renders where it always did rather than clamped to a nonsense edge.
        renderFooter();
        fireEvent.click(screen.getByTestId('count-running'));
        const popover = screen.getByTestId('bucket-popover');
        expect(popover.dataset['anchored']).toBe('false');
        expect(popover.className).toContain('right-3');
        expect(screen.queryByTestId('bucket-popover-arrow')).toBeNull();
    });
});

/**
 * §M21 — `AgentStatusDetailPopover` is a surface with its own type scale, and the port had
 * flattened it into the 11 px status row: 8 px of padding, a title with no size or weight of
 * its own, 6 px dots, and rows sitting flush against each other.
 * `StatusBarView.swift:340-408` is `.padding(12)` around a `VStack(spacing: 6)` whose title is
 * `.system(size: 13, weight: .semibold)`, whose dots are 7 pt, and whose rows are 12 pt in a
 * `VStack(spacing: 2)` with `.padding(.vertical, 3).padding(.horizontal, 4)`.
 */
describe('popover typography (§M21)', () => {
    it('pads 12 and stacks at 6, not 8 and 4', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-running'));
        const popover = screen.getByTestId('bucket-popover');
        expect(popover.className).toContain('p-3');
        expect(popover.className).not.toContain('p-2');
        // `VStack(alignment: .leading, spacing: 6)`.
        expect(popover.className).toContain('flex-col');
        expect(popover.className).toContain('gap-1.5');
        // The rows are 12 pt, so the panel does not inherit the footer row's 11.
        expect(popover.className).toContain('text-[12px]');
    });

    it('gives the title its own size and weight, over a 7 px dot', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-waiting'));
        const title = screen.getByTestId('bucket-popover-title');
        expect(title.textContent).toContain('Awaiting input');
        expect(title.className).toContain('text-[13px]');
        expect(title.className).toContain('font-semibold');
        // `.padding(.bottom, 2)` on the header, on top of the stack's own 6.
        expect(title.className).toContain('pb-[2px]');
        const dot = title.querySelector('span[aria-hidden]');
        expect(dot?.className).toContain('h-[7px]');
        expect(dot?.className).toContain('w-[7px]');
    });

    it('separates the rows by 2 px and pads them 3 × 4', () => {
        render(
            <StatusFooter summary={SUMMARY} now={NOW} bucketItems={() => items(3)} onSelectPane={vi.fn()} />
        );
        fireEvent.click(screen.getByTestId('count-running'));
        const rows = screen.getByTestId('bucket-popover-rows');
        expect(rows.className).toContain('gap-[2px]');
        expect(rows.children).toHaveLength(3);
        const row = screen.getAllByTestId('bucket-row')[0];
        /*
         * Inline rather than `px-1 py-[3px]`. It had to be: `styles.css`'s `button { padding: 0 }`
         * was UNLAYERED and beat Tailwind's layered utilities, so the classes the row used to
         * carry painted nothing at all (the audit read `padding-top: 0px` through a `py-1`).
         * S1/S17 moved that reset into `@layer base`, so a class would land now — the assertion
         * is unchanged, only its reason is: 3/4 is §M21's stated number and the style is where
         * it lives.
         */
        expect(row?.style.padding).toBe('3px 4px');
        const dot = row?.querySelector('span[aria-hidden]');
        expect(dot?.className).toContain('h-[7px]');
    });

    it('the empty state is a row of the same 12 px, not the footer’s 11', () => {
        render(<StatusFooter summary={SUMMARY} now={NOW} bucketItems={() => []} />);
        fireEvent.click(screen.getByTestId('count-inactive'));
        const popover = screen.getByTestId('bucket-popover');
        expect(popover.textContent).toContain('None.');
        // Inherited from the panel, which is where the Swift's `.font(.system(size: 12))` on
        // "None." and on every row comes to the same thing.
        expect(popover.className).toContain('text-[12px]');
        expect(screen.queryByTestId('bucket-popover-rows')).toBeNull();
    });
});

/**
 * §M22 — a zero count is inert, not dimmed. `StatusBarView.swift:284-301` builds `countLabel`
 * once, with one unconditional `.foregroundStyle(theme.textSecondary)`, and the comment beside
 * the branch says so: "0-count items stay plain (un-dimmed, non-clickable)".
 */
describe('zero counts (§M22)', () => {
    it('a zero count is not a button, and not dimmed either', () => {
        render(<StatusFooter summary={{ running: 0, waiting: 2, inactive: 0 }} now={NOW} />);
        const zero = screen.getByTestId('count-running');
        const live = screen.getByTestId('count-waiting');
        expect(zero.tagName).toBe('SPAN');
        expect(live.tagName).toBe('BUTTON');
        // Same tone on both — the only difference a 0 makes is that it cannot be clicked.
        expect(zero.style.color).not.toBe('');
        expect(zero.style.color).toBe(live.style.color);
    });

    it('all three zero counts read the same as a live one', () => {
        render(<StatusFooter summary={{ running: 0, waiting: 0, inactive: 0 }} now={NOW} />);
        const colors = ['running', 'waiting', 'inactive'].map(
            (bucket) => screen.getByTestId(`count-${bucket}`).style.color
        );
        expect(new Set(colors).size).toBe(1);
        // The footer row's own tone is `textSecondary`; the chips must not be a step below it.
        expect(colors[0]).toBe(screen.getByTestId('status-footer').style.color);
    });
});

describe('hover (§H11)', () => {
    it('a count chip answers the pointer', () => {
        renderFooter();
        const chip = screen.getByTestId('count-running');
        expect(chip.dataset['hovered']).toBe('false');
        fireEvent.mouseEnter(chip);
        expect(chip.dataset['hovered']).toBe('true');
        fireEvent.mouseLeave(chip);
        expect(chip.dataset['hovered']).toBe('false');
    });

    it('the chip whose popover is open stays lit while the pointer is away in the panel', () => {
        renderFooter();
        const chip = screen.getByTestId('count-running');
        fireEvent.click(chip);
        expect(chip.dataset['hovered']).toBe('true');
    });

    it('a popover row lights up under the pointer, like every other menu row', () => {
        renderFooter();
        fireEvent.click(screen.getByTestId('count-running'));
        const row = screen.getByTestId('bucket-row');
        expect(row.dataset['hovered']).toBe('false');
        fireEvent.mouseEnter(row);
        expect(row.dataset['hovered']).toBe('true');
        expect(row.style.background).not.toBe('');
        fireEvent.mouseLeave(row);
        expect(row.dataset['hovered']).toBe('false');
    });

    it('an inert (zero) count is not a control and never lights up', () => {
        render(<StatusFooter summary={{ running: 0, waiting: 0, inactive: 0 }} now={NOW} />);
        const chip = screen.getByTestId('count-running');
        expect(chip.tagName).toBe('SPAN');
        expect(chip.dataset['hovered']).toBeUndefined();
    });
});
