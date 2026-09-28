import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
    UPDATE_FEED_ENV,
    UPDATE_LATER,
    UPDATE_NOW,
    compareVersions,
    downloadAndInstall,
    feedURL,
    fetchUpdate,
    launchLogLine,
    parseFeedReply,
    repoFromPackage,
    shouldCheckAtLaunch,
    updatePrompt,
    updateSupport,
    type Installer,
    type UpdateHost
} from './updater.js';

const packaged: UpdateHost = { isPackaged: true, platform: 'darwin', arch: 'arm64', version: '0.2.0', repo: 'benfriebe/kelpi' };
const FEED = 'https://update.electronjs.org/benfriebe/kelpi/darwin-arm64/0.2.0';

describe('whether this build can update', () => {
    it('can when it is the packaged macOS app with a repository', () => {
        expect(updateSupport(packaged)).toEqual({ ok: true });
    });

    it('cannot in a development run, off macOS, or with no repository, and says why', () => {
        expect(updateSupport({ ...packaged, isPackaged: false })).toMatchObject({ ok: false, reason: expect.stringContaining('development') });
        expect(updateSupport({ ...packaged, platform: 'linux' })).toMatchObject({ ok: false, reason: expect.stringContaining('linux') });
        expect(updateSupport({ ...packaged, repo: undefined })).toMatchObject({ ok: false });
    });

    it('checks at launch only with the setting on, in a build that can update', () => {
        expect(shouldCheckAtLaunch(true, packaged)).toBe(true);
        expect(shouldCheckAtLaunch(false, packaged)).toBe(false);
        expect(shouldCheckAtLaunch(null, packaged)).toBe(false);
        expect(shouldCheckAtLaunch(true, { ...packaged, isPackaged: false })).toBe(false);
    });

    it('logs what it will do at launch, and that "off" means no request', () => {
        expect(launchLogLine(false, packaged)).toContain('no update request is made');
        expect(launchLogLine(true, packaged)).toContain('on; checking');
        expect(launchLogLine(true, { ...packaged, isPackaged: false })).toContain('unavailable');
    });
});

describe('the feed', () => {
    it('reads owner/name from every repository spelling', () => {
        expect(repoFromPackage('github:benfriebe/kelpi')).toBe('benfriebe/kelpi');
        expect(repoFromPackage('benfriebe/kelpi')).toBe('benfriebe/kelpi');
        expect(repoFromPackage({ url: 'https://github.com/benfriebe/kelpi.git' })).toBe('benfriebe/kelpi');
        expect(repoFromPackage({ url: 'git@github.com:benfriebe/kelpi.git' })).toBe('benfriebe/kelpi');
        expect(repoFromPackage(undefined)).toBeUndefined();
    });

    it('asks update.electronjs.org by platform, arch and version, or an overridden feed', () => {
        expect(feedURL(packaged, {})).toBe(FEED);
        expect(feedURL(packaged, { [UPDATE_FEED_ENV]: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9/benfriebe/kelpi/darwin-arm64/0.2.0');
    });

    it('orders versions, with a prerelease below its release', () => {
        expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
        expect(compareVersions('v0.2.0', '0.2.0')).toBe(0);
        expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
        expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1);
        expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    });

    it('reads "no update", an update, and every kind of bad reply', () => {
        expect(parseFeedReply(204, '', '0.2.0', FEED)).toEqual({ kind: 'none' });
        const body = JSON.stringify({ name: 'v0.3.0', notes: 'Faster.', url: 'https://x/Kelpi.zip' });
        expect(parseFeedReply(200, body, '0.2.0', FEED)).toEqual({
            kind: 'available',
            update: { version: '0.3.0', notes: 'Faster.', feed: FEED }
        });
        // A feed that offers the same or an older version is not an update.
        expect(parseFeedReply(200, JSON.stringify({ name: 'v0.2.0', url: 'x' }), '0.2.0', FEED)).toEqual({ kind: 'none' });
        expect(parseFeedReply(500, '', '0.2.0', FEED)).toMatchObject({ kind: 'error', message: expect.stringContaining('500') });
        expect(parseFeedReply(200, 'not json', '0.2.0', FEED)).toMatchObject({ kind: 'error' });
        expect(parseFeedReply(200, JSON.stringify({ notes: 'no name' }), '0.2.0', FEED)).toMatchObject({ kind: 'error' });
    });

    it('turns a network failure into an error, never a throw', async () => {
        const failing = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
        await expect(fetchUpdate(FEED, '0.2.0', failing)).resolves.toEqual({ kind: 'error', message: 'offline' });
        const none = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
        await expect(fetchUpdate(FEED, '0.2.0', none)).resolves.toEqual({ kind: 'none' });
    });
});

describe('the prompt', () => {
    const update = { version: '0.3.0', notes: 'Faster restarts.', feed: FEED };

    it('offers Update Now first and Later as the cancel, with the versions and notes', () => {
        const prompt = updatePrompt(update, '0.2.0');
        expect(prompt.message).toBe('Kelpi 0.3.0 is available');
        expect(prompt.buttons).toEqual(['Update Now', 'Later']);
        expect(prompt.buttons[UPDATE_NOW]).toBe('Update Now');
        expect(prompt.cancelId).toBe(UPDATE_LATER);
        expect(prompt.detail).toContain('You have 0.2.0');
        expect(prompt.detail).toContain('terminals and agents keep running');
        expect(prompt.detail).toContain('Faster restarts.');
    });

    it('cuts very long notes', () => {
        const prompt = updatePrompt({ ...update, notes: 'x'.repeat(5000) }, '0.2.0');
        expect(prompt.detail.length).toBeLessThan(1500);
        expect(prompt.detail.endsWith('…')).toBe(true);
    });
});

class FakeInstaller extends EventEmitter implements Installer {
    feed: string | undefined;
    checks = 0;
    installs = 0;
    setFeedURL(options: { url: string }): void {
        this.feed = options.url;
    }
    checkForUpdates(): void {
        this.checks += 1;
    }
    quitAndInstall(): void {
        this.installs += 1;
    }
}

describe('installing', () => {
    const update = { version: '0.3.0', notes: '', feed: FEED };

    it('downloads through the feed, lets the quit through, then quits into the update', async () => {
        const installer = new FakeInstaller();
        const order: string[] = [];
        const done = downloadAndInstall(installer, update, () => order.push('allow-quit'));
        expect(installer.feed).toBe(FEED);
        expect(installer.checks).toBe(1);
        expect(installer.installs).toBe(0); // nothing installs before the download finishes
        installer.emit('update-downloaded');
        await done;
        expect(order).toEqual(['allow-quit']);
        expect(installer.installs).toBe(1);
        expect(installer.listenerCount('error')).toBe(0);
    });

    it('rejects on a download error, and never installs', async () => {
        const installer = new FakeInstaller();
        const done = downloadAndInstall(installer, update, () => undefined);
        installer.emit('error', new Error('signature mismatch'));
        await expect(done).rejects.toThrow('signature mismatch');
        expect(installer.installs).toBe(0);
    });

    it('rejects when the feed withdrew the update in the meantime', async () => {
        const installer = new FakeInstaller();
        const done = downloadAndInstall(installer, update, () => undefined);
        installer.emit('update-not-available');
        await expect(done).rejects.toThrow('no longer offered');
    });
});
