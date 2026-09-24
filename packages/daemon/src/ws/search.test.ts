import { describe, expect, it } from 'vitest';

import { workspaceByID } from '../store/derived.js';
import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import type { TerminalMatch } from '../term/search.js';
import { createTerminalSearchChannel, isTerminalSearchCommand } from './search.js';

const P0 = id('dddddddd', 100);

function match(line: number, col: number, bufferLength = 100): TerminalMatch {
    return { line, col, length: 6, linesFromBottom: bufferLength - line };
}

interface Fixture {
    readonly h: ReturnType<typeof harness>;
    readonly channel: ReturnType<typeof createTerminalSearchChannel>;
    readonly calls: { paneID: string; needle: string; caseSensitive: boolean | undefined }[];
    setMatches(matches: readonly TerminalMatch[]): void;
}

function fixture(): Fixture {
    const h = harness(seededState());
    const calls: Fixture['calls'] = [];
    let matches: readonly TerminalMatch[] = [];
    const channel = createTerminalSearchChannel({
        store: h.store,
        term: {
            searchAsync: (paneID, needle, options) => {
                calls.push({ paneID, needle, caseSensitive: options.caseSensitive });
                return Promise.resolve(matches);
            }
        }
    });
    return {
        h,
        channel,
        calls,
        setMatches(next) {
            matches = next;
        }
    };
}

/**
 * A backend whose searches finish when the test says so, in whatever order it says.
 *
 * Each call waits for its own `finish(index, matches)`, which is how two recounts that race in a
 * real daemon (the buffer read is asynchronous and nothing orders two of them) are made to finish
 * out of order on purpose.
 */
function deferredFixture() {
    const h = harness(seededState());
    const pending: { needle: string; caseSensitive: boolean | undefined; resolve: (matches: readonly TerminalMatch[]) => void }[] = [];
    const channel = createTerminalSearchChannel({
        store: h.store,
        term: {
            searchAsync: (_paneID, needle, options) =>
                new Promise((resolve) => pending.push({ needle, caseSensitive: options.caseSensitive, resolve }))
        }
    });
    return {
        h,
        channel,
        pending,
        async finish(index: number, matches: readonly TerminalMatch[]): Promise<void> {
            pending[index]!.resolve(matches);
            for (let step = 0; step < 5; step += 1) await Promise.resolve();
        },
        /** Let queued requests reach their recount. */
        async settle(): Promise<void> {
            for (let step = 0; step < 5; step += 1) await Promise.resolve();
        }
    };
}

describe('isTerminalSearchCommand', () => {
    it('matches only the one verb', () => {
        expect(isTerminalSearchCommand('terminal-search')).toBe(true);
        expect(isTerminalSearchCommand('content-find')).toBe(false);
    });
});

