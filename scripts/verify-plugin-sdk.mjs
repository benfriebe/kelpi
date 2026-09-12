/** Verify the actual npm artifact from consumers outside the monorepo, without publishing. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = path.join(repo, 'packages/plugin-sdk');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-sdk-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tsc = path.join(repo, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });

try {
    const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--offline', '--cache', path.join(temporary, 'cache'), '--pack-destination', temporary], sdk));
    const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8'));
    assert.deepEqual(packed.files.map(file => file.path).sort(), ['package.json', ...manifest.files].sort(), 'SDK artifact must contain exactly its public files');
    const consumer = path.join(temporary, 'consumer'); fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'external-plugin', private: true, type: 'module', dependencies: { '@kelpi/plugin-sdk': `file:${path.join(temporary, packed.filename)}` } }));
    run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', path.join(temporary, 'cache')], consumer);
    const fixtures = {
        backend: `import type { BackendAPI, BrowserSnapshot, BuiltinProviderMethods } from '@kelpi/plugin-sdk';
export function activate(api: BackendAPI) {
    api.commands.register('example.external.list', async () => ({ count: (await api.workspaces.list()).length }));
    const provider: BuiltinProviderMethods<'kelpi.files'> = { read: () => 'text', write: () => null };
    api.providers.register<'kelpi.files'>('example.external.files', provider);
    const state: Promise<{ subscription: string; state: BrowserSnapshot }> = api.browser.watch('pane');
    // @ts-expect-error Native view attachment belongs to a view, not the backend.
    api.browser.attach({});
    return () => { void state; };
}`,
        view: `import { getKelpi, type ViewAPI, type BrowserSurface, type TerminalGrid, type TerminalSession } from '@kelpi/plugin-sdk';
const api: ViewAPI = getKelpi();
let mirror: TerminalGrid | null = null;
async function mount(element: HTMLElement) {
    await api.ready;
    const browser: BrowserSurface = await api.browser.attach({ element, onPresentation() {} });
    // Replay geometry and size ownership are part of the published surface: only a replay
    // states a grid, and every presentation states ownership.
    const terminal: TerminalSession = await api.terminal.attach({ cols: 80, rows: 24, onFrame(frame) {
        if (frame.type === 'replay') mirror = frame.grid;
        else if (frame.type === 'presentation' && frame.value.ownsSize) mirror = null;
        // @ts-expect-error Only a replay frame states the grid it was serialised at.
        else if (frame.type === 'output') void frame.grid;
        // A mirror sizes the EMULATOR; resize() still reports the measured box, never the mirror.
        if (mirror !== null) void mirror.cols;
        terminal.resize(80, 24);
    } });
    await api.ui.showNotification({ message: 'External plugin ready' });
    browser.dispose(); terminal.dispose();
}
void mount;
`,
    };
    for (const [name, contents] of Object.entries(fixtures)) {
        fs.writeFileSync(path.join(consumer, `${name}.ts`), contents);
        fs.writeFileSync(path.join(consumer, `tsconfig.${name}.json`), JSON.stringify({ compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: false, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
            types: [], lib: name === 'backend' ? ['ES2022'] : ['ES2022', 'DOM'],
        }, files: [`${name}.ts`] }));
        run(tsc, ['-p', `tsconfig.${name}.json`], consumer);
    }
    fs.writeFileSync(path.join(consumer, 'runtime.mjs'), `import assert from 'node:assert/strict';
import { createKelpiAPI, getKelpi, KelpiError } from '@kelpi/plugin-sdk';
const calls = [];
const api = createKelpiAPI(async (method, args) => { calls.push({ method, args }); return null; });
await api.storage.get('key');
assert.deepEqual(calls, [{ method: 'storage.get', args: { key: 'key' } }]);
assert.throws(() => getKelpi(), /Kelpi plugin view/);
globalThis.kelpi = api; assert.equal(getKelpi(), api);
assert.equal(typeof KelpiError, 'function');
`);
    run(process.execPath, ['runtime.mjs'], consumer);
    process.stdout.write(`SDK artifact verified: ${packed.filename}; browser types, Node-only backend types, runtime imports.\n`);
} catch (error) {
    if (error.stdout) process.stderr.write(String(error.stdout));
    if (error.stderr) process.stderr.write(String(error.stderr));
    throw error;
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
