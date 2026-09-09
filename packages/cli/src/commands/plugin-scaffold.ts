import fs from 'node:fs';
import path from 'node:path';
import { decodePluginManifest } from '@kelpi/protocol';

/** An offline, build-free starter. mkdir's exclusive create keeps existing work untouched. */
export function scaffoldPlugin(directory: string, id: string, name: string): { path: string; pluginID: string; viewID: string } {
    const viewID = `${id}.home`, commandID = `${id}.summary`;
    const manifest = {
        id, name, version: '0.1.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
        contributes: {
            views: [{ id: viewID, title: name, entry: 'ui/index.html', placements: ['pane', 'sidebar.primary', 'sidebar.secondary'], stateVersion: 1 }],
            commands: [{ id: commandID, title: `${name}: Workspace summary` }],
            settings: {},
        },
    };
    decodePluginManifest(manifest);
    const destination = path.resolve(directory);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(destination);
    fs.mkdirSync(path.join(destination, 'ui'));
    const write = (file: string, text: string): void => fs.writeFileSync(path.join(destination, file), text, { flag: 'wx' });
    write('kelpi.plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
    write('backend.mjs', `export function activate(api) {
    return api.commands.register('${commandID}', async () => ({
        workspaces: await api.workspaces.list(),
        generatedAt: new Date().toISOString(),
    }));
}
`);
    const title = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    write('ui/index.html', `<meta charset="utf-8">
<title>${title}</title>
<style>
    :root { color-scheme: dark light; }
    body { margin: 0; padding: 16px; color: var(--kelpi-fg, inherit); background: var(--kelpi-bg, transparent); font: 13px system-ui; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 15px; } button { font: inherit; } ul { padding-left: 20px; } li { margin: 8px 0; }
    #error { color: #e87979; white-space: pre-wrap; }
</style>
<header><h1>${title}</h1><button id="refresh" type="button">Refresh</button></header>
<p id="error" role="alert"></p><ul id="workspaces"></ul>
<script src="app.js"></script>
`);
    write('ui/app.js', `const api = globalThis.kelpi;
async function refresh() {
    const error = document.querySelector('#error');
    try {
        await api.ready;
        const summary = await api.commands.execute('${commandID}');
        document.querySelector('#workspaces').replaceChildren(...summary.workspaces.map(workspace => {
            const row = document.createElement('li');
            row.textContent = workspace.name + ' · ' + workspace.paneCount + ' panes';
            return row;
        }));
        error.textContent = '';
    } catch (failure) { error.textContent = failure.message; }
}
document.querySelector('#refresh').addEventListener('click', refresh);
void refresh();
`);
    write('README.md', `# ${name.replaceAll('\n', ' ')}

A Kelpi plugin with a pane, either sidebar placement, and a backend command. No build required.

From this directory, using the CLI and socket of your isolated development instance:

\`\`\`sh
kelpi plugin install . --trust
kelpi plugin open ${id} ${viewID}
kelpi plugin run ${commandID}
\`\`\`

After editing, install this directory again to copy the new package bytes. Reload restarts the
installed copy; it does not recopy source changes. Select either sidebar in Settings → Plugins.

Views receive window.kelpi; backend activate(api) receives the same typed workspace, pane,
terminal, git and service APIs, plus command/hook/provider registration. Public declarations
are in @kelpi/plugin-sdk. See Kelpi's docs/plugins.md for the complete authoring guide.
`);
    return { path: destination, pluginID: id, viewID };
}
