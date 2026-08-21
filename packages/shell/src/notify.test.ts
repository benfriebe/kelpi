import { describe, expect, it } from 'vitest';

import {
    NEX_AGENT_ACTIONS,
    NEX_AGENT_ACTION_IDS,
    NEX_AGENT_CATEGORY,
    agentNotificationSpec,
    notificationActionID,
    notificationLogLine
} from './notify.js';

describe('the nex-agent notification category (§AGNT-073)', () => {
    it('carries exactly the Swift category: identifier, two actions, Open first', () => {
        expect(NEX_AGENT_CATEGORY).toBe('nex-agent');
        expect(NEX_AGENT_ACTIONS.map((action) => action.text)).toEqual(['Open', 'Dismiss']);
        expect(NEX_AGENT_ACTIONS.every((action) => action.type === 'button')).toBe(true);
        // The order is the protocol: macOS reports a chosen action by index, and macOS shows
        // the FIRST action as the button, so "Open" leading is a behaviour, not a preference.
        expect(NEX_AGENT_ACTION_IDS).toEqual(['open', 'dismiss']);
    });

    it('attaches the same action set to every notification it builds', () => {
        const first = agentNotificationSpec({ title: 'Nex', body: 'Approval requested: Bash' });
        const second = agentNotificationSpec({ title: 'Codex', body: 'Approval requested: Edit' });
        expect(first.actions).toEqual(NEX_AGENT_ACTIONS);
        expect(second.actions).toEqual(first.actions);
        // `silent: false` is the port of `content.sound = .default`.
        expect(first.silent).toBe(false);
        expect(second.title).toBe('Codex');
        expect(second.body).toBe('Approval requested: Edit');
    });

    it('falls back to the app name and an empty body, as the Swift content does', () => {
        expect(agentNotificationSpec({})).toMatchObject({ title: 'Nex', body: '' });
        expect(agentNotificationSpec({ title: '', body: undefined }).title).toBe('Nex');
    });

    it('resolves the chosen action by index, and refuses to guess outside the set', () => {
        expect(notificationActionID(0)).toBe('open');
        expect(notificationActionID(1)).toBe('dismiss');
        // Anything else must not be read as "Open" — that would raise a window nobody asked for.
        for (const index of [-1, 2, 99, 0.5, Number.NaN]) {
            expect(notificationActionID(index)).toBeNull();
        }
    });

    it('logs a line naming the category and its actions, for the smoke to assert', () => {
        const line = notificationLogLine('nex-PANE', agentNotificationSpec({ title: 'Nex', body: 'x' }));
        expect(line).toContain('category=nex-agent');
        expect(line).toContain('actions=Open,Dismiss');
        expect(line).toContain('nex-PANE');
    });
});
