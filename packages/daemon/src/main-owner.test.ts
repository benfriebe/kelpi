/** Exercise CLI lifetime ordering without starting or stopping any real daemon. */
import { beforeEach, expect, it, vi } from 'vitest';
import { createDaemon, type Daemon, type DaemonInfo } from './boot/index.js';
import { probeDaemon } from './lifecycle/index.js';
import { connectTestOwner, type TestOwner } from './lifecycle/test-owner.js';
import { runKelpid } from './main.js';

vi.mock('./boot/index.js', async importOriginal => ({
    ...await importOriginal<typeof import('./boot/index.js')>(),
    createDaemon: vi.fn()
}));
vi.mock('./lifecycle/index.js', async importOriginal => ({
    ...await importOriginal<typeof import('./lifecycle/index.js')>(),
    probeDaemon: vi.fn()
}));
vi.mock('./lifecycle/test-owner.js', () => ({ connectTestOwner: vi.fn() }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const info = {
    pid: 1, socketPath: '/unused/control', runSocketPath: '/unused/run',
    url: 'http://127.0.0.1:1', token: 'unused', dbPath: '/unused/db',
    workspaces: 0, resumeTuples: 0, persistence: { degraded: false }
} as DaemonInfo;

function fixture() {
    const boot = deferred<DaemonInfo>();
    const stopped = deferred<void>();
    const cancellation = deferred<void>();
    const start = vi.fn(() => boot.promise);
    const stop = vi.fn(() => stopped.promise);
    const confirmStopped = vi.fn(async () => {});
    const owner: TestOwner = {
        stopRequested: false, whenStopRequested: cancellation.promise, confirmStopped
    };
    const daemon = { start, stop, persistenceHealth: () => ({ degraded: false }) } as unknown as Daemon;
    vi.mocked(createDaemon).mockReturnValue(daemon);
    vi.mocked(connectTestOwner).mockResolvedValue(owner);
    const run = () => runKelpid(['start', '--foreground'], {
        env: {}, out: vi.fn(), err: vi.fn(), waitForever: async () => {}
    });
    return { boot, stopped, cancellation, start, stop, confirmStopped, owner, run };
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(probeDaemon).mockResolvedValue({ alive: false, stalePidRecord: false });
});

it('keeps ordinary foreground signal handling when no owner is configured', async () => {
    const f = fixture();
    vi.mocked(connectTestOwner).mockResolvedValue(undefined);
    f.boot.resolve(info);
    expect(await f.run()).toBe(0);
    expect(createDaemon).toHaveBeenCalledWith(expect.objectContaining({ installSignalHandlers: true }));
    expect(f.stop).not.toHaveBeenCalled();
});

it('does not boot when the owner cancels before discovery', async () => {
    const f = fixture();
    vi.mocked(connectTestOwner).mockResolvedValue({ ...f.owner, stopRequested: true });
    expect(await f.run()).toBe(0);
    expect(probeDaemon).not.toHaveBeenCalled();
    expect(createDaemon).not.toHaveBeenCalled();
    expect(f.confirmStopped).toHaveBeenCalledOnce();
});

it('does not boot when cancellation arrives during discovery', async () => {
    const f = fixture();
    vi.mocked(probeDaemon).mockImplementation(async () => {
        Object.assign(f.owner, { stopRequested: true });
        return { alive: false, stalePidRecord: false };
    });
    expect(await f.run()).toBe(0);
    expect(createDaemon).not.toHaveBeenCalled();
    expect(f.confirmStopped).toHaveBeenCalledOnce();
});

it.each(['success', 'failure'] as const)('waits for pending startup (%s) and cleanup before receipt', async outcome => {
    const f = fixture();
    const running = f.run();
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    expect(createDaemon).toHaveBeenCalledWith(expect.objectContaining({ installSignalHandlers: false }));
    f.cancellation.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.confirmStopped).not.toHaveBeenCalled();
    if (outcome === 'success') f.boot.resolve(info);
    else f.boot.reject(new Error('startup failed'));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(f.confirmStopped).not.toHaveBeenCalled();
    f.stopped.resolve();
    expect(await running).toBe(outcome === 'success' ? 0 : 1);
    expect(f.confirmStopped).toHaveBeenCalledOnce();
});

it('does not confirm cleanup when resource teardown fails', async () => {
    const f = fixture();
    f.boot.resolve(info);
    f.cancellation.resolve();
    const rejected = expect(f.run()).rejects.toThrow('cleanup failed');
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    f.stopped.reject(new Error('cleanup failed'));
    await rejected;
    expect(f.confirmStopped).not.toHaveBeenCalled();
});

it('keeps a started daemon alive until its owner requests cleanup', async () => {
    const f = fixture();
    f.boot.resolve(info);
    let finished = false;
    const running = f.run().then(code => { finished = true; return code; });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
    f.cancellation.resolve();
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
    expect(f.confirmStopped).not.toHaveBeenCalled();
    f.stopped.resolve();
    expect(await running).toBe(0);
    expect(f.confirmStopped).toHaveBeenCalledOnce();
});

it('does not boot or claim cleanup if the owner handshake fails', async () => {
    const f = fixture();
    vi.mocked(connectTestOwner).mockRejectedValue(new Error('handshake failed'));
    await expect(f.run()).rejects.toThrow('handshake failed');
    expect(probeDaemon).not.toHaveBeenCalled();
    expect(createDaemon).not.toHaveBeenCalled();
    expect(f.confirmStopped).not.toHaveBeenCalled();
});
