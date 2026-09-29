import { describe, expect, it } from 'vitest';

import {
    chooseFolderAnswer,
    droppedFilesAnswer,
    isForwardableOpenPath,
    parseShellAction,
    parseWindowChrome,
    parseWorkspaceSelection,
    scriptedFolderAnswer,
    shellActionAppliesHere
} from './shell-actions.js';

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

/** The root arrangement's `window-chrome`: the page's toolbar is hidden, so hide the traffic lights. */
describe('parseWindowChrome', () => {
    it('decodes the flag, with and without a window scope', () => {
        expect(parseWindowChrome({ type: 'window-chrome', titleBarHidden: true, windowID: 'w1' })).toEqual({ titleBarHidden: true, windowID: 'w1' });
        expect(parseWindowChrome({ type: 'window-chrome', titleBarHidden: false })).toEqual({ titleBarHidden: false, windowID: null });
    });

    it('refuses a flag it would have to guess, and another message type', () => {
        expect(parseWindowChrome({ type: 'window-chrome' })).toBeNull();
        expect(parseWindowChrome({ type: 'window-chrome', titleBarHidden: 'true' })).toBeNull();
        expect(parseWindowChrome({ type: 'window-chrome', titleBarHidden: 1 })).toBeNull();
        expect(parseWindowChrome({ type: 'workspace-selection', titleBarHidden: true })).toBeNull();
    });

    it('shares the window filter, so one window hiding its toolbar leaves the other alone', () => {
        const report = parseWindowChrome({ type: 'window-chrome', titleBarHidden: true, windowID: 'w2' });
        expect(shellActionAppliesHere(report?.windowID ?? null, 'w2')).toBe(true);
        expect(shellActionAppliesHere(report?.windowID ?? null, 'w1')).toBe(false);
    });
});

describe('parseShellAction', () => {
    it('decodes the one-way actions with their optional scope fields', () => {
        expect(parseShellAction({ action: 'open-file-dialog', windowID: 'w1', paneID: 'p1' })).toEqual({
            action: 'open-file-dialog',
            windowID: 'w1',
            paneID: 'p1',
            requestID: null
        });
        expect(parseShellAction({ action: 'install-cli' })).toEqual({
            action: 'install-cli',
            windowID: null,
            paneID: null,
            requestID: null
        });
        expect(parseShellAction({ action: 'check-for-updates' })?.action).toBe('check-for-updates');
    });

    it('decodes a folder request with the id its answer must carry back (#283)', () => {
        expect(parseShellAction({ action: 'choose-folder-dialog', windowID: 'w1', requestID: 'r1' })).toEqual({
            action: 'choose-folder-dialog',
            windowID: 'w1',
            paneID: null,
            requestID: 'r1'
        });
    });

    it('refuses a folder request with no usable id or no window: its answer could reach nobody', () => {
        expect(parseShellAction({ action: 'choose-folder-dialog', requestID: 'r1' })).toBeNull();
        expect(parseShellAction({ action: 'choose-folder-dialog', windowID: 'w1' })).toBeNull();
        expect(parseShellAction({ action: 'choose-folder-dialog', windowID: 'w1', requestID: '' })).toBeNull();
        expect(parseShellAction({ action: 'choose-folder-dialog', windowID: 'w1', requestID: 7 })).toBeNull();
    });

    it('decodes a dropped-files request, and refuses one with no id or no window (#288)', () => {
        expect(parseShellAction({ action: 'resolve-dropped-files', windowID: 'w1', requestID: 'd1' })).toEqual({
            action: 'resolve-dropped-files',
            windowID: 'w1',
            paneID: null,
            requestID: 'd1'
        });
        expect(parseShellAction({ action: 'resolve-dropped-files', requestID: 'd1' })).toBeNull();
        expect(parseShellAction({ action: 'resolve-dropped-files', windowID: 'w1' })).toBeNull();
    });

    it('keeps a request id off the one-way actions', () => {
        expect(parseShellAction({ action: 'open-file-dialog', requestID: 'r1' })?.requestID).toBeNull();
    });

    it('ignores anything outside the allowlist and anything malformed', () => {
        expect(parseShellAction({ action: 'rm -rf /' })).toBeNull();
        expect(parseShellAction({ action: '' })).toBeNull();
        expect(parseShellAction({ action: 42 })).toBeNull();
        expect(parseShellAction({})).toBeNull();
    });
});

describe('chooseFolderAnswer (#283)', () => {
    it('carries the chosen path with the id and the REQUEST’s window', () => {
        expect(chooseFolderAnswer('r1', 'w1', '/src/app')).toEqual({
            type: 'choose-folder-answer',
            requestID: 'r1',
            path: '/src/app',
            windowID: 'w1'
        });
    });

    it('reads a cancel, an empty path and a missing one all as null', () => {
        expect(chooseFolderAnswer('r1', 'w1', null).path).toBeNull();
        expect(chooseFolderAnswer('r1', 'w1', '').path).toBeNull();
        expect(chooseFolderAnswer('r1', 'w1', undefined).path).toBeNull();
    });


});

describe('droppedFilesAnswer (#288)', () => {
    it('carries the paths, the unresolved count, the id and the REQUEST’s window', () => {
        expect(droppedFilesAnswer('d1', 'w1', { paths: ['/a b', '/c'], unresolved: 1 })).toEqual({
            type: 'dropped-files-answer',
            requestID: 'd1',
            paths: ['/a b', '/c'],
            unresolved: 1,
            windowID: 'w1'
        });
    });

    it('counts a path that is not absolute as unresolved, and sends an error only when there is one', () => {
        const answer = droppedFilesAnswer('d1', 'w1', { paths: ['/ok', 'relative', ''], unresolved: 0, error: '' });
        expect(answer.paths).toEqual(['/ok']);
        expect(answer.unresolved).toBe(2);
        expect('error' in answer).toBe(false);
        expect(droppedFilesAnswer('d1', 'w1', { paths: [], unresolved: 0, error: 'gone' }).error).toBe('gone');
    });
});

describe('scriptedFolderAnswer (the KELPI_AUDIT_CHOOSE_FOLDER seam)', () => {
    it('is the file’s one path, without the harness’s newline', () => {
        expect(scriptedFolderAnswer('/tmp/repo\n')).toBe('/tmp/repo');
    });

    it('reads an empty file, or none at all, as a cancel', () => {
        expect(scriptedFolderAnswer('')).toBeNull();
        expect(scriptedFolderAnswer('  \n')).toBeNull();
        expect(scriptedFolderAnswer(null)).toBeNull();
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
