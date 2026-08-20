/**
 * The `/usr/local/bin/nex` install and self-heal (APP-003, APP-004, APP-005).
 *
 * Every path here is under an `mkdtemp` root — including the "global" link path, which is a
 * parameter for exactly this reason. A test that used the real `/usr/local/bin/nex` would
 * replace the CLI the developer running the suite is using.
 *
 * The cases are organised around the promises the module makes rather than its functions: it
 * repairs drift, it never creates behind the user's back, it never touches an entry it cannot
 * attribute, and it reports instead of escalating when it cannot write.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_CLI_LINK_PATH,
    bundledCliLauncher,
    describeCliInstall,
    healCliSymlink,
    installCliSymlink,
    isNexManagedInstall,
    nodeCliFs,
    planCliInstall,
    resolveCliInstallMode,
    resolveCliLinkPath
} from './cli-install.js';
import { cliLauncherScript } from './packaging.js';

let root = '';
/** The "app bundle" this test's app is running from. */
let bundle = '';
let target = '';
let binDir = '';
let linkPath = '';

function makeBundle(name: string): string {
    const cliDir = path.join(root, name, 'Contents', 'Resources', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'nex.js'), '#!/usr/bin/env node\n');
    const launcher = path.join(cliDir, 'nex');
    fs.writeFileSync(launcher, cliLauncherScript({ version: '0.1.0' }), { mode: 0o755 });
    return launcher;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-cli-install-'));
    bundle = 'Nex.app';
    target = makeBundle(bundle);
    binDir = path.join(root, 'usr', 'local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    linkPath = path.join(binDir, 'nex');
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const plan = (): ReturnType<typeof planCliInstall> => planCliInstall({ linkPath, target }, nodeCliFs);
const heal = (): ReturnType<typeof healCliSymlink> => healCliSymlink({ linkPath, target }, nodeCliFs);
const install = (): ReturnType<typeof installCliSymlink> => installCliSymlink({ linkPath, target }, nodeCliFs);

describe('the launcher is what makes attribution possible', () => {
    it('carries a marker, resolves its own symlink, and prefers the bundled node', () => {
        const script = cliLauncherScript({ version: '9.9.9' });
        expect(script.startsWith('#!/bin/sh\n')).toBe(true);
        expect(script).toContain('nex-cli-launcher');
        expect(script).toContain('while [ -L "$target" ]');
        expect(script).toContain('exec "$dir/../node" "$bundle" "$@"');
        expect(script).toContain('NEX_CLI_VERSION="${NEX_CLI_VERSION:-9.9.9}"');
        expect(cliLauncherScript()).not.toContain('NEX_CLI_VERSION');
    });
});

describe('drift repair (APP-003)', () => {
    it('does nothing when the link already points at this build', () => {
        fs.symlinkSync(target, linkPath);
        expect(plan().action).toBe('ok');
        const result = heal();
        expect(result.kind).toBe('ok');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('repoints a link left behind by a previous version of this app', () => {
        const old = makeBundle('Nex-0.0.9.app');
        fs.symlinkSync(old, linkPath);
        expect(plan().action).toBe('drifted');

        const result = heal();
        expect(result.kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('adopts a DANGLING link into a bundle that has been deleted', () => {
        const ghost = path.join(root, 'Moved.app', 'Contents', 'Resources', 'cli', 'nex');
        fs.symlinkSync(ghost, linkPath);
        expect(fs.existsSync(ghost)).toBe(false);
        expect(heal().kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('adopts a dangling link from the SWIFT app layout too', () => {
        // Under `root`, not `/Applications`: on a machine where the Swift Nex is really
        // installed that link would be LIVE, which is the `foreign` case below, not this one.
        const swiftGhost = path.join(root, 'Gone.app', 'Contents', 'Helpers', 'nex');
        fs.symlinkSync(swiftGhost, linkPath);
        expect(fs.existsSync(swiftGhost)).toBe(false);
        expect(heal().kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });
});

describe('opt-in is preserved (APP-004)', () => {
    it('creates nothing when there is no global CLI at all', () => {
        expect(plan().action).toBe('absent');
        const result = heal();
        expect(result.kind).toBe('skipped');
        expect(fs.existsSync(linkPath)).toBe(false);
    });

    it('but an explicit install does create it', () => {
        const result = install();
        expect(result.kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('leaves a LIVE symlink into someone else\'s tree alone', () => {
        const homebrew = path.join(root, 'homebrew', 'Cellar', 'nex', 'bin', 'nex');
        fs.mkdirSync(path.dirname(homebrew), { recursive: true });
        fs.writeFileSync(homebrew, '#!/bin/sh\necho not us\n', { mode: 0o755 });
        fs.symlinkSync(homebrew, linkPath);

        expect(plan().action).toBe('foreign');
        expect(heal().kind).toBe('skipped');
        expect(fs.readlinkSync(linkPath)).toBe(homebrew);
        // Even an explicit install refuses rather than clobbering it.
        const explicit = install();
        expect(explicit.kind).toBe('skipped');
        expect(fs.readlinkSync(linkPath)).toBe(homebrew);
    });

    it('leaves a LIVE symlink into a Swift Nex.app alone (that app still works)', () => {
        const swift = path.join(root, 'SwiftNex.app', 'Contents', 'Helpers', 'nex');
        fs.mkdirSync(path.dirname(swift), { recursive: true });
        fs.writeFileSync(swift, 'MZ-not-really-a-binary', { mode: 0o755 });
        fs.symlinkSync(swift, linkPath);
        expect(plan().action).toBe('foreign');
        expect(fs.readlinkSync(linkPath)).toBe(swift);
    });

    it('leaves a developer\'s pin to a checkout alone', () => {
        const checkout = path.join(root, 'code', 'new_nex', 'packages', 'cli', 'dist', 'nex.js');
        fs.mkdirSync(path.dirname(checkout), { recursive: true });
        fs.writeFileSync(checkout, '#!/usr/bin/env node\n', { mode: 0o755 });
        fs.symlinkSync(checkout, linkPath);
        expect(plan().action).toBe('foreign');
    });

    it('leaves an unattributable REGULAR file alone (the conservative divergence)', () => {
        fs.writeFileSync(linkPath, 'some other nex binary', { mode: 0o755 });
        expect(isNexManagedInstall(linkPath, nodeCliFs)).toBe(false);
        expect(heal().kind).toBe('skipped');
        expect(fs.readFileSync(linkPath, 'utf8')).toBe('some other nex binary');
    });

    it('but DOES replace a copy of our own launcher (marker in the file)', () => {
        fs.writeFileSync(linkPath, cliLauncherScript({ version: '0.0.1' }), { mode: 0o755 });
        expect(isNexManagedInstall(linkPath, nodeCliFs)).toBe(true);
        expect(heal().kind).toBe('linked');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it('does nothing at all when this build has no CLI payload', () => {
        const result = healCliSymlink({ linkPath, target: path.join(root, 'nothing', 'nex') }, nodeCliFs);
        expect(result.kind).toBe('skipped');
        expect(result.plan.action).toBe('unavailable');
        expect(installCliSymlink({ linkPath, target: '' }, nodeCliFs).kind).toBe('skipped');
    });
});

describe('when it cannot write (APP-005)', () => {
    it('reports the manual command instead of escalating', () => {
        const old = makeBundle('Nex-0.0.9.app');
        fs.symlinkSync(old, linkPath);
        fs.chmodSync(binDir, 0o500);
        try {
            const result = heal();
            expect(result.kind).toBe('blocked');
            expect(result.plan.manualCommand).toBe(`sudo ln -sfn ${target} ${linkPath}`);
            expect(describeCliInstall(result)).toContain('run by hand: sudo ln -sfn');
            // Untouched: the old link is still there, pointing where it was.
            expect(fs.readlinkSync(linkPath)).toBe(old);
        } finally {
            fs.chmodSync(binDir, 0o700);
        }
    });

    it('never contains a sudo that would be RUN — only one to print', () => {
        fs.symlinkSync(makeBundle('Old.app'), linkPath);
        const result = heal();
        expect(result.plan.manualCommand.startsWith('sudo ')).toBe(true);
        expect(result.kind).toBe('linked'); // the writable case never needed it
    });
});

describe('launch policy', () => {
    const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { NEX_CLI_INSTALL: value });

    it('is off outside a packaged app — a checkout is not something to symlink', () => {
        expect(resolveCliInstallMode({ env: env(), isPackaged: false, alreadyPrompted: false })).toBe('off');
    });

    it('offers once, then only heals', () => {
        expect(resolveCliInstallMode({ env: env(), isPackaged: true, alreadyPrompted: false })).toBe('prompt');
        expect(resolveCliInstallMode({ env: env(), isPackaged: true, alreadyPrompted: true })).toBe('heal');
    });

    it('honours NEX_CLI_INSTALL, including from an unpackaged run (what the smokes set)', () => {
        expect(resolveCliInstallMode({ env: env('off'), isPackaged: true, alreadyPrompted: false })).toBe('off');
        expect(resolveCliInstallMode({ env: env('AUTO'), isPackaged: false, alreadyPrompted: true })).toBe('auto');
        expect(resolveCliInstallMode({ env: env(' heal '), isPackaged: false, alreadyPrompted: false })).toBe('heal');
        // Unrecognised values fall back to the default rather than doing something surprising.
        expect(resolveCliInstallMode({ env: env('yes please'), isPackaged: true, alreadyPrompted: true })).toBe('heal');
    });
});

describe('the link path', () => {
    it('is the one the Swift installer and `nex install-hooks --link` use', () => {
        expect(DEFAULT_CLI_LINK_PATH).toBe('/usr/local/bin/nex');
        expect(resolveCliLinkPath({})).toBe(DEFAULT_CLI_LINK_PATH);
        expect(resolveCliLinkPath({ NEX_CLI_LINK_PATH: '   ' })).toBe(DEFAULT_CLI_LINK_PATH);
    });

    it('can be aimed inside a sandbox, which is how the packaged smoke tests the heal', () => {
        expect(resolveCliLinkPath({ NEX_CLI_LINK_PATH: '/tmp/box/bin/nex' })).toBe('/tmp/box/bin/nex');
    });
});

describe('bundledCliLauncher', () => {
    it('answers with the launcher only when the payload is really there', () => {
        const resources = path.join(root, bundle, 'Contents', 'Resources');
        expect(bundledCliLauncher(resources)).toBe(target);
        expect(bundledCliLauncher(path.join(root, 'empty'))).toBe('');
        expect(bundledCliLauncher(undefined)).toBe('');
    });
});
