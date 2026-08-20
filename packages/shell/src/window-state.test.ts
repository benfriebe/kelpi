import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_WINDOW_STATE,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    clampBoundsToDisplays,
    defaultBounds,
    readWindowState,
    stripIsGrabbable,
    windowStateFile,
    writeWindowState,
    type DisplayLike
} from './window-state.js';

const laptop: DisplayLike = { workArea: { x: 0, y: 25, width: 1512, height: 945 } };
const external: DisplayLike = { workArea: { x: 1512, y: 0, width: 2560, height: 1415 } };

describe('clampBoundsToDisplays', () => {
    it('keeps a frame that fits entirely on one display', () => {
        const bounds = { x: 100, y: 100, width: 1200, height: 800 };
        expect(clampBoundsToDisplays(bounds, [laptop, external])).toEqual(bounds);
    });

    it('keeps a frame on a secondary display', () => {
        const bounds = { x: 1600, y: 200, width: 1200, height: 800 };
        expect(clampBoundsToDisplays(bounds, [laptop, external])).toEqual(bounds);
    });

    it('recentres a frame whose display was unplugged', () => {
        const bounds = { x: 3000, y: 300, width: 1200, height: 800 };
        const clamped = clampBoundsToDisplays(bounds, [laptop], laptop);
        expect(clamped).toEqual({ x: 156, y: 98, width: 1200, height: 800 });
    });

    it('shifts a partly off-screen frame back on when the title bar is still grabbable', () => {
        // 200pt of the title bar still overlaps the laptop display: shift, do not recentre.
        const bounds = { x: 1312, y: 100, width: 1200, height: 800 };
        const clamped = clampBoundsToDisplays(bounds, [laptop], laptop);
        expect(clamped).toEqual({ x: 312, y: 100, width: 1200, height: 800 });
    });

    it('recentres when the title bar is off every display', () => {
        // The window body overlaps the laptop screen, but its top strip is above it.
        const bounds = { x: 100, y: -400, width: 1200, height: 800 };
        const clamped = clampBoundsToDisplays(bounds, [laptop], laptop);
        expect(clamped.y).toBeGreaterThanOrEqual(laptop.workArea.y);
    });

    it('shrinks a frame that is larger than the display it lands on', () => {
        const bounds = { x: 0, y: 0, width: 4000, height: 3000 };
        const clamped = clampBoundsToDisplays(bounds, [laptop], laptop);
        expect(clamped.width).toBe(laptop.workArea.width);
        expect(clamped.height).toBe(laptop.workArea.height);
    });

    it('enforces the 600×400 minimum', () => {
        const clamped = clampBoundsToDisplays({ x: 10, y: 30, width: 120, height: 90 }, [laptop], laptop);
        expect(clamped.width).toBe(MIN_WINDOW_WIDTH);
        expect(clamped.height).toBe(MIN_WINDOW_HEIGHT);
    });

    it('returns a size-clamped frame when there are no displays at all', () => {
        const clamped = clampBoundsToDisplays({ x: 5, y: 5, width: 10, height: 10 }, []);
        expect(clamped).toEqual({ x: 5, y: 5, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
    });

    it('centres the default frame on the primary display', () => {
        const bounds = defaultBounds(external);
        expect(bounds.x).toBeGreaterThan(external.workArea.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(external.workArea.x + external.workArea.width);
    });
});

describe('stripIsGrabbable', () => {
    it('requires 80pt of horizontal overlap', () => {
        expect(stripIsGrabbable(laptop.workArea, { x: 1450, y: 100, width: 900, height: 600 })).toBe(false);
        expect(stripIsGrabbable(laptop.workArea, { x: 1400, y: 100, width: 900, height: 600 })).toBe(true);
    });

    it('requires the strip itself to be on screen', () => {
        expect(stripIsGrabbable(laptop.workArea, { x: 100, y: -100, width: 900, height: 600 })).toBe(false);
        expect(stripIsGrabbable(laptop.workArea, { x: 100, y: 30, width: 900, height: 600 })).toBe(true);
    });
});

describe('window state file', () => {
    const dirs: string[] = [];
    const tempDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-state-'));
        dirs.push(dir);
        return dir;
    };

    afterEach(() => {
        while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
    });

    it('round-trips bounds and the fullscreen flag', () => {
        const file = windowStateFile(tempDir());
        const state = {
            bounds: { x: 1, y: 2, width: 800, height: 600 },
            fullScreen: true,
            visibleOnAllWorkspaces: false
        };
        writeWindowState(file, state);
        expect(readWindowState(file)).toEqual(state);
    });

    // §APP-060: the Dock's own "Assign To → All Desktops" binding lives in a private plist
    // Electron cannot read, so the port owns the flag and this file is what makes it survive a
    // relaunch. Opt-in: a state file written before the flag existed reads as "off".
    it('round-trips the all-desktops assignment, and defaults it off', () => {
        const file = windowStateFile(tempDir());
        writeWindowState(file, { bounds: null, fullScreen: false, visibleOnAllWorkspaces: true });
        expect(readWindowState(file).visibleOnAllWorkspaces).toBe(true);

        const legacy = path.join(tempDir(), 'legacy.json');
        fs.writeFileSync(legacy, JSON.stringify({ bounds: null, fullScreen: false }));
        expect(readWindowState(legacy).visibleOnAllWorkspaces).toBe(false);
    });

    it('treats a missing or corrupt file as no stored state', () => {
        const dir = tempDir();
        expect(readWindowState(windowStateFile(dir))).toEqual(DEFAULT_WINDOW_STATE);
        const file = path.join(dir, 'broken.json');
        fs.writeFileSync(file, '{not json');
        expect(readWindowState(file)).toEqual(DEFAULT_WINDOW_STATE);
    });

    it('rejects a partial or non-numeric rect', () => {
        const file = path.join(tempDir(), 'partial.json');
        fs.writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: '800' }, fullScreen: false }));
        expect(readWindowState(file).bounds).toBeNull();
    });

    it('creates the directory it writes into', () => {
        const file = path.join(tempDir(), 'nested', 'window-state.json');
        writeWindowState(file, { bounds: null, fullScreen: false, visibleOnAllWorkspaces: false });
        expect(fs.existsSync(file)).toBe(true);
    });
});
