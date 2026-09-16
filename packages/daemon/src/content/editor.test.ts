import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    EDITOR_AUTOSAVE_DEBOUNCE_MS,
    createEditorBuffers,
    writeFileAtomic,
    type EditorTarget
} from './editor.js';

const FILE: EditorTarget = { kind: 'file', path: '/notes/a.md' };
const SCRATCH: EditorTarget = { kind: 'scratchpad' };

interface Harness {
    readonly writes: { path: string; text: string }[];
    readonly scratch: { paneID: string; text: string }[];
    readonly saved: { paneID: string; text: string }[];
    readonly errors: string[];
}

function harness(overrides: { failWrite?: boolean; declineScratchpad?: boolean } = {}): {
    readonly buffers: ReturnType<typeof createEditorBuffers>;
    readonly log: Harness;
} {
    const log: Harness = { writes: [], scratch: [], saved: [], errors: [] };
    const buffers = createEditorBuffers({
        writeFile: (filePath, text) => {
            if (overrides.failWrite === true) throw new Error('EACCES');
            log.writes.push({ path: filePath, text });
        },
        saveScratchpad: (paneID, text) => {
            // #106: a target that cannot dispatch says so, and the buffer stays dirty.
            if (overrides.declineScratchpad === true) return false;
            log.scratch.push({ paneID, text });
            return true;
        },
        onSaved: (paneID, text) => log.saved.push({ paneID, text }),
        onError: (error) => log.errors.push(error.message)
    });
    return { buffers, log };
}

describe('createEditorBuffers', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('debounces the save by 500 ms and coalesces keystrokes', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();

        buffers.set('p1', FILE, 'a');
        buffers.set('p1', FILE, 'ab');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS - 1);
        expect(log.writes).toEqual([]);
        expect(buffers.isDirty('p1')).toBe(true);

        buffers.set('p1', FILE, 'abc');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS - 1);
        expect(log.writes).toEqual([]); // the third keystroke restarted the timer

        vi.advanceTimersByTime(1);
        expect(log.writes).toEqual([{ path: '/notes/a.md', text: 'abc' }]);
        expect(log.saved).toEqual([{ paneID: 'p1', text: 'abc' }]);
        expect(buffers.isDirty('p1')).toBe(false);
    });

    it('sends a scratchpad buffer to the store, never to disk', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.set('p2', SCRATCH, 'note');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS);
        expect(log.scratch).toEqual([{ paneID: 'p2', text: 'note' }]);
        expect(log.writes).toEqual([]);
    });

    /**
     * Issue #106 - a save that dispatched nothing must not report itself as saved.
     *
     * `buffer.dirty = false` and `onSaved` used to run unconditionally around the scratchpad
     * target, so an edit could be marked clean with nothing written anywhere. Dirty is both the
     * truthful state and the recoverable one: `flushAll` and `forget` try again.
     */
    it('leaves the buffer dirty when the scratchpad target declines the save (#106)', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness({ declineScratchpad: true });
        buffers.set('p2', SCRATCH, 'note');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS);

        expect(log.scratch).toEqual([]);
        expect(log.saved).toEqual([]);
        expect(buffers.isDirty('p2')).toBe(true);
        expect(buffers.flush('p2')).toBe(false);
    });

    it('flush writes immediately and cancels the pending timer', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.set('p1', FILE, 'x');
        expect(buffers.flush('p1')).toBe(true);
        expect(log.writes).toHaveLength(1);
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS * 2);
        expect(log.writes).toHaveLength(1); // the timer did not fire a second write
        expect(buffers.flush('p1')).toBe(false); // nothing left to save
    });

    it('flushAll covers BOTH markdown files and scratchpads (the §7 gap)', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.set('p1', FILE, 'file text');
        buffers.set('p2', SCRATCH, 'scratch text');
        buffers.flushAll();
        expect(log.writes).toEqual([{ path: '/notes/a.md', text: 'file text' }]);
        expect(log.scratch).toEqual([{ paneID: 'p2', text: 'scratch text' }]);
        expect(buffers.dirtyPaneIDs).toEqual([]);
    });

    it('seeds a buffer without marking it dirty or scheduling a save', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.seed('p1', FILE, 'from disk');
        expect(buffers.text('p1')).toBe('from disk');
        expect(buffers.isDirty('p1')).toBe(false);
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS * 2);
        expect(log.writes).toEqual([]);
    });

    it('keeps a buffer dirty when the write fails, and reports the error', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness({ failWrite: true });
        buffers.set('p1', FILE, 'x');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS);
        expect(log.errors).toEqual(['EACCES']);
        expect(buffers.isDirty('p1')).toBe(true);
        expect(log.saved).toEqual([]);
    });

    it('forget flushes then drops; drop discards without saving', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.set('p1', FILE, 'keep me');
        buffers.forget('p1');
        expect(log.writes).toEqual([{ path: '/notes/a.md', text: 'keep me' }]);
        expect(buffers.text('p1')).toBeUndefined();

        buffers.set('p3', FILE, 'lose me');
        buffers.drop('p3');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS * 2);
        expect(log.writes).toHaveLength(1);
    });

    it('dispose cancels pending timers and accepts no further edits', () => {
        vi.useFakeTimers();
        const { buffers, log } = harness();
        buffers.set('p1', FILE, 'x');
        buffers.dispose();
        buffers.set('p1', FILE, 'y');
        vi.advanceTimersByTime(EDITOR_AUTOSAVE_DEBOUNCE_MS * 2);
        expect(log.writes).toEqual([]);
    });
});

describe('writeFileAtomic', () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    const tmpdir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-editor-'));
        dirs.push(dir);
        return dir;
    };

    it('replaces the file contents and leaves no temp files behind', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'note.md');
        fs.writeFileSync(file, 'old');
        writeFileAtomic(file, 'new');
        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        expect(fs.readdirSync(dir)).toEqual(['note.md']);
    });

    it('creates a file that does not exist yet', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'fresh.md');
        writeFileAtomic(file, 'hello');
        expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    });

    it('preserves the original mode', () => {
        const dir = tmpdir();
        const file = path.join(dir, 'note.md');
        fs.writeFileSync(file, 'old', { mode: 0o640 });
        fs.chmodSync(file, 0o640);
        writeFileAtomic(file, 'new');
        expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    });
});
