const api = globalThis.kelpi;
const element = id => document.getElementById(id);
const toolbar = document.body.dataset.view === 'toolbar';
let snapshot = null, disposed = false, choosing = false;
function failed(error) {
    if (disposed) return;
    const output = element('error'); output.textContent = error.message; output.title = error.message; output.hidden = false;
}
async function action(operation) {
    try { element('error').hidden = true; await operation(); } catch (error) { failed(error); }
}
const target = () => snapshot?.workspace ? { workspaceID: snapshot.workspace.id } : {};
const execute = (id, selection = target()) => api.ui.executeChromeCommand(id, selection);
const enabled = id => snapshot.commands.find(command => command.id === id)?.enabled === true;
function updateItems() {
    const host = element('items'), placement = toolbar ? 'workspace.header' : 'statusbar';
    const items = snapshot.items.filter(item => item.placement === placement), wanted = new Set(items.map(item => item.id));
    for (const child of [...host.children]) if (!wanted.has(child.dataset.id)) child.remove();
    for (const [index, item] of items.entries()) {
        let button = [...host.children].find(child => child.dataset.id === item.id);
        if (!button) {
            button = document.createElement('button'); button.type = 'button'; button.dataset.id = item.id;
            button.addEventListener('click', () => {
                const current = snapshot.items.find(item => item.id === button.dataset.id && item.placement === placement);
                if (current?.commandID) void action(() => execute(current.commandID));
            });
        }
        if (host.children[index] !== button) host.insertBefore(button, host.children[index] ?? null);
        button.textContent = `${item.text}${item.badge ? ` · ${item.badge}` : ''}`;
        button.title = item.tooltip ?? item.text; button.disabled = !item.enabled || !item.commandID;
        button.dataset.tone = item.tone;
    }
}
function render(value) {
    if (disposed) return;
    snapshot = value; document.body.dataset.workspace = value.workspace?.id ?? ''; document.body.dataset.connection = value.connection;
    if (toolbar) {
        for (const id of ['left', 'right', 'more']) element(id).disabled = false;
        element('workspace').textContent = value.workspace ? `${value.workspace.name} · ${value.workspace.paneCount} panes` : 'Kelpi';
        element('connection').textContent = value.connection; element('connection').dataset.connected = String(value.connection === 'connected');
        element('scope').hidden = !value.remoteWorkspaceSelected; element('scope').title = 'Toolbar commands belong to the primary host. Select its workspace to change its layout.';
        for (const side of ['left', 'right']) {
            element(side).title = `${value.sidebars[side].visible ? 'Hide' : 'Show'} ${value.sidebars[side].title}`;
            element(side).setAttribute('aria-pressed', String(value.sidebars[side].visible));
        }
        const layout = element('layout');
        if (layout.options.length !== value.layouts.length + 1) {
            layout.replaceChildren(new Option('Custom layout', ''), ...value.layouts.map(item => new Option(item.title, item.id)));
            layout.options[0].disabled = true;
        }
        layout.value = value.workspace?.layout ?? ''; layout.disabled = !enabled('kelpi.layout.cycle');
        element('sync').disabled = !enabled('kelpi.input.toggleSync');
        element('sync').setAttribute('aria-pressed', String(value.workspace?.syncInputActive ?? false));
        element('sync').title = `Synchronise input across ${value.workspace?.syncedPaneCount ?? 0} panes`;
        element('size').hidden = value.sizeControl !== 'other-window'; element('size').disabled = !enabled('kelpi.window.takeSizeControl');
    } else {
        element('cwd').textContent = value.focusedPane?.workingDirectory || 'No focused pane'; element('cwd').title = value.focusedPane?.title ?? '';
        element('branch').textContent = value.focusedPane?.gitBranch ?? '';
        element('git').textContent = value.git ? `${value.git.changedFiles} files +${value.git.additions} −${value.git.deletions}` : '';
        const metrics = element('metrics'); metrics.replaceChildren(...(value.systemStats ?? []).map(item => {
            const label = document.createElement('span'); label.textContent = `${item.title} ${item.text}`; label.title = item.detail; return label;
        }));
        for (const bucket of ['running', 'waiting', 'inactive']) {
            element(bucket).textContent = `${value.agents[bucket]} ${bucket === 'inactive' ? 'idle' : bucket}`;
            element(bucket).disabled = value.agents[bucket] === 0 || !enabled('kelpi.pane.focus');
        }
    }
    updateItems(); document.body.dataset.ready = 'true';
}
async function choose(options, onChoice) {
    if (choosing || disposed) return;
    choosing = true;
    try {
        // Chrome IDs and labels can exceed quick-pick limits. Keep the original targets
        // while sending bounded display rows, with space for navigation on larger lists.
        const choices = new Map(options.items.map((item, index) => [`row:${index}`, item]));
        const rows = [...choices].map(([id, item]) => ({
            id, label: (item.label.trim() || 'Untitled').slice(0, 200), disabled: item.disabled === true,
            ...(item.description === undefined ? {} : { description: item.description.trim().slice(0, 1024) })
        }));
        const pageSize = rows.length > 200 ? 198 : 200;
        let page = 0;
        while (!disposed) {
            const items = rows.slice(page * pageSize, (page + 1) * pageSize);
            const hasNext = (page + 1) * pageSize < rows.length;
            if (page > 0) items.unshift({ id: 'previous', label: 'Previous page' });
            if (hasNext) items.push({ id: 'next', label: 'Next page' });
            const id = await api.ui.showQuickPick({ title: options.title, items });
            if (id === null || disposed) return;
            if (id === 'previous' && page > 0) { page--; continue; }
            if (id === 'next' && hasNext) { page++; continue; }
            const choice = choices.get(id);
            if (choice && !choice.disabled) await onChoice(choice.id);
            return;
        }
    }
    finally { choosing = false; }
}
if (toolbar) {
    for (const [button, id] of [['left', 'kelpi.sidebar.left'], ['right', 'kelpi.sidebar.right'], ['sync', 'kelpi.input.toggleSync'], ['size', 'kelpi.window.takeSizeControl']]) {
        element(button).addEventListener('click', () => { void action(() => execute(id)); });
    }
    element('layout').addEventListener('change', () => { const layout = element('layout').value; void action(() => execute(`kelpi.layout.select.${layout}`)); });
    element('more').addEventListener('click', () => {
        const selection = target();
        void action(() => choose({ title: 'Window commands', items: snapshot.commands.filter(command => command.group === 'menu').map(command => ({
            id: command.id, label: command.title, disabled: !command.enabled
        })) }, id => execute(id, selection)));
    });
} else for (const bucket of ['running', 'waiting', 'inactive']) element(bucket).addEventListener('click', () => {
    const panes = snapshot.agentPanes.filter(pane => pane.bucket === bucket);
    void action(() => choose({ title: `${bucket === 'inactive' ? 'Idle' : bucket === 'waiting' ? 'Waiting' : 'Running'} agents`, items: panes.map((pane, index) => ({
        id: String(index), label: pane.title, description: pane.workspaceName
    })) }, id => {
        const pane = panes[Number(id)];
        return pane ? execute('kelpi.pane.focus', { workspaceID: pane.workspaceID, paneID: pane.paneID }) : undefined;
    }));
});
await api.ready;
const stop = api.ui.onChrome(render, failed);
addEventListener('pagehide', () => { disposed = true; stop(); });
