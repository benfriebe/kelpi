import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    APP_ENTITLEMENTS,
    APP_ICON_TILE_SPAN,
    ESM_SCOPE_PACKAGE_JSON,
    ICNS_VARIANTS,
    MINIMUM_NODE_MAJOR,
    NODE_ENTITLEMENTS,
    PACKAGED_APP_FILES,
    RESOURCE_NAMES,
    SPAWN_HELPER_ENTITLEMENTS,
    STAGED_RESOURCE_NAMES,
    adhocSignCommands,
    adhocSignRequired,
    appIconPixels,
    appIconPng,
    buildAppIcns,
    cookieEncryptionFuseEnabled,
    encodeIcns,
    isMachOHeader,
    isSignedBuild,
    nodeRuntimeIssues,
    notarizeOptions,
    packagedAppIgnore,
    readFileHeader,
    signIgnore,
    signOptionsForFile
} from './packaging.js';
import { CLI_BUNDLE_NAME } from './resources.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('packagedAppIgnore', () => {
    it('keeps the bundle, its map and package.json', () => {
        for (const kept of PACKAGED_APP_FILES) expect(packagedAppIgnore(kept)).toBe(false);
    });

    it('walks into the directories on the way to a kept file', () => {
        // @electron/packager asks about every path; answering "ignore" for `/dist` would
        // prune the whole subtree and ship an app with no main script.
        expect(packagedAppIgnore('')).toBe(false);
        expect(packagedAppIgnore('/')).toBe(false);
        expect(packagedAppIgnore('/dist')).toBe(false);
    });

    it('is an allowlist: anything else stays out', () => {
        for (const file of [
            '/node_modules',
            '/node_modules/electron/dist/Electron.app',
            '/src',
            '/src/main.ts',
            '/scripts/bundle.mjs',
            '/forge.config.cjs',
            '/out/staging/node',
            '/dist/packaging.cjs', // a build-tool artifact, not part of the app
            '/dist/main.js.LEGAL.txt',
            '/README.md',
            '/.npmrc',
            '/tsconfig.json'
        ]) {
            expect(packagedAppIgnore(file), file).toBe(true);
        }
    });

    it('does not confuse a prefix with a path segment', () => {
        expect(packagedAppIgnore('/dist-extra')).toBe(true);
        expect(packagedAppIgnore('/package.json.bak')).toBe(true);
    });
});

describe('nodeRuntimeIssues', () => {
    it('accepts a Node 24 build matching the target arch', () => {
        expect(nodeRuntimeIssues({ version: '24.15.0', arch: 'arm64' }, 'arm64')).toEqual([]);
        expect(nodeRuntimeIssues({ version: '25.0.0-nightly', arch: 'arm64' }, 'arm64')).toEqual([]);
    });

    it('rejects an older Node than the daemon is built for', () => {
        expect(nodeRuntimeIssues({ version: '22.11.0', arch: 'arm64' }, 'arm64')).toEqual([
            `Node 22.11.0 is older than the required ${String(MINIMUM_NODE_MAJOR)}.x`
        ]);
    });

    it('rejects a cross-arch binary — the failure it exists to prevent', () => {
        // An x64 Node in an arm64 bundle runs under Rosetta and then cannot dlopen the
        // arm64 pty.node, which surfaces as a broken app rather than a broken build.
        expect(nodeRuntimeIssues({ version: '24.15.0', arch: 'x64' }, 'arm64')).toEqual([
            'Node is x64 but the app is being packaged for arm64'
        ]);
    });

    it('reports both problems at once, and an unreadable version', () => {
        expect(nodeRuntimeIssues({ version: '20.1.0', arch: 'x64' }, 'arm64')).toHaveLength(2);
        expect(nodeRuntimeIssues({ version: 'not-a-version', arch: 'arm64' }, 'arm64')[0]).toMatch(
            /could not read a Node version/
        );
    });
});

