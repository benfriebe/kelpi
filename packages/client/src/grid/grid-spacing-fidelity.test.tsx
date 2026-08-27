/**
 * The SPACING-REVIEW pane-grid rows — `docs/SPACING-REVIEW.md` S8, S16, S19, S20, S30.
 *
 * The register is a DENSITY one: every row here is a control that measured correctly against
 * `docs/UI-FIDELITY.md` and still read wrong on screen, because a padding, a line box or a
 * missing floor collapsed under the squeeze. So each block names the Swift line the port is
 * being held to, quotes the number measured on the running app before the fix, and asserts the
 * declared value that produces the number after it — never "something changed".
 *
 * Nothing here re-tests what `PaneHeader.test`, `PaneGrid.test` or `PaneSearchOverlay.test`
 * already own (the truncation ORDER, the badge tones, the counter rule, the frames and drags);
 * only the metrics and the two behaviours those suites never looked at.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { leaf, split } from '@nex/core/layout';

import { PaneGrid } from './PaneGrid';
import { BADGE_COST, BADGE_TEXT_FLOOR, PaneHeader, badgeFit, headerChrome } from './PaneHeader';
import { PaneSearchOverlay } from './PaneSearchOverlay';
import { testPane } from './testing';

const PANE = 'EEEEEEEE-0000-4000-8000-000000000001';

afterEach(cleanup);

/** A pane wearing all three shrinkable badges, so the ladder has something to drop. */
function loadedPane() {
    return testPane(PANE, {
        label: 'coordinator',
        gitBranch: 'gypsy/pg',
        status: 'running',
        agentSessionID: 'session-0001',
        agentKind: 'claude',
        agentStartedAt: Date.now() - 22_000
    });
}

function renderHeader(paneWidth: number | undefined) {
    render(
        <PaneHeader
            pane={loadedPane()}
            focused
            nowSeconds={Math.floor(Date.now() / 1000)}
            {...(paneWidth === undefined ? {} : { paneWidth })}
        />
    );
    return {
        header: screen.getByTestId(`pane-header-${PANE}`),
        label: screen.queryByTestId(`pane-label-${PANE}`),
        agent: screen.queryByTestId(`pane-agent-badge-${PANE}`),
        branch: screen.queryByTestId(`pane-branch-${PANE}`)
    };
}

// ── S8: no badge renders as a colour stub ───────────────────────────────────────────

/**
 * S8 — the shrinkable badges (label chip, agent badge, branch chip).
 *
 * `PaneHeaderView.swift:80-92`, `:163-175` and `:306-336` are plain `Text(...).lineLimit(1)`:
 * when the row runs out of room the shipped header OVERFLOWS and
 * `PaneGridView.swift:354-355`'s `.frame(...).clipped()` cuts it. It cannot compress a chip to
 * nothing. The port could, and did — measured live at a 130.75 px pane, all three chips came
 * out **8.00 px wide with 0.00 px of inner text**: bare colour rectangles carrying no glyph and
 * not even an ellipsis, with the close ✕ 27.25 px past the pane's right edge anyway.
 *
 * The fix is both halves, and the halves need each other: a floor alone would have pushed the
 * ✕ (and two more buttons) further off, so a badge that cannot meet its floor is not drawn.
 */
