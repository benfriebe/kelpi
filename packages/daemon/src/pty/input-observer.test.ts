import { describe, expect, it } from 'vitest';

import { withInputObserver } from './input-observer.js';
import { createPtyManager } from './manager.js';
import type { PtyProcessHandle, PtySpawnRequest } from './types.js';

class StubPty implements PtyProcessHandle {
    readonly pid = 4321;
    readonly writes: string[] = [];
    constructor(readonly request: PtySpawnRequest) {}
    write(data: string | Uint8Array): void {
        this.writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    }
    resize(): void {}
    kill(): void {}
    onData(): void {}
    onExit(): void {}
}

describe('withInputObserver', () => {
    function setup(observe: (paneID: string, data: Uint8Array | string) => void) {
        const procs: StubPty[] = [];
        const inner = createPtyManager({
            spawner: (request) => {
                const proc = new StubPty(request);
                procs.push(proc);
                return proc;
            }
        });
        const pty = withInputObserver(inner, observe);
        for (const paneID of ['a', 'b']) pty.spawn({ paneID, cwd: '/tmp', env: [], cols: 80, rows: 24, shell: '/bin/zsh' });
        return { inner, pty, procs };
    }

    it('reports every write into a pane before it lands, once per pane it lands in', () => {
        const order: string[] = [];
        const { pty, procs } = setup((paneID, data) => order.push(`saw ${paneID} ${String(data)}`));
        pty.write('a', 'p');
        pty.setSyncGroup('ws', new Set(['a', 'b']));
        pty.write('a', 'k');
        pty.writeDirect('b', 'x');
        // Unsynced, one pane; synced, the pane typed into and the sibling it is mirrored to (a
        // keystroke mirrored into a pane a launch is waiting on is input into that pane); a
        // direct write is never mirrored.
        expect(order).toEqual(['saw a p', 'saw a k', 'saw b k', 'saw b x']);
        // The mirrored keystroke still reaches the sibling: mirroring is the inner manager's.
        expect(procs[0]?.writes).toEqual(['p', 'k']);
        expect(procs[1]?.writes).toEqual(['k', 'x']);
    });

    it('a throwing observer never costs the write', () => {
        const { pty, procs } = setup(() => {
            throw new Error('observer bug');
        });
        pty.writeDirect('a', 'still typed');
        expect(procs[0]?.writes).toEqual(['still typed']);
    });

    it('does not see writes made through the inner manager (query replies, the launcher)', () => {
        const seen: string[] = [];
        const { inner } = setup((paneID) => seen.push(paneID));
        inner.writeDirect('a', '\u001b[?62;22c');
        expect(seen).toEqual([]);
    });

    it('delegates everything else', () => {
        const seen: string[] = [];
        const { pty } = setup((paneID) => seen.push(paneID));
        // Injected OUTPUT (`pane-clear`) reaches the pane's listeners and is nobody typing.
        const output: string[] = [];
        pty.onData((paneID, data) => output.push(`${paneID} ${Buffer.from(data).toString('utf8')}`));
        pty.injectOutput('a', '\u001b[2J');
        expect(output).toEqual(['a \u001b[2J']);
        expect(seen).toEqual([]);
        expect(pty.has('a')).toBe(true);
        expect(pty.pid('a')).toBe(4321);
        expect(pty.shell('a')).toBe('/bin/zsh');
        expect(pty.paneIDs()).toEqual(['a', 'b']);
        pty.kill('a');
        expect(pty.has('a')).toBe(false);
    });
});
