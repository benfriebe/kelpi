import type { UpdateView, WsUpdateStateMessage } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { CHECK_FOR_UPDATES_LABEL } from './menu.js';
import {
    createUpdateSurface,
    dialogParent,
    failureTitle,
    nativeUpdateDialog,
    updateMenuRow,
    updateStateFrame,
    type UpdateSurfaceDeps
} from './update-surface.js';

const AVAILABLE: UpdateView = { phase: 'available', currentVersion: '0.2.2', version: '0.2.3', notes: '## Fixes\n\n- One.' };

describe('the update-state frame', () => {
    it('carries the window, the sequence, the reveal flag and the validated view', () => {
        expect(updateStateFrame('win-1', 4, true, AVAILABLE)).toEqual({
            type: 'update-state',
            windowID: 'win-1',
            seq: 4,
            reveal: true,
            view: AVAILABLE
        });
    });

    it('refuses a view that does not validate (a version phase with no version)', () => {
        expect(updateStateFrame('win-1', 1, true, { phase: 'ready', currentVersion: '0.2.2' })).toBeNull();
    });
});

describe('the native fallback', () => {
    it('is parented to the window whenever there is one, raising it first when it is hidden', () => {
        expect(dialogParent({ destroyed: false, visible: true, minimized: false })).toBe('window');
        expect(dialogParent({ destroyed: false, visible: false, minimized: false })).toBe('show-window-first');
        expect(dialogParent({ destroyed: false, visible: true, minimized: true })).toBe('show-window-first');
        expect(dialogParent({ destroyed: true, visible: true, minimized: false })).toBe('none');
        expect(dialogParent(null)).toBe('none');
    });

    it('offers Update Now / Later for an offer, mapped to the flow actions', () => {
        const dialog = nativeUpdateDialog(AVAILABLE);
        expect(dialog?.options.message).toBe('Kelpi 0.2.3 is available');
        expect(dialog?.options.buttons).toEqual(['Update Now', 'Later']);
        expect(dialog?.actions).toEqual(['update-now', 'later']);
        expect(dialog?.options.cancelId).toBe(1);
        expect(dialog?.options.detail).toContain('Kelpi asks before it restarts');
        expect(dialog?.options.detail).toContain('## Fixes');
    });

    it('offers no Update Now when the location blocks the install', () => {
        const dialog = nativeUpdateDialog({ ...AVAILABLE, location: { blocked: true, message: 'Move Kelpi to Applications.' } });
        expect(dialog?.options.buttons).toEqual(['OK']);
        expect(dialog?.actions).toEqual(['later']);
        expect(dialog?.options.detail).toBe('Move Kelpi to Applications.');
    });

    it('asks Restart Now / Later when ready, and explains that Kelpi reopens by itself', () => {
        const dialog = nativeUpdateDialog({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' });
        expect(dialog?.options.message).toBe('Kelpi 0.2.3 is ready');
        expect(dialog?.options.buttons).toEqual(['Restart Now', 'Later']);
        expect(dialog?.actions).toEqual(['restart', 'later']);
        expect(dialog?.options.detail).toContain('reopens by itself');
        expect(dialog?.options.detail).toContain('next time you quit');
    });

    it('says a download is under way and that Kelpi will ask', () => {
        const dialog = nativeUpdateDialog({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' });
        expect(dialog?.options.message).toBe('Downloading Kelpi 0.2.3…');
        expect(dialog?.options.detail).toContain('Kelpi asks before it restarts');
        expect(dialog?.actions).toEqual(['dismiss']);
    });

    it('offers Retry on a failure, headed by what failed', () => {
        const dialog = nativeUpdateDialog({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'download', message: 'offline' });
        expect(dialog?.options.message).toBe('Kelpi 0.2.3 could not be downloaded');
        expect(dialog?.options.buttons).toEqual(['Retry', 'Close']);
        expect(dialog?.actions).toEqual(['retry', 'dismiss']);
        expect(failureTitle({ phase: 'failed', currentVersion: '0.2.2', retry: 'check' })).toBe('Kelpi could not check for updates');
        expect(failureTitle({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'install' })).toBe('Kelpi 0.2.3 could not be installed');
    });

    it('has nothing to ask while idle, checking or restarting', () => {
        for (const phase of ['idle', 'checking'] as const) expect(nativeUpdateDialog({ phase, currentVersion: '0.2.2' })).toBeNull();
        expect(nativeUpdateDialog({ phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' })).toBeNull();
    });
});

describe('the menu row', () => {
    it('names the state while there is one worth knowing about', () => {
        const row = (view: UpdateView, can = true) => updateMenuRow(view, can, CHECK_FOR_UPDATES_LABEL);
        expect(row({ phase: 'idle', currentVersion: '0.2.2' })).toEqual({ label: 'Check for Updates…', enabled: true });
        expect(row({ phase: 'idle', currentVersion: '0.2.2' }, false)).toEqual({ label: 'Check for Updates…', enabled: false });
        expect(row({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' })).toEqual({ label: 'Downloading Kelpi 0.2.3…', enabled: true });
        expect(row({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' })).toEqual({
            label: 'Restart to Update to Kelpi 0.2.3…',
            enabled: true
        });
        expect(row({ phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' }).enabled).toBe(false);
        expect(row({ phase: 'checking', currentVersion: '0.2.2' }).label).toBe('Checking for Updates…');
    });
});

interface SurfaceHarness {
    readonly deps: UpdateSurfaceDeps;
    readonly sent: WsUpdateStateMessage[];
    readonly native: UpdateView[];
    readonly raised: UpdateView[];
    readonly timers: (() => void)[];
    closes: number;
    connected: boolean;
    pageUp: boolean;
}

function surfaceHarness(windowID: string | null = 'win-1'): SurfaceHarness {
    const h: SurfaceHarness = {
        sent: [],
        native: [],
        raised: [],
        timers: [],
        closes: 0,
        connected: true,
        pageUp: true,
        deps: undefined as unknown as UpdateSurfaceDeps
    };
    (h as { deps: UpdateSurfaceDeps }).deps = {
        windowID: windowID ?? undefined,
        send: (frame) => {
            if (!h.connected) return false;
            h.sent.push(frame);
            return true;
        },
        pageReady: () => h.pageUp,
        showNative: (view) => h.native.push(view),
        closeNative: () => {
            h.closes += 1;
        },
        raise: (view) => h.raised.push(view),
        log: () => undefined,
        setTimer: (run) => {
            h.timers.push(run);
            return h.timers.length - 1;
        },
        clearTimer: (timer) => {
            h.timers[timer as number] = () => undefined;
        }
    };
    return h;
}

describe('where a view goes', () => {
    it('goes to the page, and no native dialog appears once the page says it drew it', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present(AVAILABLE, true);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatchObject({ windowID: 'win-1', seq: 1, reveal: true });
        expect(h.raised).toEqual([AVAILABLE]);
        surface.acknowledge(1);
        h.timers.forEach((run) => run());
        expect(h.native).toEqual([]);
    });

    it('falls back to the native dialog when the page does not answer in time', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present(AVAILABLE, true);
        h.timers.forEach((run) => run());
        expect(h.native).toEqual([AVAILABLE]);
    });

    it('falls back at once with no connection, no loaded page, or no window id', () => {
        const offline = surfaceHarness();
        offline.connected = false;
        createUpdateSurface(offline.deps).present(AVAILABLE, true);
        expect(offline.native).toEqual([AVAILABLE]);

        const loading = surfaceHarness();
        loading.pageUp = false;
        createUpdateSurface(loading.deps).present(AVAILABLE, true);
        expect(loading.native).toEqual([AVAILABLE]);
        expect(loading.sent).toEqual([]);

        const anonymous = surfaceHarness(null);
        createUpdateSurface(anonymous.deps).present(AVAILABLE, true);
        expect(anonymous.native).toEqual([AVAILABLE]);
    });

    it('an acknowledgement of an EARLIER view does not stop the wait for the newer one', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present({ phase: 'checking', currentVersion: '0.2.2' }, true);
        surface.present(AVAILABLE, true);
        surface.acknowledge(1);
        h.timers.forEach((run) => run());
        expect(h.native).toEqual([AVAILABLE]);
    });

    it('a view that is not revealed is sent for an open sheet to follow, but raises nothing and never falls back', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present({ phase: 'restarting', currentVersion: '0.2.2', version: '0.2.3' }, false);
        h.connected = false;
        surface.present({ phase: 'idle', currentVersion: '0.2.2' }, false);
        h.timers.forEach((run) => run());
        expect(h.sent).toHaveLength(1);
        expect(h.raised).toEqual([]);
        expect(h.native).toEqual([]);
    });

    it('closes a native dialog from an earlier state whenever the state moves', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present(AVAILABLE, true);
        surface.present({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' }, true);
        expect(h.closes).toBe(2);
    });
});
