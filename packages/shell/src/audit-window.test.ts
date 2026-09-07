import { describe, expect, it } from 'vitest';

import {
    OFFSCREEN_MARGIN,
    SHIPPED_WINDOW_POLICY,
    auditWindowBounds,
    auditWindowFocusable,
    auditWindowLogLine,
    auditWindowPolicy,
    auditWindowVisibility,
    harnessWindowPolicy,
    resolveWindowPolicy
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

describe('the harness functional lane is OFF unless BOTH of its variables ask for it (#65)', () => {
    const SOCKET = '/tmp/nexaudit-scenario-x/harness.sock';

    it('returns the shipped defaults for an empty environment', () => {
        expect(harnessWindowPolicy({})).toEqual(SHIPPED_WINDOW_POLICY);
        expect(resolveWindowPolicy({})).toEqual(SHIPPED_WINDOW_POLICY);
    });

    it('does nothing for a channel with no placement asked for', () => {
        // `dev-instance.mjs` sets the socket for a window a human is looking at. The socket alone
        // must never move it.
        expect(harnessWindowPolicy({ KELPI_HARNESS_SOCKET: SOCKET })).toEqual(SHIPPED_WINDOW_POLICY);
        expect(resolveWindowPolicy({ KELPI_HARNESS_SOCKET: SOCKET, KELPI_HARNESS: '1' })).toEqual(
            SHIPPED_WINDOW_POLICY
        );
    });

    it('does nothing for a placement with no channel behind it', () => {
        // A stray KELPI_HARNESS_WINDOW with no driver to move the window back is a window the
        // machine's owner cannot see and nobody is going to restore.
        for (const placement of ['hidden', 'offscreen', 'onscreen'] as const) {
            expect(harnessWindowPolicy({ KELPI_HARNESS_WINDOW: placement })).toEqual(SHIPPED_WINDOW_POLICY);
            expect(resolveWindowPolicy({ KELPI_HARNESS_WINDOW: placement, KELPI_HARNESS: '1' })).toEqual(
                SHIPPED_WINDOW_POLICY
            );
        }
    });

    it('treats an empty or whitespace socket path as no channel, exactly as harnessSocketPath does', () => {
        for (const socket of ['', '   ']) {
            expect(harnessWindowPolicy({ KELPI_HARNESS_SOCKET: socket, KELPI_HARNESS_WINDOW: 'hidden' })).toEqual(
                SHIPPED_WINDOW_POLICY
            );
        }
    });

    it('refuses "default" and any unknown placement, so the opt-in cannot be spelled like the opt-out', () => {
        for (const placement of ['default', 'sideways', 'HIDDEN', '1', '']) {
            expect(harnessWindowPolicy({ KELPI_HARNESS_SOCKET: SOCKET, KELPI_HARNESS_WINDOW: placement })).toEqual(
                SHIPPED_WINDOW_POLICY
            );
        }
    });
});

describe('the harness functional lane, when a scenario does ask', () => {
    const SOCKET = '/tmp/nexaudit-scenario-x/harness.sock';
    const laneEnv = (placement: string) => ({ KELPI_HARNESS_SOCKET: SOCKET, KELPI_HARNESS_WINDOW: placement });

    it('carries the placement through and names itself', () => {
        for (const placement of ['hidden', 'offscreen', 'onscreen'] as const) {
            const policy = harnessWindowPolicy(laneEnv(placement));
            expect(policy.active).toBe(true);
            expect(policy.lane).toBe('harness');
            expect(policy.placement).toBe(placement);
            expect(resolveWindowPolicy(laneEnv(placement))).toEqual(policy);
        }
    });

    it('KEEPS the shipped background throttling, unlike the audit lane', () => {
        // Measured, and the opposite of what this lane was first built to do. Turning throttling
        // off pins the render widget out of the hidden state, so the page reports
        // `visibilityState: 'visible'` for ever; the client reports that to the daemon, the
        // daemon's isAppActive is exactly that value, and the stop-only dock bounce is gated on
        // the app being INACTIVE. A lane with throttling off fails dock-bounce-stop-only at every
        // placement, onscreen included: a test lane that changes the thing under test.
        for (const placement of ['hidden', 'offscreen', 'onscreen'] as const) {
            expect(harnessWindowPolicy(laneEnv(placement)).backgroundThrottling).toBe(true);
        }
        expect(harnessWindowPolicy({ ...laneEnv('hidden'), KELPI_AUDIT_THROTTLE: '1' }).backgroundThrottling).toBe(true);
    });

    it('lets a run turn throttling off explicitly, and only for the exact string "0"', () => {
        expect(
            harnessWindowPolicy({ ...laneEnv('hidden'), KELPI_HARNESS_WINDOW_THROTTLE: '0' }).backgroundThrottling
        ).toBe(false);
        for (const value of ['', '1', 'false', 'off', 'no']) {
            // A typo lands on the faithful side: the product still behaves like the product.
            expect(
                harnessWindowPolicy({ ...laneEnv('hidden'), KELPI_HARNESS_WINDOW_THROTTLE: value }).backgroundThrottling
            ).toBe(true);
        }
    });

    it('does not let the throttle hatch open the lane on its own', () => {
        expect(harnessWindowPolicy({ KELPI_HARNESS_WINDOW_THROTTLE: '0' })).toEqual(SHIPPED_WINDOW_POLICY);
        expect(resolveWindowPolicy({ KELPI_HARNESS_WINDOW_THROTTLE: '0', KELPI_HARNESS_SOCKET: SOCKET })).toEqual(
            SHIPPED_WINDOW_POLICY
        );
    });

    it("reuses the audit's geometry and visibility, rather than having its own", () => {
        // The whole point of the lane living in this file: one measured placement table, two
        // gates. A hidden scenario window is hidden the same way a hidden audit window is.
        const policy = harnessWindowPolicy(laneEnv('hidden'));
        expect(auditWindowVisibility(policy.placement)).toEqual({ opacity: 0, ignoreMouseEvents: true });
        expect(auditWindowBounds('offscreen', BOUNDS, WORK_AREA)).toEqual(
            auditWindowBounds(harnessWindowPolicy(laneEnv('offscreen')).placement, BOUNDS, WORK_AREA)
        );
    });

    it('loses to the audit when both gates are open, because audit.mjs sets the socket too', () => {
        const both = { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: 'onscreen', ...laneEnv('hidden') };
        expect(resolveWindowPolicy(both).lane).toBe('audit');
        expect(resolveWindowPolicy(both).placement).toBe('onscreen');
    });

    it('tags its log line as the harness lane, so two concurrent runs are tellable apart', () => {
        const line = auditWindowLogLine(harnessWindowPolicy(laneEnv('hidden')), BOUNDS, BOUNDS);
        expect(line.startsWith('harness-window:')).toBe(true);
        expect(line).toContain('placement=hidden');
        expect(line).toContain('backgroundThrottling=true');
        expect(line).toContain('opacity=0');
        expect(
            auditWindowLogLine(auditWindowPolicy({ KELPI_AUDIT: '1' }), BOUNDS, BOUNDS).startsWith('audit-window:')
        ).toBe(true);
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

describe('no lane window is ever the key window (#109)', () => {
    const laneEnv = (placement: string) => ({
        KELPI_HARNESS_SOCKET: '/tmp/kelpi-harness.sock',
        KELPI_HARNESS_WINDOW: placement
    });

    it('refuses key status at every placement a lane can ask for', () => {
        // The rule: a lane window never becomes the key window on its own, so the machine's real
        // keyboard never reaches it. Measured on the base tree at `--window hidden`: the
        // frontmost application right after boot was `Electron`, `harness.focus()` took the key
        // window off the app the person had moved to, and a CGEvent keystroke posted the way a
        // physical one arrives landed in the run's terminal: `echo caret-ok` typed over CDP
        // came back from `kelpi pane capture` as `echo urecaret-ok`.
        for (const placement of ['hidden', 'offscreen', 'onscreen'] as const) {
            expect(auditWindowFocusable(placement)).toBe(false);
        }
    });

    it('leaves a user’s window, and the on-screen full audit, focusable', () => {
        // `default` is what every user launch and the default audit run get. A visible window
        // that could not be typed into would be a worse lie than the one this fixes.
        expect(auditWindowFocusable('default')).toBe(true);
        expect(auditWindowFocusable(SHIPPED_WINDOW_POLICY.placement)).toBe(true);
    });

    it('covers both gates: whichever lane opened, the placement decides', () => {
        expect(auditWindowFocusable(harnessWindowPolicy(laneEnv('hidden')).placement)).toBe(false);
        expect(auditWindowFocusable(auditWindowPolicy({ KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: 'onscreen' }).placement)).toBe(
            false
        );
        expect(auditWindowFocusable(auditWindowPolicy({ KELPI_AUDIT: '1' }).placement)).toBe(true);
    });

    it('states the rule in the log line, so the policy is checkable from outside the process', () => {
        expect(auditWindowLogLine(harnessWindowPolicy(laneEnv('hidden')), BOUNDS, BOUNDS)).toContain('focusable=false');
        expect(auditWindowLogLine(auditWindowPolicy({ KELPI_AUDIT: '1' }), BOUNDS, BOUNDS)).toContain('focusable=true');
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
