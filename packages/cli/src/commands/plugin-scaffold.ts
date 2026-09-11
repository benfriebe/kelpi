import fs from 'node:fs';
import path from 'node:path';
import { decodePluginManifest } from '@kelpi/protocol';

export const pluginScaffoldTemplates = ['pane', 'sidebar', 'document', 'browser'] as const;
export type PluginScaffoldTemplate = typeof pluginScaffoldTemplates[number];

/** An offline, build-free starter. mkdir's exclusive create keeps existing work untouched. */
export function scaffoldPlugin(directory: string, id: string, name: string, template: PluginScaffoldTemplate = 'pane'): { path: string; pluginID: string; viewID: string } {
    if (!pluginScaffoldTemplates.includes(template)) throw new Error(`unknown plugin template: ${template}; choose ${pluginScaffoldTemplates.join(', ')}`);
    const viewID = `${id}.home`, commandID = `${id}.summary`;
    const placements = {
        pane: ['pane', 'sidebar.primary', 'sidebar.secondary'],
        sidebar: ['sidebar.primary', 'sidebar.secondary'],
        document: ['document.markdown', 'document.scratchpad', 'document.diff'],
        browser: ['browser'],
    }[template];
    const manifest = {
        id, name, version: '0.1.0', apiVersion: 1, trust: 'full', activation: 'on-demand', backend: 'backend.mjs',
        contributes: {
            views: [{ id: viewID, title: name, entry: 'ui/index.html', placements, stateVersion: 1 }],
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
    const body = template === 'document'
        ? `<header><h1>${title}</h1><label><input id="wrap" type="checkbox" checked>Wrap lines</label><button id="refresh" type="button">Refresh</button></header>
<p id="status" role="status">Loading document…</p><p id="error" role="alert"></p><pre id="source" aria-label="Document source"></pre>`
        : template === 'browser'
        ? `<header><h1>${title}</h1><select id="tabs" aria-label="Browser tab"></select><button id="new-tab" type="button" disabled>New tab</button></header>
<form id="navigation"><button id="back" type="button" aria-label="Back" disabled>←</button><button id="forward" type="button" aria-label="Forward" disabled>→</button><button id="reload" type="button" disabled>Reload</button><input id="address" aria-label="Address" placeholder="https://example.com" disabled><button id="go" type="submit" disabled>Go</button></form>
<p id="error" role="alert"></p><p id="status" role="status"></p><div id="page-slot" aria-label="Native browser page"></div>`
        : `<header><h1>${title}</h1><button id="refresh" type="button">Refresh</button></header>
<p id="error" role="alert"></p><ul id="workspaces"></ul>`;
    write('ui/index.html', `<meta charset="utf-8">
<title>${title}</title>
<style>
    :root { color-scheme: dark light; }
    body { margin: 0; padding: 16px; color: var(--kelpi-fg, inherit); background: var(--kelpi-bg, transparent); font: 13px system-ui; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 15px; } button { font: inherit; } ul { padding-left: 20px; } li { margin: 8px 0; }
    #error { color: #e87979; white-space: pre-wrap; } #error:empty, #status:empty { display: none; }
    pre { white-space: pre-wrap; overflow: auto; } input, select { font: inherit; min-width: 0; }
    ${template === 'browser' ? 'html, body { height: 100%; box-sizing: border-box; } body { display: flex; flex-direction: column; gap: 8px; } header, #navigation { display: flex; gap: 6px; flex-shrink: 0; } h1 { margin: 0; } #address, #tabs { flex: 1; } #page-slot { flex: 1; min-height: 0; }' : ''}
</style>
${body}
<script src="app.js"></script>
`);
    write('ui/app.js', template === 'document' ? documentScript() : template === 'browser' ? browserScript() : `const api = globalThis.kelpi;
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
    const description = {
        pane: 'A pane with optional sidebar placements and a backend workspace command.',
        sidebar: 'A workspace sidebar that can occupy either side, with a backend workspace command.',
        document: 'A read-only native document viewer for Markdown, Scratchpad and Diff. It watches the existing daemon buffer and persists the wrapping preference. Source edits and saves stay with Kelpi.',
        browser: 'A native browser surface with tabs and navigation. Kelpi owns the existing pages and sessions; this plugin supplies their controls.',
    }[template];
    const select = template === 'pane' ? `kelpi plugin open ${id} ${viewID}\n` : '';
    const placementInstructions = template === 'pane' || template === 'sidebar'
        ? 'Select either sidebar in Settings → Plugins → Workbench views.'
        : `Open an existing ${template === 'document' ? 'Markdown, Scratchpad or Diff' : 'browser'} pane, then select this plugin in Settings → Plugins → Workbench views. Native replacement views attach to existing panes; they are not opened with plugin open.`;
    write('README.md', `# ${name.replaceAll('\n', ' ')}

${description} No build required.

From this directory, using the CLI and socket of your isolated development instance:

\`\`\`sh
kelpi plugin validate .
kelpi plugin install . --trust
${select}kelpi plugin run ${commandID}
\`\`\`

${placementInstructions}

Run \`kelpi plugin dev . --trust\` to validate and install changed revisions while editing.
Invalid packages and failed updates keep the last working installation. Ctrl+C stops watching
and leaves that version installed. Reload only restarts the installed bytes.

Create a portable package outside this source directory with:

\`\`\`sh
kelpi plugin pack . --out ../${id}.kelpi-plugin
\`\`\`

Views receive window.kelpi; backend activate(api) receives the same typed workspace, pane,
terminal, git and service APIs, plus command/hook/provider registration. Public declarations
are in @kelpi/plugin-sdk. See Kelpi's docs/plugins.md for the complete authoring guide.
${template === 'document' ? '\nTo add editing, stage every input with documents.stage before serializing guarded applyDraft writes; see Document Lab and docs/plugin-documents.md for recovery and conflict handling.\n' : ''}${template === 'browser' ? '\nThis starter demonstrates surface attachment and navigation. See Browser Lab for Find, bookmarks, inspection, capture and other browser controls.\n' : ''}
`);
    return { path: destination, pluginID: id, viewID };
}

function documentScript(): string {
    return `const api = globalThis.kelpi;
const $ = id => document.getElementById(id);
let subscription, stopped = false, reading = false, reread = false;
function problem(error) { $('error').textContent = error?.message ?? error ?? ''; }
function render(state) {
    if (stopped) return;
    $('source').textContent = state.text;
    $('status').textContent = (state.path ?? state.kind) + ' · ' + (state.loaded ? state.dirty ? 'Unsaved changes' : 'Saved' : 'Loading…');
    problem(state.error);
}
async function refresh() {
    reread = true; if (reading || stopped) return;
    reading = true;
    try { while (reread && !stopped) { reread = false; render(await api.documents.get()); } }
    catch (error) { if (!stopped) problem(error); }
    finally { reading = false; }
}
const stopChanged = api.events.on('documents.changed', event => {
    if (!subscription) { reread = true; return; }
    if (event.data.subscription === subscription) return refresh();
});
const stopClosed = api.events.on('documents.closed', event => {
    if (event.data.subscription === subscription) { stop(); problem('This document was closed.'); }
});
function stop() {
    if (stopped) return;
    stopped = true; stopChanged(); stopClosed();
    if (subscription) void api.documents.unwatch(subscription).catch(() => {});
}
addEventListener('pagehide', stop, { once: true });
$('refresh').onclick = () => void refresh();
function wrap(enabled) { $('wrap').checked = enabled; $('source').style.whiteSpace = enabled ? 'pre-wrap' : 'pre'; }
$('wrap').onchange = () => {
    wrap($('wrap').checked);
    void api.setState({ wrap: $('wrap').checked }).catch(problem);
};
async function start() {
    await api.ready; if (stopped) return;
    wrap(api.state.wrap !== false);
    const watched = await api.documents.watch(); subscription = watched.subscription;
    if (stopped) { await api.documents.unwatch(subscription); return; }
    render(watched.state);
    if (reread) void refresh();
}
void start().catch(error => { problem(error); throw error; });
`;
}

function browserScript(): string {
    return `const api = globalThis.kelpi;
const $ = id => document.getElementById(id);
let state, subscription, surface, stopped = false, reading = false, reread = false, addressEditing = false;
function problem(error) { $('error').textContent = error?.message ?? error ?? ''; }
function render(next) {
    if (stopped) return;
    state = next;
    const active = state.tabs.find(tab => tab.id === state.activeTabID);
    $('tabs').replaceChildren(...state.tabs.map(tab => {
        const option = document.createElement('option'); option.value = tab.id; option.textContent = tab.title || tab.url || 'New tab'; return option;
    }));
    $('tabs').value = state.activeTabID ?? '';
    if (!addressEditing) $('address').value = active?.url ?? '';
    $('back').disabled = !active?.canGoBack; $('forward').disabled = !active?.canGoForward;
    for (const id of ['reload', 'address', 'go']) $(id).disabled = !active;
    $('new-tab').disabled = false;
}
async function refresh() {
    reread = true; if (reading || stopped) return;
    reading = true;
    try { while (reread && !stopped) { reread = false; render(await api.browser.get()); } }
    catch (error) { if (!stopped) problem(error); }
    finally { reading = false; }
}
async function action(invoke) {
    if (!state || stopped) return;
    try { problem(null); await invoke(); await refresh(); } catch (error) { if (!stopped) problem(error); }
}
$('navigation').onsubmit = event => {
    event.preventDefault(); const url = $('address').value; addressEditing = false;
    void action(() => api.browser.navigate(state.paneID, url));
};
$('address').onfocus = () => { addressEditing = true; };
$('navigation').addEventListener('focusout', event => {
    if (!$('navigation').contains(event.relatedTarget)) { addressEditing = false; if (state) render(state); }
});
$('back').onclick = () => void action(() => api.browser.back(state.paneID));
$('forward').onclick = () => void action(() => api.browser.forward(state.paneID));
$('reload').onclick = () => void action(() => api.browser.reload(state.paneID));
$('tabs').onchange = () => { const tabID = $('tabs').value; void action(() => api.browser.tabs.select(state.paneID, tabID)); };
$('new-tab').onclick = () => void action(() => api.browser.tabs.open(state.paneID));
const stopChanged = api.events.on('browser.changed', event => {
    if (!subscription) { reread = true; return; }
    if (event.data.subscription === subscription) return refresh();
});
const stopClosed = api.events.on('browser.closed', event => {
    if (event.data.subscription === subscription) { stop(); problem('This browser pane was closed.'); }
});
function stop() {
    if (stopped) return;
    stopped = true; stopChanged(); stopClosed(); surface?.dispose();
    if (subscription) void api.browser.unwatch(subscription).catch(() => {});
}
addEventListener('pagehide', stop, { once: true });
async function start() {
    await api.ready; if (stopped) return;
    const watched = await api.browser.watch(); subscription = watched.subscription;
    if (stopped) { await api.browser.unwatch(subscription); return; }
    render(watched.state); if (reread) void refresh();
    surface = await api.browser.attach({
        element: $('page-slot'),
        onPresentation: value => { $('status').textContent = value.available ? '' : value.reason ?? 'This page is hosted in another window.'; },
        onAction: action => {
            if (action.type === 'focusAddress') { $('address').focus(); $('address').select(); }
            else if (action.type === 'focus') surface?.focus();
        },
    });
    if (stopped) surface.dispose();
}
void start().catch(error => { problem(error); throw error; });
`;
}
