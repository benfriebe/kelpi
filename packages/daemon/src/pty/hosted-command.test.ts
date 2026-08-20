/**
 * Hosting a COMMAND in a pane's PTY instead of an interactive shell (CONT-081/CONT-088).
 *
 * The contract this pins down is small but load-bearing: the command runs as `<shell> -c
 * '<command>'`, which is what libghostty does with `ghostty_surface_config_s.command` — so a
 * pane's persisted `externalEditorCommand`, written by either app, launches the same process.
 */

import { describe, expect, it } from 'vitest';

import { createPtyManager } from './manager.js';
import type { PtyProcessHandle, PtySpawnRequest, PtySpawner } from './types.js';

class StubPty implements PtyProcessHandle {
    readonly pid = 4242;
    constructor(readonly request: PtySpawnRequest) {}
    write(): void {
        /* unused here */
    }
    resize(): void {
        /* unused here */
    }
    kill(): void {
        /* unused here */
    }
    onData(): void {
        /* unused here */
    }
    onExit(): void {
        /* unused here */
    }
}

function stubSpawner(): { spawner: PtySpawner; spawned: StubPty[] } {
    const spawned: StubPty[] = [];
    return {
        spawner: (request) => {
            const proc = new StubPty(request);
            spawned.push(proc);
            return proc;
        },
        spawned
    };
}

const BASE = {
    cwd: '/tmp',
    env: [] as ReadonlyArray<readonly [string, string]>,
    cols: 80,
    rows: 24
};

describe('PtySpawnOptions.command', () => {
    it('runs the command through the shell with -c', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn({
            ...BASE,
            paneID: 'pane-a',
            shell: '/bin/zsh',
            command: "/usr/bin/env PATH='/bin' nvim '/docs/a.md'"
        });
        expect(spawned[0]?.request.file).toBe('/bin/zsh');
        expect(spawned[0]?.request.args).toEqual(['-c', "/usr/bin/env PATH='/bin' nvim '/docs/a.md'"]);
    });

    it('an absent, empty or whitespace command still starts a plain interactive shell', () => {
        const { spawner, spawned } = stubSpawner();
        const manager = createPtyManager({ spawner });
        manager.spawn({ ...BASE, paneID: 'a', shell: '/bin/sh' });
        manager.spawn({ ...BASE, paneID: 'b', shell: '/bin/sh', command: '' });
        manager.spawn({ ...BASE, paneID: 'c', shell: '/bin/sh', command: '   ' });
        for (const proc of spawned) expect(proc.request.args).toEqual([]);
    });

    it('carries the command onto the /bin/sh retry when the configured shell cannot start', () => {
        const spawned: StubPty[] = [];
        let attempts = 0;
        const spawner: PtySpawner = (request) => {
            attempts += 1;
            if (attempts === 1) throw new Error('ENOENT');
            const proc = new StubPty(request);
            spawned.push(proc);
            return proc;
        };
        const manager = createPtyManager({ spawner, onError: () => undefined });
        manager.spawn({ ...BASE, paneID: 'pane-a', shell: '/bin/broken', command: "vi '/a.md'" });
        expect(spawned[0]?.request.file).toBe('/bin/sh');
        expect(spawned[0]?.request.args).toEqual(['-c', "vi '/a.md'"]);
    });
});
