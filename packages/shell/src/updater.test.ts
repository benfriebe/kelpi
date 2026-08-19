import { describe, expect, it } from 'vitest';

import {
    AUTO_UPDATE_ENV,
    AUTO_UPDATE_INTERVAL_ENV,
    AUTO_UPDATE_REPO_ENV,
    DEFAULT_UPDATE_INTERVAL,
    autoUpdateDecision,
    maybeStartAutoUpdate,
    readAutoUpdateSettings
} from './updater.js';

const packaged = { isPackaged: true, platform: 'darwin' };

describe('readAutoUpdateSettings', () => {
    it('is off unless something explicitly turns it on', () => {
        expect(readAutoUpdateSettings({}).enabled).toBe(false);
        for (const value of ['', '  ', '0', 'false', 'no', 'off', 'maybe']) {
            expect(readAutoUpdateSettings({ [AUTO_UPDATE_ENV]: value }).enabled, value).toBe(false);
        }
    });

    it('accepts the usual truthy spellings, case-insensitively', () => {
        for (const value of ['1', 'true', 'TRUE', 'yes', ' on ']) {
            expect(readAutoUpdateSettings({ [AUTO_UPDATE_ENV]: value }).enabled, value).toBe(true);
        }
    });

    it('reads the repo override and the interval, with a default interval', () => {
        expect(readAutoUpdateSettings({}).updateInterval).toBe(DEFAULT_UPDATE_INTERVAL);
        expect(readAutoUpdateSettings({}).repo).toBeUndefined();
        const settings = readAutoUpdateSettings({
            [AUTO_UPDATE_ENV]: '1',
            [AUTO_UPDATE_REPO_ENV]: ' owner/name ',
            [AUTO_UPDATE_INTERVAL_ENV]: '15 minutes'
        });
        expect(settings).toEqual({ enabled: true, repo: 'owner/name', updateInterval: '15 minutes' });
    });

    it('treats an empty repo/interval as unset rather than as a value', () => {
        const settings = readAutoUpdateSettings({
            [AUTO_UPDATE_ENV]: '1',
            [AUTO_UPDATE_REPO_ENV]: '   ',
            [AUTO_UPDATE_INTERVAL_ENV]: ''
        });
        expect(settings.repo).toBeUndefined();
        expect(settings.updateInterval).toBe(DEFAULT_UPDATE_INTERVAL);
    });
});

describe('autoUpdateDecision', () => {
    it('declines by default, and says how to opt in', () => {
        const outcome = autoUpdateDecision(readAutoUpdateSettings({}), packaged);
        expect(outcome.started).toBe(false);
        expect(outcome.started === false && outcome.reason).toContain(AUTO_UPDATE_ENV);
    });

    it('declines in a development run — Squirrel cannot update `electron .`', () => {
        const settings = readAutoUpdateSettings({ [AUTO_UPDATE_ENV]: '1' });
        const outcome = autoUpdateDecision(settings, { isPackaged: false, platform: 'darwin' });
        expect(outcome).toEqual({ started: false, reason: 'not a packaged app' });
    });

    it('declines on a platform Squirrel does not cover', () => {
        const settings = readAutoUpdateSettings({ [AUTO_UPDATE_ENV]: '1' });
        expect(autoUpdateDecision(settings, { isPackaged: true, platform: 'linux' })).toEqual({
            started: false,
            reason: 'unsupported platform linux'
        });
    });

    it('starts only when opted in, packaged, and on darwin/win32', () => {
        const settings = readAutoUpdateSettings({ [AUTO_UPDATE_ENV]: '1', [AUTO_UPDATE_REPO_ENV]: 'owner/name' });
        expect(autoUpdateDecision(settings, packaged)).toEqual({ started: true, repo: 'owner/name' });
        expect(autoUpdateDecision(settings, { isPackaged: true, platform: 'win32' }).started).toBe(true);
    });
});

describe('maybeStartAutoUpdate', () => {
    it('does nothing at all in the packaged default — no import, no network', async () => {
        // The assertion that matters for a shipped build: the disabled path returns before the
        // dynamic import of update-electron-app is ever evaluated, so nothing can contact
        // update.electronjs.org. (If it had started, `started` would be true — and this test
        // would also be making a real network call.)
        const outcome = await maybeStartAutoUpdate(packaged, {});
        expect(outcome.started).toBe(false);
        expect(outcome.started === false && outcome.reason).toContain('disabled');
    });

    it('still refuses when opted in but unpackaged, so a dev run stays inert', async () => {
        const outcome = await maybeStartAutoUpdate(
            { isPackaged: false, platform: 'darwin' },
            { [AUTO_UPDATE_ENV]: '1' }
        );
        expect(outcome).toEqual({ started: false, reason: 'not a packaged app' });
    });
});
