/**
 * node-pty adapter for `PtySpawner`.
 *
 * node-pty is a CJS native module: it is loaded through `createRequire` (lazily, on first
 * spawn) so importing the PTY layer never forces the native binding to load — stub-spawner
 * unit tests and type-only consumers stay free of it.
 */

import { createRequire } from 'node:module';
import type { PtyProcessHandle, PtySpawner, PtySpawnRequest } from './types.js';

type NodePtyModule = typeof import('node-pty');

let cached: NodePtyModule | undefined;

/** Lazily `require('node-pty')`; cached after the first successful load. */
export function loadNodePty(): NodePtyModule {
    if (cached === undefined) {
        const nodeRequire = createRequire(import.meta.url);
        cached = nodeRequire('node-pty') as NodePtyModule;
    }
    return cached;
}

/** `encoding: null` keeps node-pty in raw-Buffer mode so bytes reach the VT untranslated. */
export const nodePtySpawner: PtySpawner = (request: PtySpawnRequest): PtyProcessHandle => {
    const pty = loadNodePty();
    const proc = pty.spawn(request.file, [...request.args], {
        name: request.name,
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: { ...request.env },
        encoding: null
    });

    return {
        get pid() {
            return proc.pid;
        },
        write(data: string | Uint8Array): void {
            proc.write(typeof data === 'string' ? data : Buffer.from(data));
        },
        resize(cols: number, rows: number): void {
            proc.resize(cols, rows);
        },
        kill(signal?: string): void {
            try {
                proc.kill(signal);
            } catch {
                // Already reaped: node-pty swallows this itself on unix, but a Windows
                // build (or a race with _close) can still throw. Never propagate.
            }
        },
        onData(listener: (data: Uint8Array) => void): void {
            // Typed as `string` by node-pty's typings; `encoding: null` makes it a Buffer.
            proc.onData((chunk: unknown) => {
                listener(
                    typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Uint8Array)
                );
            });
        },
        onExit(listener: (exitCode: number, signal: number | undefined) => void): void {
            proc.onExit(({ exitCode, signal }) => {
                listener(exitCode, signal);
            });
        }
    };
};
