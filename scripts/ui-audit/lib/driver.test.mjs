import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({}));
vi.mock('./runtime-capability.mjs', () => ({
    freezeShellLoadCapability: vi.fn(() => {
        if (state.capabilityError) throw state.capabilityError;
        return state.capability;
    }),
    assertShellLoadCapability: vi.fn(() => {
        if (state.capabilityDrift) throw new Error('shell load capability changed after preflight');
    })
}));
vi.mock('./stack.mjs', () => ({
    buildAll: vi.fn(),
    clearBackgroundTaskPolicy: vi.fn(),
    makeCli: () => ({ run: vi.fn() }),
    makeSandbox: vi.fn(async () => state.sandbox),
    restartableDaemon: () => state.daemon,
    startShell: vi.fn((_sandbox, options) => {
        expect(options.extraEnv.KELPI_HARNESS_DEFER_LOAD).toBe(state.capability.mode === 'deferred' ? '1' : '0');
        return state.startShell?.() ?? state.shell;
    })
}));
vi.mock('./cdp.mjs', () => ({
    MOD: {}, sleep: async () => {}, listTargets: vi.fn(),
    waitForPageTarget: async (_port, { match }) => {
        state.targetWaits++;
        state.matchTarget = match;
        if (state.targetFailure) throw state.targetFailure;
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
        queueMicrotask(() => socket.emit('data', JSON.stringify({ id, ...(op === 'load-client' ? state.loadReply : { ok: true, result: { pid: 1 } }) }) + '\n'));
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
} } }));

import { boot, recorder } from './driver.mjs';
import { buildAll, makeSandbox, startShell } from './stack.mjs';
import { freezeShellLoadCapability, assertShellLoadCapability } from './runtime-capability.mjs';
const actualCapability = await vi.importActual('./runtime-capability.mjs');

beforeEach(() => {
    vi.clearAllMocks();
    state.capability = Object.freeze({ mode: 'deferred', targetRoot: '/repo' });
    state.capabilityError = state.capabilityDrift = state.targetFailure = undefined;
    state.targetWaits = 0;
    state.loadReply = { ok: true, result: { released: true } };
    state.order = [];
    state.onLoad = undefined;
    state.sandbox = { root: '/tmp/driver-unit', debugPort: 12345, cleanup: vi.fn() };
    state.daemon = { start: vi.fn(), stop: vi.fn() };
    state.shell = { quit: vi.fn(), waitForLine: async () => 'harness-window: placement=hidden' };
    state.startShell = undefined;
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

it.each(['shell', 'daemon', 'both'])('preserves primary sandbox after %s exit cannot be verified and still attempts both stops', async failed => {
    if (failed !== 'daemon') state.shell.quit.mockRejectedValue(Object.assign(new Error('shell stop denied'), { code: 'EPERM' }));
    if (failed !== 'shell') state.daemon.stop.mockRejectedValue(Object.assign(new Error('daemon stop denied'), { code: 'EPERM' }));
    const instance = await boot({ repoRoot: '/repo', build: false });
    await expect(instance.stop()).rejects.toThrow('preserving sandbox');
    expect(state.shell.quit).toHaveBeenCalledTimes(1);
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);
    expect(state.sandbox.cleanup).not.toHaveBeenCalled();
    expect(instance.cleanup.completed).toBe(false);
    expect(instance.cleanup.leaks).toEqual([{ path: state.sandbox.root, stopped: { shell: failed === 'daemon', daemon: failed === 'shell' } }]);
    if (failed !== 'daemon') expect(instance.cleanup.errors).toContain('shell process: shell stop denied');
    if (failed !== 'shell') expect(instance.cleanup.errors).toContain('daemon process: daemon stop denied');
});

it('retains connection cleanup failure while removing a sandbox whose owned processes did exit', async () => {
    state.page.close.mockRejectedValue(new Error('CDP close denied'));
    const instance = await boot({ repoRoot: '/repo', build: false });
    await expect(instance.stop()).rejects.toThrow('CDP close denied');
    expect(state.shell.quit).toHaveBeenCalledTimes(1);
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);
    expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
    expect(instance.cleanup.completed).toBe(false);
    expect(instance.cleanup.leaks).toEqual([]);
});

it('checks build identity before starting any daemon or shell and leaves no acquired fixture on rejection',async()=>{
    const beforeStart=vi.fn(()=>{throw Error('build identity differs');});
    await expect(boot({repoRoot:'/repo',build:false,beforeStart})).rejects.toThrow('build identity differs');
    expect(beforeStart).toHaveBeenCalledOnce();expect(state.daemon.start).not.toHaveBeenCalled();expect(state.order).toEqual([]);
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
});

