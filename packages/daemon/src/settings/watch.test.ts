import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    watchConfigFile,
    type ConfigWatchFn,
    type ConfigWatchHandle,
    type ConfigWatcher
} from './watch.js';

// ── injected-watcher unit tests (deterministic) ─────────────────────────────────────

interface FakeWatch {
    readonly fn: ConfigWatchFn;
    readonly attaches: string[];
    readonly open: () => number;
    fire(event: string, filename?: string | null): void;
    error(): void;
}

function fakeWatch(): FakeWatch {
    const attaches: string[] = [];
    let handlers: ((event: string, filename: string | null) => void)[] = [];
    let errorHandlers: (() => void)[] = [];
    let open = 0;

    const fn: ConfigWatchFn = (target, listener) => {
        attaches.push(target);
        open += 1;
        handlers = [listener];
        errorHandlers = [];
        const handle: ConfigWatchHandle = {
            close() {
                open -= 1;
                handlers = [];
                errorHandlers = [];
            },
            on(_event, listener2) {
                errorHandlers.push(() => listener2(new Error('watch failed')));
                return handle;
            }
        };
        return handle;
    };

    return {
        fn,
        attaches,
        open: () => open,
        fire(event, filename = null) {
            for (const handler of [...handlers]) handler(event, filename);
        },
        error() {
            for (const handler of [...errorHandlers]) handler();
        }
    };
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchConfigFile (injected watcher)', () => {
    const open: ConfigWatcher[] = [];
    const watch = (options: Parameters<typeof watchConfigFile>[0]): ConfigWatcher => {
        const watcher = watchConfigFile(options);
        open.push(watcher);
        return watcher;
    };
    afterEach(() => {
        for (const watcher of open.splice(0)) watcher.close();
    });

    it('watches the file itself when it exists', () => {
        const fake = fakeWatch();
        const watcher = watch({
            path: '/cfg/kelpi/config',
            onChange: () => {},
            watch: fake.fn,
            exists: () => true
        });
        expect(fake.attaches).toEqual(['/cfg/kelpi/config']);
        expect(watcher.mode).toBe('file');
    });

    it('falls back to the parent directory when the file does not exist yet', () => {
        const fake = fakeWatch();
        const watcher = watch({
            path: '/cfg/ghostty/config',
            onChange: () => {},
            watch: fake.fn,
            exists: (target) => target === '/cfg/ghostty'
        });
        expect(fake.attaches).toEqual(['/cfg/ghostty']);
        expect(watcher.mode).toBe('directory');
    });

    it('attaches nothing at all when neither the file nor its directory exist', () => {
        const fake = fakeWatch();
        const watcher = watch({
            path: '/nope/config',
            onChange: () => {},
            watch: fake.fn,
            exists: () => false
        });
        expect(fake.attaches).toEqual([]);
        expect(watcher.watching).toBe(false);
        expect(watcher.mode).toBeNull();
    });

    it('debounces a burst of change events into one call', async () => {
        const fake = fakeWatch();
        let calls = 0;
        watch({
            path: '/cfg/config',
            onChange: () => {
                calls += 1;
            },
            debounceMs: 20,
            watch: fake.fn,
            exists: () => true
        });
        fake.fire('change');
        fake.fire('change');
        fake.fire('change');
        expect(calls).toBe(0);
        await tick(40);
        expect(calls).toBe(1);
    });

    it('re-attaches after a rename and then reports the change (the editor save dance)', async () => {
        const fake = fakeWatch();
        let calls = 0;
        watch({
            path: '/cfg/config',
            onChange: () => {
                calls += 1;
            },
            debounceMs: 5,
            reattachDelayMs: 15,
            watch: fake.fn,
            exists: () => true
        });
        fake.fire('rename');
        // The old watch is released immediately; nothing has fired yet.
        expect(fake.open()).toBe(0);
        expect(calls).toBe(0);
        await tick(50);
        expect(fake.attaches).toEqual(['/cfg/config', '/cfg/config']);
        expect(fake.open()).toBe(1);
        expect(calls).toBe(1);
    });

    it('treats a watch error as a lost watch and re-attaches', async () => {
        const fake = fakeWatch();
        watch({
            path: '/cfg/config',
            onChange: () => {},
            debounceMs: 5,
            reattachDelayMs: 15,
            watch: fake.fn,
            exists: () => true
        });
        fake.error();
        await tick(50);
        expect(fake.attaches).toHaveLength(2);
    });

    it('ignores directory events naming some other file', async () => {
        const fake = fakeWatch();
        let calls = 0;
        watch({
            path: '/cfg/kelpi/config',
            onChange: () => {
                calls += 1;
            },
            debounceMs: 5,
            reattachDelayMs: 5,
            watch: fake.fn,
            exists: (target) => target === '/cfg/kelpi'
        });
        // The atomic-write temp file lands in the same directory; it is not our config.
        fake.fire('rename', '.config.kelpi-1-1.tmp');
        await tick(40);
        expect(calls).toBe(0);
        fake.fire('rename', 'config');
        await tick(40);
        expect(calls).toBe(1);
    });

    it('goes silent after close', async () => {
        const fake = fakeWatch();
        let calls = 0;
        const watcher = watch({
            path: '/cfg/config',
            onChange: () => {
                calls += 1;
            },
            debounceMs: 5,
            watch: fake.fn,
            exists: () => true
        });
        fake.fire('change');
        watcher.close();
        await tick(30);
        expect(calls).toBe(0);
        expect(fake.open()).toBe(0);
    });
});

// ── real fs.watch (the thing that actually has to work) ─────────────────────────────

describe('watchConfigFile (real fs)', () => {
    const roots: string[] = [];
    const open: ConfigWatcher[] = [];

    const tmp = (): string => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-settings-watch-'));
        roots.push(root);
        return root;
    };

    afterEach(() => {
        for (const watcher of open.splice(0)) watcher.close();
        for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    });

    const waitForChange = (options: { path: string; timeoutMs?: number }): Promise<void> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no change for ${options.path}`)), options.timeoutMs ?? 5000);
            const watcher = watchConfigFile({
                path: options.path,
                debounceMs: 10,
                reattachDelayMs: 20,
                onChange: () => {
                    clearTimeout(timer);
                    resolve();
                }
            });
            open.push(watcher);
        });

    it('reports a plain write', async () => {
        const root = tmp();
        const file = path.join(root, 'config');
        fs.writeFileSync(file, 'theme = Nord\n', 'utf8');
        const changed = waitForChange({ path: file });
        await tick(50);
        fs.writeFileSync(file, 'theme = Dracula\n', 'utf8');
        await changed;
    });

    it('survives an atomic rename over the file', async () => {
        const root = tmp();
        const file = path.join(root, 'config');
        fs.writeFileSync(file, 'theme = Nord\n', 'utf8');
        const changed = waitForChange({ path: file });
        await tick(50);
        const temp = path.join(root, 'config.tmp');
        fs.writeFileSync(temp, 'theme = Dracula\n', 'utf8');
        fs.renameSync(temp, file);
        await changed;
        expect(fs.readFileSync(file, 'utf8')).toBe('theme = Dracula\n');
    });

    it('notices a file that did not exist when the watch started', async () => {
        const root = tmp();
        const file = path.join(root, 'config');
        const changed = waitForChange({ path: file });
        await tick(50);
        fs.writeFileSync(file, 'theme = Nord\n', 'utf8');
        await changed;
    });
});
