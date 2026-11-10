/** Issue #467: rebuilding a discarded tab's history (`./tab-restore.ts`). */

import { describe, expect, it } from 'vitest';

import { restorePlan, type TabRestore } from './tab-restore.js';

const entry = (url: string, pageState?: string) => ({ url, title: url, ...(pageState === undefined ? {} : { pageState }) });

const restore = (overrides: Partial<TabRestore>): TabRestore => ({
    entries: [entry('about:blank'), entry('https://a/', 'A'), entry('https://b/', 'B')],
    index: 2,
    zoomFactor: 1,
    lastAttemptedURL: 'https://b/',
    failedLoad: false,
    navigated: true,
    ...overrides
});

describe('restorePlan', () => {
    it('restores the list as it was, page states included, and goes back to the entry the tab was on', () => {
        const plan = restorePlan(restore({}));
        expect(plan.entries.map((e) => e.url)).toEqual(['about:blank', 'https://a/', 'https://b/']);
        expect(plan.entries[2]?.pageState).toBe('B');
        expect(plan.target).toBe(2);
    });

    it('keeps the forward entries when the tab had gone back', () => {
        const plan = restorePlan(restore({ index: 1 }));
        expect(plan.target).toBe(1);
        expect(plan.entries).toHaveLength(3);
    });

    it('puts an about:blank first when the history cap had dropped the bootstrap entry', () => {
        const plan = restorePlan(restore({ entries: [entry('https://a/'), entry('https://b/')], index: 1 }));
        expect(plan.entries.map((e) => e.url)).toEqual(['about:blank', 'https://a/', 'https://b/']);
        expect(plan.target).toBe(2);
    });

    it('loads nothing for a tab that never left about:blank', () => {
        expect(restorePlan(restore({ entries: [entry('about:blank')], index: 0 })).target).toBeNull();
        expect(restorePlan(restore({ entries: [], index: -1 })).target).toBeNull();
        expect(restorePlan(restore({ entries: [], index: -1 })).entries.map((e) => e.url)).toEqual(['about:blank']);
    });

    it('goes back to the error card a failed load left, so the history before it survives', () => {
        // Loading the failed address instead would start from the restore's about:blank and
        // prune every entry after it; the card's Retry (and a reload) still retries it.
        const plan = restorePlan(
            restore({
                entries: [entry('about:blank'), entry('https://a/'), entry('data:text/html,card')],
                index: 2,
                failedLoad: true,
                lastAttemptedURL: 'https://down.example/'
            })
        );
        expect(plan.target).toBe(2);
        expect(plan.entries.map((e) => e.url)).toEqual(['about:blank', 'https://a/', 'data:text/html,card']);
    });

    it('treats an index past the list as nothing to go to', () => {
        expect(restorePlan(restore({ index: 9 })).target).toBeNull();
        expect(restorePlan(restore({ index: Number.NaN })).target).toBeNull();
    });
});
