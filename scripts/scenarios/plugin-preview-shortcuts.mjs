import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const covers = [
    'packages/client/src/App.tsx', 'packages/client/src/plugins/commands.ts',
    'packages/client/src/content/ContentFrame.tsx', 'packages/client/src/content/bridge.ts',
];

export default async function ({ page, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const repo = path.join(sandbox.root, 'preview-shortcut-repo');
    fs.mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--initial-branch=main']);
    const markdownFile = path.join(repo, 'SHORTCUTS.md');
    fs.writeFileSync(markdownFile, '# Preview shortcut probe\n');
    git(['add', 'SHORTCUTS.md']);
    git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
    fs.appendFileSync(markdownFile, '\nExercise the plugin shortcut in this preview.\n');

    const pluginID = 'scenario.preview-shortcuts';
    const fixture = path.join(sandbox.root, 'preview-shortcut-plugin');
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'kelpi.plugin.json'), JSON.stringify({
        id: pluginID, name: 'Preview shortcuts', version: '1.0.0', apiVersion: 1,
        trust: 'full', activation: 'startup', backend: 'backend.mjs',
        contributes: { commands: [
            { id: `${pluginID}.record`, title: 'Record preview shortcut', shortcut: 'ctrl+alt+b' },
            { id: `${pluginID}.read`, title: 'Read shortcut invocation' },
        ] },
    }));
    fs.writeFileSync(path.join(fixture, 'backend.mjs'), `
        export function activate(api) {
            let count = 0, context = null;
            api.commands.register('${pluginID}.record', (_args, current) => { count++; context = current; });
            api.commands.register('${pluginID}.read', () => ({ count, context }));
        }
    `);

    let workspaceID;
    const json = async args => JSON.parse(await cli.ok(args));
    try {
        await cli.ok(['plugin', 'install', fixture, '--trust']);
        const workspace = await json(['workspace', 'create', '--name', 'Preview shortcuts', '--path', repo, '--json']);
        workspaceID = workspace.workspace_id;
        const panes = () => json(['pane', 'list', '--workspace', workspaceID, '--json']);
        const terminal = (await panes())[0].id;
        const invocation = () => json(['plugin', 'run', `${pluginID}.read`]);

        for (const kind of ['markdown', 'diff']) {
            await cli.ok(kind === 'markdown' ? ['open', markdownFile] : ['diff'], { cwd: repo, paneID: terminal });
            let pane;
            const opened = await d.settle(async () => { pane = (await panes()).find(pane => pane.type === kind); return !!pane; });
            if (!opened) throw new Error(`the ${kind} pane did not open`);
            const frame = `[data-testid="content-iframe-${pane.id}"]`;
            const ready = await d.settle(async () => {
                try { return await page.evalInFrame(frame, `document.body.innerText.includes('Preview shortcut probe')`); }
                catch { return false; }
            }, { ceilingMs: 10_000 });
            rec.check(`${kind} preview renders in its native iframe`, ready);
            if (!ready) throw new Error(`the ${kind} document did not render`);
            await page.click(frame);
            rec.check(`${kind} iframe owns keyboard focus`, await d.settleDom(page, `document.activeElement === document.querySelector(${JSON.stringify(frame)})`));
            const before = await invocation();
            await page.key('KeyB', { modifiers: 3, key: 'b', keyCode: 66 });
            let after;
            const dispatched = await d.settle(async () => {
                after = await invocation();
                return after.count === before.count + 1 && after.context?.paneID === pane.id && after.context?.workspaceID === workspaceID;
            }, { ceilingMs: 5_000 });
            rec.check(`plugin shortcut crosses the focused ${kind} iframe exactly once with its pane context`, dispatched, JSON.stringify({ before, after }));
            await cli.ok(['pane', 'close', '--target', pane.id]);
        }
    } finally {
        await cli.run(['plugin', 'remove', pluginID]);
        if (workspaceID) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
