/**
 * Test support: a real `terminal-host.js`, built on demand.
 *
 * Daemon tests build their daemons in-process, but the terminal host is a separate process, so a
 * test that exercises the real launch path needs the bundle. It is built once per test process
 * with the same esbuild options as `scripts/bundle.mjs`, into a directory inside this package's
 * `node_modules/.cache` so `require('node-pty')` resolves exactly as it does beside the real
 * bundle. Removed when the process exits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST_BUNDLE_NAME } from './runtime.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const banner = `import { createRequire as __kelpidCreateRequire } from 'node:module';
import { fileURLToPath as __kelpidFileURLToPath } from 'node:url';
import { dirname as __kelpidDirname } from 'node:path';
const require = __kelpidCreateRequire(import.meta.url);
const __filename = __kelpidFileURLToPath(import.meta.url);
const __dirname = __kelpidDirname(__filename);
`;

let built: Promise<string> | undefined;

/** The directory holding a freshly built `terminal-host.js` (a `TerminalHostLaunch.daemonDir`). */
export function buildHostBundle(): Promise<string> {
    built ??= (async () => {
        const esbuild = await import('esbuild');
        const dir = path.join(packageRoot, 'node_modules', '.cache', `kelpi-host-test-${process.pid}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await esbuild.build({
            entryPoints: [path.join(packageRoot, 'src', 'host', 'main.ts')],
            outfile: path.join(dir, HOST_BUNDLE_NAME),
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node24',
            external: ['node-pty'],
            banner: { js: banner },
            logLevel: 'silent'
        });
        fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
        process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
        return dir;
    })();
    return built;
}
