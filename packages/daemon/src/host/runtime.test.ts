import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    HOST_BUNDLE_NAME,
    isPackagedDir,
    leaseRuntime,
    prepareHostRuntime,
    pruneRuntimeCopies,
    releaseRuntime
} from './runtime.js';

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeDaemonDir(packaged: boolean): { root: string; daemonDir: string; dataRoot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kth-rt-'));
    roots.push(root);
    const daemonDir = packaged ? path.join(root, 'Kelpi.app', 'Contents', 'Resources', 'daemon') : path.join(root, 'dist');
    const helperDir = path.join(daemonDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, HOST_BUNDLE_NAME), 'host v1');
    fs.writeFileSync(path.join(daemonDir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(helperDir, 'spawn-helper'), 'helper', { mode: 0o644 });
    fs.writeFileSync(path.join(helperDir, 'pty.node'), 'native');
    return { root, daemonDir, dataRoot: path.join(root, 'state', 'terminal-host') };
}

describe('the terminal host runtime', () => {
    it('recognises a daemon inside an app bundle', () => {
        expect(isPackagedDir('/Applications/Kelpi.app/Contents/Resources/daemon')).toBe(true);
        expect(isPackagedDir('/Users/me/code/kelpi/packages/daemon/dist')).toBe(false);
    });

    it('launches a development host in place', () => {
        const { daemonDir, dataRoot } = fakeDaemonDir(false);
        expect(prepareHostRuntime({ daemonDir, dataRoot })).toEqual({
            entry: path.join(daemonDir, HOST_BUNDLE_NAME),
            runtimeDir: daemonDir,
            copied: false
        });
        expect(fs.existsSync(dataRoot)).toBe(false);
    });

    it('copies a packaged runtime out of the bundle, executable, once per content', () => {
        const { daemonDir, dataRoot } = fakeDaemonDir(true);
        const first = prepareHostRuntime({ daemonDir, dataRoot });
        expect(first.copied).toBe(true);
        expect(path.dirname(first.runtimeDir)).toBe(dataRoot);
        expect(fs.readFileSync(first.entry, 'utf8')).toBe('host v1');
        const helper = path.join(first.runtimeDir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
        expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
        expect(prepareHostRuntime({ daemonDir, dataRoot }).runtimeDir).toBe(first.runtimeDir);

        // An update changes the content, so the new version gets its own copy beside the old.
        fs.writeFileSync(path.join(daemonDir, HOST_BUNDLE_NAME), 'host v2');
        const second = prepareHostRuntime({ daemonDir, dataRoot });
        expect(second.runtimeDir).not.toBe(first.runtimeDir);
        expect(fs.existsSync(first.runtimeDir)).toBe(true);
    });

    it('prunes old copies but never a leased one', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kth-prune-'));
        roots.push(root);
        const copies = Array.from({ length: 6 }, (_, i) => {
            const dir = path.join(root, `${String(i).repeat(16)}`.slice(0, 16));
            fs.mkdirSync(dir);
            const time = new Date(Date.UTC(2026, 0, 1 + i));
            fs.utimesSync(dir, time, time);
            return dir;
        });
        const lease = leaseRuntime(copies[0]!); // the oldest, but a live host runs from it
        fs.utimesSync(copies[0]!, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
        pruneRuntimeCopies(root, [copies[5]]);
        const left = fs.readdirSync(root).sort();
        // Kept: the named one (5), the three newest after it (4, 3, 2), and the leased one (0).
        expect(left).toEqual(['0000000000000000', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555']);
        releaseRuntime(lease);
        // Removing the lease touched the directory; put its age back.
        fs.utimesSync(copies[0]!, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
        pruneRuntimeCopies(root, [copies[5]]);
        expect(fs.readdirSync(root)).not.toContain('0000000000000000');
    });
});
