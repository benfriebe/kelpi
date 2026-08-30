/**
 * The LOW-POLISH pane-grid items — `docs/UI-FIDELITY.md` L22…L40 and L47.
 *
 * Individually these are a point of type, two pixels of padding, a hover state nobody asked for.
 * Collectively they are the register's whole thesis: the port read as a rebuild rather than as
 * the app. So every block below names the Swift line it is holding the port to and asserts the
 * NUMBER or the STRING that line specifies — never "something changed".
 *
 * Nothing here re-tests behaviour the neighbouring suites already own (`PaneSearchOverlay.test`'s
 * counter rule and keyboard contract, `PaneHeader.test`'s truncation order and badge tones,
 * `PaneGrid.test`'s frames and drags) — only the presentation those suites never looked at.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaneHeader } from './PaneHeader';
import { PaneSearchOverlay } from './PaneSearchOverlay';
import { ICON_STROKE } from './icons';
import { testPane } from './testing';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

afterEach(cleanup);

function renderBar(overrides: Partial<Parameters<typeof PaneSearchOverlay>[0]> = {}) {
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
    return {
        bar: screen.getByTestId(`pane-search-${PANE}`),
        input: screen.getByTestId(`pane-search-input-${PANE}`) as HTMLInputElement
    };
}

// ── the find bar (L22, L23, L24, L29, L37 — and L39/L40/L47 through it) ─────────────

describe('pane search overlay — LOW-POLISH', () => {
    /**
     * L22/L40 — `Color.primary.opacity(0.08)`, `.cornerRadius(5)`, `.padding(.vertical, 5)`
     * (`PaneSearchOverlay.swift:26-28`).
     *
     * The fill is the interesting one: an 8% tint of the LABEL colour is lighter than the header
     * bar on dark and darker than it on light — an inset well either way. The port had reached
     * for `surfaceBackground` (#101013), which is darker than the #13131A bar in BOTH columns, so
     * the field read as a hole punched through the bar rather than a well set into it.
     */
    it('sets the field into the bar rather than punching it through', () => {
        const { input } = renderBar();
        expect(input.style.background).toBe('color-mix(in srgb, var(--kelpi-fg, #E6E6EA) 8%, transparent)');
        expect(input.style.background).not.toContain('--kelpi-surface-bg');
        expect(input.style.borderRadius).toBe('5px');
        expect(input.style.paddingTop).toBe('5px');
        expect(input.style.paddingBottom).toBe('5px');
        // The radius is stated inline, so the 4 px Tailwind default must not also be in play.
        expect(input.className).not.toMatch(/\brounded\b/);
        expect(input.className).not.toContain('py-1');
    });

    /** L37 — chevrons 10 pt `.medium` (`:50`, `:60`), ✕ 9 pt `.semibold` (`:70`). */
    it('draws the chevrons and the ✕ at the Swift’s sizes AND weights', () => {
        renderBar();
        for (const part of ['next', 'prev']) {
            const glyph = screen.getByTestId(`pane-search-${part}-${PANE}`).querySelector('svg');
            expect(glyph?.getAttribute('width')).toBe('10');
            expect(glyph?.getAttribute('data-weight')).toBe('medium');
            expect(glyph?.getAttribute('stroke-width')).toBe(String(ICON_STROKE.medium));
        }
        const close = screen.getByTestId(`pane-search-close-${PANE}`).querySelector('svg');
        expect(close?.getAttribute('width')).toBe('9');
        expect(close?.getAttribute('data-weight')).toBe('semibold');
        // A stroke in viewBox units shrinks with the glyph, so 9 px WITHOUT the weight bump
        // would draw the ✕ thinner than its 10 px neighbours — the opposite of `.semibold`.
        expect(ICON_STROKE.semibold).toBeGreaterThan(ICON_STROKE.regular);
    });

    /**
     * L24 — `PaneSearchOverlay.swift:54-56,64-66,74-75` sets opacity from `localNeedle.isEmpty`
     * and nothing else. There is no `.onHover` anywhere in the file, so the shipped controls do
     * not brighten under the cursor; the port's `hover:opacity-100` was invented chrome.
     */
    it('has no hover brighten on any of its three controls', () => {
        renderBar({ needle: 'x' });
        for (const part of ['next', 'prev', 'close']) {
            const button = screen.getByTestId(`pane-search-${part}-${PANE}`);
            expect(button.className).toContain('opacity-70');
            expect(button.className).not.toContain('hover:opacity');
        }
    });

    /** L24, the other half: the dimmed pair keeps its 0.3, still without a hover branch. */
    it('keeps the empty-needle pair at 0.3 and inert', () => {
        renderBar();
        for (const part of ['next', 'prev']) {
            const button = screen.getByTestId(`pane-search-${part}-${PANE}`) as HTMLButtonElement;
            expect(button.className).toContain('opacity-30');
            expect(button.className).not.toContain('hover:opacity');
            expect(button.disabled).toBe(true);
        }
    });

    /**
     * L29 — `PaneSearchOverlay.swift:82-85` seeds `localNeedle` and focuses; SwiftUI leaves the
     * caret at the end. The port also `select()`ed, so re-opening the bar over a needle you had
     * just typed put it one keystroke from being erased.
     */
    it('focuses without selecting, caret at the end of the seeded needle', () => {
        const { input } = renderBar({ needle: 'branch' });
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(6);
        expect(input.selectionEnd).toBe(6);
    });

    /**
     * L39/L40/L47 were closed by H29's unification — the content find bar IS this component
     * (`content/ContentFrame.tsx` mounts it with its own `testIDPrefix` and `label`). Asserted
     * here so the three cannot silently regress if the two bars are ever split again: the
     * landmark travels, the placeholder is the Swift's "Search", the field is 160 px of 12 px
     * monospace, and the counter is absent until there is a needle.
     */
    it('carries the landmark, the placeholder and the counter rule onto the content surface', () => {
        render(
            <PaneSearchOverlay
                paneID={PANE}
                testIDPrefix="content-find"
                label="Find in markdown preview"
                needle=""
                total={0}
                selected={null}
                onNeedleChange={vi.fn()}
                onNext={vi.fn()}
                onPrevious={vi.fn()}
                onClose={vi.fn()}
            />
        );
        const bar = screen.getByTestId(`content-find-${PANE}`);
        expect(bar.getAttribute('role')).toBe('search');
        expect(bar.getAttribute('aria-label')).toBe('Find in markdown preview');
        const input = screen.getByTestId(`content-find-input-${PANE}`) as HTMLInputElement;
        expect(input.getAttribute('placeholder')).toBe('Search');
        expect(input.className).toContain('w-[160px]');
        expect(input.style.fontSize).toBe('12px');
        // L39: no standing `0/0` — a total of 0 with no needle shows nothing at all.
        expect(screen.queryByTestId(`content-find-count-${PANE}`)).toBeNull();
        // L40: 22×22 buttons, dimmed and inert, not `↑ ↓ ✕` text characters.
        for (const part of ['next', 'prev', 'close']) {
            const button = screen.getByTestId(`content-find-${part}-${PANE}`);
            expect(button.className).toContain('h-[22px]');
            expect(button.className).toContain('w-[22px]');
            expect(button.querySelector('svg')).not.toBeNull();
        }
        expect((screen.getByTestId(`content-find-next-${PANE}`) as HTMLButtonElement).disabled).toBe(true);
    });
});

