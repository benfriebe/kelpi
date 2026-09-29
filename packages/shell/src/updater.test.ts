import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
    UPDATE_FEED_ENV,
    UPDATE_LATER,
    UPDATE_NOW,
    compareVersions,
    versionIn,
    bundlePathFromExe,
    downloadUpdate,
    feedURL,
    installLocation,
    installLocationLogLine,
    launchVersionLogLine,
    fetchUpdate,
    launchLogLine,
    offeredVersion,
    parseFeedReply,
    repoFromPackage,
    shouldCheckAtLaunch,
    updatePrompt,
    updateSupport,
    type DirectoryAccess,
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
        // The feed's "No updates found" (no non-prerelease release to serve) is not a failure.
        expect(parseFeedReply(404, 'No updates found', '0.2.0', FEED)).toEqual({ kind: 'none' });
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

    it("reads the version from the release's tag, then its title", () => {
        expect(versionIn('Kelpi 0.2.0')).toBe('0.2.0');
        expect(versionIn('v0.2.0-rc.2')).toBe('0.2.0-rc.2');
        expect(versionIn('Kelpi 1.10.3-beta.1 (hotfix)')).toBe('1.10.3-beta.1');
        expect(versionIn('Kelpi')).toBeUndefined();
        const url = 'https://github.com/benfriebe/kelpi/releases/download/v1.0.0-rc.1/Kelpi-darwin-arm64-1.0.0-rc.1.zip';
        expect(offeredVersion('A renamed release', url)).toBe('1.0.0-rc.1');
        expect(offeredVersion('Kelpi 0.4.0', 'https://example.test/Kelpi.zip')).toBe('0.4.0');
        expect(offeredVersion('no version here', 'https://example.test/Kelpi.zip')).toBeUndefined();
    });

    it('offers the real feed reply for v0.2.0 with its plain version', () => {
        // Captured from update.electronjs.org for 0.2.0-rc.2 on 2026-09-29.
        const body = JSON.stringify({
            name: 'Kelpi 0.2.0',
            notes: "## What's Changed",
            url: 'https://github.com/benfriebe/kelpi/releases/download/v0.2.0/Kelpi-darwin-arm64-0.2.0.zip'
        });
        const reply = parseFeedReply(200, body, '0.2.0-rc.2', FEED);
        expect(reply).toMatchObject({ kind: 'available', update: { version: '0.2.0' } });
        if (reply.kind === 'available') expect(updatePrompt(reply.update, '0.2.0-rc.2').message).toBe('Kelpi 0.2.0 is available');
        // A title prefix no longer hides the major version.
        const major = JSON.stringify({ name: 'Kelpi 1.0.0', url: 'https://github.com/o/r/releases/download/v1.0.0/K.zip' });
        expect(parseFeedReply(200, major, '0.9.0', FEED)).toMatchObject({ kind: 'available', update: { version: '1.0.0' } });
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

describe('downloading (#286: nothing quits when it finishes)', () => {
    const update = { version: '0.3.0', notes: '', feed: FEED };

    it('downloads through the feed and resolves when Squirrel has it, without quitting or installing', async () => {
        const installer = new FakeInstaller();
        const done = downloadUpdate(installer, update);
        expect(installer.feed).toBe(FEED);
        expect(installer.checks).toBe(1);
        installer.emit('update-available');
        installer.emit('update-downloaded');
        await done;
        // The old `downloadAndInstall` called quitAndInstall right here; the restart is now the
        // user's Restart Now (`update-flow.ts`).
        expect(installer.installs).toBe(0);
        expect(installer.listenerCount('error')).toBe(0);
        expect(installer.listenerCount('update-downloaded')).toBe(0);
        expect(installer.listenerCount('update-available')).toBe(0);
    });

    it('rejects on a download error, and never installs', async () => {
        const installer = new FakeInstaller();
        const done = downloadUpdate(installer, update);
        installer.emit('error', new Error('signature mismatch'));
        await expect(done).rejects.toThrow('signature mismatch');
        expect(installer.installs).toBe(0);
    });

    it('rejects when the feed withdrew the update in the meantime', async () => {
        const installer = new FakeInstaller();
        const done = downloadUpdate(installer, update);
        installer.emit('update-not-available');
        await expect(done).rejects.toThrow('no longer offered');
    });

    it('rejects when setting the feed throws (an unsigned build)', async () => {
        const installer = new FakeInstaller();
        installer.setFeedURL = () => {
            throw new Error('Could not get code signature for running application');
        };
        await expect(downloadUpdate(installer, update)).rejects.toThrow('code signature');
    });

    it('reports a slow download and keeps waiting for it, so a late finish still counts (#286 review)', async () => {
        vi.useFakeTimers();
        try {
            const installer = new FakeInstaller();
            const onSlow = vi.fn();
            let finished = false;
            const done = downloadUpdate(installer, update, { slowMs: 60_000, onSlow }).then(() => {
                finished = true;
            });
            await vi.advanceTimersByTimeAsync(60_001);
            expect(onSlow).toHaveBeenCalledTimes(1);
            expect(finished).toBe(false);
            expect(installer.listenerCount('update-downloaded')).toBe(1);
            installer.emit('update-downloaded');
            await done;
            expect(finished).toBe(true);
            expect(installer.checks).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('where Kelpi runs from (#286)', () => {
    const HOME = '/Users/jordon';
    const access = (answers: Record<string, DirectoryAccess>) => (directory: string): DirectoryAccess => answers[directory] ?? 'writable';

    it('finds the bundle an executable belongs to', () => {
        expect(bundlePathFromExe('/Applications/Kelpi.app/Contents/MacOS/Kelpi')).toBe('/Applications/Kelpi.app');
        expect(bundlePathFromExe('/Volumes/Kelpi 0.2.3/Kelpi.app/Contents/MacOS/Kelpi')).toBe('/Volumes/Kelpi 0.2.3/Kelpi.app');
        expect(bundlePathFromExe('/usr/local/bin/node')).toBeNull();
    });

    it('is fine in /Applications and ~/Applications', () => {
        expect(installLocation('/Applications/Kelpi.app', access({}), HOME).kind).toBe('ok');
        expect(installLocation(`${HOME}/Applications/Kelpi.app`, access({}), HOME).kind).toBe('ok');
        expect(installLocation('/Applications/Tools/Kelpi.app', access({}), HOME).kind).toBe('ok');
    });

    it('refuses an App-Translocated copy, and says to move it to Applications', () => {
        const where = installLocation(
            '/private/var/folders/xy/T/AppTranslocation/1A2B3C/d/Kelpi.app',
            access({}),
            HOME
        );
        expect(where.kind).toBe('blocked');
        if (where.kind !== 'blocked') return;
        expect(where.reason).toBe('translocated');
        expect(where.message).toContain('App Translocation');
        expect(where.message).toContain('Applications');
    });

    it('refuses a read-only volume, naming the disk image to eject', () => {
        const where = installLocation('/Volumes/Kelpi 0.2.3/Kelpi.app', access({ '/Volumes/Kelpi 0.2.3': 'read-only' }), HOME);
        expect(where).toMatchObject({ kind: 'blocked', reason: 'read-only' });
        expect(where.kind === 'blocked' ? where.message : '').toContain('eject /Volumes/Kelpi 0.2.3');
    });

    it('refuses any read-only location, disk image or not', () => {
        expect(installLocation('/opt/ro/Kelpi.app', access({ '/opt/ro': 'read-only' }), HOME)).toMatchObject({ kind: 'blocked', reason: 'read-only' });
    });

    it('allows a writable folder outside Applications, with a note to suspect it', () => {
        const where = installLocation(`${HOME}/Downloads/Kelpi.app`, access({}), HOME);
        expect(where.kind).toBe('warn');
        expect(where.kind === 'warn' ? where.message : '').toContain(`${HOME}/Downloads`);
    });

    it('allows a folder this account cannot write, noting it may need an administrator', () => {
        const where = installLocation('/Applications/Kelpi.app', access({ '/Applications': 'denied' }), HOME);
        expect(where.kind).toBe('warn');
        expect(where.kind === 'warn' ? where.message : '').toContain('administrator');
    });

    it('logs the verdict with the path', () => {
        expect(installLocationLogLine({ kind: 'ok', bundlePath: '/Applications/Kelpi.app' })).toBe(
            'auto-update: install location /Applications/Kelpi.app (ok)'
        );
        expect(
            installLocationLogLine({ kind: 'blocked', bundlePath: '/x/AppTranslocation/y/Kelpi.app', reason: 'translocated', message: 'm' })
        ).toBe('auto-update: install location /x/AppTranslocation/y/Kelpi.app (blocked: translocated)');
    });
});

describe('the launch version line (#286)', () => {
    it('says when this launch is a new version, the same one, or the first recorded', () => {
        expect(launchVersionLogLine('0.2.2', '0.2.3')).toBe('auto-update: running 0.2.3, updated from 0.2.2');
        expect(launchVersionLogLine('0.2.3', '0.2.3')).toBe('auto-update: running 0.2.3 (as last launch)');
        expect(launchVersionLogLine('', '0.2.3')).toBe('auto-update: running 0.2.3 (no earlier launch recorded)');
        expect(launchVersionLogLine('0.2.3', '0.2.2')).toBe('auto-update: running 0.2.2, previously 0.2.3');
    });
});
