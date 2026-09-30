/**
 * The shared default-branch fetch (issue #294): one fetch per repo, a prefetch reused by the
 * create that follows it, expiry, the rate limit, and the silent failure.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultBranchFetchCache } from './fetch-cache.js';
import { WorktreeCreateCancelledError, type WorktreeGitCallOptions, type WorktreeGitOps } from './worktree-add.js';

interface PendingFetch {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly options: WorktreeGitCallOptions | undefined;
    resolve(): void;
    reject(error: Error): void;
}

/** Fake git: `main` is the default branch everywhere, and every fetch waits to be settled. */
function fakeGit() {
    const fetches: PendingFetch[] = [];
    const ops: WorktreeGitOps = {
        read: async (args) => {
            if (args[0] === 'symbolic-ref') return 'origin/main\n';
            if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
            throw new Error(`unexpected read ${args.join(' ')}`);
        },
        long: (args, cwd, options) =>
            new Promise<string>((resolve, reject) => {
                const pending: PendingFetch = {
                    args,
                    cwd,
                    options,
                    resolve: () => resolve(''),
                    reject
                };
                fetches.push(pending);
                options?.signal?.addEventListener('abort', () => reject(new Error('killed')), { once: true });
            })
    };
    return { ops, fetches };
}

function setup() {
    let now = 1_000_000;
    const git = fakeGit();
    const logs: string[] = [];
    const cache = createDefaultBranchFetchCache({ ops: git.ops, log: (line) => logs.push(line), now: () => now });
    return {
        ...git,
        cache,
        logs,
        advance: (ms: number) => {
            now += ms;
        }
    };
}

const flush = async (): Promise<void> => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const create = (overrides: Partial<Parameters<ReturnType<typeof setup>['cache']['fetchForCreate']>[0]> = {}) => ({
    repoPath: '/code/app',
    remote: 'origin',
    branch: 'main',
    ...overrides
});

