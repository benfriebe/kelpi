import { afterEach, expect, it, vi } from 'vitest';
import { createPersistence, SAVE_MAX_WAIT_MS } from './persistence.js';
import { toSnapshot } from '../store/index.js';
import { seededState } from '../store/testing.js';
afterEach(() => vi.useRealTimers());
it('saves the latest state under continuous updates and starts a new deadline after each save', () => {
    vi.useFakeTimers();
    const p = createPersistence({ path: ':memory:' });
    const snapshot = toSnapshot(seededState());
    p.saveNow(snapshot);
    const savedAt = p.health().lastSaveAt!;
    for (let i = 0; i < 100; i++) {
        p.scheduleSave({ ...snapshot, workspaces: snapshot.workspaces.map(w => ({ ...w, name: `revision-${i}` })) });
        vi.advanceTimersByTime(100);
        if (i === 49) expect(p.health().lastSaveAt).toBe(savedAt + SAVE_MAX_WAIT_MS);
    }
    expect(p.health().lastSaveAt).toBe(savedAt + 2 * SAVE_MAX_WAIT_MS);
    expect(p.hasPendingSave()).toBe(false);
    expect(p.loadOutcome().snapshot?.workspaces[0]?.name).toBe('revision-99');
    p.close();
    expect(vi.getTimerCount()).toBe(0);
});
it('cancels the deadline after an explicit save, flush or close', () => {
    vi.useFakeTimers();
    const p = createPersistence({ path: ':memory:' });
    const snapshot = toSnapshot(seededState());
    for (const finish of [() => p.saveNow(snapshot), () => p.flush(), () => p.close()]) {
        p.scheduleSave(snapshot);
        finish();
        expect(vi.getTimerCount()).toBe(0);
    }
});
