import { describe, expect, it } from 'vitest';

import {
    ICNS_VARIANTS,
    MINIMUM_NODE_MAJOR,
    PACKAGED_APP_FILES,
    STAGED_RESOURCE_NAMES,
    adhocSignCommands,
    adhocSignRequired,
    appIconPixels,
    appIconPng,
    buildAppIcns,
    cookieEncryptionFuseEnabled,
    encodeIcns,
    isSignedBuild,
    nodeRuntimeIssues,
    packagedAppIgnore
} from './packaging.js';

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

    it('paints the glyph and the accent dot, not a flat tile', () => {
        const canvas = appIconPixels(256);
        const colours = new Set<string>();
        for (let index = 0; index < canvas.rgba.length; index += 4) {
            colours.add(`${String(canvas.rgba[index])},${String(canvas.rgba[index + 1])},${String(canvas.rgba[index + 2])}`);
        }
        expect(colours.size).toBeGreaterThan(20);
    });

    it('encodes to a PNG', () => {
        expect(appIconPng(32).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
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
        const commands = adhocSignCommands('/out/Nex.app');
        expect(commands.map((command) => [...command])).toEqual([
            // --deep: the four renamed `Nex Helper*.app` bundles are broken too, not just the
            // outer one. --force: there is a (stale) signature to replace.
            ['codesign', '--force', '--deep', '--sign', '-', '/out/Nex.app'],
            // The verify is the point of the exercise — a silent codesign success over a bundle
            // that still fails --strict would ship the same defect.
            ['codesign', '--verify', '--strict', '/out/Nex.app']
        ]);
    });
});
