import { describe, expect, it } from 'vitest';

import {
    OFFSCREEN_MARGIN,
    SHIPPED_WINDOW_POLICY,
    auditWindowBounds,
    auditWindowLogLine,
    auditWindowPolicy,
    auditWindowVisibility
} from './audit-window.js';

const WORK_AREA = { x: 0, y: 25, width: 2456, height: 1304 };
const BOUNDS = { x: 120, y: 90, width: 1280, height: 820 };

describe('the audit window policy is OFF unless the audit asks for it', () => {
    it('returns the shipped defaults for an empty environment', () => {
        expect(auditWindowPolicy({})).toEqual(SHIPPED_WINDOW_POLICY);
        expect(auditWindowPolicy({}).backgroundThrottling).toBe(true);
        expect(auditWindowPolicy({}).placement).toBe('default');
        expect(auditWindowPolicy({}).active).toBe(false);
    });

    it('ignores the placement and throttle knobs entirely without KELPI_AUDIT', () => {
        // The load-bearing case: a user (or a packaged build) can have these set for any reason
        // and still get the window a shipped launch builds. Nothing here may leak into a release.
        const stray = auditWindowPolicy({
            KELPI_AUDIT_WINDOW: 'offscreen',
            KELPI_AUDIT_THROTTLE: '1',
            KELPI_HARNESS: '1'
        });
        expect(stray).toEqual(SHIPPED_WINDOW_POLICY);
    });

    it('does not treat KELPI_HARNESS as an audit run', () => {
        // The web smoke and the packaging probes set KELPI_HARNESS and assert on a user's window.
        expect(auditWindowPolicy({ KELPI_HARNESS: '1' })).toEqual(SHIPPED_WINDOW_POLICY);
    });

    it('only accepts the exact string "1"', () => {
        for (const value of ['', '0', 'true', 'yes', 'KELPI_AUDIT']) {
            expect(auditWindowPolicy({ KELPI_AUDIT: value })).toEqual(SHIPPED_WINDOW_POLICY);
        }
    });
});

describe('the audit window policy, when the audit does ask', () => {
    it('turns background throttling off', () => {
        const policy = auditWindowPolicy({ KELPI_AUDIT: '1' });
        expect(policy.active).toBe(true);
        expect(policy.backgroundThrottling).toBe(false);
    });

    it('keeps an escape hatch back to the shipped throttling, so the flag stays measurable', () => {
        const policy = auditWindowPolicy({ KELPI_AUDIT: '1', KELPI_AUDIT_THROTTLE: '1' });
        expect(policy.backgroundThrottling).toBe(true);
        expect(policy.active).toBe(true);
    });

    it('reads the placement, and degrades an unknown value to the visible default', () => {
        for (const placement of ['hidden', 'offscreen', 'onscreen', 'default'] as const) {
            expect(auditWindowPolicy({ KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: placement }).placement).toBe(placement);
        }
        expect(auditWindowPolicy({ KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: 'sideways' }).placement).toBe('default');
        expect(auditWindowPolicy({ KELPI_AUDIT: '1' }).placement).toBe('default');
    });
});

describe('how the window is made invisible', () => {
    it('hides by opacity, not by hide() or minimize()', () => {
        // Both of those fire events this app ACTS on — `webHost.releaseViews('window-hidden' |
        // 'window-minimized')` — so using either would change the product's behaviour in the
        // middle of the run measuring it. Opacity fires nothing.
        expect(auditWindowVisibility('hidden')).toEqual({ opacity: 0, ignoreMouseEvents: true });
    });

    it('leaves every other placement compositing alone', () => {
        for (const placement of ['default', 'offscreen', 'onscreen'] as const) {
            expect(auditWindowVisibility(placement)).toEqual({ opacity: null, ignoreMouseEvents: false });
        }
    });

    it('makes the hidden window click-through, so it cannot eat the owner’s clicks', () => {
        // An invisible rectangle that swallows clicks is worse than a visible window, because
        // there is nothing to see. CDP delivers the audit's own input below AppKit's hit-testing.
        expect(auditWindowVisibility('hidden').ignoreMouseEvents).toBe(true);
    });
});

describe('audit window geometry', () => {
    it('leaves the restored bounds untouched at the default placement', () => {
        expect(auditWindowBounds('default', BOUNDS, WORK_AREA)).toEqual(BOUNDS);
    });

    it('pushes the origin past the TRAILING edge, never a negative one', () => {
        // AppKit constrains a negative origin back until part of the frame is visible (measured:
        // x −1680 came back as −1240). A large positive x is accepted verbatim.
        const moved = auditWindowBounds('offscreen', BOUNDS, WORK_AREA);
        expect(moved.x).toBe(WORK_AREA.x + WORK_AREA.width + OFFSCREEN_MARGIN);
        expect(moved.y).toBe(WORK_AREA.y + WORK_AREA.height + OFFSCREEN_MARGIN);
        expect(moved.x).toBeGreaterThan(WORK_AREA.x + WORK_AREA.width);
        expect(moved.y).toBeGreaterThan(WORK_AREA.y + WORK_AREA.height);
    });

    it('never changes the window SIZE, whatever the placement', () => {
        // The audit asserts on layout geometry — gutters, clearances, wrapped terminal columns.
        // A placement that also resized the window would change the product under test.
        for (const placement of ['default', 'offscreen', 'onscreen'] as const) {
            const moved = auditWindowBounds(placement, BOUNDS, WORK_AREA);
            expect(moved.width).toBe(BOUNDS.width);
            expect(moved.height).toBe(BOUNDS.height);
        }
    });

    it('parks the fidelity fallback at the work area origin', () => {
        const moved = auditWindowBounds('onscreen', BOUNDS, WORK_AREA);
        expect(moved).toEqual({ ...BOUNDS, x: WORK_AREA.x, y: WORK_AREA.y });
    });
});

describe('the audit window log line', () => {
    it('records what was asked for and what AppKit did with it', () => {
        const line = auditWindowLogLine(
            auditWindowPolicy({ KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: 'offscreen' }),
            { x: 2856, y: 1729, width: 1280, height: 820 },
            { x: 2856, y: 1297, width: 1280, height: 820 }
        );
        expect(line).toContain('placement=offscreen');
        expect(line).toContain('backgroundThrottling=false');
        expect(line).toContain('opacity=default');
        expect(line).toContain('requested=2856,1729 1280x820');
        expect(line).toContain('actual=2856,1297 1280x820');
    });
});
