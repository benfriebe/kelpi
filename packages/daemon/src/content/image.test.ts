import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IMAGE_CHANGED_MESSAGE } from '@kelpi/protocol';

import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import type { Pane } from '../store/types.js';
import { createImageWatchService, imageAssetPath } from './image.js';
import { createContentService } from './service.js';
import type { WatchFn } from './watcher.js';

const SHELL = id('dddddddd', 100);
const IMG = id('eeeeeeee', 1);
const IMG2 = id('eeeeeeee', 2);

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-image-'));
    dirs.push(dir);
    return dir;
}

function openImage(h: ReturnType<typeof harness>, filePath: string, paneID = IMG): Pane {
    h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID, filePath, now: NOW, paneType: 'image' });
    const pane = visiblePane(workspaceByID(h.state(), W1)!, paneID);
    if (pane === null) throw new Error('image pane did not open');
    return pane;
}

/** A `fs.watch` stand-in: each watched path's listener, and whether its handle was closed. */
function fakeWatch(): { watch: WatchFn; fire(filePath: string, event?: string): void; open(): string[] } {
    const live = new Map<string, (event: string, filename: string | null) => void>();
    return {
        watch: (filePath, listener) => {
            live.set(filePath, listener);
            return {
                close: () => {
                    live.delete(filePath);
                },
                on: () => undefined
            };
        },
        fire: (filePath, event = 'change') => live.get(filePath)?.(event, null),
        open: () => [...live.keys()]
    };
}

describe('imageAssetPath', () => {
    it('serves the pane\'s own file, by its own name', () => {
        const dir = tempDir();
        const file = path.join(dir, 'shot.png');
        fs.writeFileSync(file, 'png');
        const h = harness(seededState(W1, SHELL));
        const pane = openImage(h, file);
        expect(pane.type).toBe('image');
        expect(imageAssetPath(pane, 'shot.png')).toBe(file);
    });

    it('serves nothing beside it: a sibling, a traversal, another name, a directory', () => {
        const dir = tempDir();
        const file = path.join(dir, 'shot.png');
        fs.writeFileSync(file, 'png');
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        fs.mkdirSync(path.join(dir, 'folder.png'));
        const h = harness(seededState(W1, SHELL));
        const pane = openImage(h, file);
        expect(imageAssetPath(pane, 'secret.txt')).toBeNull();
        expect(imageAssetPath(pane, '../shot.png')).toBeNull();
        expect(imageAssetPath(pane, `${dir}/shot.png`)).toBeNull();
        expect(imageAssetPath(pane, 'Shot.png')).toBeNull();
        expect(imageAssetPath(openImage(h, path.join(dir, 'folder.png'), IMG2), 'folder.png')).toBeNull();
    });

    it('serves nothing for a missing file, a relative path, or a pane of another type', () => {
        const dir = tempDir();
        const h = harness(seededState(W1, SHELL));
        expect(imageAssetPath(openImage(h, path.join(dir, 'gone.png')), 'gone.png')).toBeNull();
        expect(imageAssetPath(openImage(h, 'relative/shot.png', IMG2), 'shot.png')).toBeNull();
        const shell = visiblePane(workspaceByID(h.state(), W1)!, SHELL)!;
        expect(imageAssetPath({ ...shell, filePath: path.join(dir, 'x.png') }, 'x.png')).toBeNull();
    });

    it('is what the content service\'s asset route answers for an image pane', () => {
        const dir = tempDir();
        const file = path.join(dir, 'shot.png');
        fs.writeFileSync(file, 'png');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
        const h = harness(seededState(W1, SHELL));
        const service = createContentService({ store: h.store, watch: false });
        try {
            openImage(h, file);
            expect(service.assetPath(IMG, 'shot.png')).toBe(file);
            expect(service.assetPath(IMG, 'notes.txt')).toBeNull();
        } finally {
            service.dispose();
        }
    });
});

describe('createImageWatchService', () => {
    it('watches every visible image pane, including ones already open when it starts', () => {
        const h = harness(seededState(W1, SHELL));
        openImage(h, '/pics/a.png');
        const fake = fakeWatch();
        const service = createImageWatchService({ store: h.store, broadcast: () => undefined, watch: fake.watch });
        try {
            expect([...service.watched()]).toEqual([[IMG, '/pics/a.png']]);
            openImage(h, '/pics/b.png', IMG2);
            expect([...service.watched().keys()].sort()).toEqual([IMG, IMG2].sort());
            expect(fake.open().sort()).toEqual(['/pics/a.png', '/pics/b.png']);
        } finally {
            service.dispose();
        }
    });

    it('broadcasts one image-changed for a burst of writes', async () => {
        const h = harness(seededState(W1, SHELL));
        openImage(h, '/pics/a.png');
        const fake = fakeWatch();
        const sent: Record<string, unknown>[] = [];
        const service = createImageWatchService({ store: h.store, broadcast: (event) => sent.push(event), watch: fake.watch, debounceMs: 10 });
        try {
            fake.fire('/pics/a.png');
            fake.fire('/pics/a.png');
            fake.fire('/pics/a.png');
            expect(sent).toEqual([]);
            await tick(30);
            expect(sent).toEqual([{ type: IMAGE_CHANGED_MESSAGE, paneID: IMG, workspaceID: W1 }]);
        } finally {
            service.dispose();
        }
    });

    it('re-attaches after a replace (the rename an atomic write does) and reports it', async () => {
        const h = harness(seededState(W1, SHELL));
        openImage(h, '/pics/a.png');
        const fake = fakeWatch();
        const sent: Record<string, unknown>[] = [];
        const service = createImageWatchService({
            store: h.store,
            broadcast: (event) => sent.push(event),
            watch: fake.watch,
            debounceMs: 5,
            reattachDelayMs: 5
        });
        try {
            fake.fire('/pics/a.png', 'rename');
            await tick(40);
            expect(fake.open()).toEqual(['/pics/a.png']);
            expect(sent).toHaveLength(1);
        } finally {
            service.dispose();
        }
    });

    it('stops watching a closed pane, and a change already pending for it is dropped', async () => {
        const h = harness(seededState(W1, SHELL));
        openImage(h, '/pics/a.png');
        const fake = fakeWatch();
        const sent: Record<string, unknown>[] = [];
        const service = createImageWatchService({ store: h.store, broadcast: (event) => sent.push(event), watch: fake.watch, debounceMs: 10 });
        try {
            fake.fire('/pics/a.png');
            h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: IMG });
            expect(service.watched().size).toBe(0);
            expect(fake.open()).toEqual([]);
            await tick(30);
            expect(sent).toEqual([]);
        } finally {
            service.dispose();
        }
    });

    it('ignores other pane types and closes everything on dispose', () => {
        const h = harness(seededState(W1, SHELL));
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: IMG2, filePath: '/docs/a.md', now: NOW });
        openImage(h, '/pics/a.png');
        const fake = fakeWatch();
        const service = createImageWatchService({ store: h.store, broadcast: () => undefined, watch: fake.watch });
        expect([...service.watched().keys()]).toEqual([IMG]);
        service.dispose();
        expect(fake.open()).toEqual([]);
    });
});
