/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export async function activate(api) {
    let history = await api.storage.get('history') ?? [];
    const initial = await api.snapshot();
    let sequence = initial.sequence;
    const off = api.events.on('state.changed', async event => {
        if (event.sequence <= sequence) return;
        sequence = event.sequence;
        // Runs in the daemon's plugin process even when every UI window is closed.
        const updates = event.data.filter(change => change.kind === 'pane-upserted').map(change => ({
            at: Date.now(), workspaceID: change.workspaceID, paneID: change.pane.id,
            title: change.pane.label ?? change.pane.title, status: change.pane.status
        }));
        if (!updates.length) return;
        history = [...history, ...updates].slice(-100);
        await api.storage.set('history', history);
        await api.emit('history', { count: history.length });
    });
    api.commands.register('example.agent-board.open', () => api.openView('example.agent-board.board'));
    api.commands.register('example.agent-board.history', () => history);
    return off;
}
