/**
 * The `/usr/local/bin/kelpi` install and self-heal (APP-003, APP-004, APP-005).
 *
 * Every path here is under an `mkdtemp` root — including the "global" link path, which is a
 * parameter for exactly this reason. A test that used the real `/usr/local/bin/kelpi` would
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
    CLI_MARKER_SCAN_LIMIT,
    DEFAULT_CLI_LINK_PATH,
    SWIFT_CLI_MARKERS,
    bundledCliLauncher,
    carriesCompiledCliMarkers,
    describeCliInstall,
    healCliSymlink,
    installCliSymlink,
    isKelpiManagedInstall,
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
    fs.writeFileSync(path.join(cliDir, 'kelpi.js'), '#!/usr/bin/env node\n');
    const launcher = path.join(cliDir, 'kelpi');
    fs.writeFileSync(launcher, cliLauncherScript({ version: '0.1.0' }), { mode: 0o755 });
    return launcher;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cli-install-'));
    bundle = 'Kelpi.app';
    target = makeBundle(bundle);
    binDir = path.join(root, 'usr', 'local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    linkPath = path.join(binDir, 'kelpi');
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
        expect(script).toContain('KELPI_CLI_VERSION="${KELPI_CLI_VERSION:-9.9.9}"');
        expect(cliLauncherScript()).not.toContain('KELPI_CLI_VERSION');
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
        const old = makeBundle('Kelpi-0.0.9.app');
        fs.symlinkSync(old, linkPath);
        expect(plan().action).toBe('drifted');

        const result = heal();
        expect(result.kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('adopts a DANGLING link into a bundle that has been deleted', () => {
        const ghost = path.join(root, 'Moved.app', 'Contents', 'Resources', 'cli', 'kelpi');
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
        const homebrew = path.join(root, 'homebrew', 'Cellar', 'kelpi', 'bin', 'kelpi');
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
        const checkout = path.join(root, 'code', 'new_nex', 'packages', 'cli', 'dist', 'kelpi.js');
        fs.mkdirSync(path.dirname(checkout), { recursive: true });
        fs.writeFileSync(checkout, '#!/usr/bin/env node\n', { mode: 0o755 });
        fs.symlinkSync(checkout, linkPath);
        expect(plan().action).toBe('foreign');
    });

    it('leaves an unattributable REGULAR file alone (the conservative divergence)', () => {
        fs.writeFileSync(linkPath, 'some other kelpi binary', { mode: 0o755 });
        expect(isKelpiManagedInstall(linkPath, nodeCliFs)).toBe(false);
        expect(heal().kind).toBe('skipped');
        expect(fs.readFileSync(linkPath, 'utf8')).toBe('some other kelpi binary');
    });

    it('but DOES replace a copy of our own launcher (marker in the file)', () => {
        fs.writeFileSync(linkPath, cliLauncherScript({ version: '0.0.1' }), { mode: 0o755 });
        expect(isKelpiManagedInstall(linkPath, nodeCliFs)).toBe(true);
        expect(heal().kind).toBe('linked');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it('does nothing at all when this build has no CLI payload', () => {
        const result = healCliSymlink({ linkPath, target: path.join(root, 'nothing', 'kelpi') }, nodeCliFs);
        expect(result.kind).toBe('skipped');
        expect(result.plan.action).toBe('unavailable');
        expect(installCliSymlink({ linkPath, target: '' }, nodeCliFs).kind).toBe('skipped');
    });
});

/**
 * The pre-April-2025 `cp` installer's leftover: a compiled Swift `nex` sitting at the link path
 * as a REGULAR file. The Swift asked a Team-ID signature; this port asks for two embedded
 * strings and a Mach-O magic, which is a heuristic and is tested as one — most of the cases
 * below are about what it must NOT adopt.
 *
 * Fixtures are files, never processes: nothing here (and nothing in the module) executes a
 * candidate. The shipped-binary case proves that in the strongest available way — the copy is
 * mode 0o600, so a code path that tried to run it could not have succeeded.
 */