describe('S8 — a squeezed badge is an ellipsis or nothing, never a colour stub', () => {
    it('floors the text of every shrinkable badge, so `truncate` has something to draw', () => {
        const { label, agent, branch } = renderHeader(600);
        for (const badge of [label, agent, branch]) {
            const text = badge?.querySelector('span');
            expect(text?.className).toContain('truncate');
            // ~15 px at the badges' 10 px mono: one glyph plus the ellipsis.
            expect((text as HTMLElement).style.minWidth).toBe(BADGE_TEXT_FLOOR);
        }
    });

    it('keeps the glyph out of the squeeze too — `shrink-0` on the icon', () => {
        const { label, branch } = renderHeader(600);
        // The 8 px stub was 4 px of padding either side and NOTHING else: the SVG had been
        // squeezed to zero along with the text.
        expect(label?.querySelector('svg')?.getAttribute('class')).toContain('shrink-0');
        expect(branch?.querySelector('svg')?.getAttribute('class')).toContain('shrink-0');
    });

    it('drops the branch first — the footer and the inspector both still show it', () => {
        const { label, agent, branch } = renderHeader(220);
        expect(branch).toBeNull();
        expect(label).not.toBeNull();
        expect(agent).not.toBeNull();
    });

    it('drops the agent badge next — the status dot keeps carrying the state', () => {
        const { label, agent, branch } = renderHeader(180);
        expect(agent).toBeNull();
        expect(branch).toBeNull();
        expect(label).not.toBeNull();
        // The dot is what survives it, so it had better still be there.
        expect(screen.getByTestId(`pane-status-dot-${PANE}`).getAttribute('data-status')).toBe('running');
    });

    it('drops the label last, and at the 130.75 px pane that started this row draws none', () => {
        const { label, agent, branch } = renderHeader(130.75);
        expect(label).toBeNull();
        expect(agent).toBeNull();
        expect(branch).toBeNull();
        // …and the close ✕ — the thing the stubs were displacing — is still rendered.
        expect(screen.getByTestId(`pane-close-${PANE}`)).toBeTruthy();
    });

    /**
     * The ladder is arithmetic, not a table of widths: what fits depends on how many badges the
     * pane actually wants and how many buttons its type draws. A fixed table would have dropped
     * a markdown pane's lone branch chip at the width a shell pane carrying all three needs.
     */
    it('spends the header’s own arithmetic, from its parts', () => {
        expect(headerChrome(4)).toBe(130); // shell: 16 + 10 + 4×20 + 6×4
        expect(headerChrome(6)).toBe(178); // markdown in preview: + copy + edit
        const all = { label: true, agent: true, branch: true, buttons: 4 };
        const need = BADGE_COST.label + BADGE_COST.agent + BADGE_COST.branch;
        expect(badgeFit({ ...all, paneWidth: 130 + need })).toEqual({ label: true, agent: true, branch: true });
        expect(badgeFit({ ...all, paneWidth: 130 + need - 0.1 })).toEqual({
            label: true,
            agent: true,
            branch: false
        });
        expect(badgeFit({ ...all, paneWidth: 130 + BADGE_COST.label + BADGE_COST.agent })).toEqual({
            label: true,
            agent: true,
            branch: false
        });
        expect(badgeFit({ ...all, paneWidth: 130 + BADGE_COST.label })).toEqual({
            label: true,
            agent: false,
            branch: false
        });
        expect(badgeFit({ ...all, paneWidth: 130 + BADGE_COST.label - 0.1 })).toEqual({
            label: false,
            agent: false,
            branch: false
        });
    });

    it('keeps a lone badge far longer than a header carrying three', () => {
        // A markdown pane in preview: six buttons, and a branch chip as its only badge.
        const lone = { label: false, agent: false, branch: true, buttons: 6 };
        expect(badgeFit({ ...lone, paneWidth: 216 }).branch).toBe(true);
        // …where a shell pane wanting all three has already dropped its branch at that width.
        expect(badgeFit({ label: true, agent: true, branch: true, buttons: 4, paneWidth: 216 }).branch).toBe(
            false
        );
    });

    it('draws all three when there is no width to reason about (a standalone render)', () => {
        const { label, agent, branch } = renderHeader(undefined);
        expect(label).not.toBeNull();
        expect(agent).not.toBeNull();
        expect(branch).not.toBeNull();
        expect(badgeFit({ label: true, agent: true, branch: true, buttons: 4, paneWidth: Number.NaN })).toEqual({
            label: true,
            agent: true,
            branch: true
        });
    });
});

// ── S8/S19: what the grid itself has to supply ──────────────────────────────────────

describe('S8/S19 — the grid’s side of the two pane-grid rows', () => {
    /** `a | b` at 800 × 600: two 400 px panes, so the ladder is exercised through the grid. */
    const SIDE_BY_SIDE = split('horizontal', 0.5, leaf('a'), leaf('b'));

    function gridAt(width: number) {
        return (
            <PaneGrid
                layout={SIDE_BY_SIDE}
                panes={[
                    testPane('a', { label: 'coordinator', gitBranch: 'gypsy/pg' }),
                    testPane('b')
                ]}
                size={{ width, height: 600 }}
                headerHeight={24}
                renderPane={(paneID) => <div data-testid={`body-${paneID}`} />}
            />
        );
    }

    function renderGrid(width: number) {
        return render(gridAt(width));
    }

    it('hands the header its own width, so `badgeFit` has something to read', () => {
        // 800 wide → 400 px panes → over every rung of the ladder.
        renderGrid(800);
        expect(screen.queryByTestId('pane-label-a')).not.toBeNull();
        expect(screen.queryByTestId('pane-branch-a')).not.toBeNull();
        cleanup();
        // 320 wide → 160 px panes → under the bottom rung. Without the wiring both chips would
        // still be here, 8 px wide and empty.
        renderGrid(320);
        expect(screen.queryByTestId('pane-label-a')).toBeNull();
        expect(screen.queryByTestId('pane-branch-a')).toBeNull();
    });

    /**
     * S19 — `ResizeDimensionsOverlay.swift:10-21` is mounted by `PaneGridView.swift:387-391`'s
     * `.overlay { }` against the whole pane rect, which proposes the pane's FULL width, so the
     * chip stays one line however narrow the pane is. A shrink-to-fit absolute box with only
     * `left: 50%` gets (containing block − left) — half the pane — so `16 x 49` wrapped to two
     * lines at a 132.25 px pane (66.13 × 48.39 measured) and to three below ~84 px.
     */
    it('keeps the resize badge on one line', () => {
        vi.useFakeTimers();
        const view = renderGrid(800);
        // The chip only exists while something is resizing, so change the grid's size (M18's
        // own trigger) to raise it.
        view.rerender(gridAt(900));
        const badge = screen.getByTestId('pane-size-a');
        expect(badge.className).toContain('whitespace-nowrap');
        // M18's box is untouched: this row adds a wrapping rule, it does not resize the chip.
        expect(badge.className).toContain('px-3');
        expect(badge.className).toContain('py-1.5');
        vi.useRealTimers();
    });
});

