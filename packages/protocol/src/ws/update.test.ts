import { describe, expect, it } from 'vitest';

import {
    MAX_UPDATE_MESSAGE_LENGTH,
    MAX_UPDATE_NOTES_LENGTH,
    UPDATE_PHASES,
    isUpdateUserAction,
    normalizeUpdateView,
    updateSeq,
    updateVersion
} from './update.js';

describe('the update view (#286)', () => {
    it('keeps a well-formed view, field for field', () => {
        const view = {
            phase: 'available',
            currentVersion: '0.2.2',
            version: '0.2.3',
            notes: '## Fixes\n\n- One',
            location: { blocked: false, message: 'Kelpi is running from ~/Downloads.' }
        };
        expect(normalizeUpdateView(view)).toEqual(view);
    });

    it('refuses an unknown phase, a missing or malformed current version, and a version phase with no version', () => {
        expect(normalizeUpdateView({ phase: 'installing', currentVersion: '0.2.2' })).toBeNull();
        expect(normalizeUpdateView({ phase: 'idle' })).toBeNull();
        expect(normalizeUpdateView({ phase: 'idle', currentVersion: '<b>0.2</b>' })).toBeNull();
        for (const phase of ['available', 'downloading', 'ready', 'restarting']) {
            expect(normalizeUpdateView({ phase, currentVersion: '0.2.2' })).toBeNull();
            expect(normalizeUpdateView({ phase, currentVersion: '0.2.2', version: '"><img>' })).toBeNull();
        }
        expect(normalizeUpdateView(null)).toBeNull();
        expect(normalizeUpdateView([])).toBeNull();
    });

    it('accepts every phase that needs nothing more than the current version', () => {
        for (const phase of UPDATE_PHASES.filter((p) => !['available', 'downloading', 'ready', 'restarting'].includes(p))) {
            expect(normalizeUpdateView({ phase, currentVersion: '0.3.0-dev' })?.phase).toBe(phase);
        }
    });

    it('drops unknown fields, a retry off a failure, and a location without both halves', () => {
        expect(
            normalizeUpdateView({
                phase: 'up-to-date',
                currentVersion: '0.2.3',
                retry: 'download',
                script: 'alert(1)',
                location: { blocked: true }
            })
        ).toEqual({ phase: 'up-to-date', currentVersion: '0.2.3' });
        expect(normalizeUpdateView({ phase: 'failed', currentVersion: '0.2.3', retry: 'reinstall-os' })).toEqual({
            phase: 'failed',
            currentVersion: '0.2.3'
        });
    });

    it('cuts long notes and messages, and strips control characters', () => {
        const view = normalizeUpdateView({
            phase: 'failed',
            currentVersion: '0.2.2',
            message: `bad\u0007 thing\n${'x'.repeat(MAX_UPDATE_MESSAGE_LENGTH * 2)}`,
            notes: `a\u0000b\n${'y'.repeat(MAX_UPDATE_NOTES_LENGTH * 2)}`
        });
        expect(view?.message?.startsWith('bad thing x')).toBe(true);
        expect(view?.message?.length).toBeLessThanOrEqual(MAX_UPDATE_MESSAGE_LENGTH + 1);
        expect(view?.notes?.startsWith('ab\ny')).toBe(true);
        expect(view?.notes?.length).toBeLessThanOrEqual(MAX_UPDATE_NOTES_LENGTH + 1);
    });

    it('reads versions, sequences and actions strictly', () => {
        expect(updateVersion('0.2.3')).toBe('0.2.3');
        expect(updateVersion('v1.0.0-rc.1')).toBe('v1.0.0-rc.1');
        expect(updateVersion('0.2')).toBeUndefined();
        expect(updateVersion(`1.2.3-${'a'.repeat(80)}`)).toBeUndefined();
        expect(updateSeq(0)).toBe(0);
        expect(updateSeq(-1)).toBeUndefined();
        expect(updateSeq(1.5)).toBeUndefined();
        expect(updateSeq('3')).toBeUndefined();
        expect(isUpdateUserAction('restart')).toBe(true);
        expect(isUpdateUserAction('quit')).toBe(false);
    });
});
