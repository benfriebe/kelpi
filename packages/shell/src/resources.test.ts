import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    RESOURCE_NAMES,
    hasClientBuild,
    hasDaemonPayload,
    packagedClientDir,
    packagedDaemonEntry,
    packagedNodeBinary
} from './resources.js';

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-shell-resources-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('the packaged Resources layout', () => {
    it('is the one forge.config.cjs stages and daemon.ts reads', () => {
        expect(packagedDaemonEntry('/A/Contents/Resources')).toBe('/A/Contents/Resources/daemon/nexd.js');
        expect(packagedClientDir('/A/Contents/Resources')).toBe('/A/Contents/Resources/client');
        expect(packagedNodeBinary('/A/Contents/Resources')).toBe('/A/Contents/Resources/node');
    });

    it('names each entry exactly once, so the Forge config has one thing to copy', () => {
        expect([RESOURCE_NAMES.daemon, RESOURCE_NAMES.client, RESOURCE_NAMES.node]).toEqual([
            'daemon',
            'client',
            'node'
        ]);
    });
});

describe('hasClientBuild', () => {
    it('requires an index.html to serve', () => {
        const dir = tempDir();
        expect(hasClientBuild(dir)).toBe(false);
        fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
        expect(hasClientBuild(dir)).toBe(true);
    });

    it('is false for a directory instead of a file, and for nothing at all', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'index.html'));
        expect(hasClientBuild(dir)).toBe(false);
        expect(hasClientBuild(path.join(dir, 'missing'))).toBe(false);
        expect(hasClientBuild(undefined)).toBe(false);
        expect(hasClientBuild('')).toBe(false);
    });
});

describe('hasDaemonPayload', () => {
    it('is true only once the entry script is actually there', () => {
        const resources = tempDir();
        expect(hasDaemonPayload(resources)).toBe(false);
        fs.mkdirSync(path.join(resources, 'daemon'));
        expect(hasDaemonPayload(resources)).toBe(false);
        fs.writeFileSync(packagedDaemonEntry(resources), '// bundle');
        expect(hasDaemonPayload(resources)).toBe(true);
    });

    it('handles the un-packaged case (no resourcesPath at all)', () => {
        expect(hasDaemonPayload(undefined)).toBe(false);
        expect(hasDaemonPayload('')).toBe(false);
    });
});