// ── S20: the pill's line box ────────────────────────────────────────────────────────

/**
 * S20 — `PaneHeaderView.swift:89-91, 135-137, 151-153, 172-174, 327-329`.
 *
 * The Swift's `.padding(.vertical, 1)` sits around a `Text` whose line box already carries the
 * ascender and the descender, so the padding is OUTSIDE the glyph box (chip ≈ 14 pt).
 * `leading-none` collapsed the line box to exactly the font size and put the 1 px inside it:
 * the pill measured **12.00 px**, and on a real branch string (`gypsy/pg`, ascent 7.29 +
 * descent 2.15 measured off the resolved face) the inner `truncate` span clipped the last pixel
 * of the descender — `scrollHeight` 11 in a 10 px content box.
 */
describe('S20 — the badge pill leaves the descender inside it', () => {
    it('no badge carries `leading-none`', () => {
        renderHeader(600);
        for (const id of [`pane-label-${PANE}`, `pane-agent-badge-${PANE}`, `pane-branch-${PANE}`]) {
            expect(screen.getByTestId(id).className).not.toContain('leading-none');
        }
    });

    it('uses a 1.2 line box — the register’s 14 px pill, not `normal`’s 16', () => {
        renderHeader(600);
        // Measured live: `normal` for this monospace face is 14 px at 10 px, so simply dropping
        // the class (the register's literal suggestion) would have made the pill 16 rather than
        // the 14 it asks for. 1.2 is the smallest line box that clears the measured ink.
        expect(screen.getByTestId(`pane-label-${PANE}`).className).toContain('leading-[1.2]');
        // The 1 px of vertical padding is the Swift's and does not move.
        expect(screen.getByTestId(`pane-label-${PANE}`).className).toContain('py-px');
    });
});

// ── S30: the header's hairline is painted, not laid out ─────────────────────────────

/**
 * S30 — `PaneHeaderView.swift:274-275` is a 24 pt box from `.padding(.vertical, 2)`, and
 * `:297-299` draws the rule as an `.overlay(alignment: .bottom)`, which consumes no layout
 * height. A `borderBottom` on a `border-box` element of `height: 24` does: the content band
 * measured 23 px, so the 20 px buttons sat 1.5 px above centre and 2.5 px below.
 */
describe('S30 — the header keeps all 24 px of its content band', () => {
    it('paints the divider with an inset shadow instead of a border', () => {
        const { header } = renderHeader(600);
        expect(header.style.boxShadow).toBe('inset 0 -1px 0 var(--nex-border, #24242B)');
        expect(header.style.borderBottom).toBe('');
        expect(header.style.height).toBe('24px');
    });
});

// ── S16: the find field's 160 px is the TEXT column ─────────────────────────────────

/**
 * S16 — `PaneSearchOverlay.swift:20-33` puts `.frame(width: 160)` on the `TextField` and its
 * leading 8, the counter's trailing reserve and the vertical 5 OUTSIDE it, so the needle you
 * can see is a flat 160 pt in every state and the BAR grows to hold the counter. Under
 * Tailwind's global `border-box` the same 160 was the outer box: 8/8 left 144 px of text, and a
 * live `1/3` counter reserved 33 px and left **119** — a field that shrinks as you find more.
 */
describe('S16 — 160 is the field’s text column, not its border box', () => {
    function renderBar(overrides: Record<string, unknown> = {}) {
        render(
            <PaneSearchOverlay
                paneID={PANE}
                needle=""
                total={null}
                selected={null}
                onNeedleChange={vi.fn()}
                onNext={vi.fn()}
                onPrevious={vi.fn()}
                onClose={vi.fn()}
                {...overrides}
            />
        );
        return screen.getByTestId(`pane-search-input-${PANE}`) as HTMLInputElement;
    }

    it('makes the declared 160 a content box', () => {
        const input = renderBar();
        expect(input.style.boxSizing).toBe('content-box');
        expect(input.className).toContain('w-[160px]');
        // The insets are unchanged — they are the Swift's, and they now sit outside the 160.
        expect(input.style.paddingTop).toBe('5px');
        expect(input.className).toContain('px-2');
    });

    it('so the counter’s reserve grows the bar instead of eating the needle', () => {
        const input = renderBar({ needle: 'x', total: 345, selected: 11 });
        // `12/345` → 6 × 7 + 12. Before, that came out of the 160 and left ~98 px of field.
        expect(input.style.paddingRight).toBe('54px');
        expect(input.style.boxSizing).toBe('content-box');
    });
});
