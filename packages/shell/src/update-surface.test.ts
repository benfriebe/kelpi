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
        expect(dialog?.options.detail).toContain('Give it those few seconds');
        expect(dialog?.options.detail).toContain('next time you quit');
        expect(dialog?.options.detail).toContain('wait a few seconds before opening Kelpi again');
    });

    it('says a download is under way and that Kelpi will ask', () => {
        const dialog = nativeUpdateDialog({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' });
        expect(dialog?.options.message).toBe('Downloading Kelpi 0.2.3…');
        expect(dialog?.options.detail).toContain('Kelpi will ask before it restarts');
        expect(dialog?.actions).toEqual(['dismiss']);
    });

    it('offers Quit (not Retry) for a failed install, with the Squirrel reason', () => {
        const dialog = nativeUpdateDialog({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'install', message: 'ShipIt failed' });
        expect(dialog?.options.message).toBe('Kelpi could not finish installing the update');
        expect(dialog?.options.detail).toContain('Quit Kelpi and open it again');
        expect(dialog?.options.detail).toContain('ShipIt failed');
        expect(dialog?.options.buttons).toEqual(['Quit Kelpi', 'Close']);
        expect(dialog?.actions).toEqual(['quit', 'dismiss']);
    });

    it('says a slow download is still going, not failed', () => {
        const dialog = nativeUpdateDialog({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3', slow: true });
        expect(dialog?.options.detail).toContain('taking longer than expected');
        expect(dialog?.actions).toEqual(['dismiss']);
    });

    it('offers Retry on a failure, headed by what failed', () => {
        const dialog = nativeUpdateDialog({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'download', message: 'offline' });
        expect(dialog?.options.message).toBe('Kelpi 0.2.3 could not be downloaded');
        expect(dialog?.options.buttons).toEqual(['Retry', 'Close']);
        expect(dialog?.actions).toEqual(['retry', 'dismiss']);
        expect(failureTitle({ phase: 'failed', currentVersion: '0.2.2', retry: 'check' })).toBe('Kelpi could not check for updates');
        expect(failureTitle({ phase: 'failed', currentVersion: '0.2.2', version: '0.2.3', retry: 'install' })).toBe('Kelpi could not finish installing the update');
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
    /** What `raise` answers: whether the user can see a surface now. */
    visible: boolean;
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
        visible: true,
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
        raise: (view) => {
            h.raised.push(view);
            return h.visible;
        },
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
        // One surface at a time: the page is told to close its sheet first.
        expect(h.sent.at(-1)).toMatchObject({ seq: 2, reveal: false, hide: true, view: AVAILABLE });
    });

    it('an unprompted state with the window out of sight waits in the page: no native dialog is forced', () => {
        const h = surfaceHarness();
        h.visible = false;
        const surface = createUpdateSurface(h.deps);
        surface.present(AVAILABLE, true, false);
        h.timers.forEach((run) => run());
        expect(h.sent).toHaveLength(1);
        expect(h.native).toEqual([]);
        h.connected = false;
        surface.present({ phase: 'ready', currentVersion: '0.2.2', version: '0.2.3' }, true, false);
        expect(h.native).toEqual([]);
    });

    it('a press on a view the state has moved on from is stale; one on the current question is not', () => {
        const h = surfaceHarness();
        const surface = createUpdateSurface(h.deps);
        surface.present({ phase: 'failed', currentVersion: '0.2.2', retry: 'check', message: 'offline' }, true); // seq 1
        surface.present(AVAILABLE, true); // seq 2, a new question
        expect(surface.isCurrent(1)).toBe(false);
        expect(surface.isCurrent(2)).toBe(true);
        // The same question re-presented (a slow download, a re-reveal) keeps earlier presses current.
        surface.present({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' }, true); // seq 3
        surface.present({ phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3', slow: true }, false); // seq 4
        expect(surface.isCurrent(3)).toBe(true);
        expect(surface.isCurrent(2)).toBe(false);
        expect(surface.isCurrent(undefined)).toBe(true);
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
