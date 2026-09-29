import { describe, expect, it, vi } from 'vitest';

import { closesSheet, createUpdateSheetController, parseUpdateState, type UpdateSheetState } from './update-sheet';

const VIEW = { phase: 'available', currentVersion: '0.2.2', version: '0.2.3', notes: '## Fixes' };

function frame(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: 'update-state', windowID: 'WIN-1', seq: 1, reveal: true, view: VIEW, notesHTML: '<h2>Fixes</h2>', ...fields };
}

describe('reading update-state (#286)', () => {
    it('reads a frame for this window, view validated', () => {
        expect(parseUpdateState(frame(), 'WIN-1')).toEqual({ view: VIEW, seq: 1, reveal: true, notesHTML: '<h2>Fixes</h2>' });
    });

    it('ignores another window\'s frame, other message types and malformed frames', () => {
        expect(parseUpdateState(frame({ windowID: 'WIN-2' }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(frame({ windowID: undefined }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(frame({ type: 'menu-command' }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(frame({ seq: 'x' }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(frame({ reveal: 1 }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(frame({ view: { phase: 'ready', currentVersion: '0.2.2' } }), 'WIN-1')).toBeNull();
        expect(parseUpdateState(null, 'WIN-1')).toBeNull();
    });

    it('keeps notes HTML only beside notes', () => {
        expect(parseUpdateState(frame({ view: { phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' } }), 'WIN-1')?.notesHTML).toBeUndefined();
    });
});

describe('the update sheet controller (#286)', () => {
    function controller() {
        const sent: [string, number | undefined][] = [];
        const states: (UpdateSheetState | null)[] = [];
        const c = createUpdateSheetController({
            windowID: 'WIN-1',
            send: (action, seq) => sent.push([action, seq]),
            onChange: (state) => states.push(state)
        });
        return { c, sent, states };
    }

    it('opens on a revealed view and acknowledges it with its seq', () => {
        const { c, sent } = controller();
        c.handleMessage(frame({ seq: 7 }));
        expect(c.current?.view.phase).toBe('available');
        expect(sent).toEqual([['shown', 7]]);
    });

    it('follows an open sheet on a view that is not revealed, and stays closed on one while closed', () => {
        const { c, sent } = controller();
        c.handleMessage(frame({ reveal: false }));
        expect(c.current).toBeNull();
        c.handleMessage(frame({ seq: 2 }));
        c.handleMessage(frame({ seq: 3, reveal: false, view: { phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' } }));
        expect(c.current?.view.phase).toBe('restarting');
        expect(sent).toEqual([['shown', 2]]);
    });

    it('sends each button to the shell, closing the sheet for Later and dismiss only', () => {
        const { c, sent } = controller();
        c.handleMessage(frame());
        c.act('update-now');
        expect(c.current).not.toBeNull();
        c.act('later');
        expect(c.current).toBeNull();
        expect(sent.slice(1)).toEqual([
            ['update-now', undefined],
            ['later', undefined]
        ]);
        expect(closesSheet('dismiss')).toBe(true);
        expect(closesSheet('restart')).toBe(false);
    });

    it('closes when the flow goes idle', () => {
        const onChange = vi.fn();
        const c = createUpdateSheetController({ windowID: 'WIN-1', send: () => undefined, onChange });
        c.handleMessage(frame());
        c.handleMessage(frame({ seq: 2, reveal: false, view: { phase: 'idle', currentVersion: '0.2.2' } }));
        expect(c.current).toBeNull();
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});
