import { describe, expect, it } from 'vitest';
import { notificationDecision } from './notifications.js';
import type { NotificationContext, NotificationSource } from './index.js';

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
    return { isFocused: false, isAppActive: false, backgroundTaskCount: 0, muted: false, ...overrides };
}

describe('stop-synthetic notification', () => {
    it('fires when the pane is unattended', () => {
        expect(notificationDecision('stop', ctx())).toEqual({
            shouldNotify: true,
            shouldBounce: true,
            observersOnly: false
        });
        expect(notificationDecision('stop', ctx({ isAppActive: true }))).toEqual({
            shouldNotify: true,
            shouldBounce: false,
            observersOnly: false
        });
        expect(notificationDecision('stop', ctx({ isFocused: true }))).toEqual({
            shouldNotify: true,
            shouldBounce: true,
            observersOnly: false
        });
    });

    it('is suppressed when the pane is focused in an active client', () => {
        expect(
            notificationDecision('stop', ctx({ isFocused: true, isAppActive: true }))
        ).toEqual({ shouldNotify: false, shouldBounce: false, observersOnly: false });
    });

    it('is suppressed while background work is in flight', () => {
        expect(notificationDecision('stop', ctx({ backgroundTaskCount: 1 }))).toEqual({
            shouldNotify: false,
            shouldBounce: false,
            observersOnly: false
        });
    });
});

describe('agent-authored notification', () => {
    it('ignores background work but honours focus', () => {
        expect(
            notificationDecision('agentNotification', ctx({ backgroundTaskCount: 3 }))
        ).toEqual({ shouldNotify: true, shouldBounce: false, observersOnly: false });
        expect(
            notificationDecision(
                'agentNotification',
                ctx({ isFocused: true, isAppActive: true, backgroundTaskCount: 3 })
            )
        ).toEqual({ shouldNotify: false, shouldBounce: false, observersOnly: false });
    });
});

describe('error and OSC', () => {
    it('never suppresses errors', () => {
        expect(
            notificationDecision(
                'error',
                ctx({ isFocused: true, isAppActive: true, backgroundTaskCount: 9 })
            )
        ).toEqual({ shouldNotify: true, shouldBounce: false, observersOnly: false });
    });

    it('suppresses OSC notifications only when focused and active', () => {
        expect(notificationDecision('osc', ctx({ isFocused: true, isAppActive: true }))).toEqual({
            shouldNotify: false,
            shouldBounce: false,
            observersOnly: false
        });
        expect(
            notificationDecision('osc', ctx({ isFocused: true, backgroundTaskCount: 4 }))
        ).toEqual({ shouldNotify: true, shouldBounce: false, observersOnly: false });
    });
});

describe('muted workspace', () => {
    it('keeps the matrix and routes the result to observers only', () => {
        for (const isAppActive of [false, true]) {
            expect(notificationDecision('stop', ctx({ isAppActive, muted: true }))).toEqual({
                shouldNotify: true,
                shouldBounce: !isAppActive,
                observersOnly: true
            });
            expect(notificationDecision('agentNotification', ctx({ isAppActive, muted: true }))).toEqual({
                shouldNotify: true,
                shouldBounce: false,
                observersOnly: true
            });
            expect(notificationDecision('osc', ctx({ isAppActive, muted: true }))).toEqual({
                shouldNotify: true,
                shouldBounce: false,
                observersOnly: true
            });
        }
    });

    it('silences errors too, even for the pane the user is looking at', () => {
        expect(
            notificationDecision('error', ctx({ isFocused: true, isAppActive: true, muted: true }))
        ).toEqual({ shouldNotify: true, shouldBounce: false, observersOnly: true });
    });

    it('leaves a suppressed event suppressed', () => {
        expect(
            notificationDecision('stop', ctx({ isFocused: true, isAppActive: true, muted: true }))
        ).toEqual({ shouldNotify: false, shouldBounce: false, observersOnly: true });
        expect(notificationDecision('stop', ctx({ backgroundTaskCount: 2, muted: true }))).toEqual({
            shouldNotify: false,
            shouldBounce: false,
            observersOnly: true
        });
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
