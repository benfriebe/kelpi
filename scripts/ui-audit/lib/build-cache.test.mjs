import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleHash, cacheDecision, writeRecordedHash } from './build-cache.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-build-cache-')); roots.push(root); return root; };
const write = (root, relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe('plugin SDK bundle cache dependencies', () => {
    it('invalidates browser and daemon bundles for an SDK-only source change', () => {
        const root = fixture();
        write(root, 'packages/plugin-sdk/api.js', 'export const version = 1;');
        const daemon = bundleHash(root, 'daemon'), client = bundleHash(root, 'client');
        write(root, 'packages/plugin-sdk/api.js', 'export const version = 2;');
        expect(bundleHash(root, 'daemon')).not.toBe(daemon);
        expect(bundleHash(root, 'client')).not.toBe(client);
    });

    it('rebuilds when the backend runner is missing even though the main artifact and hash survive', () => {
        const root = fixture();
        write(root, 'packages/daemon/dist/kelpid.js', 'daemon');
        write(root, 'packages/daemon/dist/runner.mjs', 'runner');
        writeRecordedHash(root, 'daemon', bundleHash(root, 'daemon'));
        expect(cacheDecision(root, 'daemon').cached).toBe(true);
        fs.unlinkSync(path.join(root, 'packages/daemon/dist/runner.mjs'));
        expect(cacheDecision(root, 'daemon')).toMatchObject({ cached: false, reason: 'missing companion artefact' });
    });
});

describe('the client bundle keys on its build-time environment (#353)', () => {
    it('a VITE_* variable changes the client hash and no other bundle', () => {
        const root = fixture();
        write(root, 'packages/client/src/main.ts', 'export {};');
        const plain = { PATH: '/usr/bin' };
        const xterm = { ...plain, VITE_TERMINAL_ENGINE: 'xterm' };
        expect(bundleHash(root, 'client', { env: xterm })).not.toBe(bundleHash(root, 'client', { env: plain }));
        for (const bundle of ['daemon', 'cli', 'shell']) {
            expect(bundleHash(root, bundle, { env: xterm })).toBe(bundleHash(root, bundle, { env: plain }));
        }
    });

    it('ignores variables Vite does not substitute', () => {
        const root = fixture();
        expect(bundleHash(root, 'client', { env: { HOME: '/a' } })).toBe(bundleHash(root, 'client', { env: { HOME: '/b' } }));
    });

    it('a .env file next to the client invalidates it', () => {
        const root = fixture();
        const env = {};
        const before = bundleHash(root, 'client', { env });
        write(root, 'packages/client/.env.local', 'VITE_TERMINAL_ENGINE=xterm\n');
        expect(bundleHash(root, 'client', { env })).not.toBe(before);
    });
});