it('checks provenance again immediately before shell acquisition and cleans a rejected boundary',async()=>{
    state.daemon.start=vi.fn(async()=>state.order.push('daemon-start'));
    state.startShell=vi.fn(()=>state.shell);
    let calls=0;
    const beforeStart=vi.fn(()=>{
        state.order.push('boundary');
        if(++calls===2) throw Error('shell output differs');
    });
    await expect(boot({repoRoot:'/repo',build:false,beforeStart})).rejects.toThrow('shell output differs');
    expect(state.order).toEqual(['boundary','daemon-start','boundary']);
    expect(beforeStart).toHaveBeenCalledTimes(2);
    expect(state.startShell).not.toHaveBeenCalled();
    expect(state.shell.quit).not.toHaveBeenCalled();
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);
    expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
});

it('checks every actual acquisition boundary in order before releasing the client',async()=>{
    state.daemon.start=vi.fn(async()=>state.order.push('daemon-start'));
    const beforeStart=vi.fn(()=>state.order.push(`boundary-${beforeStart.mock.calls.length}`));
    const instance=await boot({repoRoot:'/repo',build:false,beforeStart,beforeLoad:async()=>state.order.push('before-load')});
    try {
        expect(state.order).toEqual(['boundary-1','daemon-start','boundary-2','watch','before-load','boundary-3','load']);
        expect(beforeStart).toHaveBeenCalledTimes(3);
    } finally { await instance.stop(); }
});

it('cleans acquired resources when the client-release boundary rejects after beforeLoad',async()=>{
    state.startShell=vi.fn(()=>state.shell);
    let calls=0;
    const beforeStart=vi.fn(()=>{ if(++calls===3) throw Error('client output differs'); });
    const beforeLoad=vi.fn(async()=>state.order.push('before-load'));
    await expect(boot({repoRoot:'/repo',build:false,beforeStart,beforeLoad})).rejects.toThrow('client output differs');
    expect(beforeStart).toHaveBeenCalledTimes(3);
    expect(beforeLoad).toHaveBeenCalledOnce();
    expect(state.order).toEqual(['watch','before-load']);
    expect(state.startShell).toHaveBeenCalledOnce();
    expect(state.page.close).toHaveBeenCalledTimes(1);
    expect(state.shell.quit).toHaveBeenCalledTimes(1);
    expect(state.daemon.stop).toHaveBeenCalledTimes(1);
    expect(state.sandbox.cleanup).toHaveBeenCalledTimes(1);
});


