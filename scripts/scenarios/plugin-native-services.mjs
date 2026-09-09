import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const covers = ['packages/daemon/src/plugins/', 'packages/daemon/src/content/', 'packages/daemon/src/git/', 'packages/daemon/src/graft/associations', 'packages/daemon/src/boot/compose.ts', 'packages/client/src/app/inspector', 'packages/plugin-sdk/', 'examples/plugins/service-lab/'];
const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/plugins/service-lab');
const pluginID = 'example.service-lab';

export default async function ({ page, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const repo = path.join(sandbox.root, 'native-service-repo');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main']);
    const file = path.join(repo, 'NOTES.md');
    fs.writeFileSync(file, '# Native services\n\nOriginal text.\n');
    git(['add', 'NOTES.md']);
    git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
    fs.appendFileSync(file, '\nChanged text.\n');

    // Layer deterministic failure/race probes onto a private copy of the runnable example.
    const fixture = path.join(sandbox.root, 'service-lab');
    fs.cpSync(example, fixture, { recursive: true });
    fs.renameSync(path.join(fixture, 'backend.mjs'), path.join(fixture, 'base.mjs'));
    const manifestFile = path.join(fixture, 'kelpi.plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.contributes.commands.push({ id: `${pluginID}.configure`, title: 'Configure private scenario' });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(fixture, 'backend.mjs'), `
        import { activate as baseActivate } from './base.mjs';
        export async function activate(api) {
            let config = {};
            await baseActivate({...api, providers: {register(id, methods) {
                if (id.endsWith('.git')) {
                    const original = methods.getStatus;
                    methods = {...methods, getStatus: async (...args) => {
                        const result = await original(...args);
                        return config.gitStatus ? {kind:'dirty',changedFiles:7,additions:4321,deletions:1234} : result;
                    }};
                }
                if (id.endsWith('.renderer')) {
                    const original = methods.render;
                    methods = {...methods, render: async (...args) => {
                        const mode = config.mode;
                        if (mode === 'invalid') return {html:7};
                        if (mode === 'throw') throw new Error('intentional render failure');
                        const result = await original(...args);
                        if (mode === 'slow' && args[0].source.includes('Slow source')) await new Promise(resolve => setTimeout(resolve,700));
                        return result;
                    }};
                }
                api.providers.register(id,methods);
            }}});
            api.commands.register('${pluginID}.configure', args => {config = args; return null;});
        }
    `);

    const tokenFile = fs.readdirSync(sandbox.runDir).find(file => file.endsWith('.token'));
    const token = fs.readFileSync(path.join(sandbox.runDir, tokenFile), 'utf8').trim();
    const socket = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${token}`);
    const pending = new Map(); let sequence = 0;
    const ready = new Promise((resolve, reject) => {
        socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, token, client: { kind: 'browser', name: 'native-service-scenario' } })));
        socket.addEventListener('error', reject, { once: true });
        socket.addEventListener('message', event => {
            let message; try { message = JSON.parse(String(event.data)); } catch { return; }
            if (message.type === 'welcome') resolve();
            if (message.type === 'command-reply') pending.get(message.id)?.(message.reply);
        });
    });
    const command = payload => new Promise((resolve, reject) => {
        const id = `native-${++sequence}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native command timeout: ${payload.command}`)); }, 35_000);
        pending.set(id, reply => { clearTimeout(timer); pending.delete(id); reply.ok ? resolve(reply) : reject(new Error(JSON.stringify(reply))); });
        socket.send(JSON.stringify({ type: 'command', id, payload }));
    });
    const json = async args => JSON.parse(await cli.ok(args));
    const select = (service, provider) => cli.ok(['plugin', 'service-select', service, provider]);
    const configure = args => cli.ok(['plugin', 'run', `${pluginID}.configure`, '--args', JSON.stringify(args)]);
    const services = () => json(['plugin', 'services']);
    const panes = workspaceID => json(['pane', 'list', '--workspace', workspaceID, '--json']);
    const frame = paneID => `[data-testid="content-iframe-${paneID}"]`;
    const frameHas = (paneID, text) => d.settle(async () => {
        try { return await page.evalInFrame(frame(paneID), `document.body.innerText.includes(${JSON.stringify(text)})`); } catch { return false; }
    }, { ceilingMs: 10_000 });
    let workspaceID, worktreeWorkspaceID;
    try {
        await ready;
        const catalog = await services();
        rec.check('composed daemon exposes all four native service contracts', ['kelpi.files', 'kelpi.git', 'kelpi.content.render', 'kelpi.process'].every(id => catalog.some(service => service.id === id && service.activeProviderID === `${id}.bundled`)));
        await cli.ok(['plugin', 'install', fixture, '--trust']);
        const workspace = await json(['workspace', 'create', '--name', 'Native service validation', '--path', repo, '--json']);
        workspaceID = workspace.workspace_id;
        const terminal = (await panes(workspaceID))[0].id;
        await command({ command: 'add-repo-association', workspace_id: workspaceID, path: repo });
        await cli.ok(['open', file], { paneID: terminal });
        await d.settle(async () => (await panes(workspaceID)).some(pane => pane.type === 'markdown'));
        const markdown = (await panes(workspaceID)).find(pane => pane.type === 'markdown').id;
        rec.check('native Markdown initially uses the bundled renderer', await frameHas(markdown, 'Original text.'));

        await configure({ gitStatus: true });
        await select('kelpi.git', `${pluginID}.git`);
        const status = await command({ command: 'workspace-repo-status', workspace_id: workspaceID, refresh: true });
        rec.check('native repository status reads the selected Git implementation', status.associations.some(association => association.status.additions === 4321 && association.status.changed_files === 7), JSON.stringify(status.associations));
        if (!await page.eval(`document.querySelector('[data-testid="toggle-inspector"]')?.getAttribute('aria-pressed') === 'true'`)) await page.click('[data-testid="toggle-inspector"]');
        rec.check('Inspector displays the provider result through its ordinary data feed', await d.settleDom(page, `document.querySelector('[data-testid="inspector-repos"]')?.innerText.includes('4321')`));

        await select('kelpi.content.render', `${pluginID}.renderer`);
        rec.check('selecting a renderer updates the existing native Markdown pane', await frameHas(markdown, 'Service Lab'));
        rec.check('provider HTML retains the content iframe sandbox', await page.eval(`document.querySelector(${JSON.stringify(frame(markdown))}).getAttribute('sandbox') === 'allow-scripts'`) && await page.evalInFrame(frame(markdown), `(() => { try { parent.document.body; return false; } catch { return true; } })()`));
        await cli.ok(['diff'], { cwd: repo, paneID: terminal });
        await d.settle(async () => (await panes(workspaceID)).some(pane => pane.type === 'diff'));
        const diff = (await panes(workspaceID)).find(pane => pane.type === 'diff').id;
        rec.check('CLI-created native Diff uses the same Git and rendering providers', await frameHas(diff, 'Service Lab') && (await json(['plugin', 'run', `${pluginID}.history`])).some(entry => entry.service === 'kelpi.git' && entry.method === 'getDiff'));
        await rec.shot(page, 'native-inspector-markdown-and-diff-providers');
        await cli.ok(['pane', 'close', '--target', diff]);
        await page.click('[aria-label="Show diff for this repo"]');
        let inspectorDiff;
        await d.settle(async () => { inspectorDiff = (await panes(workspaceID)).find(pane => pane.type === 'diff'); return !!inspectorDiff; });
        rec.check('Inspector opens a native Diff through the same selected adapters', !!inspectorDiff && await frameHas(inspectorDiff.id, 'Service Lab'));

        await select('kelpi.process', `${pluginID}.process`);
        const processArgs = { file: process.execPath, args: ['-e', 'process.stdout.write(process.env.KELPI_REQUIRE_SOCKET)'], cwd: repo };
        const processResult = await json(['plugin', 'run', `${pluginID}.exec`, '--args', JSON.stringify(processArgs)]);
        rec.check('managed SDK execution uses the process provider with private CLI routing', processResult.stdout === '1' && (await json(['plugin', 'run', `${pluginID}.history`])).some(entry => entry.service === 'kelpi.process' && entry.method === 'exec'));

        await configure({ mode: 'slow' });
        fs.writeFileSync(file, '# Slow source\n');
        await command({ command: 'markdown-set-mode', pane_id: markdown, mode: 'edit' });
        await command({ command: 'content-set-text', pane_id: markdown, text: '# Slow source\n' });
        const older = command({ command: 'markdown-save', pane_id: markdown });
        await command({ command: 'content-set-text', pane_id: markdown, text: '# Latest source\n' });
        await command({ command: 'markdown-save', pane_id: markdown });
        await older;
        await command({ command: 'markdown-set-mode', pane_id: markdown, mode: 'view' });
        rec.check('a slower previous render cannot overwrite the latest saved source', await frameHas(markdown, 'Latest source') && fs.readFileSync(file, 'utf8') === '# Latest source\n');

        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disabling the provider restores the open native preview', await d.settle(async () => { try { return await page.evalInFrame(frame(markdown), `document.body.innerText.includes('Latest source') && !document.getElementById('service-lab-banner')`); } catch { return false; } }));
        rec.check('fallback preserves every selected provider preference', (await services()).filter(service => ['kelpi.git', 'kelpi.content.render', 'kelpi.process'].includes(service.id)).every(service => service.selectedProviderID?.startsWith(pluginID) && service.activeProviderID === `${service.id}.bundled`));
        rec.check('Inspector refreshes provider fallback without reopening', await d.settleDom(page, `document.querySelector('[data-testid="inspector-repos"]') && !document.querySelector('[data-testid="inspector-repos"]').innerText.includes('4321')`));
        await cli.ok(['plugin', 'enable', pluginID]);
        rec.check('reenabling restores the preferred native renderer', await frameHas(markdown, 'Service Lab'));
        await cli.ok(['plugin', 'reload', pluginID]);
        rec.check('reloading preserves the native pane and saved content', await frameHas(markdown, 'Service Lab') && await frameHas(markdown, 'Latest source'));

        await configure({ mode: 'invalid' });
        await command({ command: 'content-set-font-size', pane_id: markdown, size: 17 });
        rec.check('invalid provider output is retired and the native preview recovers', await d.settle(async () => {
            const renderer = (await services()).find(service => service.id === 'kelpi.content.render');
            return renderer.activeProviderID === 'kelpi.content.render.bundled' && await page.evalInFrame(frame(markdown), `document.body.innerText.includes('Latest source') && !document.getElementById('service-lab-banner')`);
        }));
        rec.check('provider failure preserves the authoritative editor file', fs.readFileSync(file, 'utf8') === '# Latest source\n');
        await cli.ok(['plugin', 'reload', pluginID]);
        rec.check('reload recovers a failed native provider in the same pane', await frameHas(markdown, 'Service Lab'));

        await command({ command: 'set-general-setting', key: 'worktree-base-path', value: path.join(sandbox.root, 'provider-worktrees') });
        const worktree = await json(['workspace', 'create', '--name', 'Provider worktree', '--worktree', 'provider-check', '--branch', 'provider-check', '--repo', repo, '--json']);
        worktreeWorkspaceID = worktree.workspace_id;
        rec.check('ordinary CLI workspace creation delegates real worktree creation to the Git provider', fs.existsSync(path.join(worktree.worktree_path, 'NOTES.md')) && (await json(['plugin', 'run', `${pluginID}.history`])).some(entry => entry.method === 'worktreeAdd'));
        const associated = await command({ command: 'workspace-repo-status', workspace_id: worktreeWorkspaceID, refresh: true });
        const association = associated.associations.find(entry => entry.is_worktree);
        const original = fs.readFileSync(file, 'utf8');
        await command({ command: 'graft-session-start', association_id: association.id });
        rec.check('native graft uses selected Git primitives to mirror a real worktree', fs.readFileSync(file, 'utf8') === fs.readFileSync(path.join(worktree.worktree_path, 'NOTES.md'), 'utf8'));
        await command({ command: 'graft-session-stop', association_id: association.id });
        rec.check('graft stop restores the original dirty checkout through the provider', fs.readFileSync(file, 'utf8') === original);
        await command({ command: 'remove-repo-association', workspace_id: worktreeWorkspaceID, association_id: association.id, delete_worktree: true });
        rec.check('native worktree removal delegates once and removes the real directory', !fs.existsSync(worktree.worktree_path) && (await json(['plugin', 'run', `${pluginID}.history`])).some(entry => entry.method === 'removeWorktree'));
    } finally {
        socket.close();
        for (const service of ['kelpi.git', 'kelpi.content.render', 'kelpi.process']) await cli.run(['plugin', 'service-select', service, 'default']);
        await cli.run(['plugin', 'remove', pluginID]);
        if (worktreeWorkspaceID) await cli.run(['workspace', 'delete', worktreeWorkspaceID, '--force']);
        if (workspaceID) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
