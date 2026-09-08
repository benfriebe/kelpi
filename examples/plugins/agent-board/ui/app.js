const api = window.kelpi;
await api.ready;
const $ = id => document.getElementById(id);
let snapshot = null, sequence = -1, refreshing = false, again = false;
const error = cause => { $('error').textContent = cause.message ?? String(cause); };
$('filter').value = api.state.filter ?? '';
function render(settings) {
    const root = $('panes'); root.replaceChildren();
    const query = $('filter').value.toLowerCase(); let count = 0;
    for (const workspace of snapshot.workspaces) {
        const panes = workspace.panes.filter(pane => (settings.showIdle || pane.status !== 'idle') && `${workspace.name} ${pane.label ?? pane.title ?? ''}`.toLowerCase().includes(query));
        if (!panes.length) continue;
        const title = document.createElement('h3'); title.textContent = workspace.name; root.append(title);
        for (const pane of panes) {
            count++;
            const button = document.createElement('button'); button.className = 'pane'; button.dataset.paneId = pane.id;
            const name = document.createElement('span'); name.textContent = pane.label ?? pane.title ?? pane.type;
            const status = document.createElement('small'); status.textContent = pane.status;
            button.append(name, status); button.onclick = () => api.ui.focusPane(workspace.id, pane.id).catch(error); root.append(button);
        }
    }
    $('count').textContent = `${count} panes`;
}
async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
        const result = await api.snapshot(); snapshot = result.state; sequence = result.sequence;
        render(await api.settings.get());
        const history = await api.commands.execute('example.agent-board.history');
        const list = $('history'); list.replaceChildren();
        for (const entry of history.slice(-15).reverse()) { const row = document.createElement('li'); row.textContent = `${entry.title ?? entry.paneID}: ${entry.status}`; list.append(row); }
        $('error').textContent = '';
    } catch (cause) { error(cause); }
    finally { refreshing = false; if (again) { again = false; void refresh(); } }
}
api.events.on('state.changed', event => { if (event.sequence > sequence) void refresh(); });
api.events.on('gap', () => void refresh());
api.events.on('settings.changed', () => void refresh());
$('refresh').onclick = refresh;
$('filter').oninput = () => { if (api.context.paneID) void api.setState({ filter: $('filter').value }).catch(error); void refresh(); };
$('create').onclick = async () => {
    try {
        const workspaceID = api.context.workspaceID ?? snapshot.lastActiveWorkspaceID;
        const workspace = snapshot.workspaces.find(workspace => workspace.id === workspaceID);
        const source = workspace?.focusedPaneID ?? workspace?.panes[0]?.id;
        const reply = await api.command(source ? { command: 'pane-split', pane_id: source, direction: 'horizontal' } : { command: 'pane-create', workspace_id: workspaceID });
        if (reply.ok !== true) throw new Error(reply.error ?? 'Could not create terminal');
        if (reply.pane_id) await api.ui.reveal(reply.pane_id);
    } catch (cause) { error(cause); }
};
await refresh();
