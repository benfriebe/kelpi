import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    clientUrl,
    daemonEntryCandidates,
    daemonUrl,
    readHttpPort,
    resolveDaemonEntry,
    resolveNodeBinary
} from './daemon.js';

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-daemon-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('daemonEntryCandidates', () => {
    it('lets NEXD_ENTRY win outright', () => {
        expect(
            daemonEntryCandidates({ env: { NEXD_ENTRY: '/opt/nexd.js' }, appDir: '/app', resourcesPath: '/res' })
        ).toEqual(['/opt/nexd.js']);
    });

    it('looks beside the shell package first, then the packaged Resources hook', () => {
        expect(daemonEntryCandidates({ env: {}, appDir: '/repo/packages/shell', resourcesPath: '/app/Resources' })).toEqual([
            '/repo/packages/daemon/dist/nexd.js',
            '/app/Resources/daemon/nexd.js'
        ]);
    });

    it('ignores an empty override', () => {
        expect(daemonEntryCandidates({ env: { NEXD_ENTRY: '   ' }, appDir: '/repo/packages/shell' })).toEqual([
            '/repo/packages/daemon/dist/nexd.js'
        ]);
    });
});

describe('resolveDaemonEntry', () => {
    it('returns the first candidate that exists', () => {
        const root = tempDir();
        const resources = path.join(root, 'Resources', 'daemon');
        fs.mkdirSync(resources, { recursive: true });
        fs.writeFileSync(path.join(resources, 'nexd.js'), '// bundle');
        expect(
            resolveDaemonEntry({ env: {}, appDir: path.join(root, 'shell'), resourcesPath: path.join(root, 'Resources') })
        ).toBe(path.join(resources, 'nexd.js'));
    });

    it('is undefined when nothing is on disk', () => {
        expect(resolveDaemonEntry({ env: {}, appDir: path.join(tempDir(), 'shell') })).toBeUndefined();
    });
});

describe('resolveNodeBinary', () => {
    it('honours NEXD_NODE', () => {
        expect(resolveNodeBinary({ env: { NEXD_NODE: '/usr/local/bin/node24' } })).toBe('/usr/local/bin/node24');
    });

    it('prefers a Node shipped in the app bundle', () => {
        const root = tempDir();
        const bundled = path.join(root, 'node');
        fs.writeFileSync(bundled, '#!/bin/sh\n');
        fs.chmodSync(bundled, 0o755);
        expect(resolveNodeBinary({ env: {}, resourcesPath: root })).toBe(bundled);
    });

    it('falls back to the current interpreter outside Electron', () => {
        // These tests run under plain Node, which is exactly the "not Electron" branch.
        expect(resolveNodeBinary({ env: {} })).toBe(process.execPath);
    });
});

describe('url helpers', () => {
    it('always points at loopback', () => {
        expect(daemonUrl(19_400)).toBe('http://127.0.0.1:19400');
    });

    it('hands the client its token in the query string', () => {
        expect(clientUrl({ url: 'http://127.0.0.1:8080', token: 'a b/c' })).toBe(
            'http://127.0.0.1:8080/?token=a%20b%2Fc'
        );
    });
});

describe('readHttpPort', () => {
    it('prefers the pid record, then the port file, then nothing', () => {
        const dir = tempDir();
        const paths = {
            dir,
            protocol: 1,
            socket: path.join(dir, 'daemon-v1.sock'),
            token: path.join(dir, 'daemon-v1.token'),
            pid: path.join(dir, 'daemon-v1.pid')
        };
        expect(readHttpPort(paths)).toBeUndefined();

        fs.writeFileSync(path.join(dir, 'daemon-v1.port'), '4242\n');
        expect(readHttpPort(paths)).toBe(4242);

        fs.writeFileSync(paths.pid, JSON.stringify({ pid: 123, protocol: 1, http_port: 5150 }));
        expect(readHttpPort(paths)).toBe(5150);
    });
});
