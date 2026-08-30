/**
 * `--link` and the command resolution behind it (CLI-143, CLI-144).
 *
 * The install directory is always a temp path here. `/usr/local/bin` is a real directory on the
 * machine running this suite and it very likely holds a real `kelpi`; a test that used the default
 * would replace the developer's own CLI with a symlink into a checkout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeInstallFs, type InstallFs } from './fs.js';
import { DEFAULT_INSTALL_DIR, directoryOnPath, linkCli } from './link.js';
import { findSelfOnPath, resolveHookCommand, resolveSelfExecutable, shellQuote } from './self.js';

let root = '';
let installDir = '';
let target = '';

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-link-'));
    installDir = path.join(root, 'bin');
    target = path.join(root, 'app', 'kelpi.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/usr/bin/env node\n', { mode: 0o755 });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('directoryOnPath', () => {
    it('compares entries, ignoring a trailing slash', () => {
        expect(directoryOnPath('/usr/local/bin', '/bin:/usr/local/bin:/opt')).toBe(true);
        expect(directoryOnPath('/usr/local/bin/', '/usr/local/bin')).toBe(true);
        expect(directoryOnPath('/usr/local/bin', '/bin:/usr/bin')).toBe(false);
        expect(directoryOnPath('/usr/local/bin', undefined)).toBe(false);
        // Not a prefix match: /usr/local/binaries must not read as /usr/local/bin.
        expect(directoryOnPath('/usr/local/bin', '/usr/local/binaries')).toBe(false);
    });
});

describe('linkCli', () => {
    it('creates the directory and a symlink (never a copy)', () => {
        const result = linkCli({ installDir, target, pathValue: installDir, dryRun: false }, nodeInstallFs);
        expect(result).toMatchObject({ ok: true, action: 'linked', onPath: true });
        expect(fs.lstatSync(result.path).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(result.path)).toBe(target);
    });

    it('is idempotent and reports `unchanged` the second time', () => {
        linkCli({ installDir, target, dryRun: false }, nodeInstallFs);
        const again = linkCli({ installDir, target, dryRun: false }, nodeInstallFs);
        expect(again.action).toBe('unchanged');
        expect(fs.readlinkSync(again.path)).toBe(target);
    });

    it('repairs a symlink that points somewhere else (the post-update drift case)', () => {
        fs.mkdirSync(installDir, { recursive: true });
        fs.symlinkSync(path.join(root, 'old', 'kelpi.js'), path.join(installDir, 'kelpi'));
        const result = linkCli({ installDir, target, dryRun: false }, nodeInstallFs);
        expect(result.action).toBe('linked');
        expect(fs.readlinkSync(result.path)).toBe(target);
    });

    it('replaces a stale REGULAR file (the pre-April `cp` install)', () => {
        fs.mkdirSync(installDir, { recursive: true });
        fs.writeFileSync(path.join(installDir, 'kelpi'), 'stale copy');
        const result = linkCli({ installDir, target, dryRun: false }, nodeInstallFs);
        expect(result.action).toBe('linked');
        expect(fs.lstatSync(result.path).isSymbolicLink()).toBe(true);
    });

    it('warns (via onPath) when the install directory is not on PATH', () => {
        const result = linkCli({ installDir, target, pathValue: '/usr/bin:/bin', dryRun: false }, nodeInstallFs);
        expect(result.ok).toBe(true);
        expect(result.onPath).toBe(false);
    });

    it('writes nothing on a dry run but reports the plan', () => {
        const result = linkCli({ installDir, target, dryRun: true }, nodeInstallFs);
        expect(result.action).toBe('would-link');
        expect(fs.existsSync(installDir)).toBe(false);
    });

    it('never sudos: an unwritable directory returns the manual command instead', () => {
        fs.mkdirSync(installDir, { recursive: true });
        fs.chmodSync(installDir, 0o500);
        try {
            const result = linkCli({ installDir, target, dryRun: false }, nodeInstallFs);
            expect(result.ok).toBe(false);
            expect(result.action).toBe('failed');
            expect(result.reason).toContain('not writable');
            expect(result.manualCommand).toBe(
                `sudo mkdir -p ${installDir} && sudo ln -sfn ${target} ${path.join(installDir, 'kelpi')}`
            );
            expect(fs.existsSync(path.join(installDir, 'kelpi'))).toBe(false);
        } finally {
            fs.chmodSync(installDir, 0o700);
        }
    });

    it('defaults to /usr/local/bin, the same directory the shell installer used', () => {
        expect(DEFAULT_INSTALL_DIR).toBe('/usr/local/bin');
    });
});

describe('resolving what the hooks should invoke', () => {
    it('quotes only what needs quoting', () => {
        expect(shellQuote('/usr/local/bin/kelpi')).toBe('/usr/local/bin/kelpi');
        expect(shellQuote('/Users/a b/kelpi.js')).toBe("'/Users/a b/kelpi.js'");
        expect(shellQuote("/tmp/it's/kelpi")).toBe("'/tmp/it'\\''s/kelpi'");
    });

    it('resolves argv[1] through symlinks', () => {
        const link = path.join(root, 'link-to-kelpi');
        fs.symlinkSync(target, link);
        expect(resolveSelfExecutable(['node', link], nodeInstallFs)).toBe(fs.realpathSync(target));
    });

    it('finds itself on PATH through a symlink', () => {
        fs.mkdirSync(installDir, { recursive: true });
        fs.symlinkSync(target, path.join(installDir, 'kelpi'));
        const self = fs.realpathSync(target);
        expect(findSelfOnPath(self, `/nowhere:${installDir}`, nodeInstallFs)).toBe(installDir);
        expect(findSelfOnPath(self, '/nowhere', nodeInstallFs)).toBeNull();
    });

    it('accepts a launcher SIBLING on PATH (the packaged-app shape)', () => {
        // /usr/local/bin/kelpi -> Resources/cli/kelpi (a launcher), which execs Resources/cli/kelpi.js.
        const cliDir = path.join(root, 'Resources', 'cli');
        fs.mkdirSync(cliDir, { recursive: true });
        const bundle = path.join(cliDir, 'kelpi.js');
        const launcher = path.join(cliDir, 'kelpi');
        fs.writeFileSync(bundle, '');
        fs.writeFileSync(launcher, '', { mode: 0o755 });
        fs.mkdirSync(installDir, { recursive: true });
        fs.symlinkSync(launcher, path.join(installDir, 'kelpi'));

        expect(findSelfOnPath(fs.realpathSync(bundle), installDir, nodeInstallFs)).toBe(installDir);
    });

    it('prefers the bare `kelpi` when PATH resolves to us, else the absolute path', () => {
        fs.mkdirSync(installDir, { recursive: true });
        fs.symlinkSync(target, path.join(installDir, 'kelpi'));

        const onPath = resolveHookCommand({ argv: ['node', target], pathValue: installDir }, nodeInstallFs);
        expect(onPath).toMatchObject({ command: 'kelpi', onPath: true, pathEntry: installDir });

        const offPath = resolveHookCommand({ argv: ['node', target], pathValue: '/usr/bin' }, nodeInstallFs);
        expect(offPath).toMatchObject({ command: fs.realpathSync(target), onPath: false });
    });

    it('honours an explicit --command over everything', () => {
        const resolved = resolveHookCommand(
            { override: '  /opt/kelpi  ', argv: ['node', target], pathValue: '/usr/bin' },
            nodeInstallFs
        );
        expect(resolved.command).toBe('/opt/kelpi');
    });

    it('falls back to the bare `kelpi` when it cannot see its own path at all', () => {
        const blind: InstallFs = { ...nodeInstallFs, realPath: () => null, exists: () => false };
        expect(resolveHookCommand({ argv: ['node'], pathValue: '' }, blind)).toMatchObject({
            executable: null,
            command: 'kelpi'
        });
    });
});
