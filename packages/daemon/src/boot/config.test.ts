import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    CONFIG_PATH_ENV,
    configuredTcpPort,
    createProfileReader,
    loadDaemonConfig,
    resolveConfigPath
} from './config.js';

const temporaries: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-config-'));
    temporaries.push(dir);
    return dir;
}

afterEach(() => {
    while (temporaries.length > 0) {
        const dir = temporaries.pop();
        if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('config location', () => {
    it('is literally ~/.config/nex/config (no XDG lookup)', () => {
        expect(resolveConfigPath({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/Users/x' })).toBe(
            '/Users/x/.config/nex/config'
        );
    });

    it('honours KELPID_CONFIG_PATH, expanding ~', () => {
        expect(resolveConfigPath({ env: { [CONFIG_PATH_ENV]: '~/dev.conf' }, home: '/Users/x' })).toBe(
            '/Users/x/dev.conf'
        );
    });
});

describe('loadDaemonConfig', () => {
    it('treats a missing file as an empty config, never an error', () => {
        const config = loadDaemonConfig({ path: '/nope/does/not/exist', home: '/Users/x' });
        expect(config.exists).toBe(false);
        expect(config.profiles).toEqual([]);
        expect(configuredTcpPort(config)).toBeUndefined();
    });

    it('parses tcp-port and profiles, expanding ~ in profile values', () => {
        const dir = tempDir();
        const file = path.join(dir, 'config');
        fs.writeFileSync(
            file,
            ['tcp-port = 19400', 'profile = work:CLAUDE_CONFIG_DIR=~/.claude-work', 'profile = work:A=1'].join('\n')
        );

        const config = loadDaemonConfig({ path: file, home: '/Users/x' });
        expect(configuredTcpPort(config)).toBe(19400);
        expect(config.profiles).toEqual([
            { name: 'work', env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude-work', A: '1' } }
        ]);
    });

    it('reads tcp-port = 0 as "no TCP listener"', () => {
        const dir = tempDir();
        const file = path.join(dir, 'config');
        fs.writeFileSync(file, 'tcp-port = 0\n');
        expect(configuredTcpPort(loadDaemonConfig({ path: file, home: '/Users/x' }))).toBeUndefined();
    });
});

describe('createProfileReader', () => {
    it('re-reads the file on every call so edits reach the next spawn', () => {
        const dir = tempDir();
        const file = path.join(dir, 'config');
        fs.writeFileSync(file, 'profile = work:A=1\n');
        const read = createProfileReader({ path: file, home: '/Users/x' });

        expect(read()).toEqual([{ name: 'work', env: { A: '1' } }]);

        fs.writeFileSync(file, 'profile = work:A=2\nprofile = play:B=3\n');
        expect(read()).toEqual([
            { name: 'work', env: { A: '2' } },
            { name: 'play', env: { B: '3' } }
        ]);

        fs.rmSync(file);
        expect(read()).toEqual([]);
    });
});
