import { describe, expect, it } from 'vitest';

import { clearFocusedScreen } from './clear-screen';

function harness(options: { focused: string | null; terminals: readonly string[] }) {
    const cleared: string[] = [];
    const run = () =>
        clearFocusedScreen({
            focusedPaneID: () => options.focused,
            isTerminalPane: (paneID) => options.terminals.includes(paneID),
            clear: (paneID) => cleared.push(paneID)
        });
    return { cleared, run };
}

describe('clearFocusedScreen', () => {
    it('clears the focused terminal pane and consumes the chord', () => {
        const h = harness({ focused: 'pane-a', terminals: ['pane-a', 'pane-b'] });

        expect(h.run()).toBe(true);

        expect(h.cleared).toEqual(['pane-a']);
    });

    it.each([
        ['nothing is focused', { focused: null, terminals: ['pane-a'] }],
        ['the focused pane has no terminal renderer', { focused: 'markdown', terminals: ['pane-a'] }]
    ])('falls through and clears nothing when %s', (_label, options) => {
        const h = harness(options);

        expect(h.run()).toBe(false);

        expect(h.cleared).toEqual([]);
    });
});
