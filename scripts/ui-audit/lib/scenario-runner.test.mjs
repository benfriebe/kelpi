import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixtureAcceptanceProvenance } from './fixture-acceptance-provenance.mjs';

// Exercise the real runner/recorder and watcher without launching Electron. Only the private
// instance boundary is replaced, so attribution, exit status, JSON and teardown remain real.
it.each([false, true])('records enforced cleanup=%s and boot errors on their own instances, drains shared intervals once, and stops both instances', (leak) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-runner-test-'));
    try {
        const provenance = fixtureAcceptanceProvenance({ root, temp });
        const driver = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')).href;
        const watcher = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/renderer-errors.mjs')).href;
        const stub = path.join(temp, 'driver.mjs');
        const stopped = path.join(temp, 'stopped');
        const slot = path.join(temp, 'desktop-slot.mjs');
        const acquired = path.join(temp, 'acquired');
        fs.writeFileSync(slot, `import fs from 'node:fs';
            export const DESKTOP_TEST_PORT = 19735;
            export async function holdDesktopTestSlot() { fs.writeFileSync(${JSON.stringify(acquired)}, 'yes'); return { release: async () => {} }; }`);
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
                page.eval = async () => JSON.stringify({ phonePlace: null, phoneLanding: null, workbench: page.fixtureLeak ? { 'terminal @ private': 'example.fixture' } : {}, settingsOpen: false, overlays: [], hasFocus: true, viewport: '800x600', url: 'http://fixture' });
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
                if (specifier.endsWith('/desktop-slot.mjs'))
                    return { url: ${JSON.stringify(pathToFileURL(slot).href)}, shortCircuit: true };
                if (specifier === ${JSON.stringify(path.join(root, 'scripts/ui-audit/lib/driver.mjs'))})
                    return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
                if (specifier === './acceptance-provenance.mjs' && context.parentURL?.endsWith('/incident-diagnostics-replay.mjs'))
                    return { url: ${JSON.stringify(pathToFileURL(provenance.module).href)}, shortCircuit: true };
                return nextResolve(specifier, context);
            } });
        `);
        const scenarios = ['first', 'dedicated', 'next', 'clean'].map((name) => {
            const file = path.join(temp, name + '.mjs');
            fs.writeFileSync(file, `export default async ({page}) => { ${name === 'first' && leak ? 'page.fixtureLeak = true;' : ''} }; ${name === 'dedicated' ? "export const windowPlacement = 'offscreen';" : ''}`);
            return file;
        });
        const run = spawnSync(process.execPath, ['--import', hook, process.env.SCENARIO_RUNNER_UNDER_TEST ?? path.join(root, 'scripts/scenario.mjs'),
            '--no-build', '--window', 'hidden', '--out', path.join(temp, 'out'), ...scenarios], { env: provenance.env, encoding: 'utf8', timeout: 20_000 });
        expect(run.status, run.stdout + run.stderr).toBe(1);
        expect(fs.existsSync(path.join(temp, 'out/results.json')), run.stdout + run.stderr).toBe(true);
        const output = JSON.parse(fs.readFileSync(path.join(temp, 'out/results.json'), 'utf8'));
        const summaries = output.summaries;
        expect(summaries.map((scenario) => scenario.name)).toEqual(['first', 'dedicated', 'next', 'clean']);
        expect(summaries.slice(0, 3).map((scenario) => scenario.results[0].detail)).toEqual([
            'uncaught: boot-1', 'uncaught: boot-2', 'uncaught: idle-lane'
        ]);
        expect(summaries.map((scenario) => scenario.failed)).toEqual(leak ? [2, 1, 2, 1] : [1, 1, 1, 0]);
        if (leak) {
            expect(summaries[0].results.at(-1).failureClass).toBe('cleanup');
            expect(output.leaks).toHaveLength(1);
        }
        expect(summaries[1].ownInstance).toBe(true);
        expect(fs.readFileSync(stopped, 'utf8')).toBe('21');
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

// Negative startup tests use the actual runner with only its private instance boundary replaced.
// This proves a failed required placement never falls through into a weaker fixture.
it.each(['startup', 'dedicated'])('retains %s fixture failure and never runs the dependent scenario', (failure) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-required-fixture-'));
    try {
        const provenance = fixtureAcceptanceProvenance({ root, temp });
        const driver = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')).href;
        const ran = path.join(temp, 'ran'), stopped = path.join(temp, 'stopped');
        const stub = path.join(temp, 'driver.mjs'), slot = path.join(temp, 'slot.mjs'), hook = path.join(temp, 'hook.mjs');
        fs.writeFileSync(slot, 'export const DESKTOP_TEST_PORT = 19735; export async function holdDesktopTestSlot() { return { release: async () => {} }; }');
        fs.writeFileSync(stub, `import fs from 'node:fs';
            export { recorder, WINDOW_PLACEMENTS } from ${JSON.stringify(driver + '?real')};
            let calls = 0;
            export async function boot({window}) {
                if (++calls === ${failure === 'startup' ? 1 : 2}) throw new Error('required fixture refused');
                return { page: { eval: async () => JSON.stringify({workbench:{},phonePlace:null,overlays:[],viewport:'800x600',url:'private',hasFocus:true}) },
                    sandbox: {base:'private'}, harness:{path:'private'}, windowPlacement:window,
                    rendererErrors: {finish(rec) { rec.check('renderer clean', true); }},
                    stop:async () => fs.appendFileSync(${JSON.stringify(stopped)}, 'stopped') };
            }`);
        fs.writeFileSync(hook, `import {registerHooks} from 'node:module';
            registerHooks({resolve(s,c,next) {
                if(s.endsWith('/desktop-slot.mjs')) return {url:${JSON.stringify(pathToFileURL(slot).href)},shortCircuit:true};
                if(s===${JSON.stringify(path.join(root,'scripts/ui-audit/lib/driver.mjs'))}) return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};
                if(s==='./acceptance-provenance.mjs'&&c.parentURL?.endsWith('/incident-diagnostics-replay.mjs')) return {url:${JSON.stringify(pathToFileURL(provenance.module).href)},shortCircuit:true};
                return next(s,c);
            }});`);
        const scenario = path.join(temp, 'required.mjs');
        fs.writeFileSync(scenario, `import fs from 'node:fs'; export const windowPlacement='offscreen'; export default async () => fs.writeFileSync(${JSON.stringify(ran)},'ran');`);
        const run = spawnSync(process.execPath, ['--import', hook, path.join(root, 'scripts/scenario.mjs'), '--no-build', '--window', 'hidden', '--out', path.join(temp, 'out'), scenario], { env: provenance.env, encoding: 'utf8', timeout: 10_000 });
        expect(run.status, run.stdout + run.stderr).toBe(1);
        expect(fs.existsSync(ran)).toBe(false);
        expect(fs.existsSync(path.join(temp, 'out/results.json')), run.stdout + run.stderr).toBe(true);
        const result = JSON.parse(fs.readFileSync(path.join(temp, 'out/results.json'), 'utf8'));
        if (failure === 'startup') expect(result.harnessFailure.detail).toContain('required fixture refused');
        else {
            expect(result.summaries[0].firstFailure.failureClass).toBe('fixture');
            expect(result.cleanup).toEqual({attempted:true,completed:true,errors:[],leaks:[]});
            expect(fs.readFileSync(stopped,'utf8')).toBe('stopped');
            expect(result.sequence.firstFailure.precedingFiles).toEqual([]);
        }
        expect(result.provenance.head).toMatch(/^[a-f0-9]{40}$/);
    } finally { fs.rmSync(temp, {recursive:true,force:true}); }
});

it('uses scoped fixture build evidence but the real execution guard rejects runtime drift', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-provenance-guard-'));
    try {
        const provenance = fixtureAcceptanceProvenance({ root, temp });
        const hook = path.join(temp, 'hook.mjs');
        const replay = pathToFileURL(path.join(root, 'scripts/ui-audit/lib/incident-diagnostics-replay.mjs')).href;
        fs.writeFileSync(hook, `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){
            return s==='./acceptance-provenance.mjs'&&c.parentURL?.endsWith('/incident-diagnostics-replay.mjs')
                ? {url:${JSON.stringify(pathToFileURL(provenance.module).href)},shortCircuit:true}:next(s,c);}});`);
        const script = `import {captureProvenance,bindCoreExecution} from ${JSON.stringify(replay)};
            const p=captureProvenance(${JSON.stringify(root)}); console.log('complete='+p.complete);
            process.env.KELPI_UNIT_FIXTURE_DRIFT='1';
            try { bindCoreExecution(${JSON.stringify(root)},p,{boundary:'fixture-drift'}); process.exitCode=2; }
            catch(error) { console.log(error.message); }`;
        const run = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script], { env: provenance.env, encoding: 'utf8', timeout: 10_000 });
        expect(run.status, run.stdout + run.stderr).toBe(0);
        expect(run.stdout).toContain('complete=true');
        expect(run.stdout).toContain('runtime outputs differ from original build receipt');
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
