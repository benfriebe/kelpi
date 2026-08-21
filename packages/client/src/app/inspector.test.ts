/**
 * The inspector's data feed: reply parsing (which must never throw on a shape it did not
 * expect) and the re-read triggers — open, workspace change, association/branch change, poll.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection';
import {
    parseAssociations,
    parseGitStatus,
    parseRepos,
    useInspectorData,
    type InspectorReader
} from './inspector';

afterEach(() => {
    vi.useRealTimers();
});

describe('parsing', () => {
    it('reads the wire shape the daemon sends', () => {
        const reply: CommandReply = {
            ok: true,
            workspace_id: 'w1',
            associations: [
                {
                    id: 'a1',
                    repo_id: 'r1',
                    repo_name: 'app',
                    repo_path: '/src/app',
                    worktree_path: '/src/app',
                    worktree_path_real: '/private/src/app',
                    branch: 'main',
                    is_worktree: false,
                    status: { kind: 'dirty', changed_files: 3, additions: 27, deletions: 12 }
                }
            ]
        };
        expect(parseAssociations(reply)).toEqual([
            {
                id: 'a1',
                repoID: 'r1',
                repoName: 'app',
                repoPath: '/src/app',
                worktreePath: '/src/app',
                // §APP-071 / §GIT-092: the symlink-resolved twin, which is what the status
                // footer actually matches a pane's cwd against.
                worktreePathReal: '/private/src/app',
                branch: 'main',
                isWorktree: false,
                status: { kind: 'dirty', changedFiles: 3, additions: 27, deletions: 12 }
            }
        ]);
    });

    /** An older daemon does not send it; every consumer then falls back to `worktreePath`. */
    it('leaves the canonical worktree path blank when the daemon omits it', () => {
        const parsed = parseAssociations({
            ok: true,
            associations: [{ id: 'a1', worktree_path: '/src/app' }]
        });
        expect(parsed[0]?.worktreePathReal).toBe('');
    });

    it('treats anything unexpected as unknown rather than throwing', () => {
        expect(parseGitStatus(undefined)).toEqual({
            kind: 'unknown',
            changedFiles: 0,
            additions: 0,
            deletions: 0
        });
        expect(parseGitStatus({ kind: 'weird' })).toMatchObject({ kind: 'unknown' });
        expect(parseGitStatus({ kind: 'dirty', changed_files: -4 })).toEqual({
            kind: 'dirty',
            changedFiles: 0,
            additions: 0,
            deletions: 0
        });
        expect(parseAssociations({ ok: true })).toEqual([]);
        expect(parseAssociations({ ok: true, associations: ['nope', { repo_id: 'x' }] })).toEqual([]);
        expect(parseRepos({ ok: true, repos: [{ id: 'r1', name: 'app', path: '/p', worktree_base: '/b' }] })).toEqual(
            [{ id: 'r1', name: 'app', path: '/p', worktreeBase: '/b' }]
        );
    });
});

interface Reader extends InspectorReader {
    listRepos: ReturnType<typeof vi.fn> & (() => Promise<CommandReply>);
    workspaceRepoStatus: ReturnType<typeof vi.fn> &
        ((input: { workspaceID: string; refresh?: boolean }) => Promise<CommandReply>);
}

function reader(): Reader {
    return {
        listRepos: vi.fn().mockResolvedValue({ ok: true, repos: [] }),
        workspaceRepoStatus: vi.fn().mockResolvedValue({ ok: true, associations: [] })
    } as unknown as Reader;
}

describe('useInspectorData', () => {
    it('reads no GIT while the inspector is closed, but still knows the registry', () => {
        const commands = reader();
        renderHook(() =>
            useInspectorData({ commands, workspaceID: 'w1', enabled: false, associationsKey: '' })
        );
        // The status read shells out to git; the registry read does not, and the New Workspace
        // form's worktree section needs it whether or not the inspector is open (§WS-078).
        expect(commands.workspaceRepoStatus).not.toHaveBeenCalled();
        expect(commands.listRepos).toHaveBeenCalledTimes(1);
    });

    it('reads git on open, and again when the association signature changes', async () => {
        const commands = reader();
        const { rerender } = renderHook(
            (props: { key: string }) =>
                useInspectorData({
                    commands,
                    workspaceID: 'w1',
                    enabled: true,
                    associationsKey: props.key,
                    pollMs: 0
                }),
            { initialProps: { key: 'a1:/src/app:main' } }
        );
        await waitFor(() => {
            expect(commands.workspaceRepoStatus).toHaveBeenCalledTimes(1);
        });
        // Opening is exactly when a stale badge is worth a real `git status`.
        expect(commands.workspaceRepoStatus).toHaveBeenCalledWith({ workspaceID: 'w1', refresh: true });

        // A HEAD move that renamed the branch arrives as a delta → a new signature → a re-read.
        rerender({ key: 'a1:/src/app:feature' });
        await waitFor(() => {
            expect(commands.workspaceRepoStatus).toHaveBeenCalledTimes(2);
        });
    });

    it('polls while open and stops when it closes', async () => {
        vi.useFakeTimers();
        const commands = reader();
        const { rerender, unmount } = renderHook(
            (props: { enabled: boolean }) =>
                useInspectorData({
                    commands,
                    workspaceID: 'w1',
                    enabled: props.enabled,
                    associationsKey: 'k',
                    pollMs: 1000
                }),
            { initialProps: { enabled: true } }
        );
        expect(commands.workspaceRepoStatus).toHaveBeenCalledTimes(1);
        await act(async () => {
            vi.advanceTimersByTime(2000);
            await Promise.resolve();
        });
        expect(commands.workspaceRepoStatus).toHaveBeenCalledTimes(3);

        rerender({ enabled: false });
        await act(async () => {
            vi.advanceTimersByTime(5000);
            await Promise.resolve();
        });
        expect(commands.workspaceRepoStatus).toHaveBeenCalledTimes(3);
        unmount();
    });

    it('keeps the last good values when a read fails', async () => {
        const commands = reader();
        commands.workspaceRepoStatus.mockResolvedValueOnce({
            ok: true,
            associations: [
                {
                    id: 'a1',
                    repo_id: 'r1',
                    repo_name: 'app',
                    worktree_path: '/src/app',
                    branch: 'main',
                    is_worktree: false,
                    status: { kind: 'clean' }
                }
            ]
        });
        const { result } = renderHook(() =>
            useInspectorData({ commands, workspaceID: 'w1', enabled: true, associationsKey: 'k', pollMs: 0 })
        );
        await waitFor(() => {
            expect(result.current.associations).toHaveLength(1);
        });

        commands.workspaceRepoStatus.mockRejectedValueOnce(new Error('connection lost'));
        act(() => {
            result.current.refresh();
        });
        await waitFor(() => {
            expect(result.current.refreshing).toBe(false);
        });
        // A momentary git/connection failure must not blank the panel.
        expect(result.current.associations).toHaveLength(1);
    });
});