describe('prefetch', () => {
    it('fetches the default branch once, with no tags, into its remote-tracking ref, never prompting', async () => {
        const h = setup();
        expect(h.cache.prefetch('/code/app')).toBe('started');
        await flush();
        expect(h.fetches).toHaveLength(1);
        expect(h.fetches[0]?.args).toEqual(['fetch', '--no-tags', '--progress', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        expect(h.fetches[0]?.cwd).toBe('/code/app');
        expect(h.fetches[0]?.options?.env).toEqual({ GIT_TERMINAL_PROMPT: '0' });
        expect(h.logs.some((line) => line.includes('fetching origin/main for /code/app') && line.includes('from origin/HEAD'))).toBe(true);
    });

    it('never runs two at once for a repo, then reuses a fresh one, then rate-limits a failed one', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        expect(h.cache.prefetch('/code/app')).toBe('in-flight');
        expect(h.cache.prefetch('/code/app/')).toBe('in-flight'); // the same repo, spelled differently
        await flush();
        expect(h.fetches).toHaveLength(1);
        h.fetches[0]?.resolve();
        await flush();
        h.advance(20_000);
        expect(h.cache.prefetch('/code/app')).toBe('recent');
        // Past the reuse window: a new one may start.
        h.advance(45_000);
        expect(h.cache.prefetch('/code/app')).toBe('started');
        await flush();
        h.fetches[1]?.reject(new Error("fatal: unable to access 'https://example.com/': Could not resolve host"));
        await flush();
        // A failure is only remembered for the rate limit: no retry storm, then a retry.
        h.advance(5_000);
        expect(h.cache.prefetch('/code/app')).toBe('rate-limited');
        h.advance(5_000);
        expect(h.cache.prefetch('/code/app')).toBe('started');
        expect(h.logs.some((line) => line.includes('failed (the next create fetches for itself)'))).toBe(true);
    });

    it('keeps one record per repository, independently', async () => {
        const h = setup();
        expect(h.cache.prefetch('/code/app')).toBe('started');
        expect(h.cache.prefetch('/code/other')).toBe('started');
        await flush();
        expect(h.fetches.map((fetch) => fetch.cwd)).toEqual(['/code/app', '/code/other']);
    });
});

describe('fetchForCreate', () => {
    it('joins a running prefetch instead of fetching again, and sees its meter', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        const joined: string[] = [];
        const seen: number[] = [];
        const pending = h.cache.fetchForCreate(create({ onJoin: (origin) => joined.push(origin), onProgress: (p) => seen.push(p.percent) }));
        await flush();
        // The prefetch's stderr reaches the joined create's meter.
        h.fetches[0]?.options?.onStderr?.('Receiving objects:  45% (45/100)\r');
        h.fetches[0]?.resolve();
        expect(await pending).toEqual({ kind: 'joined', origin: 'prefetch' });
        expect(joined).toEqual(['prefetch']);
        expect(seen).toEqual([45]);
        expect(h.fetches).toHaveLength(1);
    });

    it('reuses a fetch that finished recently, and fetches for itself once it is stale', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        h.fetches[0]?.resolve();
        await flush();
        h.advance(5_000);
        expect(await h.cache.fetchForCreate(create())).toEqual({ kind: 'reused', ageMs: 5_000, origin: 'prefetch' });
        expect(h.fetches).toHaveLength(1);
        h.advance(60_000);
        const own = h.cache.fetchForCreate(create());
        await flush();
        expect(h.fetches).toHaveLength(2);
        h.fetches[1]?.resolve();
        expect(await own).toEqual({ kind: 'fetched' });
    });

    it('never reuses a fetch older than the reuse window, even while the record is kept for the rate limit', async () => {
        let now = 0;
        const git = fakeGit();
        // A reuse window shorter than the rate limit: the record outlives its reusability.
        const cache = createDefaultBranchFetchCache({ ops: git.ops, now: () => now, reuseMs: 2_000, minIntervalMs: 10_000 });
        cache.prefetch('/code/app');
        await flush();
        git.fetches[0]?.resolve();
        await flush();
        now += 3_000;
        expect(cache.peek('/code/app')).not.toBeNull();
        const own = cache.fetchForCreate(create());
        await flush();
        expect(git.fetches).toHaveLength(2);
        git.fetches[1]?.resolve();
        expect(await own).toEqual({ kind: 'fetched' });
    });

    it('does not reuse a fetch of another branch or remote', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        h.fetches[0]?.resolve();
        await flush();
        const other = h.cache.fetchForCreate(create({ branch: 'trunk' }));
        await flush();
        expect(h.fetches).toHaveLength(2);
        expect(h.fetches[1]?.args.at(-1)).toBe('+refs/heads/trunk:refs/remotes/origin/trunk');
        h.fetches[1]?.resolve();
        expect(await other).toEqual({ kind: 'fetched' });
    });

    it('fetches for itself when the prefetch it joined failed', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        const pending = h.cache.fetchForCreate(create());
        await flush();
        h.fetches[0]?.reject(new Error('fatal: network down'));
        await flush();
        expect(h.fetches).toHaveLength(2);
        h.fetches[1]?.resolve();
        expect(await pending).toEqual({ kind: 'fetched' });
    });

    it("lets a second create join the first create's fetch, and a create's own fetch report its failure", async () => {
        const h = setup();
        const first = h.cache.fetchForCreate(create());
        await flush();
        const second = h.cache.fetchForCreate(create());
        await flush();
        expect(h.fetches).toHaveLength(1);
        h.fetches[0]?.reject(new Error('fatal: denied'));
        await expect(first).rejects.toThrow('fatal: denied');
        // The joiner saw the failure and fetched for itself.
        await flush();
        expect(h.fetches).toHaveLength(2);
        h.fetches[1]?.resolve();
        expect(await second).toEqual({ kind: 'fetched' });
        // A prefetch now is rate-limited by the create's fetch as well: one fetch per repo.
        expect(h.cache.prefetch('/code/app')).toBe('rate-limited');
    });

    it('a cancelled joiner stops waiting but never kills the shared prefetch', async () => {
        const h = setup();
        h.cache.prefetch('/code/app');
        await flush();
        const controller = new AbortController();
        const pending = h.cache.fetchForCreate(create({ signal: controller.signal }));
        await flush();
        controller.abort();
        await expect(pending).rejects.toBeInstanceOf(WorktreeCreateCancelledError);
        expect(h.cache.peek('/code/app')).toMatchObject({ origin: 'prefetch', finishedAt: null });
        h.fetches[0]?.resolve();
        await flush();
        expect(h.cache.peek('/code/app')).toMatchObject({ ok: true });
    });

    it("a cancelled create kills its OWN fetch", async () => {
        const h = setup();
        const controller = new AbortController();
        const pending = h.cache.fetchForCreate(create({ signal: controller.signal }));
        await flush();
        expect(h.fetches[0]?.options?.signal).toBe(controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow('killed');
        expect(h.cache.peek('/code/app')).toMatchObject({ origin: 'create', ok: false });
    });
});
