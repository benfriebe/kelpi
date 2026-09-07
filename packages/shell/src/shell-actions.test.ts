import { describe, expect, it } from 'vitest';

import {
    isForwardableOpenPath,
    parseShellAction,
    parseWindowControl,
    parseWorkspaceSelection,
    shellActionAppliesHere
} from './shell-actions.js';
import { AUTO_UPDATE_ENV, checkForUpdatesNow } from './updater.js';

/**
 * §WS-151 — `workspace-selection`, the client's report that greys File ▸ Deselect All Workspaces.
 *
 * The rule under test is the refusal, not the happy path: a frame whose count cannot be trusted
 * must produce NO report at all, because both defaults are wrong in a visible way (0 greys a row
 * over a frame nobody understood; anything else un-greys one).
 */
describe('parseWorkspaceSelection', () => {
    it('decodes a count, with and without a window scope', () => {
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: 3, windowID: 'w1' })).toEqual(
            { selected: 3, windowID: 'w1' }
        );
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: 0 })).toEqual({
            selected: 0,
            windowID: null
        });
    });

    it('refuses anything that is not a usable count', () => {
        expect(parseWorkspaceSelection({ type: 'workspace-selection' })).toBeNull();
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: -1 })).toBeNull();
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: 1.5 })).toBeNull();
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: '2' })).toBeNull();
        expect(parseWorkspaceSelection({ type: 'workspace-selection', selected: Number.NaN })).toBeNull();
    });

    it('is not confused by another message that happens to carry a count', () => {
        expect(parseWorkspaceSelection({ type: 'shell-activation', selected: 4 })).toBeNull();
        expect(parseWorkspaceSelection({ selected: 4 })).toBeNull();
    });

    it('shares the window filter with `shell-action`, so two windows keep two menus', () => {
        const report = parseWorkspaceSelection({
            type: 'workspace-selection',
            selected: 2,
            windowID: 'w2'
        });
        expect(shellActionAppliesHere(report?.windowID ?? null, 'w2')).toBe(true);
        expect(shellActionAppliesHere(report?.windowID ?? null, 'w1')).toBe(false);
    });
});

describe('parseShellAction', () => {
    it('decodes the three actions with their optional scope fields', () => {
        expect(parseShellAction({ action: 'open-file-dialog', windowID: 'w1', paneID: 'p1' })).toEqual({
            action: 'open-file-dialog',
            windowID: 'w1',
            paneID: 'p1'
        });
        expect(parseShellAction({ action: 'install-cli' })).toEqual({
            action: 'install-cli',
            windowID: null,
            paneID: null
        });
        expect(parseShellAction({ action: 'check-for-updates' })?.action).toBe('check-for-updates');
    });

    it('ignores anything outside the allowlist and anything malformed', () => {
        expect(parseShellAction({ action: 'rm -rf /' })).toBeNull();
        expect(parseShellAction({ action: '' })).toBeNull();
        expect(parseShellAction({ action: 42 })).toBeNull();
        expect(parseShellAction({})).toBeNull();
    });
});

describe('shellActionAppliesHere', () => {
    it('an unaddressed request is every shell’s', () => {
        expect(shellActionAppliesHere(null, 'w1')).toBe(true);
        expect(shellActionAppliesHere(null, undefined)).toBe(true);
    });

    it('an addressed request is only the named window’s', () => {
        expect(shellActionAppliesHere('w1', 'w1')).toBe(true);
        expect(shellActionAppliesHere('w1', 'w2')).toBe(false);
    });

    it('a shell with no identity still acts (a dev run without a window id)', () => {
        expect(shellActionAppliesHere('w1', undefined)).toBe(true);
    });
});

describe('checkForUpdatesNow (APP-026)', () => {
    const packaged = { isPackaged: true, platform: 'darwin' };

    it('explains the refusal instead of sitting grey when updates are off', () => {
        const result = checkForUpdatesNow({ host: packaged, env: {} });
        expect(result.kind).toBe('unavailable');
        expect(result.kind === 'unavailable' ? result.message : '').toContain(AUTO_UPDATE_ENV);
    });

    it('names the real reason for a development run', () => {
        const result = checkForUpdatesNow({
            host: { isPackaged: false, platform: 'darwin' },
            env: { [AUTO_UPDATE_ENV]: '1' }
        });
        expect(result.kind).toBe('unavailable');
        expect(result.kind === 'unavailable' ? result.message : '').toContain('not a packaged app');
    });

    it('says "not started yet" rather than pretending, when the feed is not up', () => {
        const result = checkForUpdatesNow({
            host: packaged,
            env: { [AUTO_UPDATE_ENV]: '1' },
            started: false
        });
        expect(result.kind).toBe('unavailable');
        expect(result.kind === 'unavailable' ? result.message : '').toContain('has not finished starting');
    });

    it('asks the backend once the updater really is running', () => {
        let checks = 0;
        const result = checkForUpdatesNow({
            host: packaged,
            env: { [AUTO_UPDATE_ENV]: '1' },
            started: true,
            backend: {
                checkForUpdates: () => {
                    checks += 1;
                }
            }
        });
        expect(result.kind).toBe('checking');
        expect(checks).toBe(1);
    });

    it('reports a throwing backend rather than crashing the menu click', () => {
        const result = checkForUpdatesNow({
            host: packaged,
            env: { [AUTO_UPDATE_ENV]: '1' },
            started: true,
            backend: {
                checkForUpdates: () => {
                    throw new Error('no feed configured');
                }
            }
        });
        expect(result.kind).toBe('failed');
        expect(result.kind === 'failed' ? result.message : '').toBe('no feed configured');
    });
});

describe('isForwardableOpenPath (CONT-124)', () => {
    it('accepts the two markdown extensions, case-insensitively', () => {
        expect(isForwardableOpenPath('/a/notes.md')).toBe(true);
        expect(isForwardableOpenPath('/a/notes.MD')).toBe(true);
        expect(isForwardableOpenPath('/a/notes.markdown')).toBe(true);
    });

    it('ignores everything else — an unfiltered forward renders bytes as markdown', () => {
        expect(isForwardableOpenPath('/a/photo.png')).toBe(false);
        expect(isForwardableOpenPath('/a/README')).toBe(false);
        expect(isForwardableOpenPath('/a/.md')).toBe(false);
        expect(isForwardableOpenPath('')).toBe(false);
    });
});

describe('the window-control request (§APP-046b)', () => {
    it('reads the three verbs the page can send', () => {
        for (const action of ['minimize', 'maximize', 'close'] as const) {
            expect(parseWindowControl({ type: 'window-control', action })).toEqual({
                action,
                windowID: null
            });
        }
    });

    it('carries the window id, so one window’s × cannot close another', () => {
        expect(parseWindowControl({ type: 'window-control', action: 'close', windowID: 'w-1' })).toEqual({
            action: 'close',
            windowID: 'w-1'
        });
    });

    it('refuses a frame that is not a window-control at all', () => {
        expect(parseWindowControl({ type: 'shell-activation', active: true })).toBeNull();
        expect(parseWindowControl({ action: 'close' })).toBeNull();
    });

    it('refuses an unknown verb rather than falling through to close', () => {
        // The tempting default is the destructive one: a frame nobody understood must never
        // close the user's window.
        for (const action of ['destroy', 'quit', 'CLOSE', '', 42, null, undefined]) {
            expect(parseWindowControl({ type: 'window-control', action })).toBeNull();
        }
    });
});
