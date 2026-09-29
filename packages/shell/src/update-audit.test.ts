import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_UPDATER_ENV, auditUpdaterControlPath, createAuditInstaller, readAuditUpdaterControl } from './update-audit.js';

describe('the harness updater seam (#286)', () => {
    it('is off in a packaged app whatever the environment says, and off when unset', () => {
        expect(auditUpdaterControlPath({ [AUDIT_UPDATER_ENV]: '/tmp/control.json' }, true)).toBeNull();
        expect(auditUpdaterControlPath({}, false)).toBeNull();
        expect(auditUpdaterControlPath({ [AUDIT_UPDATER_ENV]: '  ' }, false)).toBeNull();
        expect(auditUpdaterControlPath({ [AUDIT_UPDATER_ENV]: '/tmp/control.json' }, false)).toBe('/tmp/control.json');
    });

    describe('the control file', () => {
        let dir: string | null = null;
        afterEach(() => {
            if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
            dir = null;
        });

        it('is dormant when missing or not an object, and reads only string fields', () => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-update-audit-'));
            const file = path.join(dir, 'control.json');
            expect(readAuditUpdaterControl(file)).toBeNull();
            fs.writeFileSync(file, '[1]');
            expect(readAuditUpdaterControl(file)).toBeNull();
            fs.writeFileSync(file, JSON.stringify({ feed: 'http://127.0.0.1:9', download: 'done', bundlePath: 7 }));
            expect(readAuditUpdaterControl(file)).toEqual({ feed: 'http://127.0.0.1:9', download: 'done' });
        });
    });

    describe('the stand-in installer', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('"downloads" until the control file says done, and quits without installing only when asked', async () => {
            vi.useFakeTimers();
            let download = 'pending';
            const quit = vi.fn();
            const installer = createAuditInstaller({ read: () => ({ download }), log: () => undefined, quit, pollMs: 10, quitDelayMs: 50 });
            const downloaded = vi.fn();
            installer.on('update-downloaded', downloaded);
            installer.setFeedURL({ url: 'http://127.0.0.1:9/x' });
            installer.checkForUpdates();
            await vi.advanceTimersByTimeAsync(100);
            expect(downloaded).not.toHaveBeenCalled();
            download = 'done';
            await vi.advanceTimersByTimeAsync(20);
            expect(downloaded).toHaveBeenCalledTimes(1);
            expect(quit).not.toHaveBeenCalled();
            installer.quitAndInstall();
            await vi.advanceTimersByTimeAsync(60);
            expect(quit).toHaveBeenCalledTimes(1);
        });

        it('fails with the control file\'s message', async () => {
            vi.useFakeTimers();
            const installer = createAuditInstaller({
                read: () => ({ download: 'fail: The network connection was lost.' }),
                log: () => undefined,
                quit: () => undefined,
                pollMs: 10
            });
            const failed = vi.fn();
            installer.on('error', failed);
            installer.checkForUpdates();
            await vi.advanceTimersByTimeAsync(20);
            expect(failed).toHaveBeenCalledTimes(1);
            expect((failed.mock.calls[0]?.[0] as Error).message).toBe('The network connection was lost.');
        });
    });
});
