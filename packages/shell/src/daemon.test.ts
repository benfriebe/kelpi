import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    CLIENT_DIR_ENV,
    clientUrl,
    daemonEntryCandidates,
    daemonSpawnEnv,
    daemonUrl,
    HELPERS_DIR_ENV,
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

describe('daemonSpawnEnv', () => {
    /** A packaged `Contents/Resources` with a client build in it. */
    function resourcesWithClient(): string {
        const resources = tempDir();
        fs.mkdirSync(path.join(resources, 'client'), { recursive: true });
        fs.writeFileSync(path.join(resources, 'client', 'index.html'), '<!doctype html>');
        return resources;
    }

    it('tells a daemon it starts where the bundled client build is', () => {
        const resources = resourcesWithClient();
        expect(daemonSpawnEnv({ PATH: '/usr/bin' }, { resourcesPath: resources })).toEqual({
            PATH: '/usr/bin',
            [CLIENT_DIR_ENV]: path.join(resources, 'client')
        });
    });

    it('leaves an explicit NEXD_CLIENT_DIR alone — that is how a dev points at a vite build', () => {
        const resources = resourcesWithClient();
        const env = { [CLIENT_DIR_ENV]: '/work/client/dist' };
        expect(daemonSpawnEnv(env, { resourcesPath: resources })).toBe(env);
    });

    it('adds nothing in a development run (there is no Resources directory)', () => {
        const env = { PATH: '/usr/bin' };
        expect(daemonSpawnEnv(env, {})).toBe(env);
        expect(daemonSpawnEnv(env, { resourcesPath: '' })).toBe(env);
    });

    it('would rather say nothing than point the daemon at an empty directory', () => {
        // The daemon's own "client not built" page is a better answer than a configured
        // directory with no index.html in it.
        const resources = tempDir();
        const env = { PATH: '/usr/bin' };
        expect(daemonSpawnEnv(env, { resourcesPath: resources })).toBe(env);
        fs.mkdirSync(path.join(resources, 'client'));
        expect(daemonSpawnEnv(env, { resourcesPath: resources })).toBe(env);
    });

    /** A packaged `Contents/Resources` with a CLI payload (the `nex` launcher) in it. */
    function addCliPayload(resources: string): string {
        fs.mkdirSync(path.join(resources, 'cli'), { recursive: true });
        fs.writeFileSync(path.join(resources, 'cli', 'nex'), '#!/bin/sh\n');
        return path.join(resources, 'cli');
    }

    it('tells a daemon it starts where the bundled nex CLI is (pane PATH routing)', () => {
        const resources = resourcesWithClient();
        const cliDir = addCliPayload(resources);
        expect(daemonSpawnEnv({ PATH: '/usr/bin' }, { resourcesPath: resources })).toEqual({
            PATH: '/usr/bin',
            [CLIENT_DIR_ENV]: path.join(resources, 'client'),
            [HELPERS_DIR_ENV]: cliDir
        });
    });

    it('leaves an explicit NEXD_HELPERS_DIR alone', () => {
        const resources = resourcesWithClient();
        addCliPayload(resources);
        const env = { [CLIENT_DIR_ENV]: '/work/client/dist', [HELPERS_DIR_ENV]: '/work/cli' };
        expect(daemonSpawnEnv(env, { resourcesPath: resources })).toBe(env);
    });

    it('adds no helpers dir when the build carries no CLI payload', () => {
        const resources = resourcesWithClient();
        const spawnEnv = daemonSpawnEnv({ PATH: '/usr/bin' }, { resourcesPath: resources });
        expect(spawnEnv[HELPERS_DIR_ENV]).toBeUndefined();
        expect(spawnEnv[CLIENT_DIR_ENV]).toBe(path.join(resources, 'client'));
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