describe('terminal-search', () => {
    it('rejects an unknown action', async () => {
        const f = fixture();
        const reply = await f.channel.run({ action: 'burn', workspace_id: W1 });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).toContain('action must be one of');
    });

    it('rejects a request that names no known workspace', async () => {
        const f = fixture();
        expect(await f.channel.run({ action: 'toggle', workspace_id: 'nope' })).toMatchObject({ ok: false });
        expect(await f.channel.run({ action: 'toggle' })).toMatchObject({ ok: false });
    });

    it('resolves the workspace from a pane id when no workspace id is given', async () => {
        const f = fixture();
        const reply = await f.channel.run({ action: 'toggle', pane_id: P0 });
        expect(reply).toMatchObject({ ok: true, workspace_id: W1, pane_id: P0 });
    });

    it('toggle opens the bar on the focused shell pane and closes it again', async () => {
        const f = fixture();
        const opened = await f.channel.run({ action: 'toggle', workspace_id: W1 });
        expect(opened).toMatchObject({ ok: true, pane_id: P0, needle: '', total: null, selected: null });
        const closed = await f.channel.run({ action: 'toggle', workspace_id: W1 });
        expect(closed).toMatchObject({ ok: true, pane_id: null });
    });

    it('refuses set/next/prev while no search is open', async () => {
        const f = fixture();
        for (const action of ['set', 'next', 'prev']) {
            const reply = await f.channel.run({ action, workspace_id: W1, needle: 'x' });
            expect(reply).toMatchObject({ ok: false });
            expect(String(reply['error'])).toContain('no search is open');
        }
    });

    it('set publishes the needle and the total, with no selection yet', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 2), match(20, 4), match(30, 6)]);
        const reply = await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        expect(reply).toMatchObject({ ok: true, needle: 'marker', total: 3, selected: null, match: null });
        const workspace = workspaceByID(f.h.state(), W1);
        expect(workspace?.searchNeedle).toBe('marker');
        expect(workspace?.searchTotal).toBe(3);
        expect(workspace?.searchSelected).toBeNull();
    });

    it('set requires a needle field', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        expect(await f.channel.run({ action: 'set', workspace_id: W1 })).toMatchObject({ ok: false });
    });

    it('forwards case sensitivity to the backend', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'x', case_sensitive: true });
        expect(f.calls.at(-1)).toMatchObject({ paneID: P0, needle: 'x', caseSensitive: true });
    });

    it('next starts at the first match and wraps; prev starts at the last', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 0), match(20, 0), match(30, 0)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });

        expect(await f.channel.run({ action: 'next', workspace_id: W1 })).toMatchObject({ selected: 0 });
        expect(await f.channel.run({ action: 'next', workspace_id: W1 })).toMatchObject({ selected: 1 });
        expect(await f.channel.run({ action: 'next', workspace_id: W1 })).toMatchObject({ selected: 2 });
        expect(await f.channel.run({ action: 'next', workspace_id: W1 })).toMatchObject({ selected: 0 });
        expect(await f.channel.run({ action: 'prev', workspace_id: W1 })).toMatchObject({ selected: 2 });
    });

    it('prev with no selection lands on the last match', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 0), match(20, 0)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        expect(await f.channel.run({ action: 'prev', workspace_id: W1 })).toMatchObject({ selected: 1 });
    });

    it('carries the selected match position, anchored to the bottom of the buffer', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(90, 7, 100)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        const reply = await f.channel.run({ action: 'next', workspace_id: W1 });
        expect(reply['match']).toMatchObject({ line: 90, col: 7, length: 6, lines_from_bottom: 10 });
    });

    it('a total of zero drops the selection so the counter can never read "3/0"', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 0), match(20, 0)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        await f.channel.run({ action: 'next', workspace_id: W1 });
        f.setMatches([]);
        const reply = await f.channel.run({ action: 'next', workspace_id: W1 });
        expect(reply).toMatchObject({ total: 0, selected: null, match: null });
    });

    it('close clears every field', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 0)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        const reply = await f.channel.run({ action: 'close', workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, pane_id: null, needle: '', total: null, selected: null });
    });

    it('status reads without mutating', async () => {
        const f = fixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        f.setMatches([match(10, 0)]);
        await f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        const before = workspaceByID(f.h.state(), W1);
        const reply = await f.channel.run({ action: 'status', workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, needle: 'marker', total: 1 });
        expect(workspaceByID(f.h.state(), W1)).toBe(before);
    });

    it('defaults to status when no action is given', async () => {
        const f = fixture();
        expect(await f.channel.run({ workspace_id: W1 })).toMatchObject({ ok: true, pane_id: null });
    });

    it('reports no total for a non-terminal pane, whose find runs client-side', async () => {
        const f = fixture();
        const MD = id('eeeeeeee', 1);
        f.h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/tmp/doc.md',
            now: NOW
        });
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        expect(workspaceByID(f.h.state(), W1)?.searchingPaneID).toBe(MD);
        const reply = await f.channel.run({ action: 'set', workspace_id: W1, needle: 'x' });
        expect(reply).toMatchObject({ ok: true, total: null });
        expect(f.calls).toHaveLength(0);
    });

    it('survives a backend with no search support at all', async () => {
        const h = harness(seededState());
        const channel = createTerminalSearchChannel({ store: h.store, term: {} });
        await channel.run({ action: 'toggle', workspace_id: W1 });
        expect(await channel.run({ action: 'set', workspace_id: W1, needle: 'x' })).toMatchObject({
            ok: true,
            total: 0
        });
    });
});

