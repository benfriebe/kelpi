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
