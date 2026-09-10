import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Build the example from the repository's installed, lockfile-pinned dependencies. */
export async function buildTerminalLab(repoRoot) {
    const client = createRequire(path.join(repoRoot, 'packages/client/package.json'));
    const vite = createRequire(client.resolve('vite/package.json'));
    const { build } = vite('esbuild');
    const directory = path.join(repoRoot, 'examples/plugins/terminal-lab');
    await build({
        entryPoints: [path.join(directory, 'ui/terminal.js')], outfile: path.join(directory, 'ui/bundle.js'),
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'eof',
        nodePaths: [path.join(repoRoot, 'packages/client/node_modules')]
    });
    const packageRoot = path.dirname(client.resolve('@xterm/xterm/package.json'));
    fs.copyFileSync(path.join(packageRoot, 'LICENSE'), path.join(directory, 'ui/xterm.LICENSE'));
    return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
    process.stdout.write(`${await buildTerminalLab(root)}\n`);
}
