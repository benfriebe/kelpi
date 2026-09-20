import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({}));
vi.mock('./stack.mjs', () => ({
    buildAll: vi.fn(),
    clearBackgroundTaskPolicy: vi.fn(),
    makeCli: () => ({ run: vi.fn() }),
    makeSandbox: async () => state.sandbox,
    restartableDaemon: () => state.daemon,
    startShell: (_sandbox, options) => {
        expect(options.extraEnv.KELPI_HARNESS_DEFER_LOAD).toBe('1');
        return state.shell;
    }
}));
vi.mock('./cdp.mjs', () => ({
    MOD: {}, sleep: async () => {}, listTargets: vi.fn(),
    waitForPageTarget: async (_port, { match }) => {
        state.matchTarget = match;
        return { webSocketDebuggerUrl: 'ws://private-test' };
    },
    connect: async () => state.page
}));
vi.mock('node:net', () => ({ default: { createConnection: () => {
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.destroy = vi.fn();
    socket.end = vi.fn();
    socket.write = (line) => {
        const { id, op } = JSON.parse(line);
        if (op === 'load-client') {
            state.order.push('load');
            state.onLoad?.();
        }
        queueMicrotask(() => socket.emit('data', JSON.stringify({ id, ok: true,
            result: op === 'load-client' ? { released: true } : { pid: 1 } }) + '\n'));
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
} } }));

import { boot } from './driver.mjs';

beforeEach(() => {
    state.order = [];
    state.onLoad = undefined;
    state.sandbox = { root: '/tmp/driver-unit', debugPort: 12345, cleanup: vi.fn() };
    state.daemon = { start: vi.fn(), stop: vi.fn() };
    state.shell = { quit: vi.fn(), waitForLine: async () => 'harness-window: placement=hidden' };
    state.page = new EventEmitter();
    state.page.send = vi.fn(async (method) => {
        if (method === 'Runtime.enable') state.order.push('watch');
    });
    state.page.eval = vi.fn(async () => true);
    state.page.close = vi.fn();
});

describe('boot watches the first client navigation', () => {
    it('waits for a real blank document, ignoring the uninitialized Electron target', async () => {
        const instance = await boot({ repoRoot: '/repo', build: false });
        try {
            expect(state.matchTarget({ url: '' })).toBe(false);
            expect(state.matchTarget({ url: 'about:blank' })).toBe(true);
            expect(state.matchTarget({ url: 'http://already-loaded/?shellWindow=1' })).toBe(false);
        } finally {
            await instance.stop();
        }
    });

    it('does not set up or release the client before Runtime.enable acknowledges', async () => {
        let acknowledge;
        const enabling = new Promise((resolve) => { acknowledge = resolve; });
        let requested;
        const requestedEnable = new Promise((resolve) => { requested = resolve; });
        state.page.send = vi.fn((method) => {
            if (method !== 'Runtime.enable') return Promise.resolve();
            state.order.push('watch');
            requested();
            return enabling;
        });
        const pending = boot({ repoRoot: '/repo', build: false,
            beforeLoad: async () => state.order.push('setup') });
        await requestedEnable;
        expect(state.order).toEqual(['watch']);
        acknowledge();
        const instance = await pending;
        expect(state.order).toEqual(['watch', 'setup', 'load']);
        await instance.stop();
    });

    it('rejects and cleans a failed watcher without running setup or loading the client', async () => {
        state.page.send.mockRejectedValue(new Error('session unavailable'));
        const beforeLoad = vi.fn();
        await expect(boot({ repoRoot: '/repo', build: false, beforeLoad, timeoutMs: 1234 }))
            .rejects.toThrow('Runtime.enable: session unavailable');
        expect(state.page.send).toHaveBeenCalledWith('Runtime.enable', {}, 1234);
        expect(beforeLoad).not.toHaveBeenCalled();
        expect(state.order).not.toContain('load');
        expect(state.page.close).toHaveBeenCalledTimes(1);
        expect(state.shell.quit).toHaveBeenCalledTimes(1);
        expect(state.daemon.stop).toHaveBeenCalledTimes(1);
        expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    });

    it('arms before setup and load, returning startup errors even when the app root never mounts', async () => {
        state.page.eval.mockResolvedValue(false);
        state.onLoad = () => {
            state.page.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'root failed to mount' } });
            state.page.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'startup error' }] });
        };
        const instance = await boot({ repoRoot: '/repo', build: false, window: 'hidden',
            beforeLoad: async () => state.order.push('setup') });
        expect(state.order).toEqual(['watch', 'setup', 'load']);
        const rec = { check: vi.fn() };
        instance.rendererErrors.finish(rec);
        expect(rec.check).toHaveBeenCalledWith('the renderer threw nothing and logged no error', false,
            'uncaught: root failed to mount | console.error: startup error');
        await instance.stop();
        await instance.stop();
        expect(state.shell.quit).toHaveBeenCalledTimes(1);
        expect(state.daemon.stop).toHaveBeenCalledTimes(1);
        expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    });

    it('waits through navigation context replacement before accepting a healthy root', async () => {
        state.page.eval.mockRejectedValueOnce(new Error('execution context destroyed')).mockResolvedValueOnce(false).mockResolvedValue(true);
        const instance = await boot({ repoRoot: '/repo', build: false });
        expect(state.page.eval).toHaveBeenCalledTimes(3);
        expect(instance.rendererErrors.hasErrors).toBe(false);
        await instance.stop();
    });

    it('cleans up a failed pre-load hook without releasing the app', async () => {
        await expect(boot({ repoRoot: '/repo', build: false, beforeLoad: () => {
            throw new Error('setup refused');
        } })).rejects.toThrow('setup refused');
        expect(state.order).toEqual(['watch']);
        expect(state.page.close).toHaveBeenCalledTimes(1);
        expect(state.shell.quit).toHaveBeenCalledTimes(1);
        expect(state.daemon.stop).toHaveBeenCalledTimes(1);
        expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans up and rejects a missing root without renderer errors', async () => {
        state.page.eval.mockResolvedValue(false);
        await expect(boot({ repoRoot: '/repo', build: false, timeoutMs: -1 })).rejects.toThrow('the client app root did not appear');
        expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    });
});

it('reports cleanup errors while still attempting every remaining owned resource', async () => {
    state.shell.quit.mockRejectedValue(new Error('shell refused cleanup'));
    const instance = await boot({ repoRoot: '/repo', build: false });
    await expect(instance.stop()).rejects.toThrow('shell refused cleanup');
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);
    expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    expect(instance.cleanup).toEqual({ attempted: true, completed: false, leaks: [], errors: ['shell process: shell refused cleanup'] });
});

it('checks build identity before starting any daemon or shell and leaves no acquired fixture on rejection',async()=>{
    const beforeStart=vi.fn(()=>{throw Error('build identity differs');});
    await expect(boot({repoRoot:'/repo',build:false,beforeStart})).rejects.toThrow('build identity differs');
    expect(beforeStart).toHaveBeenCalledOnce();expect(state.daemon.start).not.toHaveBeenCalled();expect(state.order).toEqual([]);
});
