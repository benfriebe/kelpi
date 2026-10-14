import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_PROTOCOL_VERSION as HARNESS_WS_PROTOCOL_VERSION } from './stack.mjs';
import { WS_PROTOCOL_VERSION } from '../../../packages/protocol/src/ws/messages.ts';

const scripts = fileURLToPath(new URL('../../', import.meta.url));

/** Every .mjs under scripts/, the harness's scenarios, audit steps and storms. */
function harnessFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : harnessFiles(full);
        return entry.name.endsWith('.mjs') ? [full] : [];
    });
}

it('the harness says hello at the protocol version the daemon speaks', () => {
    expect(HARNESS_WS_PROTOCOL_VERSION).toBe(WS_PROTOCOL_VERSION);
});

it('no harness socket says hello at any other version', () => {
    // A hello the daemon refuses gets no welcome, and a script waiting on one hangs the battery (#403).
    const stale = [];
    for (const file of harnessFiles(scripts)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
            const match = /protocolVersion:\s*([A-Za-z_0-9]+)/.exec(line);
            if (!match) return;
            const value = match[1];
            if (value === 'WS_PROTOCOL_VERSION' || value === String(WS_PROTOCOL_VERSION)) return;
            stale.push(`${path.relative(scripts, file)}:${index + 1}: protocolVersion: ${value}`);
        });
    }
    expect(stale).toEqual([]);
});
