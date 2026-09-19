import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Exercise the real runner/recorder and watcher without launching Electron. Only the private
// instance boundary is replaced, so attribution, exit status, JSON and teardown remain real.
it('records boot errors on their own instances, drains shared intervals once, and stops both instances', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-runner-test-'));
    try {
        const driver = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')).href;
        const watcher = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/renderer-errors.mjs')).href;
        const stub = path.join(temp, 'driver.mjs');
        const stopped = path.join(temp, 'stopped');
        const slot = path.join(temp, 'desktop-slot.mjs');
        const acquired = path.join(temp, 'acquired');
        fs.writeFileSync(slot, `import fs from 'node:fs';
            export async function holdDesktopTestSlot() { fs.writeFileSync(${JSON.stringify(acquired)}, 'yes'); }`);
        fs.writeFileSync(stub, `
            import { EventEmitter } from 'node:events';
            import fs from 'node:fs';
            import { watchRendererErrors } from ${JSON.stringify(watcher)};
            export { recorder, WINDOW_PLACEMENTS } from ${JSON.stringify(driver + '?real')};
            let count = 0;
            let lane;
            export async function boot({ window }) {
                if (!fs.existsSync(${JSON.stringify(acquired)})) throw new Error('boot before desktop slot');
                const id = ++count;
                const page = new EventEmitter();
                page.send = async () => {};
                page.eval = async () => { throw new Error('no DOM in this runner unit fixture'); };
                const rendererErrors = await watchRendererErrors(page);
                page.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'boot-' + id } });
                if (id === 1) lane = page;
                else lane.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'idle-lane' } });
                return { page, rendererErrors, sandbox: { base: 'private-fixture' }, debugPort: 1,
                    harness: { path: 'private-fixture' }, windowPlacement: window,
                    stop: async () => fs.appendFileSync(${JSON.stringify(stopped)}, String(id)) };
            }
        `);
        const hook = path.join(temp, 'hook.mjs');
        fs.writeFileSync(hook, `
            import { registerHooks } from 'node:module';
            registerHooks({ resolve(specifier, context, nextResolve) {
                if (specifier === './ui-audit/lib/desktop-slot.mjs')
                    return { url: ${JSON.stringify(pathToFileURL(slot).href)}, shortCircuit: true };
                if (specifier === ${JSON.stringify(path.join(root, 'scripts/ui-audit/lib/driver.mjs'))})
                    return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
                return nextResolve(specifier, context);
            } });
        `);
        const scenarios = ['first', 'dedicated', 'next', 'clean'].map((name) => {
            const file = path.join(temp, name + '.mjs');
            fs.writeFileSync(file, `export default async () => {}; ${name === 'dedicated' ? "export const windowPlacement = 'offscreen';" : ''}`);
            return file;
        });
        const run = spawnSync(process.execPath, ['--import', hook, path.join(root, 'scripts/scenario.mjs'),
            '--no-build', '--window', 'hidden', '--out', path.join(temp, 'out'), ...scenarios], { encoding: 'utf8', timeout: 20_000 });
        expect(run.status, run.stdout + run.stderr).toBe(1);
        const output = JSON.parse(fs.readFileSync(path.join(temp, 'out/results.json'), 'utf8'));
        const summaries = output.summaries;
        expect(summaries.map((scenario) => scenario.name)).toEqual(['first', 'dedicated', 'next', 'clean']);
        expect(summaries.map((scenario) => scenario.results[0].detail)).toEqual([
            'uncaught: boot-1', 'uncaught: boot-2', 'uncaught: idle-lane', ''
        ]);
        expect(summaries.map((scenario) => scenario.failed)).toEqual([1, 1, 1, 0]);
        expect(summaries[1].ownInstance).toBe(true);
        expect(fs.readFileSync(stopped, 'utf8')).toBe('21');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