describe('source-bound boot compatibility', () => {
    it('selects legacy before acquisition, watches only after attachment and retains coverage', async () => {
        state.capability = Object.freeze({ mode: 'legacy-immediate', targetRoot: '/target' });
        const beforeStart = vi.fn();
        const instance = await boot({ repoRoot: '/target', build: false, beforeStart });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-coverage-'));
        try {
            expect(freezeShellLoadCapability).toHaveBeenCalledWith('/target');
            expect(state.matchTarget({ url: 'about:blank' })).toBe(false);
            expect(state.matchTarget({ url: '' })).toBe(false);
            expect(state.matchTarget({ url: 'http://client/?shellWindow=1' })).toBe(true);
            expect(state.order).toEqual(['watch']);
            expect(beforeStart).toHaveBeenCalledTimes(2);
            expect(instance.bootCapability).toBe(state.capability);
            const rec = recorder({ name: 'legacy', outDir: directory });
            instance.rendererErrors.finish(rec);
            expect(rec.summary().rendererCoverage[0]).toMatchObject({ scope: 'post-attach', firstDocument: false,
                bootCapability: state.capability });
            expect(Date.parse(rec.summary().rendererCoverage[0].enabledAt)).toBeGreaterThanOrEqual(Date.parse(rec.summary().rendererCoverage[0].subscribedAt));
            state.page.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'after attach' } });
            instance.rendererErrors.finish(rec);
            expect(rec.summary().results[1]).toMatchObject({ ok: false, detail: 'uncaught: after attach' });
            expect(rec.summary().rendererCoverage.map(coverage => coverage.checkIndex)).toEqual([0, 1]);
        } finally { await instance.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
        expect(state.shell.quit).toHaveBeenCalledOnce();
        expect(state.daemon.stop).toHaveBeenCalledOnce();
        expect(state.sandbox.cleanup).toHaveBeenCalledOnce();
    });

    it.each([{ beforeLoad: vi.fn() }, { requirePreNavigation: true }])('rejects legacy pre-navigation demands before build or acquisition: %j', async requirement => {
        state.capability = { mode: 'legacy-immediate', targetRoot: '/repo' };
        await expect(boot({ repoRoot: '/repo', ...requirement })).rejects.toThrow('does not support pre-navigation');
        expect(buildAll).not.toHaveBeenCalled();
        expect(makeSandbox).not.toHaveBeenCalled();
        expect(state.daemon.start).not.toHaveBeenCalled();
        expect(startShell).not.toHaveBeenCalled();
        expect(state.order).toEqual([]);
        if (requirement.beforeLoad) expect(requirement.beforeLoad).not.toHaveBeenCalled();
    });

    it('refuses unestablished capability before build or acquisition', async () => {
        state.capabilityError = new Error('unsupported or ambiguous shell load capability');
        await expect(boot({ repoRoot: '/repo' })).rejects.toThrow('unsupported or ambiguous');
        expect(buildAll).not.toHaveBeenCalled();
        expect(makeSandbox).not.toHaveBeenCalled();
        expect(startShell).not.toHaveBeenCalled();
    });

    it('keeps pre-first-load coverage for a capable target requesting the guarantee', async () => {
        const instance = await boot({ repoRoot: '/repo', build: false, requirePreNavigation: true });
        try {
            expect(instance.rendererErrors.coverage).toMatchObject({ scope: 'pre-first-load', firstDocument: true, bootCapability: state.capability });
            expect(state.order).toEqual(['watch', 'load']);
            expect(assertShellLoadCapability).toHaveBeenCalledTimes(4);
        } finally { await instance.stop(); }
    });

    it.each([
        { ok: false, error: 'unknown op load-client' },
        { ok: true, result: { released: false } },
        { ok: true, result: null }
    ])('never falls back after deferred release refusal: %j', async reply => {
        state.loadReply = reply;
        await expect(boot({ repoRoot: '/repo', build: false })).rejects.toThrow(/load-client|did not hold/);
        expect(state.targetWaits).toBe(1);
        expect(startShell).toHaveBeenCalledOnce();
        expect(state.order).toEqual(['watch', 'load']);
        expect(state.page.close).toHaveBeenCalledOnce();
        expect(state.shell.quit).toHaveBeenCalledOnce();
        expect(state.daemon.stop).toHaveBeenCalledOnce();
        expect(state.sandbox.cleanup).toHaveBeenCalledOnce();
    });

    it('never falls back after a missing deferred target and retains the first failure on unsafe cleanup', async () => {
        state.targetFailure = new Error('blank target timed out');
        state.shell.quit.mockRejectedValue(new Error('shell still live'));
        const error = await boot({ repoRoot: '/repo', build: false }).catch(error => error);
        expect(error.message).toBe('blank target timed out');
        expect(error.cleanupError).toContain('shell still live');
        expect(error.cleanup.completed).toBe(false);
        expect(state.targetWaits).toBe(1);
        expect(startShell).toHaveBeenCalledOnce();
        expect(state.daemon.stop).toHaveBeenCalledOnce();
        expect(state.sandbox.cleanup).not.toHaveBeenCalled();
    });

    it('cleans a failed legacy watcher without inventing pre-load coverage or releasing a client', async () => {
        state.capability = { mode: 'legacy-immediate', targetRoot: '/repo' };
        state.page.send.mockRejectedValue(new Error('legacy session refused'));
        await expect(boot({ repoRoot: '/repo', build: false })).rejects.toThrow('legacy session refused');
        expect(state.order).not.toContain('load');
        expect(state.targetWaits).toBe(1);
        expect(state.page.close).toHaveBeenCalledOnce();
        expect(state.sandbox.cleanup).toHaveBeenCalledOnce();
    });

    it.each(['deferred', 'legacy-immediate'])('rejects %s source drift across the daemon/shell boundary', async mode => {
        state.capability = { mode, targetRoot: '/repo' };
        state.daemon.start.mockImplementation(async () => { state.capabilityDrift = true; });
        await expect(boot({ repoRoot: '/repo', build: false })).rejects.toThrow('changed after preflight');
        expect(startShell).not.toHaveBeenCalled();
        expect(state.daemon.stop).toHaveBeenCalledOnce();
        expect(state.sandbox.cleanup).toHaveBeenCalledOnce();
    });
});