describe('a compiled CLI left by the old `cp` installer (APP-004)', () => {
    const SHIPPED_CLI = '/Applications/Nex.app/Contents/Helpers/nex';

    /** A Mach-O-shaped fixture carrying exactly the strings a case wants to test. */
    function machOFixture(name: string, strings: readonly string[]): string {
        const file = path.join(root, name);
        const magic = Buffer.alloc(4);
        // MH_MAGIC_64. A real thin arm64 binary starts `cf fa ed fe` and a universal one
        // `ca fe ba be`; all three are in the module's magic list, and `/bin/ls` below is a
        // genuine one of the latter.
        magic.writeUInt32BE(0xfeedfacf, 0);
        const body = Buffer.from(`${strings.join('\0')}\0`, 'latin1');
        // Padded so the needles are NOT in the first bytes: `readHead`'s 4 KiB must not be what
        // finds them, or this would pass for the wrong reason.
        fs.writeFileSync(file, Buffer.concat([magic, Buffer.alloc(200_000), body]), { mode: 0o755 });
        return file;
    }

    it('names two markers that are in the shipped binary AND in the CLI’s first version', () => {
        // Pinning the constant: `cli-install.ts`'s note and the checklist item both quote these,
        // and a silent edit here would make both of them lies.
        expect([...SWIFT_CLI_MARKERS]).toEqual(['NEX_PANE_ID', 'Usage: nex ']);
    });

    it('attributes a real shipped CLI binary and heals it into a symlink', () => {
        if (!fs.existsSync(SHIPPED_CLI)) {
            // No Kelpi.app on this machine — the synthetic Mach-O cases below carry the logic;
            // this one is the reality check, and it is honest about not having run.
            expect(fs.existsSync(SHIPPED_CLI)).toBe(false);
            return;
        }
        fs.writeFileSync(linkPath, fs.readFileSync(SHIPPED_CLI), { mode: 0o600 });
        expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(true);
        expect(isKelpiManagedInstall(linkPath, nodeCliFs)).toBe(true);
        expect(plan().action).toBe('drifted');
        expect(heal().kind).toBe('linked');
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('attributes a Mach-O carrying BOTH markers, wherever in the file they sit', () => {
        fs.copyFileSync(machOFixture('compiled-nex', ['NEX_PANE_ID', 'Usage: nex pane split [...]']), linkPath);
        expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(true);
        expect(heal().kind).toBe('linked');
        expect(fs.readlinkSync(linkPath)).toBe(target);
    });

    it('refuses a Mach-O carrying only ONE of them', () => {
        for (const only of ['NEX_PANE_ID', 'Usage: nex event stop']) {
            fs.rmSync(linkPath, { force: true });
            fs.copyFileSync(machOFixture(`half-${only.slice(0, 5)}`, [only]), linkPath);
            expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(false);
            expect(isKelpiManagedInstall(linkPath, nodeCliFs)).toBe(false);
            expect(plan().action).toBe('foreign');
            expect(heal().kind).toBe('skipped');
            expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
        }
    });

    it('refuses a real, unrelated Mach-O binary (the decoy: /bin/ls)', () => {
        fs.copyFileSync('/bin/ls', linkPath);
        const before = fs.readFileSync(linkPath);
        expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(false);
        expect(heal().kind).toBe('skipped');
        expect(fs.readFileSync(linkPath).equals(before)).toBe(true);
    });

    it('refuses a SCRIPT that merely mentions both markers — the magic is part of the check', () => {
        fs.writeFileSync(linkPath, '#!/bin/sh\n# Usage: nex … reads NEX_PANE_ID\nexec other-nex "$@"\n', {
            mode: 0o755
        });
        expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(false);
        expect(isKelpiManagedInstall(linkPath, nodeCliFs)).toBe(false);
        expect(heal().kind).toBe('skipped');
        expect(fs.readFileSync(linkPath, 'utf8')).toContain('exec other-nex');
    });

    it('refuses an empty or unreadable file rather than throwing', () => {
        fs.writeFileSync(linkPath, '');
        expect(carriesCompiledCliMarkers(linkPath, nodeCliFs)).toBe(false);
        expect(carriesCompiledCliMarkers(path.join(root, 'no-such-file'), nodeCliFs)).toBe(false);
        expect(heal().kind).toBe('skipped');
    });

    it('reads at most the scan limit, so a huge file at the link path is not swallowed whole', () => {
        expect(CLI_MARKER_SCAN_LIMIT).toBe(16 * 1024 * 1024);
        const seen: number[] = [];
        const probe = {
            ...nodeCliFs,
            readBytes(file: string, maxBytes: number): Buffer | null {
                seen.push(maxBytes);
                return nodeCliFs.readBytes(file, maxBytes);
            }
        };
        fs.copyFileSync(machOFixture('scan-limit', ['NEX_PANE_ID', 'Usage: nex ']), linkPath);
        expect(carriesCompiledCliMarkers(linkPath, probe)).toBe(true);
        expect(seen).toEqual([CLI_MARKER_SCAN_LIMIT]);
    });
});

describe('when it cannot write (APP-005)', () => {
    it('reports the manual command instead of escalating', () => {
        const old = makeBundle('Kelpi-0.0.9.app');
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
    const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { KELPI_CLI_INSTALL: value });

    it('is off outside a packaged app — a checkout is not something to symlink', () => {
        expect(resolveCliInstallMode({ env: env(), isPackaged: false, alreadyPrompted: false })).toBe('off');
    });

    it('offers once, then only heals', () => {
        expect(resolveCliInstallMode({ env: env(), isPackaged: true, alreadyPrompted: false })).toBe('prompt');
        expect(resolveCliInstallMode({ env: env(), isPackaged: true, alreadyPrompted: true })).toBe('heal');
    });

    it('honours KELPI_CLI_INSTALL, including from an unpackaged run (what the smokes set)', () => {
        expect(resolveCliInstallMode({ env: env('off'), isPackaged: true, alreadyPrompted: false })).toBe('off');
        expect(resolveCliInstallMode({ env: env('AUTO'), isPackaged: false, alreadyPrompted: true })).toBe('auto');
        expect(resolveCliInstallMode({ env: env(' heal '), isPackaged: false, alreadyPrompted: false })).toBe('heal');
        // Unrecognised values fall back to the default rather than doing something surprising.
        expect(resolveCliInstallMode({ env: env('yes please'), isPackaged: true, alreadyPrompted: true })).toBe('heal');
    });
});

describe('the link path', () => {
    it('is the one the Swift installer and `kelpi install-hooks --link` use', () => {
        expect(DEFAULT_CLI_LINK_PATH).toBe('/usr/local/bin/kelpi');
        expect(resolveCliLinkPath({})).toBe(DEFAULT_CLI_LINK_PATH);
        expect(resolveCliLinkPath({ KELPI_CLI_LINK_PATH: '   ' })).toBe(DEFAULT_CLI_LINK_PATH);
    });

    it('can be aimed inside a sandbox, which is how the packaged smoke tests the heal', () => {
        expect(resolveCliLinkPath({ KELPI_CLI_LINK_PATH: '/tmp/box/bin/kelpi' })).toBe('/tmp/box/bin/kelpi');
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