describe('the app icon', () => {
    it('renders a square canvas of the requested size', () => {
        const canvas = appIconPixels(64);
        expect(canvas.width).toBe(64);
        expect(canvas.height).toBe(64);
        expect(canvas.rgba.length).toBe(64 * 64 * 4);
    });

    it('rejects a nonsensical size rather than allocating something absurd', () => {
        expect(() => appIconPixels(0)).toThrow(/bad size/);
        expect(() => appIconPixels(-8)).toThrow(/bad size/);
        expect(() => appIconPixels(12.5)).toThrow(/bad size/);
    });

    it('leaves the corners transparent and the middle opaque (it is a rounded tile)', () => {
        const canvas = appIconPixels(128);
        const alphaAt = (x: number, y: number): number => canvas.rgba[(y * canvas.width + x) * 4 + 3] as number;
        expect(alphaAt(0, 0)).toBe(0);
        expect(alphaAt(127, 0)).toBe(0);
        expect(alphaAt(64, 64)).toBe(255);
    });

    it('paints the kelpie line art, not a flat tile', () => {
        const canvas = appIconPixels(256);
        const colours = new Set<string>();
        let white = 0;
        for (let index = 0; index < canvas.rgba.length; index += 4) {
            colours.add(`${String(canvas.rgba[index])},${String(canvas.rgba[index + 1])},${String(canvas.rgba[index + 2])}`);
            if ((canvas.rgba[index] as number) >= 250 && (canvas.rgba[index + 2] as number) >= 250) white += 1;
        }
        // Anti-aliased strokes over a gradient produce many shades; the stroke cores stay white.
        expect(colours.size).toBeGreaterThan(20);
        expect(white).toBeGreaterThan(500);
    });

    it('encodes to a PNG', () => {
        expect(appIconPng(32).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('sits on the macOS icon grid rather than filling the canvas (#5)', () => {
        // A full-bleed macOS icon shape is 824 of 1024 points wide, and the Dock lays every
        // tile out on the same 1024 box. Painting into the 100pt padding is what made Kelpi
        // read ~10% larger than the apps beside it.
        expect(APP_ICON_TILE_SPAN).toBeCloseTo(824 / 1024, 6);

        const size = 256;
        const canvas = appIconPixels(size);
        const alphaAt = (x: number, y: number): number => canvas.rgba[(y * size + x) * 4 + 3] as number;
        const middle = size / 2;

        let left = 0;
        while (left < size && alphaAt(left, middle) < 128) left += 1;
        let right = size - 1;
        while (right > left && alphaAt(right, middle) < 128) right -= 1;
        expect((right - left + 1) / size).toBeCloseTo(APP_ICON_TILE_SPAN, 2);

        // Square and centred: the top edge starts exactly where the left edge does.
        let top = 0;
        while (top < size && alphaAt(middle, top) < 128) top += 1;
        expect(top).toBe(left);
    });

    it('keeps the mark clear of the tile edge', () => {
        // The glyph span is measured against the tile, so moving the tile onto the grid has to
        // move the kelpie with it rather than leaving it bleeding over the corners.
        const size = 256;
        const canvas = appIconPixels(size);
        let minX = size;
        let maxX = -1;
        let minY = size;
        let maxY = -1;
        for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
                const at = (y * size + x) * 4;
                const white =
                    (canvas.rgba[at] as number) >= 250 &&
                    (canvas.rgba[at + 1] as number) >= 250 &&
                    (canvas.rgba[at + 2] as number) >= 250;
                if (!white) continue;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
        const tileStart = ((1 - APP_ICON_TILE_SPAN) / 2) * size;
        const tileEnd = size - tileStart;
        expect(minX).toBeGreaterThan(tileStart);
        expect(minY).toBeGreaterThan(tileStart);
        expect(maxX).toBeLessThan(tileEnd);
        expect(maxY).toBeLessThan(tileEnd);
    });
});

describe('encodeIcns', () => {
    it('writes the icns magic and a total length that covers every entry', () => {
        const icns = encodeIcns([
            { type: 'ic07', data: new Uint8Array([1, 2, 3, 4]) },
            { type: 'ic08', data: new Uint8Array([5, 6]) }
        ]);
        expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
        expect(icns.readUInt32BE(4)).toBe(icns.length);
        expect(icns.length).toBe(8 + (8 + 4) + (8 + 2));

        // First entry: OSType, then its own length (payload + the 8-byte entry header).
        expect(icns.subarray(8, 12).toString('ascii')).toBe('ic07');
        expect(icns.readUInt32BE(12)).toBe(12);
        expect(icns.subarray(20, 24).toString('ascii')).toBe('ic08');
        expect(icns.readUInt32BE(24)).toBe(10);
    });

    it('refuses an empty file and a bad OSType', () => {
        expect(() => encodeIcns([])).toThrow(/at least one entry/);
        expect(() => encodeIcns([{ type: 'nope!', data: new Uint8Array(1) }])).toThrow(/4 characters/);
    });
});

describe('buildAppIcns', () => {
    it('carries every declared variant, each one a PNG', () => {
        // The full set renders a 1024² image; two small variants prove the structure.
        const icns = buildAppIcns([
            { type: 'icp4', size: 16 },
            { type: 'ic11', size: 32 }
        ]);
        expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
        expect(icns.subarray(8, 12).toString('ascii')).toBe('icp4');
        const firstLength = icns.readUInt32BE(12);
        expect(icns.subarray(16, 24).equals(PNG_SIGNATURE)).toBe(true);
        expect(icns.subarray(8 + firstLength, 12 + firstLength).toString('ascii')).toBe('ic11');
    });

    it('declares the variants macOS actually wants, largest last', () => {
        expect(ICNS_VARIANTS.map((variant) => variant.size)).toEqual([16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]);
        expect(new Set(ICNS_VARIANTS.map((variant) => variant.type)).size).toBe(ICNS_VARIANTS.length);
    });
});

describe('STAGED_RESOURCE_NAMES', () => {
    it('is the list forge.config.cjs copies into Contents/Resources', () => {
        expect([...STAGED_RESOURCE_NAMES]).toEqual(['daemon', 'client', 'cli', 'node']);
    });
});

describe('cookieEncryptionFuseEnabled', () => {
    // The regression guard for run-F ▸ N2: with this fuse on and no signing identity, the
    // packaged app blocks in OSCrypt's login-keychain call and its window never loads.
    it('stays off for an ad-hoc build', () => {
        expect(cookieEncryptionFuseEnabled(undefined)).toBe(false);
        expect(cookieEncryptionFuseEnabled(null)).toBe(false);
        expect(cookieEncryptionFuseEnabled('')).toBe(false);
        expect(cookieEncryptionFuseEnabled('   ')).toBe(false);
    });

    it('turns on with a real identity, in the same step as signing', () => {
        expect(cookieEncryptionFuseEnabled('Developer ID Application: Someone (TEAMID)')).toBe(true);
        expect(isSignedBuild('Developer ID Application: Someone (TEAMID)')).toBe(true);
        expect(isSignedBuild('')).toBe(false);
    });
});

describe('the post-package ad-hoc signature (N22)', () => {
    // Forge's fuses plugin signs at packageAfterCopy; packager renames the app and all four
    // helper bundles AFTER that, so without this step the shipped bundle's seal is broken and
    // the app runs under the stale `com.github.Electron` identity — which is what stopped CDP
    // attaching to the packaged app.
    it('is required for an ad-hoc macOS build', () => {
        expect(adhocSignRequired('', 'darwin')).toBe(true);
        expect(adhocSignRequired(undefined, 'darwin')).toBe(true);
        expect(adhocSignRequired('   ', 'mas')).toBe(true);
    });

    it('is skipped when osxSign already signed the finished bundle', () => {
        expect(adhocSignRequired('Developer ID Application: Someone (TEAMID)', 'darwin')).toBe(false);
    });

    it('does not run off macOS, where there is nothing to seal', () => {
        expect(adhocSignRequired('', 'linux')).toBe(false);
        expect(adhocSignRequired('', 'win32')).toBe(false);
    });

    it('re-signs the whole bundle ad-hoc and then proves the seal', () => {
        const commands = adhocSignCommands('/out/Kelpi.app');
        expect(commands.map((command) => [...command])).toEqual([
            // --deep: the four renamed `Kelpi Helper*.app` bundles are broken too, not just the
            // outer one. --force: there is a (stale) signature to replace.
            ['codesign', '--force', '--deep', '--sign', '-', '/out/Kelpi.app'],
            // The verify is the point of the exercise — a silent codesign success over a bundle
            // that still fails --strict would ship the same defect.
            ['codesign', '--verify', '--strict', '/out/Kelpi.app']
        ]);
    });
});

describe('the Developer ID signature', () => {
    const app = '/out/Kelpi-darwin-arm64/Kelpi.app';

    it('gives the app its terminal entitlements, under the hardened runtime', () => {
        expect(signOptionsForFile(app, 'Kelpi.app')).toEqual({
            hardenedRuntime: true,
            entitlements: [...APP_ENTITLEMENTS]
        });
        // A pane's voice mode and osascript are attributed to the app; without these they are
        // denied with no prompt once the hardened runtime is on.
        expect(APP_ENTITLEMENTS).toContain('com.apple.security.device.audio-input');
        expect(APP_ENTITLEMENTS).toContain('com.apple.security.automation.apple-events');
    });

    it("gives the bundled node Node's own release entitlements", () => {
        expect(signOptionsForFile(`${app}/Contents/Resources/node`, 'Kelpi.app')?.entitlements).toEqual([
            ...NODE_ENTITLEMENTS
        ]);
        expect(NODE_ENTITLEMENTS).toContain('com.apple.security.cs.allow-jit');
    });

    it('passes DYLD_* through node and spawn-helper to the shells they start', () => {
        const helper = `${app}/Contents/Resources/daemon/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`;
        expect(signOptionsForFile(helper, 'Kelpi.app')?.entitlements).toEqual([...SPAWN_HELPER_ENTITLEMENTS]);
        const dyld = 'com.apple.security.cs.allow-dyld-environment-variables';
        expect(SPAWN_HELPER_ENTITLEMENTS).toContain(dyld);
        expect(NODE_ENTITLEMENTS).toContain(dyld);
    });

    it("leaves Electron's helpers, frameworks and libraries on osx-sign's defaults", () => {
        for (const file of [
            `${app}/Contents/Frameworks/Kelpi Helper (Renderer).app`,
            `${app}/Contents/Frameworks/Kelpi Helper.app`,
            `${app}/Contents/Frameworks/Electron Framework.framework`,
            `${app}/Contents/Resources/daemon/node_modules/node-pty/prebuilds/darwin-arm64/pty.node`,
            `${app}/Contents/Resources/nodes`,
            '/out/Other.app'
        ]) {
            expect(signOptionsForFile(file, 'Kelpi.app')).toBeNull();
        }
    });

    it('never grants get-task-allow, which notarization rejects', () => {
        for (const set of [APP_ENTITLEMENTS, NODE_ENTITLEMENTS, SPAWN_HELPER_ENTITLEMENTS]) {
            expect(set).not.toContain('com.apple.security.get-task-allow');
        }
    });
});

describe('signIgnore', () => {
    const header = (...bytes: number[]) => () => Uint8Array.from(bytes);

    it('signs Mach-O files: thin arm64, thin x86_64 and universal', () => {
        expect(isMachOHeader(Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
        expect(isMachOHeader(Uint8Array.from([0xce, 0xfa, 0xed, 0xfe]))).toBe(true);
        expect(isMachOHeader(Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
        expect(signIgnore('/x/node', header(0xcf, 0xfa, 0xed, 0xfe))).toBe(false);
    });

    it('skips resources that only look binary', () => {
        expect(signIgnore('/x/icon.png', () => PNG_SIGNATURE)).toBe(true);
        expect(signIgnore('/x/engine.wasm', header(0x00, 0x61, 0x73, 0x6d))).toBe(true);
        expect(signIgnore('/x/tiny', header(0xcf, 0xfa))).toBe(true);
    });

    it('never skips a directory, so every .app and .framework is still signed', () => {
        expect(signIgnore('/x/Kelpi.app', () => null)).toBe(false);
    });

    it('reads real files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-sign-ignore-'));
        try {
            const text = path.join(dir, 'kelpi');
            fs.writeFileSync(text, '#!/bin/sh\n');
            expect(signIgnore(text)).toBe(true);
            expect(signIgnore(dir)).toBe(false);
            expect(readFileHeader(path.join(dir, 'missing'))).toBeNull();
            if (process.platform === 'darwin') expect(signIgnore(process.execPath)).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('notarizeOptions', () => {
    const identity = 'Developer ID Application: Someone (TEAMID)';

    it('is off when no credentials are set, and treats blank values as unset', () => {
        expect(notarizeOptions({}, identity)).toBeNull();
        expect(notarizeOptions({ APPLE_ID: '  ', KELPI_NOTARY_PROFILE: '' }, '')).toBeNull();
    });

    it('takes a notarytool keychain profile for a local build', () => {
        expect(notarizeOptions({ KELPI_NOTARY_PROFILE: 'kelpi-notary' }, identity)).toEqual({
            keychainProfile: 'kelpi-notary'
        });
    });

    it('takes an App Store Connect API key', () => {
        const env = { APPLE_API_KEY: '/k/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer' };
        expect(notarizeOptions(env, identity)).toEqual({
            appleApiKey: '/k/AuthKey.p8',
            appleApiKeyId: 'KEYID',
            appleApiIssuer: 'issuer'
        });
    });

    it("takes the Apple ID and app-specific password Nex's release used", () => {
        const env = { APPLE_ID: 'me@example.com', APPLE_ID_PASSWORD: 'abcd-efgh', APPLE_TEAM_ID: '4ASXCG2599' };
        expect(notarizeOptions(env, identity)).toEqual({
            appleId: 'me@example.com',
            appleIdPassword: 'abcd-efgh',
            teamId: '4ASXCG2599'
        });
    });

    it('refuses half-set credentials rather than shipping an unnotarized app', () => {
        expect(() => notarizeOptions({ APPLE_ID: 'me@example.com', APPLE_TEAM_ID: 'T' }, identity)).toThrow(
            /APPLE_ID_PASSWORD missing/
        );
    });

    it('refuses to notarize an ad-hoc build', () => {
        expect(() => notarizeOptions({ KELPI_NOTARY_PROFILE: 'kelpi-notary' }, '')).toThrow(/KELPI_MACOS_IDENTITY/);
    });
});

describe('ESM_SCOPE_PACKAGE_JSON', () => {
    it('declares an ES module scope and nothing else', () => {
        expect(JSON.parse(ESM_SCOPE_PACKAGE_JSON)).toEqual({ type: 'module' });
    });

    // The layout the promoted app runs from: the bundle deep inside `out/…/Kelpi.app`, and above
    // the app the shell's own package.json, which has no `type`. Staged without this file, every
    // packaged `kelpi` command printed MODULE_TYPELESS_PACKAGE_JSON before its output.
    it('stops Node warning about a staged ESM bundle under a typeless package.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-shell-esm-scope-'));
        try {
            fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@kelpi/shell', main: 'dist/main.js' }));
            const cliDir = path.join(root, 'out', 'Kelpi-darwin-arm64', 'Kelpi.app', 'Contents', 'Resources', RESOURCE_NAMES.cli);
            fs.mkdirSync(cliDir, { recursive: true });
            const bundle = path.join(cliDir, CLI_BUNDLE_NAME);
            // Module syntax, as esbuild emits it: parsing this as CommonJS fails on the import.
            fs.writeFileSync(bundle, "import path from 'node:path';\nprocess.stdout.write(`ok ${path.sep}\\n`);\n");
            // A bare environment, so no inherited NODE_OPTIONS can add or hide a warning.
            const run = () => spawnSync(process.execPath, [bundle], { encoding: 'utf8', env: {} });

            // Without the scope file: the defect, which also proves this Node still reports it.
            expect(run().stderr).toContain('MODULE_TYPELESS_PACKAGE_JSON');

            fs.writeFileSync(path.join(cliDir, 'package.json'), ESM_SCOPE_PACKAGE_JSON);
            const scoped = run();
            expect(scoped.stderr).toBe('');
            expect(scoped.stdout).toBe(`ok ${path.sep}\n`);
            expect(scoped.status).toBe(0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