/**
 * Two recounts race, and the one that was asked for LAST is the one that counts.
 *
 * A presenter's case toggle sends the needle case sensitive, and its stand-down re-sends it
 * insensitive a moment later: if the first recount finished second, it published its total over
 * the second's, and the native bar - which has no toggle - read "no matches" for a needle that
 * plainly matched.
 */
describe('terminal-search recounts that finish out of order', () => {
    it('drops a set whose recount finishes after a newer set, whatever its case flag', async () => {
        const f = deferredFixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        const sensitive = f.channel.run({ action: 'set', workspace_id: W1, needle: 'needle', case_sensitive: true });
        const insensitive = f.channel.run({ action: 'set', workspace_id: W1, needle: 'needle', case_sensitive: false });
        await f.settle();
        expect(f.pending.map((call) => call.caseSensitive)).toEqual([true, false]);
        // The NEWER request finishes first and publishes twelve.
        await f.finish(1, Array.from({ length: 12 }, (_, index) => match(index + 1, 0)));
        await insensitive;
        expect(workspaceByID(f.h.state(), W1)?.searchTotal).toBe(12);
        // The older one finishes second and publishes nothing.
        await f.finish(0, []);
        expect(await sensitive).toMatchObject({ ok: true });
        expect(workspaceByID(f.h.state(), W1)?.searchTotal).toBe(12);
    });

    it('lets two steps on the same needle both land, whatever order they finish in', async () => {
        const f = deferredFixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        const three = [match(10, 0), match(20, 0), match(30, 0)];
        const set = f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        await f.settle();
        await f.finish(0, three);
        await set;
        const first = f.channel.run({ action: 'next', workspace_id: W1 });
        const second = f.channel.run({ action: 'next', workspace_id: W1 });
        await f.settle();
        await f.finish(2, three);
        await f.finish(1, three);
        await Promise.all([first, second]);
        expect(workspaceByID(f.h.state(), W1)?.searchSelected).toBe(1);
    });

    it('drops a step counted for a needle that has since been replaced', async () => {
        const f = deferredFixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        const set = f.channel.run({ action: 'set', workspace_id: W1, needle: 'old' });
        await f.settle();
        await f.finish(0, [match(10, 0), match(20, 0)]);
        await set;
        const step = f.channel.run({ action: 'next', workspace_id: W1 });
        const replaced = f.channel.run({ action: 'set', workspace_id: W1, needle: 'new' });
        await f.settle();
        await f.finish(2, [match(40, 0)]);
        await replaced;
        await f.finish(1, [match(10, 0), match(20, 0)]);
        await step;
        const workspace = workspaceByID(f.h.state(), W1);
        expect(workspace?.searchNeedle).toBe('new');
        expect(workspace?.searchTotal).toBe(1);
        expect(workspace?.searchSelected).toBeNull();
    });

    it('publishes nothing from a recount that finishes after the bar closed', async () => {
        const f = deferredFixture();
        await f.channel.run({ action: 'toggle', workspace_id: W1 });
        const set = f.channel.run({ action: 'set', workspace_id: W1, needle: 'marker' });
        await f.settle();
        await f.channel.run({ action: 'close', workspace_id: W1 });
        await f.finish(0, [match(10, 0)]);
        await set;
        const workspace = workspaceByID(f.h.state(), W1);
        expect(workspace?.searchingPaneID).toBeNull();
        expect(workspace?.searchTotal).toBeNull();
    });
});
