import { describe, expect, it } from 'vitest';
import { notificationDecision } from './notifications.js';
import type { NotificationContext, NotificationSource } from './index.js';

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
    return { isFocused: false, isAppActive: false, backgroundTaskCount: 0, ...overrides };
}

describe('stop-synthetic notification', () => {
    it('fires when the pane is unattended', () => {
        expect(notificationDecision('stop', ctx())).toEqual({
            shouldNotify: true,
            shouldBounce: true
        });
        expect(notificationDecision('stop', ctx({ isAppActive: true }))).toEqual({
            shouldNotify: true,
            shouldBounce: false
        });
        expect(notificationDecision('stop', ctx({ isFocused: true }))).toEqual({
            shouldNotify: true,
            shouldBounce: true
        });
    });

    it('is suppressed when the pane is focused in an active client', () => {
        expect(
            notificationDecision('stop', ctx({ isFocused: true, isAppActive: true }))
        ).toEqual({ shouldNotify: false, shouldBounce: false });
    });

    it('is suppressed while background work is in flight', () => {
        expect(notificationDecision('stop', ctx({ backgroundTaskCount: 1 }))).toEqual({
            shouldNotify: false,
            shouldBounce: false
        });
    });
});

describe('agent-authored notification', () => {
    it('ignores background work but honours focus', () => {
        expect(
            notificationDecision('agentNotification', ctx({ backgroundTaskCount: 3 }))
        ).toEqual({ shouldNotify: true, shouldBounce: false });
        expect(
            notificationDecision(
                'agentNotification',
                ctx({ isFocused: true, isAppActive: true, backgroundTaskCount: 3 })
            )
        ).toEqual({ shouldNotify: false, shouldBounce: false });
    });
});

describe('error and OSC', () => {
    it('never suppresses errors', () => {
        expect(
            notificationDecision(
                'error',
                ctx({ isFocused: true, isAppActive: true, backgroundTaskCount: 9 })
            )
        ).toEqual({ shouldNotify: true, shouldBounce: false });
    });

    it('suppresses OSC notifications only when focused and active', () => {
        expect(notificationDecision('osc', ctx({ isFocused: true, isAppActive: true }))).toEqual({
            shouldNotify: false,
            shouldBounce: false
        });
        expect(
            notificationDecision('osc', ctx({ isFocused: true, backgroundTaskCount: 4 }))
        ).toEqual({ shouldNotify: true, shouldBounce: false });
    });
});

describe('bounce precedence', () => {
    it('only the stop path ever bounces', () => {
        const sources: NotificationSource[] = ['agentNotification', 'error', 'osc'];
        for (const source of sources) {
            expect(notificationDecision(source, ctx()).shouldBounce).toBe(false);
        }
    });
});
