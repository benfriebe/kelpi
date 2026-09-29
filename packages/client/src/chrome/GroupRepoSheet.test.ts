/**
 * The group repository sheet's two decisions, as pure functions (app-state-core.md §5.5): what a
 * Save sends, and which registry rows it lists. The sheet itself is driven end to end in
 * `Sidebar.group-repo.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { groupRepoSaveChange, groupRepoSheetRows } from './GroupRepoSheet';
import type { ChromeRepo } from './types';

describe('groupRepoSaveChange', () => {
    it('sends a registry row by id and a folder by path, each with the switch', () => {
        expect(groupRepoSaveChange({ kind: 'repo', repoID: 'r1' }, true, false)).toEqual({ repoID: 'r1', createWorktree: true });
        expect(groupRepoSaveChange({ kind: 'folder', path: '/src/x' }, false, true)).toEqual({ repoPath: '/src/x', createWorktree: false });
    });

    it('clears with no switch at all, never "switch on, no repo" (the reducer invariant)', () => {
        expect(groupRepoSaveChange({ kind: 'none' }, true, true)).toEqual({ repoPath: null });
    });

    it('has nothing to save for no repository on a group that has none', () => {
        expect(groupRepoSaveChange({ kind: 'none' }, false, false)).toBeNull();
    });
});

describe('groupRepoSheetRows', () => {
    const repos: ChromeRepo[] = [
        { id: 'm', name: 'manual', path: '/m', worktreeBase: '/wt' },
        { id: 'a', name: 'auto', path: '/a', worktreeBase: '/wt', isAutoDiscovered: true }
    ];
    it('hides auto-discovered rows unless asked, or unless one is the current repo', () => {
        expect(groupRepoSheetRows(repos, null, false).map((repo) => repo.id)).toEqual(['m']);
        expect(groupRepoSheetRows(repos, null, true).map((repo) => repo.id)).toEqual(['m', 'a']);
        expect(groupRepoSheetRows(repos, 'a', false).map((repo) => repo.id)).toEqual(['m', 'a']);
    });
});
