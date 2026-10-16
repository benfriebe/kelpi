// @vitest-environment node
/**
 * #353: `VITE_TERMINAL_ENGINE=xterm` must reach the bundle.
 *
 * Vite substitutes `import.meta.env.VITE_*` at BUILD time, and only in that literal form. Every
 * other test passes the engine explicitly, and vitest rewrites `import.meta` at run time, where a
 * cast or an optional chain reads the variable fine, so a `stubEnv` test could never have caught
 * the bug: the read compiled to `import.meta.env?.VITE_TERMINAL_ENGINE`, unreplaced, undefined in
 * the browser, and every build shipped ghostty-web. So this builds `renderer.ts` for real and
 * reads what `configuredTerminalEngine` compiled to.
 *
 * The node environment is not a preference: esbuild, which Vite builds with, refuses to run under
 * jsdom (its `TextEncoder` output fails an `instanceof Uint8Array` check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientRoot = fileURLToPath(new URL('../..', import.meta.url));
const envDirs: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of envDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory whose `.env` holds exactly `contents`, so the developer's own files never apply. */
function envDir(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-engine-env-'));
    envDirs.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), contents);
    return dir;
}

/** The body of `configuredTerminalEngine` as Vite compiles it with `env` as the build's env dir. */
async function compiledEngineRead(dir: string): Promise<string> {
    // Vite merges `VITE_*` from `process.env` over the files, so a shell that exports the
    // variable would otherwise decide both cases. Removed for the build; `afterEach` restores it.
    vi.stubEnv('VITE_TERMINAL_ENGINE', undefined);
    const output = await build({
        configFile: false,
        root: clientRoot,
        envDir: dir,
        logLevel: 'silent',
        build: {
            write: false,
            minify: false,
            lib: { entry: path.join(clientRoot, 'src/terminal/renderer.ts'), formats: ['es'], fileName: 'renderer' },
            // Both engines are dynamic imports of `renderer.ts`; their wasm and CSS are not the
            // subject and would only slow the build down.
            rollupOptions: { external: ['ghostty-web', '@xterm/xterm'] }
        }
    });
    const results = (Array.isArray(output) ? output : [output]) as Rollup.RollupOutput[];
    const code = results
        .flatMap((result) => result.output)
        .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
        .join('\n');
    const match = /function configuredTerminalEngine\(\) \{[^}]*\}/.exec(code);
    expect(match, 'configuredTerminalEngine is in the bundle').not.toBeNull();
    return match?.[0] ?? '';
}

// Built by concatenation so vitest's own `import.meta.env` rewrite cannot touch the needle.
const UNREPLACED = 'import.meta' + '.env';

describe('VITE_TERMINAL_ENGINE at build time (#353)', () => {
    it('compiles to the xterm engine when the build says xterm', async () => {
        const body = await compiledEngineRead(envDir('VITE_TERMINAL_ENGINE=xterm\n'));
        expect(body).toContain('resolveTerminalEngine("xterm")');
        expect(body).not.toContain(UNREPLACED);
    }, 30_000);

    it('compiles to the default engine when the build says nothing', async () => {
        const body = await compiledEngineRead(envDir(''));
        expect(body).toMatch(/resolveTerminalEngine\((void 0|undefined)?\)/);
        expect(body).not.toContain(UNREPLACED);
    }, 30_000);
});
