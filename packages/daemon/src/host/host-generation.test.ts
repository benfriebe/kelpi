/**
 * A running host keeps the code it started with, node-pty included, until it exits. Only a new
 * generation makes a daemon start a fresh host and drain the old one (`docs/terminal-host.md`
 * §11), so a node-pty upgrade that forgets to bump it never reaches a machine that is already
 * running (#370, #372).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DRAINABLE_HOST_PROTOCOLS, HOST_NODE_PTY_VERSION, HOST_PROTOCOL_VERSION } from './protocol.js';

const packageJSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

describe('the terminal host generation', () => {
    it('moves with node-pty', () => {
        const declared = (JSON.parse(fs.readFileSync(packageJSON, 'utf8')) as { dependencies: Record<string, string> })
            .dependencies['node-pty'];
        expect(
            declared,
            'node-pty changed: bump HOST_PROTOCOL_VERSION, add the old one to DRAINABLE_HOST_PROTOCOLS, then update HOST_NODE_PTY_VERSION'
        ).toBe(HOST_NODE_PTY_VERSION);
    });

    it('only drains older generations', () => {
        for (const protocol of DRAINABLE_HOST_PROTOCOLS.keys()) expect(protocol).toBeLessThan(HOST_PROTOCOL_VERSION);
    });
});
