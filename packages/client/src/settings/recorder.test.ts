import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import { describe, expect, it } from 'vitest';

import type { KeyEventLike } from '../chrome';
import { NEEDS_MODIFIER_MESSAGE, recordKeyEvent } from './recorder';

function press(code: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
    return {
        code,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        ...modifiers
    };
}

const options = { bindings: DEFAULT_KEYBINDINGS };

describe('the key recorder (§13.2)', () => {
    it('captures a modified combo as its config + display strings', () => {
        const outcome = recordKeyEvent(press('KeyT', { ctrlKey: true, altKey: true }), options);
        expect(outcome).toMatchObject({ kind: 'captured', config: 'ctrl+alt+t', display: '⌃⌥T' });
    });

    it('refuses a bare key: the combo needs at least one modifier', () => {
        expect(recordKeyEvent(press('KeyT'), options)).toEqual({
            kind: 'rejected',
            reason: NEEDS_MODIFIER_MESSAGE
        });
    });

    it('accepts a bare F-key (§13.2’s exemption)', () => {
        expect(recordKeyEvent(press('F5'), options)).toMatchObject({ kind: 'captured', config: 'f5' });
        expect(recordKeyEvent(press('F12'), options)).toMatchObject({ kind: 'captured', config: 'f12' });
    });

    it('cancels on bare Escape — the sheet’s standard cancel beats the capture rule', () => {
        expect(recordKeyEvent(press('Escape'), options)).toEqual({ kind: 'cancelled' });
    });

    it('still records a MODIFIED Escape', () => {
        expect(recordKeyEvent(press('Escape', { metaKey: true }), options)).toMatchObject({
            kind: 'captured',
            config: 'super+escape'
        });
    });

    it('ignores a bare modifier press and an unmappable key rather than erroring', () => {
        expect(recordKeyEvent(press('MetaLeft', { metaKey: true }), options)).toEqual({ kind: 'ignored' });
        expect(recordKeyEvent(press('IntlBackslash', { metaKey: true }), options)).toEqual({ kind: 'ignored' });
    });

    it('refuses a combo another action already owns, naming it (§8.5)', () => {
        const outcome = recordKeyEvent(press('KeyD', { metaKey: true }), {
            bindings: DEFAULT_KEYBINDINGS,
            excluding: 'close_pane'
        });
        expect(outcome).toMatchObject({ kind: 'conflict', action: 'split_right' });
        expect(outcome.kind === 'conflict' ? outcome.reason : '').toBe('Already bound to “Split Right”');
    });

    it('treats re-recording the action’s own combo as an unchanged capture', () => {
        const outcome = recordKeyEvent(press('KeyD', { metaKey: true }), {
            bindings: DEFAULT_KEYBINDINGS,
            excluding: 'split_right'
        });
        expect(outcome).toMatchObject({ kind: 'captured', config: 'super+d', unchanged: true });
    });

    it('captures a free combo as changed even when the action already has other triggers', () => {
        const outcome = recordKeyEvent(press('KeyJ', { ctrlKey: true, shiftKey: true }), {
            bindings: DEFAULT_KEYBINDINGS,
            excluding: 'split_right'
        });
        expect(outcome).toMatchObject({ kind: 'captured', config: 'ctrl+shift+j', unchanged: false });
    });
});