// ── the header (L24, L25, L26, L27, L28, L32, L34) ──────────────────────────────────

describe('pane header — LOW-POLISH', () => {
    function glyphOf(testID: string): SVGElement | null {
        return screen.getByTestId(testID).querySelector('svg');
    }

    /** L24 — every button in `PaneHeaderView.swift:177-273` is a flat `.opacity(0.6)`. */
    it('has no hover brighten on any header button', () => {
        render(
            <PaneHeader
                pane={testPane('a', { type: 'markdown', filePath: '/repo/NOTES.md' })}
                focused
                onCopyDocument={vi.fn()}
            />
        );
        for (const testID of ['pane-copy-a', 'pane-edit-toggle-a', 'pane-split-right-a', 'pane-close-a']) {
            const button = screen.getByTestId(testID);
            expect(button.className).toContain('opacity-60');
            expect(button.className).not.toContain('hover:opacity');
        }
    });

    /** L25 — close is 9 pt `.semibold` (`:265`) against the row's 10 pt regular. */
    it('draws the close ✕ smaller and bolder than its neighbours', () => {
        render(<PaneHeader pane={testPane('a')} focused />);
        const close = glyphOf('pane-close-a');
        expect(close?.getAttribute('width')).toBe('9');
        expect(close?.getAttribute('stroke-width')).toBe(String(ICON_STROKE.semibold));
        for (const testID of ['pane-split-right-a', 'pane-split-down-a', 'pane-new-web-a']) {
            const glyph = glyphOf(testID);
            expect(glyph?.getAttribute('width')).toBe('10');
            expect(glyph?.getAttribute('stroke-width')).toBe(String(ICON_STROKE.regular));
        }
    });

    /**
     * L27 — `PaneHeaderView.swift:109` and `:134` are both `.orange`. One token, both badges,
     * and NOT the agent amber: a synced pane must not read as a pane with an agent in it.
     */
    it('paints ZOOM and SYNC from one orange token, distinct from the agent amber', () => {
        render(
            <PaneHeader
                pane={testPane('a', { agentSessionID: 's', status: 'running', agentStartedAt: null })}
                focused
                zoomed
                zoomAvailable
                syncActive
                nowSeconds={0}
            />
        );
        const zoom = screen.getByTestId('pane-zoom-badge-a');
        const sync = screen.getByTestId('pane-sync-badge-a');
        expect(zoom.style.color).toBe('var(--kelpi-orange, #D08237)');
        expect(sync.style.color).toBe(zoom.style.color);
        // The hard-coded hex is gone, and so is the collision with `--kelpi-agent`.
        expect(zoom.getAttribute('style')).not.toContain('#D08237;');
        expect(sync.style.color).not.toContain('--kelpi-agent');
        expect(screen.getByTestId('pane-agent-badge-a').style.color).toContain('--kelpi-agent');
    });

    /**
     * L28 — `HStack(spacing: 2)` inside every badge, and the glyph at 8 everywhere except the
     * branch chip's `arrow.triangle.branch`, which is 9 (`PaneHeaderView.swift:166`).
     */
    it('draws badge glyphs at the Swift’s size, two points from their text', () => {
        render(
            <PaneHeader
                pane={testPane('a', { label: 'worker', gitBranch: 'main' })}
                focused
                zoomed
                zoomAvailable
                syncActive
            />
        );
        for (const testID of ['pane-label-a', 'pane-zoom-badge-a', 'pane-sync-badge-a']) {
            expect(glyphOf(testID)?.getAttribute('width')).toBe('8');
            expect(screen.getByTestId(testID).className).toContain('gap-[2px]');
        }
        expect(glyphOf('pane-branch-a')?.getAttribute('width')).toBe('9');
        expect(screen.getByTestId('pane-branch-a').className).toContain('gap-[2px]');
    });

    /** L28, the dimmed variant: SYNC OFF is the same 8 pt glyph at its own 9 pt text. */
    it('gives SYNC OFF the same 8 pt glyph', () => {
        render(<PaneHeader pane={testPane('a')} focused syncActive syncExcluded />);
        expect(glyphOf('pane-sync-off-badge-a')?.getAttribute('width')).toBe('8');
    });

    /**
     * L32 — `PaneHeaderView.swift:94-98` is a bare `Text(displayPath)` with no `.help()`, so
     * hovering a truncated path in the shipped app shows nothing. The native tooltip was a port
     * invention, and the only header element that answered a hover at all.
     */
    it('shows no tooltip on the truncated path', () => {
        render(
            <PaneHeader
                pane={testPane('a', { workingDirectory: '/Users/ben/code/kelpi/packages/client/src/grid' })}
                focused
                homeDirectory="/Users/ben"
            />
        );
        expect(screen.getByTestId('pane-title-a').getAttribute('title')).toBeNull();
    });

    /**
     * L34 — `tag.fill` is FILLED (`:82`) and ZOOM's `arrow.up.left.and.arrow.down.right` (`:103`)
     * is two diagonal arrows, not the four corner brackets the port had drawn (that shape is the
     * crop/fit glyph, and it reads as one).
     */
    it('redraws the two badge glyphs closer to their SF originals', () => {
        render(<PaneHeader pane={testPane('a', { label: 'worker' })} focused zoomed zoomAvailable />);
        const tag = glyphOf('pane-label-a')?.querySelector('path');
        expect(tag?.getAttribute('fill')).toBe('currentColor');
        expect(tag?.getAttribute('stroke')).toBe('none');
        // Two subpaths: the tag body and the eyelet punched out of it.
        expect(tag?.getAttribute('d')?.match(/M/g)?.length).toBe(2);

        const zoom = glyphOf('pane-zoom-badge-a');
        // One path per arrow — the bracket form was a single four-segment path.
        expect(zoom?.querySelectorAll('path').length).toBe(2);
        for (const arrow of Array.from(zoom?.querySelectorAll('path') ?? [])) {
            // Each arrow is a diagonal shaft plus a two-legged head at its tip.
            expect(arrow.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+ [\d.]+ [\d.]+M/);
        }
    });
});
