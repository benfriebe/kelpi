import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentModel, type AgentCounts } from './agents.js';
import {
    DEFAULT_SHELL_SETTINGS,
    markQuitConfirmationMigrated,
    pendingQuitConfirmationMigration,
    quitDialogSpec,
    readShellSettings,
    settingsFile,
    shouldConfirmQuit,
    writeShellSettings
} from './settings.js';

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-settings-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function counts(active: number): AgentCounts {
    const model = new AgentModel();
    const panes = Array.from({ length: active }, (_value, index) => ({
        id: `p${String(index)}`,
        status: 'waitingForInput'
    }));
    model.applySnapshot({ workspaces: [{ id: 'w1', name: 'alpha', panes }] } as never);
    return model.counts();
}

describe('shell settings', () => {
    it('defaults confirmQuitWhenActive to true when the file is missing', () => {
        expect(readShellSettings(settingsFile(tempDir()))).toEqual(DEFAULT_SHELL_SETTINGS);
    });

    it('round-trips the suppression flag', () => {
        const file = settingsFile(tempDir());
        writeShellSettings(file, { ...DEFAULT_SHELL_SETTINGS, confirmQuitWhenActive: false });
        expect(readShellSettings(file).confirmQuitWhenActive).toBe(false);
    });

    it('round-trips the CLI-install state, defaulting both keys to "never"', () => {
        const file = settingsFile(tempDir());
        expect(readShellSettings(file).cliInstallPrompted).toBe(false);
        expect(readShellSettings(file).cliInstallNotifiedVersion).toBe('');

        writeShellSettings(file, {
            ...DEFAULT_SHELL_SETTINGS,
            cliInstallPrompted: true,
            cliInstallNotifiedVersion: '0.1.0'
        });
        const read = readShellSettings(file);
        expect(read.cliInstallPrompted).toBe(true);
        expect(read.cliInstallNotifiedVersion).toBe('0.1.0');
        // Unchanged by the new keys.
        expect(read.confirmQuitWhenActive).toBe(true);
    });

    it('reads a garbage CLI-install value as "never", not as truthy', () => {
        const file = path.join(tempDir(), 'settings.json');
        fs.writeFileSync(file, JSON.stringify({ cliInstallPrompted: 'yes', cliInstallNotifiedVersion: 7 }));
        expect(readShellSettings(file).cliInstallPrompted).toBe(false);
        expect(readShellSettings(file).cliInstallNotifiedVersion).toBe('');
    });

    it('treats any non-false value (including garbage) as true', () => {
        const file = path.join(tempDir(), 'settings.json');
        fs.writeFileSync(file, JSON.stringify({ confirmQuitWhenActive: 'no' }));
        expect(readShellSettings(file).confirmQuitWhenActive).toBe(true);
        fs.writeFileSync(file, 'not json at all');
        expect(readShellSettings(file).confirmQuitWhenActive).toBe(true);
    });
});

describe('shouldConfirmQuit', () => {
    it('asks only when agents are active', () => {
        expect(shouldConfirmQuit({ confirmQuitWhenActive: true }, counts(0))).toBe(false);
        expect(shouldConfirmQuit({ confirmQuitWhenActive: true }, counts(2))).toBe(true);
    });

    it('never asks once the user suppressed it', () => {
        expect(shouldConfirmQuit({ confirmQuitWhenActive: false }, counts(3))).toBe(false);
    });
});

describe('quitDialogSpec', () => {
    it('defaults to Cancel and offers the suppression checkbox', () => {
        const spec = quitDialogSpec(counts(1));
        expect(spec.buttons).toEqual(['Quit', 'Cancel']);
        expect(spec.defaultId).toBe(1);
        expect(spec.cancelId).toBe(1);
        expect(spec.checkboxLabel).toBe("Don't ask again");
        expect(spec.message).toBe('Quit Nex?');
        expect(spec.detail).toContain('keep running in the background');
    });
});

// ---------------------------------------------------------------------------
// §AGNT-117 — the suppression moved into the daemon settings; migrate once
// ---------------------------------------------------------------------------

describe('quit-confirmation migration (§AGNT-117)', () => {
    it('has something to migrate only for a user who actually suppressed it', () => {
        expect(pendingQuitConfirmationMigration(DEFAULT_SHELL_SETTINGS)).toBe(false);
        expect(
            pendingQuitConfirmationMigration({ ...DEFAULT_SHELL_SETTINGS, confirmQuitWhenActive: false })
        ).toBe(true);
    });

    it('never migrates twice, so a later daemon-side re-enable is not undone', () => {
        const suppressed = { ...DEFAULT_SHELL_SETTINGS, confirmQuitWhenActive: false };
        const file = settingsFile(tempDir());
        const migrated = markQuitConfirmationMigrated(file, suppressed);
        expect(migrated.quitConfirmationMigrated).toBe(true);
        expect(pendingQuitConfirmationMigration(migrated)).toBe(false);
        // And it survived the round trip, so the next launch does not push the old value again.
        expect(readShellSettings(file).quitConfirmationMigrated).toBe(true);
    });

    it('reads a pre-migration file as "not migrated yet"', () => {
        const file = path.join(tempDir(), 'legacy.json');
        fs.writeFileSync(file, JSON.stringify({ confirmQuitWhenActive: false }));
        const read = readShellSettings(file);
        expect(read.quitConfirmationMigrated).toBe(false);
        expect(pendingQuitConfirmationMigration(read)).toBe(true);
    });

    it('leaves the CLI-install keys alone when it marks the migration done', () => {
        const file = settingsFile(tempDir());
        writeShellSettings(file, {
            ...DEFAULT_SHELL_SETTINGS,
            confirmQuitWhenActive: false,
            cliInstallPrompted: true,
            cliInstallNotifiedVersion: '0.4.2'
        });
        markQuitConfirmationMigrated(file, readShellSettings(file));
        const read = readShellSettings(file);
        expect(read.cliInstallPrompted).toBe(true);
        expect(read.cliInstallNotifiedVersion).toBe('0.4.2');
    });
});