const capabilityRoot = path.resolve(import.meta.dirname, '../../..');
const capabilityFiles = ['main.ts', 'harness.ts', 'harness-protocol.ts'].map(name => `packages/shell/src/${name}`);
const legacyInputs = [
    '8e3e9f8eee00da502ac51bb93d4e435945fa5473cdfc795c604981878a51eed5',
    '3c52919f04fe3b18f64774b7a270c15a6abdac2ca3ba05fa859f2d7651e0a74a',
    'a3d97fdcbf052abb521183c9bccc0dbef35cb485ae1a8d2276b3ed26d7cc42be'
].map((sha256, index) => ({ path: capabilityFiles[index], sha256 }));
const hash = value => createHash('sha256').update(value).digest('hex');

describe('reviewed shell source contracts', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

    it('recognizes only the complete reviewed legacy triple, independent of input order', () => {
        expect(actualCapability.selectShellLoadCapability(legacyInputs)).toBe('legacy-immediate');
        expect(actualCapability.selectShellLoadCapability([...legacyInputs].reverse())).toBe('legacy-immediate');
    });

    it.each([
        null, [], legacyInputs.slice(1), [...legacyInputs, legacyInputs[0]],
        [legacyInputs[0], legacyInputs[0], legacyInputs[2]],
        [{ path: capabilityFiles[0], sha256: 'marker missing' }, ...legacyInputs.slice(1)],
        [{ ...legacyInputs[0], path: '../main.ts' }, ...legacyInputs.slice(1)]
    ])('refuses malformed or incomplete source identity: %j', inputs => {
        expect(() => actualCapability.selectShellLoadCapability(inputs)).toThrow('malformed');
    });

    it('freezes current target source bytes and rejects mixed/unknown contracts', () => {
        const capability = actualCapability.freezeShellLoadCapability(capabilityRoot);
        expect(capability.mode).toBe('deferred');
        expect(capability.targetRoot).toBe(fs.realpathSync(capabilityRoot));
        expect(Object.isFrozen(capability)).toBe(true);
        expect(Object.isFrozen(capability.sources)).toBe(true);
        expect(Object.isFrozen(capability.sources[0])).toBe(true);
        expect(() => actualCapability.assertShellLoadCapability(capability)).not.toThrow();
        expect(() => actualCapability.selectShellLoadCapability([capability.sources[0], ...legacyInputs.slice(1)])).toThrow('unsupported or ambiguous');
        expect(() => actualCapability.selectShellLoadCapability(legacyInputs.map(input => ({ ...input, sha256: 'a'.repeat(64) })))).toThrow('unsupported or ambiguous');
        expect(() => actualCapability.assertShellLoadCapability({ ...capability, mode: 'legacy-immediate' })).toThrow('changed after preflight');
    });

    it('binds the capability to the pinned target context and refuses mismatched/missing/duplicate inputs', () => {
        const capability = actualCapability.freezeShellLoadCapability(capabilityRoot);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-context-'));
        const file = path.join(directory, 'context.json');
        const base = { schemaVersion: 1, target: { root: capability.targetRoot, expectedHead: capability.targetHead,
            source: { inputs: capability.sources } }, harness: { root: capability.targetRoot } };
        const install = context => {
            const bytes = JSON.stringify(context); fs.writeFileSync(file, bytes);
            vi.stubEnv('KELPI_ACCEPTANCE_CONTEXT', file); vi.stubEnv('KELPI_ACCEPTANCE_CONTEXT_SHA256', hash(bytes));
        };
        try {
            install(base);
            expect(actualCapability.freezeShellLoadCapability(capabilityRoot)).toMatchObject({ contextSha256: hash(JSON.stringify(base)), mode: 'deferred' });
            for (const inputs of [[], [...capability.sources, capability.sources[0]], legacyInputs]) {
                install({ ...base, target: { ...base.target, source: { inputs } } });
                expect(() => actualCapability.freezeShellLoadCapability(capabilityRoot)).toThrow('differs from pinned target');
            }
            install({ ...base, target: { ...base.target, expectedHead: '0'.repeat(40) } });
            expect(() => actualCapability.freezeShellLoadCapability(capabilityRoot)).toThrow('head differs');
            install(base); vi.stubEnv('KELPI_ACCEPTANCE_CONTEXT_SHA256', '0'.repeat(64));
            expect(() => actualCapability.freezeShellLoadCapability(capabilityRoot)).toThrow('context digest differs');
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('does not classify edited source bytes as a known contract', () => {
        const read = fs.readFileSync;
        vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
            const bytes = read(file, ...args);
            return file === path.join(fs.realpathSync(capabilityRoot), capabilityFiles[0])
                ? Buffer.concat([bytes, Buffer.from('\n// unreviewed source change')]) : bytes;
        });
        expect(() => actualCapability.freezeShellLoadCapability(capabilityRoot)).toThrow('unsupported or ambiguous');
    });
});
