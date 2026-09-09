import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import { createContentService, type ContentPaneState, type ContentService } from './service.js';

const MD = id('eeeeeeee', 1);
const fixtures: { service: ContentService; dir: string }[] = [];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** Delay only these reads; subsequent reads use the real filesystem. */
function delayReads(count = 1) {
    const spy = vi.spyOn(fs.promises, 'readFile');
    return Array.from({ length: count }, () => {
        const entered = deferred<void>();
        const result = deferred<string>();
        spy.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
        return { entered: entered.promise, ...result };
    });
}

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-markdown-race-'));
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, '# Original\n');
    const store = harness(seededState());
    const service = createContentService({ store: store.store, watch: false, debounceMs: 60_000 });
    const open = () => store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: file, now: NOW });
    open();
    const result = { dir, file, store, service, open };
    fixtures.push(result);
    return result;
}

afterEach(() => {
    for (const f of fixtures.splice(0)) {
        f.service.dispose();
        fs.rmSync(f.dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
});

describe('Markdown disk read ownership', () => {
    it('keeps unsaved edits when an earlier preview refresh finishes', async () => {
        const f = fixture();
        const seen: ContentPaneState[] = [];
        await f.service.subscribe(MD, state => seen.push(state));
        const [read] = delayReads();
        const refresh = f.service.refresh(MD);
        await read!.entered;

        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, '# Unsaved latest\n');
        const notifications = seen.length;
        read!.resolve('# Stale disk contents\n');
        await refresh;

        expect(await f.service.state(MD)).toMatchObject({ mode: 'edit', text: '# Unsaved latest\n', dirty: true, error: null });
        expect(seen).toHaveLength(notifications);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# Original\n');
        f.service.flushSync();
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# Unsaved latest\n');
    });

    it.each(['save', 'view'] as const)('does not restore stale text or errors after the newer edit is clean (%s)', async action => {
        const f = fixture();
        await f.service.subscribe(MD, () => {});
        const [read] = delayReads();
        const refresh = f.service.refresh(MD);
        await read!.entered;
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, '# Saved latest\n');
        if (action === 'save') await f.service.save(MD);
        else await f.service.setMode(MD, 'view');

        if (action === 'save') read!.reject(new Error('retired read failure'));
        else read!.resolve('# Stale disk contents\n');
        await refresh;
        expect(await f.service.state(MD)).toMatchObject({ text: '# Saved latest\n', dirty: false, loaded: true, error: null });
        expect(fs.readFileSync(f.file, 'utf8')).toBe('# Saved latest\n');
    });

    it('does not start a disk reload over an active edit buffer', async () => {
        const f = fixture();
        await f.service.subscribe(MD, () => {});
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'still dirty');
        const read = vi.spyOn(fs.promises, 'readFile');
        expect(await f.service.refresh(MD)).toMatchObject({ text: 'still dirty', dirty: true });
        expect(read).not.toHaveBeenCalled();
        f.service.flushSync();
        expect(fs.readFileSync(f.file, 'utf8')).toBe('still dirty');
    });

    it.each(['success', 'failure'] as const)('keeps the newer of two refreshes when the older read ends in %s', async result => {
        const f = fixture();
        const seen: ContentPaneState[] = [];
        await f.service.subscribe(MD, state => seen.push(state));
        const [oldRead, newRead] = delayReads(2);
        const oldRefresh = f.service.refresh(MD);
        await oldRead!.entered;
        const newRefresh = f.service.refresh(MD);
        await newRead!.entered;
        newRead!.resolve('# Newest\n');
        await newRefresh;
        if (result === 'success') oldRead!.resolve('# Oldest\n');
        else oldRead!.reject(new Error('old file is gone'));
        await oldRefresh;
        expect(await f.service.state(MD)).toMatchObject({ text: '# Newest\n', loaded: true, error: null, dirty: false });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.html).toContain('<h1>Newest</h1>');
    });

    it('drops a read for the previous file after the pane source moves', async () => {
        const f = fixture();
        await f.service.subscribe(MD, () => {});
        const [read] = delayReads();
        const oldRefresh = f.service.refresh(MD);
        await read!.entered;
        const nextFile = path.join(f.dir, 'next.md');
        fs.writeFileSync(nextFile, '# Next file\n');
        // Exercise the scope-change seam consumed by ensure(), independently of the action
        // which changed the pane. The existing entry still holds the previous path here.
        const state = f.store.state();
        vi.spyOn(f.store.store, 'getState').mockReturnValue({
            ...state,
            workspaces: state.workspaces.map(workspace => ({
                ...workspace,
                panes: workspace.panes.map(pane => pane.id === MD ? { ...pane, filePath: nextFile } : pane)
            }))
        });
        expect(await f.service.state(MD)).toMatchObject({ filePath: nextFile, text: '# Next file\n' });
        read!.resolve('# Previous file\n');
        await oldRefresh;
        expect(await f.service.state(MD)).toMatchObject({ filePath: nextFile, text: '# Next file\n', dirty: false });
    });

    it.each(['unsubscribe', 'close'] as const)('cannot seed a replacement entry after %s', async release => {
        const f = fixture();
        const seen: ContentPaneState[] = [];
        const oldSubscription = await f.service.subscribe(MD, state => seen.push(state));
        const [read] = delayReads();
        const refresh = f.service.refresh(MD);
        await read!.entered;
        if (release === 'unsubscribe') oldSubscription.unsubscribe();
        else {
            f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
            f.open();
        }
        await f.service.subscribe(MD, () => {});
        await f.service.setMode(MD, 'edit');
        await f.service.setText(MD, 'replacement entry edits');
        // A delayed unsubscribe from the closed entry must not drop the replacement buffer.
        oldSubscription.unsubscribe();
        read!.resolve('retired entry text');
        await refresh;
        expect(await f.service.state(MD)).toMatchObject({ text: 'replacement entry edits', dirty: true });
        expect(seen).toEqual([]);
        f.service.flushSync();
        expect(fs.readFileSync(f.file, 'utf8')).toBe('replacement entry edits');
    });

    it.each(['close', 'dispose'] as const)('does not finish an initial subscription after %s', async action => {
        const f = fixture();
        const seen: ContentPaneState[] = [];
        const [read] = delayReads();
        const subscription = f.service.subscribe(MD, state => seen.push(state));
        const rejected = expect(subscription).rejects.toThrow('closed while loading');
        await read!.entered;
        if (action === 'dispose') f.service.dispose();
        else f.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
        read!.resolve('too late');
        await rejected;
        expect(seen).toEqual([]);
    });

    it('still loads a restored pane that starts in edit mode', async () => {
        const f = fixture();
        f.store.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: MD, editing: true });
        expect(await f.service.state(MD)).toMatchObject({ mode: 'edit', text: '# Original\n', loaded: true, dirty: false });
        await f.service.setText(MD, 'restored editor saved');
        await f.service.save(MD);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('restored editor saved');
    });
});
