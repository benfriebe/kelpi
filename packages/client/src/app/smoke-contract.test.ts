/**
 * Guards the live smoke script's hand-rolled protocol constants.
 *
 * `scripts/smoke.mjs` is deliberately dependency-free JavaScript — it has to run against the
 * BUILT daemon and the BUILT client, without importing the workspace's TypeScript — so it
 * re-declares the PTY frame layout and the protocol version. That duplication is only safe if
 * something fails when the protocol moves, which is this file: it reads the script and asserts
 * every constant still matches `@nex/protocol`.
 */

import { PTY_FRAME_HEADER_BYTES, PTY_FRAME_TYPES, WS_PROTOCOL_VERSION } from '@nex/protocol';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'smoke.mjs');
const source = readFileSync(scriptPath, 'utf8');

function numberLiteral(name: string): number {
    const match = new RegExp(`const ${name} = (\\d+)`).exec(source);
    if (match === null) throw new Error(`${name} is not declared in smoke.mjs`);
    return Number.parseInt(match[1] as string, 10);
}

describe('smoke.mjs protocol constants', () => {
    it('declares the same PTY frame types as the protocol package', () => {
        const match = /const FRAME = \{([^}]+)\}/.exec(source);
        expect(match).not.toBeNull();
        const declared = Object.fromEntries(
            (match?.[1] ?? '')
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
                .map((entry) => {
                    const [name, value] = entry.split(':').map((part) => part.trim());
                    return [name as string, Number(value)];
                })
        );
        expect(declared).toEqual({ ...PTY_FRAME_TYPES });
    });

    it('declares the same frame header size and protocol version', () => {
        expect(numberLiteral('FRAME_HEADER_BYTES')).toBe(PTY_FRAME_HEADER_BYTES);
        expect(numberLiteral('PROTOCOL_VERSION')).toBe(WS_PROTOCOL_VERSION);
    });

    it('never points a smoke run at the production control socket', () => {
        // The Swift app owns /tmp/nex.sock on a dev machine. The socket the daemon is given
        // must be inside the throwaway root, and the guard that refuses the production path
        // must still be there.
        expect(source).toContain("const socketPath = path.join(root, 'nexd.sock')");
        expect(source).toContain('NEXD_SOCKET_PATH: socketPath');
        expect(source).toContain('refusing to touch the production socket');
        // The run dir, database and HOME are throwaway too.
        for (const variable of ['NEXD_RUN_DIR: runDir', 'NEXD_DB_PATH: path.join(root,', 'HOME: home']) {
            expect(source).toContain(variable);
        }
    });
});
